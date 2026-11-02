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
import { HOT_POLICY } from '../perf/hotData.js';
import { CACHE_CONTROL, sendHot } from '../perf/http.js';
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
/** Media in display order, only the columns the serializer reads. */
const NEWS_MEDIA_INCLUDE = {
  media: {
    orderBy: { order: 'asc' },
    select: { order: true, kind: true, url: true, posterUrl: true, width: true, height: true },
  },
} as const satisfies Prisma.NewsItemInclude;

export function newsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;

  app.get('/v1/news', async (request, reply) => {
    const query = parseInput(NewsPageQuerySchema, cleanQuery(request.query));
    const filter = query.filter ?? null;
    // Validated before the cache lookup: a bad cursor is a 400, never a cached body.
    const cursor = query.cursor === undefined ? null : decodeNewsCursor(query.cursor);
    if (cursor !== null && cursor.filter !== filter) {
      throw badRequest(
        `cursor: this cursor belongs to ${cursor.filter === null ? 'the unfiltered feed' : `filter "${cursor.filter}"`} — start again without it`,
      );
    }
    const key = `news:page:${filter ?? 'all'}:${query.limit}:${query.cursor ?? ''}`;
    const { body } = await ctx.hot.cache.get(key, HOT_POLICY.news, async () => {
      // hiddenAt: null also excludes suppressed dedupe placeholders (they are always hidden).
      // Filtered queries use the (hiddenAt, source, publishedAt DESC) index.
      const where: Prisma.NewsItemWhereInput = {
        hiddenAt: null,
        source: filter === null ? { not: 'instagram_story' } : { in: [...NEWS_FILTER_SOURCES[filter]] },
      };
      if (cursor !== null) {
        where.OR = [
          { publishedAt: { lt: cursor.publishedAt } },
          { publishedAt: cursor.publishedAt, id: { lt: cursor.id } },
        ];
      }
      const rows = await prisma.newsItem.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: NEWS_MEDIA_INCLUDE,
      });
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      return {
        build: () =>
          serialize(NewsPageSchema, {
            items: page.map((row) => toNewsItem(row, ctx.mediaUrl)),
            nextCursor:
              rows.length > query.limit && last !== undefined
                ? encodeNewsCursor(last.publishedAt, last.id, filter)
                : null,
          }),
      };
    });
    return sendHot(request, reply, body, CACHE_CONTROL.news);
  });

  // The filter chips that have something to show, in display order: one grouped query over visible items.
  app.get('/v1/news/filters', async (request, reply) => {
    const { body } = await ctx.hot.cache.get('news:filters', HOT_POLICY.news, async () => {
      const groups = await prisma.newsItem.groupBy({
        by: ['source'],
        where: { hiddenAt: null, source: { in: FILTERED_SOURCES } },
      });
      const present = new Set(groups.map((g) => g.source));
      return {
        build: () =>
          serialize(NewsFiltersSchema, {
            filters: NewsFilterSchema.options.filter((f) =>
              NEWS_FILTER_SOURCES[f].some((s) => present.has(s)),
            ),
          }),
      };
    });
    return sendHot(request, reply, body, NEWS_FILTERS_CACHE_CONTROL);
  });

  app.get('/v1/news/stories', async (request, reply) => {
    const { body } = await ctx.hot.cache.get('news:stories', HOT_POLICY.news, async () => {
      const rows = await prisma.newsItem.findMany({
        where: { source: 'instagram_story', hiddenAt: null, expiresAt: { gt: ctx.clock.now() } },
        orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
        include: NEWS_MEDIA_INCLUDE,
      });
      return {
        build: () => serialize(StoriesSchema, { items: rows.map((row) => toNewsItem(row, ctx.mediaUrl)) }),
      };
    });
    return sendHot(request, reply, body, CACHE_CONTROL.news);
  });

  app.get('/v1/news/:id', async (request, reply) => {
    const { id } = parseInput(ParamsSchema, request.params);
    const { body } = await ctx.hot.cache.get(`news:item:${id}`, HOT_POLICY.news, async () => {
      const row = await prisma.newsItem.findUnique({ where: { id }, include: NEWS_MEDIA_INCLUDE });
      if (row === null || row.hiddenAt !== null) throw notFound('This news item does not exist');
      return { build: () => serialize(NewsItemSchema, toNewsItem(row, ctx.mediaUrl)) };
    });
    return sendHot(request, reply, body, CACHE_CONTROL.news);
  });
}
