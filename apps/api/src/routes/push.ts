import {
  AdminPushHealthSchema,
  DeleteWebPushSubscriptionBodySchema,
  PushServiceSchema,
  PushTestResultSchema,
  type PushService,
  NativePushDeviceBodySchema,
  NotificationPrefsSchema,
  VapidKeySchema,
  WebPushSubscriptionBodySchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AppContext } from '../context.js';
import { ApiHttpError } from '../errors.js';
import { PUSH_ICON } from '../news/pushNews.js';
import { testPushCopy } from '../push/copy.js';
import { notify } from '../push/notify.js';
import { pushServiceOf } from '../push/stats.js';
import { parseInput, serialize } from '../validate.js';

export function pushRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  auth: Auth,
  writeLimit: object,
  testLimit: object,
): void {
  const { prisma } = ctx;

  // A test notification to the caller's OWN devices only (same provider path as every other push).
  app.post('/v1/push/test', { config: { rateLimit: testLimit } }, async (request) => {
    const { user } = await auth.requireUser(request);
    if (ctx.push === null) {
      throw new ApiHttpError(503, 'upstream_unavailable', 'Push notifications are not configured');
    }
    const result = await notify(ctx, {
      kind: 'test',
      to: [user.id],
      pref: null,
      options: { ttlSec: 10 * 60, urgency: 'high' },
      build: ({ locale }) => ({
        ...testPushCopy(locale),
        url: '/profile/',
        tag: 'push-test',
        icon: PUSH_ICON,
        image: null,
      }),
    });
    return serialize(PushTestResultSchema, {
      devices: result.devices,
      delivered: result.devicesDelivered,
      gone: result.gone,
      failed: result.failed,
    });
  });

  // Counts only: no endpoint, key or user id leaves the server.
  void app.register(async (admin) => {
    admin.addHook('onRequest', async (request) => {
      await auth.requireAdmin(request);
    });
    admin.get('/v1/admin/push/health', async () => {
      const [users, subs] = await Promise.all([
        prisma.user.count({ where: { pushSubscriptions: { some: {} } } }),
        prisma.pushSubscription.findMany({ select: { endpoint: true } }),
      ]);
      const counts = new Map<PushService, number>();
      for (const s of subs)
        counts.set(pushServiceOf(s.endpoint), (counts.get(pushServiceOf(s.endpoint)) ?? 0) + 1);
      return serialize(AdminPushHealthSchema, {
        users,
        devices: PushServiceSchema.options
          .filter((service) => (counts.get(service) ?? 0) > 0)
          .map((service) => ({ service, count: counts.get(service) ?? 0 })),
        recent: ctx.pushStats.recent(),
      });
    });
  });

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
