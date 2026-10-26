import type { MediaDraft, NewsItemDraft } from '@fant/integrations';
import type { NewsLinks } from '@fant/shared';
import { Prisma, type PrismaClient } from '@prisma/client';
import { downloadMedia } from '../media/download.js';
import type { MediaStore } from '../media/store.js';
import { readLinks, type NewsItemWithMedia } from './serialize.js';

export interface IngestDeps {
  prisma: PrismaClient;
  media: MediaStore;
  fetch: typeof fetch;
}

export interface IngestOptions {
  /** Copy every media file (and poster) into the MediaStore — required for Instagram (CDN URLs expire). */
  rehost: boolean;
}

export interface IngestResult {
  /** Items inserted by this run (never updates) — the ones that may trigger a push. */
  created: NewsItemWithMedia[];
  updated: number;
  unchanged: number;
  /** Items not saved this run (e.g. media failed to download); retried on the next poll. */
  failed: { dedupeKey: string; reason: string }[];
}

interface MediaRow {
  order: number;
  kind: 'image' | 'video';
  url: string;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  sourceUrl: string;
  storageKey: string | null;
  posterKey: string | null;
}

/** `instagram:17890` → `17890` (only key-safe characters). */
function externalIdOf(dedupeKey: string): string {
  const raw = dedupeKey.slice(dedupeKey.indexOf(':') + 1);
  return raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'item';
}

async function rehostMedia(deps: IngestDeps, draft: NewsItemDraft): Promise<MediaRow[]> {
  const base = `instagram/${externalIdOf(draft.dedupeKey)}`;
  const rows: MediaRow[] = [];
  for (const [n, m] of draft.media.entries()) {
    const file = await downloadMedia(deps.fetch, m.sourceUrl, m.kind);
    const storageKey = `${base}/${n}.${file.ext}`;
    const url = await deps.media.put(storageKey, file.bytes, file.contentType);
    let posterUrl: string | null = null;
    let posterKey: string | null = null;
    if (m.posterSourceUrl !== null) {
      const poster = await downloadMedia(deps.fetch, m.posterSourceUrl, 'image');
      posterKey = `${base}/${n}-poster.${poster.ext}`;
      posterUrl = await deps.media.put(posterKey, poster.bytes, poster.contentType);
    }
    rows.push({
      ...dims(m),
      order: n,
      kind: m.kind,
      url,
      posterUrl,
      sourceUrl: m.sourceUrl,
      storageKey,
      posterKey,
    });
  }
  return rows;
}

function dims(m: MediaDraft): { width: number | null; height: number | null } {
  return { width: m.width, height: m.height };
}

function directMedia(draft: NewsItemDraft): MediaRow[] {
  return draft.media.map((m, n) => ({
    ...dims(m),
    order: n,
    kind: m.kind,
    url: m.sourceUrl,
    posterUrl: m.posterSourceUrl,
    sourceUrl: m.sourceUrl,
    storageKey: null,
    posterKey: null,
  }));
}

/** A link found earlier (e.g. Apple, resolved later) is never wiped by a poll that didn't find it. */
function mergeLinks(existing: NewsLinks, incoming: NewsLinks): NewsLinks {
  return {
    spotify: incoming.spotify ?? existing.spotify,
    apple: incoming.apple ?? existing.apple,
    instagram: incoming.instagram ?? existing.instagram,
    x: incoming.x ?? existing.x,
    audio: incoming.audio ?? existing.audio,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameDate = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Upserts drafts by `dedupeKey`: new → insert (with media, re-hosted when asked), existing → update only
 * the fields that changed. Re-running with the same drafts is a no-op. A single item failing never
 * fails the batch.
 */
export async function ingestDrafts(
  deps: IngestDeps,
  drafts: readonly NewsItemDraft[],
  options: IngestOptions,
): Promise<IngestResult> {
  const { prisma } = deps;
  const result: IngestResult = { created: [], updated: 0, unchanged: 0, failed: [] };

  for (const draft of drafts) {
    try {
      const existing = await prisma.newsItem.findUnique({
        where: { dedupeKey: draft.dedupeKey },
        include: { media: { orderBy: { order: 'asc' } } },
      });

      if (existing === null) {
        const media = options.rehost ? await rehostMedia(deps, draft) : directMedia(draft);
        try {
          const created = await prisma.newsItem.create({
            data: {
              dedupeKey: draft.dedupeKey,
              source: draft.source,
              title: draft.title,
              text: draft.text,
              links: draft.links,
              podcast: draft.podcast ?? Prisma.DbNull,
              publishedAt: draft.publishedAt,
              expiresAt: draft.expiresAt,
              media: { create: media },
            },
            include: { media: { orderBy: { order: 'asc' } } },
          });
          result.created.push(created);
        } catch (err) {
          // Another instance inserted it between our read and write: that run owns the push.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            result.unchanged += 1;
            continue;
          }
          throw err;
        }
        continue;
      }

      const links = mergeLinks(readLinks(existing.links), draft.links);
      const data: Prisma.NewsItemUpdateInput = {};
      if (existing.title !== draft.title) data.title = draft.title;
      if (existing.text !== draft.text) data.text = draft.text;
      if (!sameJson(readLinks(existing.links), links)) data.links = links;
      if (!sameJson(existing.podcast, draft.podcast)) data.podcast = draft.podcast ?? Prisma.DbNull;
      if (!sameDate(existing.publishedAt, draft.publishedAt)) data.publishedAt = draft.publishedAt;
      if (!sameDate(existing.expiresAt, draft.expiresAt)) data.expiresAt = draft.expiresAt;

      let media: MediaRow[] | null = null;
      if (options.rehost) {
        // Re-hosted media never changes after publishing (CDN URLs rotate on every poll, so don't compare
        // them) — only retry when nothing was stored.
        if (existing.media.length === 0 && draft.media.length > 0) media = await rehostMedia(deps, draft);
      } else if (
        !sameJson(
          existing.media.map((m) => [m.kind, m.sourceUrl]),
          draft.media.map((m) => [m.kind, m.sourceUrl]),
        )
      ) {
        media = directMedia(draft);
      }

      if (Object.keys(data).length === 0 && media === null) {
        result.unchanged += 1;
        continue;
      }
      await prisma.$transaction(async (tx) => {
        if (media !== null) {
          await tx.newsMedia.deleteMany({ where: { itemId: existing.id } });
          await tx.newsMedia.createMany({ data: media.map((m) => ({ ...m, itemId: existing.id })) });
        }
        await tx.newsItem.update({ where: { id: existing.id }, data });
      });
      result.updated += 1;
    } catch (err) {
      result.failed.push({ dedupeKey: draft.dedupeKey, reason: errorText(err) });
    }
  }
  return result;
}
