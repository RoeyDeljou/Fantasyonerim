import {
  DeleteWebPushSubscriptionBodySchema,
  NativePushDeviceBodySchema,
  NotificationPrefsSchema,
  VapidKeySchema,
  WebPushSubscriptionBodySchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { ApiHttpError } from '../errors.js';
import { parseInput, serialize } from '../validate.js';

export function pushRoutes(app: FastifyInstance, ctx: AppContext, auth: Auth, writeLimit: object): void {
  const { prisma } = ctx;

  app.get('/v1/push/vapid-public-key', async () => {
    const key = ctx.config.vapidPublicKey;
    if (!key) throw new ApiHttpError(503, 'upstream_unavailable', 'Push notifications are not configured');
    return serialize(VapidKeySchema, { publicKey: key });
  });

  app.post('/v1/push/subscriptions', { config: { rateLimit: writeLimit } }, async (request, reply) => {
    const { user } = await auth.requireUser(request);
    const body = parseInput(WebPushSubscriptionBodySchema, request.body);
    // Upsert by endpoint: a browser re-subscribing (or another account on the same device) re-binds it.
    await prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      update: { userId: user.id, p256dh: body.keys.p256dh, auth: body.keys.auth, failureCount: 0 },
      create: { endpoint: body.endpoint, userId: user.id, p256dh: body.keys.p256dh, auth: body.keys.auth },
    });
    return reply.code(204).send();
  });

  app.delete('/v1/push/subscriptions', { config: { rateLimit: writeLimit } }, async (request, reply) => {
    const { user } = await auth.requireUser(request);
    const body = parseInput(DeleteWebPushSubscriptionBodySchema, request.body);
    await prisma.pushSubscription.deleteMany({ where: { endpoint: body.endpoint, userId: user.id } });
    return reply.code(204).send();
  });

  app.post('/v1/push/devices', { config: { rateLimit: writeLimit } }, async (request, reply) => {
    const { user } = await auth.requireUser(request);
    const body = parseInput(NativePushDeviceBodySchema, request.body);
    await prisma.nativePushDevice.upsert({
      where: { token: body.token },
      update: { userId: user.id, platform: body.platform },
      create: { token: body.token, userId: user.id, platform: body.platform },
    });
    return reply.code(204).send();
  });

  app.get('/v1/me/notification-prefs', async (request) => {
    const { user } = await auth.requireUser(request);
    const prefs = await prisma.notificationPrefs.findUnique({ where: { userId: user.id } });
    return serialize(NotificationPrefsSchema, {
      news: prefs?.news ?? true,
      fpl: prefs?.fpl ?? true,
      live: prefs?.live ?? true,
      community: prefs?.community ?? true,
    });
  });

  app.put('/v1/me/notification-prefs', { config: { rateLimit: writeLimit } }, async (request) => {
    const { user } = await auth.requireUser(request);
    const body = parseInput(NotificationPrefsSchema, request.body);
    const saved = await prisma.notificationPrefs.upsert({
      where: { userId: user.id },
      update: body,
      create: { userId: user.id, ...body },
    });
    return serialize(NotificationPrefsSchema, {
      news: saved.news,
      fpl: saved.fpl,
      live: saved.live,
      community: saved.community,
    });
  });
}
