import {
  NEWS_FILTER_SOURCES,
  NewsFilterSchema,
  NewsFiltersSchema,
  NewsItemIdSchema,
  NewsItemSchema,
  NewsPageQuerySchema,
  NewsPageSchema,
  StoriesSchema,
  type NewsFilter,
} from '@fant/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { toNewsItem } from '../news/serialize.js';
import { parseInput, serialize } from '../validate.js';
import { cleanQuery } from './query.js';

const CursorSchema = z.union([
  // [iso, id, filter | null] — the filter the cursor was issued for.
  z.tuple([z.string().datetime({ offset: true }), z.string().min(1).max(100), NewsFilterSchema.nullable()]),
  // [iso, id] — cursors issued before filters existed: the unfiltered feed.
  z.tuple([z.string().datetime({ offset: true }), z.string().min(1).max(100)]),
]);

/** Opaque keyset cursor on (publishedAt, id) for one filter: base64url(JSON [iso, id, filter | null]). */
export function encodeNewsCursor(publishedAt: Date, id: string, filter: NewsFilter | null = null): string {
  return Buffer.from(JSON.stringify([publishedAt.toISOString(), id, filter])).toString('base64url');
}

export function decodeNewsCursor(cursor: string): {
  publishedAt: Date;
  id: string;
  filter: NewsFilter | null;
} {
  try {
    const [iso, id, filter] = CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    return { publishedAt: new Date(iso), id, filter: filter ?? null };
  } catch {
    throw badRequest('cursor: invalid or expired cursor');
  }
}

/** Sources covered by some filter (the feed shows these; stories live in the profile header). */
const FILTERED_SOURCES = [...new Set(Object.values(NEWS_FILTER_SOURCES).flat())];
export const NEWS_FILTERS_CACHE_CONTROL = 'public, max-age=60';

const ParamsSchema = z.object({ id: NewsItemIdSchema });

export function newsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;

  app.get('/v1/news', async (request) => {
    const query = parseInput(NewsPageQuerySchema, cleanQuery(request.query));
    const filter = query.filter ?? null;
    // hiddenAt: null also excludes suppressed dedupe placeholders (they are always hidden).
    // Filtered queries use the (hiddenAt, source, publishedAt DESC) index.
    const where: Prisma.NewsItemWhereInput = {
      hiddenAt: null,
      source: filter === null ? { not: 'instagram_story' } : { in: [...NEWS_FILTER_SOURCES[filter]] },
    };
    if (query.cursor !== undefined) {
      const c = decodeNewsCursor(query.cursor);
      if (c.filter !== filter) {
        throw badRequest(
          `cursor: this cursor belongs to ${c.filter === null ? 'the unfiltered feed' : `filter "${c.filter}"`} — start again without it`,
        );
      }
      where.OR = [{ publishedAt: { lt: c.publishedAt } }, { publishedAt: c.publishedAt, id: { lt: c.id } }];
    }
    const rows = await prisma.newsItem.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: { media: { orderBy: { order: 'asc' } } },
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return serialize(NewsPageSchema, {
      items: page.map((row) => toNewsItem(row, ctx.mediaUrl)),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeNewsCursor(last.publishedAt, last.id, filter)
          : null,
    });
  });

  // The filter chips that have something to show, in display order: one grouped query over visible items.
  app.get('/v1/news/filters', async (_request, reply) => {
    const groups = await prisma.newsItem.groupBy({
      by: ['source'],
      where: { hiddenAt: null, source: { in: FILTERED_SOURCES } },
    });
    const present = new Set(groups.map((g) => g.source));
    reply.header('cache-control', NEWS_FILTERS_CACHE_CONTROL);
    return serialize(NewsFiltersSchema, {
      filters: NewsFilterSchema.options.filter((f) => NEWS_FILTER_SOURCES[f].some((s) => present.has(s))),
    });
  });

  app.get('/v1/news/stories', async () => {
    const rows = await prisma.newsItem.findMany({
      where: { source: 'instagram_story', hiddenAt: null, expiresAt: { gt: ctx.clock.now() } },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
      include: { media: { orderBy: { order: 'asc' } } },
    });
    return serialize(StoriesSchema, { items: rows.map((row) => toNewsItem(row, ctx.mediaUrl)) });
  });

  app.get('/v1/news/:id', async (request) => {
    const { id } = parseInput(ParamsSchema, request.params);
    const row = await prisma.newsItem.findUnique({
      where: { id },
      include: { media: { orderBy: { order: 'asc' } } },
    });
    if (row === null || row.hiddenAt !== null) throw notFound('This news item does not exist');
    return serialize(NewsItemSchema, toNewsItem(row, ctx.mediaUrl));
  });
}
