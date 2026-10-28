import { IntegrationRateLimitError } from '@fant/integrations';
import { Prisma } from '@prisma/client';
import type { AppContext } from '../context.js';
import { downloadMedia } from '../media/download.js';
import { readLinks } from '../news/serialize.js';
import { HOUR } from './types.js';

/**
 * Per-episode Spotify video thumbnails (16:9) replace the square RSS show cover on podcast cards. Looked up via
 * Spotify's public oEmbed, re-hosted in the MediaStore, a few episodes per podcast run (sequential, rate-limit
 * friendly), and remembered per item so the backfill of old episodes happens once.
 */
export const THUMBNAIL_BATCH = 15;
/** Audio-only episodes ("none") are re-checked this often while recent: the video often lands after the audio. */
export const THUMBNAIL_RECHECK_MS = HOUR;
export const THUMBNAIL_RECHECK_WINDOW_MS = 7 * 24 * HOUR;

export type ThumbnailStatus = 'found' | 'none' | 'error';

export interface ThumbnailRunResult {
  checked: number;
  found: number;
  none: number;
  failed: number;
  /** First failure, for the run summary (never recorded on the Spotify integration). */
  firstError: string | null;
}

function keySafe(dedupeKey: string): string {
  const raw = dedupeKey.slice(dedupeKey.indexOf(':') + 1);
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'item';
}

/** Due: never checked; "error" an hour later; "none" hourly while published within the last 7 days. */
async function dueItemIds(app: AppContext, now: Date): Promise<string[]> {
  const recheckBefore = new Date(now.getTime() - THUMBNAIL_RECHECK_MS);
  const recentAfter = new Date(now.getTime() - THUMBNAIL_RECHECK_WINDOW_MS);
  const rows = await app.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "NewsItem"
    WHERE "source" = 'podcast' AND ("links" ->> 'spotify') IS NOT NULL
      AND (
        "thumbnailStatus" IS NULL
        OR ("thumbnailStatus" = 'error' AND "thumbnailCheckedAt" <= ${recheckBefore})
        OR ("thumbnailStatus" = 'none' AND "thumbnailCheckedAt" <= ${recheckBefore}
            AND "publishedAt" >= ${recentAfter})
      )
    ORDER BY ("thumbnailStatus" IS NULL) DESC, "publishedAt" DESC, "id" DESC
    LIMIT ${THUMBNAIL_BATCH}`);
  return rows.map((r) => r.id);
}

async function mark(app: AppContext, id: string, status: ThumbnailStatus, now: Date): Promise<void> {
  await app.prisma.newsItem.updateMany({
    where: { id },
    data: { thumbnailStatus: status, thumbnailCheckedAt: now },
  });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One batch. Never throws for a single episode; a 429 stops the batch (the rest wait for the next run). */
export async function fillEpisodeThumbnails(app: AppContext, now: Date): Promise<ThumbnailRunResult> {
  const result: ThumbnailRunResult = { checked: 0, found: 0, none: 0, failed: 0, firstError: null };
  for (const id of await dueItemIds(app, now)) {
    const item = await app.prisma.newsItem.findUnique({ where: { id } });
    const spotifyUrl = item === null ? null : readLinks(item.links).spotify;
    if (item === null || spotifyUrl === null) continue;
    result.checked += 1;
    try {
      const thumb = await app.integrations.fetchSpotifyEpisodeThumbnail(spotifyUrl, app.integrationCtx);
      if (thumb === null) {
        await mark(app, id, 'none', now);
        result.none += 1;
        continue;
      }
      const file = await downloadMedia(app.fetch, thumb.url, 'image');
      const storageKey = `spotify/${keySafe(item.dedupeKey)}/thumbnail.${file.ext}`;
      const url = await app.media.put(storageKey, file.bytes, file.contentType);
      await app.prisma.$transaction([
        app.prisma.newsMedia.deleteMany({ where: { itemId: id } }),
        app.prisma.newsMedia.create({
          data: {
            itemId: id,
            order: 0,
            kind: 'image',
            url,
            posterUrl: null,
            width: thumb.width === null ? null : Math.round(thumb.width),
            height: thumb.height === null ? null : Math.round(thumb.height),
            sourceUrl: thumb.url,
            storageKey,
          },
        }),
        app.prisma.newsItem.update({
          where: { id },
          data: { thumbnailStatus: 'found', thumbnailCheckedAt: now },
        }),
      ]);
      result.found += 1;
    } catch (err) {
      result.failed += 1;
      result.firstError ??= `${item.title ?? item.dedupeKey}: ${errorText(err)}`;
      await mark(app, id, 'error', now);
      if (err instanceof IntegrationRateLimitError) break;
    }
  }
  return result;
}

export function thumbnailSummary(r: ThumbnailRunResult): string {
  if (r.checked === 0) return 'thumbnails: none due';
  const base = `thumbnails: ${r.found} found, ${r.none} none, ${r.failed} failed`;
  return r.firstError === null ? base : `${base} (${r.firstError})`;
}
