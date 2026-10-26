import { randomUUID } from 'node:crypto';
import {
  AdminNewsBodySchema,
  AdminPushBodySchema,
  AdminPushResultSchema,
  NewsItemIdSchema,
  NewsItemSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { pushNewNewsItems, PUSH_ICON } from '../news/pushNews.js';
import { EMPTY_LINKS, toNewsItem } from '../news/serialize.js';
import { notify } from '../push/notify.js';
import { parseInput, serialize } from '../validate.js';

const ParamsSchema = z.object({ id: NewsItemIdSchema });

/** Manual fallback news + manual push. Every route re-checks the ADMIN role first. */
export function adminNewsRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth): void {
  const { prisma } = ctx;

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });

    admin.post('/v1/admin/news', async (request, reply) => {
      const body = parseInput(AdminNewsBodySchema, request.body);
      const now = ctx.clock.now();
      const created = await prisma.newsItem.create({
        data: {
          dedupeKey: `admin_update:${randomUUID()}`,
          source: 'admin_update',
          title: body.title,
          text: body.text,
          links: { ...EMPTY_LINKS, ...body.links },
          publishedAt: now,
        },
        include: { media: true },
      });
      try {
        await pushNewNewsItems(ctx, [created]);
      } catch (err) {
        request.log.error({ err }, 'admin news push failed');
      }
      return reply.code(201).send(serialize(NewsItemSchema, toNewsItem(created)));
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

    admin.post('/v1/admin/push', async (request) => {
      const body = parseInput(AdminPushBodySchema, request.body);
      // Explicit broadcast by an admin: every subscribed user, no preference filter, not deduped.
      const result = await notify(ctx, {
        to: 'all',
        pref: null,
        options: { ttlSec: 24 * 3600, urgency: 'high' },
        build: () => ({ title: body.title, body: body.body, url: body.url, tag: null, icon: PUSH_ICON, image: null }),
      });
      return serialize(AdminPushResultSchema, result);
    });
  });
}
