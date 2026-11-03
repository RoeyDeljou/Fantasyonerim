import { setImmediate as nextTurn } from 'node:timers/promises';
import { Prisma } from '@prisma/client';
import type { AppContext } from '../context.js';
import { downloadMedia, MediaDownloadError } from '../media/download.js';
import { storeVariants } from '../media/variants.js';
import { isQuietHour } from '../perf/keepAlive.js';
import { MINUTE, type Job } from './types.js';

/** Images given variants per run: ~1 s of CPU each at most on a 0.1-CPU host, spread over time. */
export const IMAGE_VARIANTS_BATCH = 10;
export const IMAGE_VARIANTS_EVERY_MS = 10 * MINUTE;
/** Uploads younger than this are left to the upload route's own (after-response) generation. */
export const UPLOAD_VARIANTS_GRACE_MS = 5 * MINUTE;

export interface BackfillResult {
  done: number;
  none: number;
  failed: number;
  skipped: string | null;
}

/** A download that will never succeed (gone, or not an image): don't retry it every run. */
function permanent(err: unknown): boolean {
  return (
    err instanceof MediaDownloadError && /HTTP 4\d\d|content type|empty file|too large/.test(err.message)
  );
}

async function liveFixtureNow(app: AppContext): Promise<boolean> {
  try {
    const event = (await app.fpl.getBootstrap()).currentEvent;
    if (event === null) return false;
    return (await app.fpl.getFixtures(event)).some((f) => f.status === 'live');
  } catch {
    return false; // FPL down doesn't mean users are watching a match
  }
}

/**
 * One backfill batch: re-hosted News images and community uploads that have no variants yet (NULL), newest
 * first. Each is downloaded once through its public URL (the `/media` CDN, else the bucket), its variants are
 * written next to it and the row is updated — so a crash or a later run simply carries on (idempotent: keys are
 * deterministic, a re-run overwrites). A permanent failure marks the row `[]` (no variants), a transient one stops
 * the batch for the next run.
 */
export async function backfillImageVariants(
  app: AppContext,
  now: Date,
  options: { force?: boolean; batch?: number } = {},
): Promise<BackfillResult> {
  const result: BackfillResult = { done: 0, none: 0, failed: 0, skipped: null };
  if (!options.force) {
    if (isQuietHour(now, app.config.keepAlive?.quietHours)) return { ...result, skipped: 'quiet hours' };
    if (await liveFixtureNow(app)) return { ...result, skipped: 'a fixture is live' };
  }
  const limit = options.batch ?? IMAGE_VARIANTS_BATCH;
  const media = await app.prisma.newsMedia.findMany({
    where: { kind: 'image', storageKey: { not: null }, variants: { equals: Prisma.DbNull } },
    orderBy: [{ item: { publishedAt: 'desc' } }, { id: 'asc' }],
    take: limit,
    select: { id: true, url: true, storageKey: true },
  });
  const uploads =
    media.length >= limit
      ? []
      : await app.prisma.upload.findMany({
          where: {
            variants: { equals: Prisma.DbNull },
            createdAt: { lt: new Date(now.getTime() - UPLOAD_VARIANTS_GRACE_MS) },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: limit - media.length,
          select: { id: true, url: true, storageKey: true },
        });

  const work = [
    ...media.map((m) => ({
      ...m,
      save: (v: Prisma.InputJsonValue) =>
        app.prisma.newsMedia.updateMany({ where: { id: m.id }, data: { variants: v } }),
    })),
    ...uploads.map((u) => ({
      ...u,
      save: (v: Prisma.InputJsonValue) =>
        app.prisma.upload.updateMany({ where: { id: u.id }, data: { variants: v } }),
    })),
  ];
  for (const item of work) {
    if (item.storageKey === null) continue;
    await nextTurn();
    try {
      const file = await downloadMedia(app.fetch, app.mediaUrl(item.url), 'image');
      const stored = await storeVariants(app.media, item.storageKey, file.bytes);
      await item.save(stored);
      if (stored.length === 0) result.none += 1;
      else result.done += 1;
    } catch (err) {
      result.failed += 1;
      if (!permanent(err)) break;
      await item.save([]);
    }
  }
  return result;
}

export const imageVariantsJob: Job = {
  name: 'image_variants',
  everyMs: IMAGE_VARIANTS_EVERY_MS,
  async run(ctx) {
    const r = await backfillImageVariants(ctx.app, ctx.now, { force: ctx.force });
    return {
      summary:
        r.skipped !== null
          ? `skipped: ${r.skipped}`
          : `${r.done} images got variants, ${r.none} already small, ${r.failed} failed`,
    };
  },
};
