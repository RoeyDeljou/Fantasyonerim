import {
  AdminNewsBodySchema,
  AdminPushBodySchema,
  AdminPushResultSchema,
  HiddenNewsListSchema,
  NewsItemIdSchema,
  NewsItemSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { pushNewNewsItems, PUSH_ICON } from '../news/pushNews.js';
import { createAdminUpdate } from '../news/adminUpdate.js';
import { toNewsItem } from '../news/serialize.js';
import { notify } from '../push/notify.js';
import { parseInput, serialize } from '../validate.js';

const ParamsSchema = z.object({ id: NewsItemIdSchema });
export const HIDDEN_NEWS_LIMIT = 200;

/** Manual fallback news + manual push. Every route re-checks the ADMIN role first. */
export function adminNewsRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  const { prisma } = ctx;

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.post('/v1/admin/news', async (request, reply) => {
      const body = parseInput(AdminNewsBodySchema, request.body);
      const created = await createAdminUpdate(ctx, {
        title: body.title,
        text: body.text,
        links: body.links,
      });
      try {
        await pushNewNewsItems(ctx, [created]);
      } catch (err) {
        request.log.error({ err }, 'admin news push failed');
      }
      return reply.code(201).send(serialize(NewsItemSchema, toNewsItem(created, ctx.mediaUrl)));
    });

    admin.delete('/v1/admin/news/:id', async (request, reply) => {
      const { id } = parseInput(ParamsSchema, request.params);
      const result = await prisma.newsItem.updateMany({
        where: { id, hiddenAt: null },
        data: { hiddenAt: ctx.clock.now() },
      });
      if (result.count === 0 && (await prisma.newsItem.count({ where: { id } })) === 0) {
        throw notFound('This news item does not exist');
      }
      return reply.code(204).send();
    });

    // Hidden items, newest-hidden first. Expired stories (hidden by the cleanup job) can't come back.
    admin.get('/v1/admin/news/hidden', async () => {
      const now = ctx.clock.now();
      const rows = await prisma.newsItem.findMany({
        where: {
          hiddenAt: { not: null },
          // Dedupe placeholders (our own X post from a broadcast) are not real hidden items.
          suppressed: false,
          NOT: { source: 'instagram_story', expiresAt: { lte: now } },
        },
        orderBy: [{ hiddenAt: 'desc' }, { id: 'desc' }],
        take: HIDDEN_NEWS_LIMIT,
        include: { media: { orderBy: { order: 'asc' } } },
      });
      return serialize(HiddenNewsListSchema, {
        items: rows.flatMap((row) =>
          row.hiddenAt === null
            ? []
            : [{ item: toNewsItem(row, ctx.mediaUrl), hiddenAt: row.hiddenAt.toISOString() }],
        ),
      });
    });

    // Un-hide (idempotent). Not re-pushed: it was announced when it first arrived. Dedupe placeholders: 400.
    admin.post('/v1/admin/news/:id/restore', async (request, reply) => {
      const { id } = parseInput(ParamsSchema, request.params);
      const result = await prisma.newsItem.updateMany({
        where: { id, suppressed: false },
        data: { hiddenAt: null },
      });
      if (result.count === 0) {
        if ((await prisma.newsItem.count({ where: { id } })) > 0) {
          throw badRequest("This item can't be restored");
        }
        throw notFound('This news item does not exist');
      }
      return reply.code(204).send();
    });

    admin.post('/v1/admin/push', async (request) => {
      const body = parseInput(AdminPushBodySchema, request.body);
      // Explicit broadcast by an admin: every subscribed user, no preference filter, not deduped.
      const result = await notify(ctx, {
        to: 'all',
        pref: null,
        options: { ttlSec: 24 * 3600, urgency: 'high' },
        build: () => ({
          title: body.title,
          body: body.body,
          url: body.url,
          tag: null,
          icon: PUSH_ICON,
          image: null,
        }),
      });
      return serialize(AdminPushResultSchema, result);
    });
  });
}
