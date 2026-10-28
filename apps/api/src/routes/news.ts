import {
  NewsItemIdSchema,
  NewsItemSchema,
  NewsPageQuerySchema,
  NewsPageSchema,
  StoriesSchema,
} from '@fant/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { toNewsItem } from '../news/serialize.js';
import { parseInput, serialize } from '../validate.js';
import { cleanQuery } from './query.js';

const CursorSchema = z.tuple([z.string().datetime({ offset: true }), z.string().min(1).max(100)]);

/** Opaque keyset cursor on (publishedAt, id): base64url(JSON [iso, id]). */
export function encodeNewsCursor(publishedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([publishedAt.toISOString(), id])).toString('base64url');
}

export function decodeNewsCursor(cursor: string): { publishedAt: Date; id: string } {
  try {
    const [iso, id] = CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { publishedAt: new Date(iso), id };
  } catch {
    throw badRequest('cursor: invalid or expired cursor');
  }
}

const ParamsSchema = z.object({ id: NewsItemIdSchema });

export function newsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;

  app.get('/v1/news', async (request) => {
    const query = parseInput(NewsPageQuerySchema, cleanQuery(request.query));
    const where: Prisma.NewsItemWhereInput = { hiddenAt: null, source: { not: 'instagram_story' } };
    if (query.cursor !== undefined) {
      const c = decodeNewsCursor(query.cursor);
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
        rows.length > query.limit && last !== undefined ? encodeNewsCursor(last.publishedAt, last.id) : null,
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
