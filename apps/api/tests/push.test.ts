import { BootstrapSchema, NewsItemSchema, NewsPageSchema, NotificationPrefsSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatOffset } from '../src/push/copy.js';
import { FakePushProvider, fakeIntegrations, subscribe } from './fakes.js';
import { makeBootstrap, makePicks, type FakeFplService } from './fakeFpl.js';
import type { TestClock } from './helpers.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
} from './helpers.js';

const prisma = createTestPrisma();
const MIN = 60_000;
const HOUR = 60 * MIN;
const VAPID = 'BARW9HWQIO3yvIxl8aHJdD2VxTpVSCtUsgyoQFb35AeAH';

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  push = new FakePushProvider();
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    push,
    integrations: fakeIntegrations().factories,
    config: { vapidPublicKey: VAPID },
  }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

function gw(
  id: number,
  deadline: Date,
  flags: { finished?: boolean; dataChecked?: boolean; isCurrent?: boolean } = {},
) {
  return {
    id,
    name: `Gameweek ${id}`,
    deadlineTime: deadline.toISOString(),
    finished: flags.finished ?? false,
    dataChecked: flags.dataChecked ?? false,
    isCurrent: flags.isCurrent ?? false,
    isNext: false,
    averageScore: null,
    highestScore: null,
  };
}

function setEvents(events: ReturnType<typeof gw>[]) {
  fpl.bootstrap = BootstrapSchema.parse({ ...makeBootstrap(), events });
}

describe('push subscriptions, devices and prefs', () => {
  it('serves the VAPID public key, or 503 when push is not configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/push/vapid-public-key' });
    expect(res.json()).toEqual({ publicKey: VAPID });
    const { app: bare } = await buildTestApp(prisma);
    expect((await bare.inject({ method: 'GET', url: '/v1/push/vapid-public-key' })).statusCode).toBe(503);
    await bare.close();
  });

  it('requires sign-in and validates bodies', async () => {
    const payload = {
      endpoint: 'https://push.test/1',
      keys: { p256dh: 'p256dh-key-0123456789', auth: 'auth-1234' },
    };
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscriptions', payload })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'DELETE', url: '/v1/push/subscriptions', payload })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'POST', url: '/v1/push/devices', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me/notification-prefs' })).statusCode).toBe(401);
    const { token } = await registerUser(app, fpl, 7);
    const h = bearer(token);
    for (const bad of [
      {},
      { endpoint: 'not-a-url', keys: payload.keys },
      { endpoint: payload.endpoint, keys: { p256dh: 'x', auth: 'y' } },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/push/subscriptions',
        headers: h,
        payload: bad,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/push/subscriptions',
          headers: h,
          payload: { endpoint: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/push/devices',
          headers: h,
          payload: { platform: 'wp', token: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/me/notification-prefs',
          headers: h,
          payload: { news: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('upserts by endpoint (re-binding it to the current user) and unsubscribes', async () => {
    const a = await registerUser(app, fpl, 1);
    const b = await registerUser(app, fpl, 2);
    await subscribe(app, a.token, 'https://push.test/shared');
    await subscribe(app, a.token, 'https://push.test/shared');
    expect(await prisma.pushSubscription.count()).toBe(1);
    await subscribe(app, b.token, 'https://push.test/shared');
    const rows = await prisma.pushSubscription.findMany();
    expect(rows.map((r) => r.userId)).toEqual([b.user.id]);
    // A can't delete B's subscription.
    await app.inject({
      method: 'DELETE',
      url: '/v1/push/subscriptions',
      headers: bearer(a.token),
      payload: { endpoint: 'https://push.test/shared' },
    });
    expect(await prisma.pushSubscription.count()).toBe(1);
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/push/subscriptions',
      headers: bearer(b.token),
      payload: { endpoint: 'https://push.test/shared' },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.pushSubscription.count()).toBe(0);
  });

  it('stores native push devices (no sender yet)', async () => {
    const { token, user } = await registerUser(app, fpl, 3);
    const payload = { platform: 'fcm', token: 'fcm-token-1234567890' };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/push/devices', headers: bearer(token), payload }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/push/devices', headers: bearer(token), payload }))
        .statusCode,
    ).toBe(204);
    expect(await prisma.nativePushDevice.findMany({ select: { userId: true, platform: true } })).toEqual([
      { userId: user.id, platform: 'fcm' },
    ]);
  });

  it('notification prefs default to all on and can be changed', async () => {
    const { token } = await registerUser(app, fpl, 4);
    const get = await app.inject({ method: 'GET', url: '/v1/me/notification-prefs', headers: bearer(token) });
    expect(NotificationPrefsSchema.parse(get.json())).toEqual({
      news: true,
      fpl: true,
      live: true,
      community: true,
    });
    const prefs = { news: false, fpl: true, live: false, community: true };
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(token),
      payload: prefs,
    });
    expect(put.json()).toEqual(prefs);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/me/notification-prefs', headers: bearer(token) })).json(),
    ).toEqual(prefs);
  });

  it('rate-limits subscription writes', async () => {
    const { app: limited } = await buildTestApp(prisma, { push, fpl, rateLimit: { writeMax: 2 } });
    const { token } = await registerUser(limited, fpl, 9);
    const send = () =>
      limited.inject({
        method: 'POST',
        url: '/v1/push/devices',
        headers: bearer(token),
        payload: { platform: 'apns', token: 'apns-token-123456' },
      });
    expect((await send()).statusCode).toBe(204);
    expect((await send()).statusCode).toBe(204);
    expect((await send()).statusCode).toBe(429);
    await limited.close();
  });
});

describe('admin news + manual push', () => {
  it('admin news posts as admin_update, pushes to users with the news pref, and can be hidden', async () => {
    const admin = await adminToken(app, prisma);
    const on = await registerUser(app, fpl, 11);
    const off = await registerUser(app, fpl, 12);
    const en = await registerUser(app, fpl, 13);
    await prisma.user.update({ where: { id: en.user.id }, data: { locale: 'en' } });
    await subscribe(app, on.token, 'https://push.test/on');
    await subscribe(app, off.token, 'https://push.test/off');
    await subscribe(app, en.token, 'https://push.test/en');
    await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(off.token),
      payload: { news: false, fpl: true, live: true, community: true },
    });

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/admin/news',
      headers: bearer(admin),
      payload: { title: null, text: '' },
    });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/news',
      headers: bearer(admin),
      payload: {
        title: 'שידור חי הערב',
        text: 'ב-21:00 ביוטיוב',
        links: { x: 'https://x.com/fantasyonerim' },
      },
    });
    expect(res.statusCode).toBe(201);
    const item = NewsItemSchema.parse(res.json());
    expect(item).toMatchObject({
      source: 'admin_update',
      title: 'שידור חי הערב',
      links: { x: 'https://x.com/fantasyonerim', apple: null },
    });
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual(['https://push.test/en', 'https://push.test/on']);
    expect(push.sent.every((s) => s.payload.url === `/news/?item=${item.id}`)).toBe(true);

    const hide = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/news/${item.id}`,
      headers: bearer(admin),
    });
    expect(hide.statusCode).toBe(204);
    const feed = NewsPageSchema.parse((await app.inject({ method: 'GET', url: '/v1/news' })).json());
    expect(feed.items).toHaveLength(0);
    expect(await prisma.newsItem.count()).toBe(1); // kept for dedupe
    expect(
      (await app.inject({ method: 'DELETE', url: '/v1/admin/news/unknown', headers: bearer(admin) }))
        .statusCode,
    ).toBe(404);
  });

  it('manual push goes to every subscribed user; gone (410) subscriptions are deleted', async () => {
    const admin = await adminToken(app, prisma);
    const a = await registerUser(app, fpl, 21);
    const b = await registerUser(app, fpl, 22);
    await subscribe(app, a.token, 'https://push.test/a');
    await subscribe(app, b.token, 'https://push.test/b-gone');
    push.results.set('https://push.test/b-gone', 'gone');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/push',
          headers: bearer(admin),
          payload: { title: '', body: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/push',
          headers: bearer(admin),
          payload: { title: 't', body: 'b', url: 'https://evil.test' },
        })
      ).statusCode,
    ).toBe(400);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/push',
      headers: bearer(admin),
      payload: { title: 'גול!', body: 'סלאח כובש' },
    });
    expect(res.json()).toEqual({ recipients: 2, delivered: 1 });
    expect(push.sent[0]?.payload).toMatchObject({ title: 'גול!', body: 'סלאח כובש', url: '/news/' });
    expect((await prisma.pushSubscription.findMany()).map((s) => s.endpoint)).toEqual([
      'https://push.test/a',
    ]);
  });

  it('other push errors count failures and delete the subscription after 5', async () => {
    const admin = await adminToken(app, prisma);
    const a = await registerUser(app, fpl, 31);
    await subscribe(app, a.token, 'https://push.test/flaky');
    push.results.set('https://push.test/flaky', 'error');
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/admin/push',
        headers: bearer(admin),
        payload: { title: 't', body: 'b' },
      });
    }
    expect((await prisma.pushSubscription.findFirstOrThrow()).failureCount).toBe(4);
    await app.inject({
      method: 'POST',
      url: '/v1/admin/push',
      headers: bearer(admin),
      payload: { title: 't', body: 'b' },
    });
    expect(await prisma.pushSubscription.count()).toBe(0);
  });
});

describe('deadline reminders', () => {
  it('sends each offset once, localized, and never after the deadline', async () => {
    const deadline = new Date(clock.now().getTime() + 2 * HOUR - 4 * MIN);
    setEvents([
      gw(9, new Date(clock.now().getTime() - 3 * 24 * HOUR), { isCurrent: true }),
      gw(10, deadline),
    ]);
    const he = await registerUser(app, fpl, 41);
    const en = await registerUser(app, fpl, 42);
    const off = await registerUser(app, fpl, 43);
    await prisma.user.update({ where: { id: en.user.id }, data: { locale: 'en' } });
    for (const u of [he, en, off]) await subscribe(app, u.token, `https://push.test/${u.user.id}`);
    await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(off.token),
      payload: { news: true, fpl: false, live: true, community: true },
    });

    await app.jobs.run('deadline_reminders', { force: true });
    expect(push.sent).toHaveLength(2);
    const byEndpoint = new Map(push.sent.map((s) => [s.endpoint, s]));
    expect(byEndpoint.get(`https://push.test/${he.user.id}`)?.payload).toMatchObject({
      title: '⏰ הדדליין של מחזור 10 בעוד שעתיים!',
      url: '/my-team/',
      tag: 'deadline-10',
    });
    expect(byEndpoint.get(`https://push.test/${en.user.id}`)?.payload.title).toBe(
      '⏰ Gameweek 10 deadline in 2 hours!',
    );
    expect(push.sent[0]?.options).toMatchObject({ urgency: 'high', ttlSec: 3600 });

    await app.jobs.run('deadline_reminders', { force: true });
    clock.advance(30 * MIN);
    await app.jobs.run('deadline_reminders', { force: true });
    expect(push.sent).toHaveLength(2);
    clock.advance(2 * HOUR);
    await app.jobs.run('deadline_reminders', { force: true });
    expect(push.sent).toHaveLength(2);
  });

  it('drops a reminder that is more than 30 minutes late (sleeping host)', async () => {
    const u = await registerUser(app, fpl, 44);
    await subscribe(app, u.token, 'https://push.test/late');
    // 24 h reminder was due 40 min ago; the 2 h one is not due yet.
    setEvents([gw(10, new Date(clock.now().getTime() + 24 * HOUR - 40 * MIN))]);
    await app.jobs.run('deadline_reminders', { force: true });
    expect(push.sent).toHaveLength(0);
    // 24 h reminder due 20 min ago → still sent.
    setEvents([gw(11, new Date(clock.now().getTime() + 24 * HOUR - 20 * MIN))]);
    await app.jobs.run('deadline_reminders', { force: true });
    expect(push.sent.map((s) => s.payload.title)).toEqual(['⏰ הדדליין של מחזור 11 בעוד יום!']);
  });

  it('formats offsets in both languages', () => {
    expect([1440, 2880, 120, 60, 180, 30].map((m) => formatOffset('he', m))).toEqual([
      'יום',
      'יומיים',
      'שעתיים',
      'שעה',
      '3 שעות',
      '30 דקות',
    ]);
    expect([1440, 120, 60, 1].map((m) => formatOffset('en', m))).toEqual([
      '1 day',
      '2 hours',
      '1 hour',
      '1 minute',
    ]);
  });
});

describe('gameweek summary', () => {
  it('pushes each user their GW points + rank once, respecting the fpl pref', async () => {
    setEvents([
      gw(9, new Date(clock.now().getTime() - 5 * 24 * HOUR), {
        isCurrent: true,
        finished: true,
        dataChecked: true,
      }),
      gw(10, new Date(clock.now().getTime() + 2 * 24 * HOUR)),
    ]);
    const a = await registerUser(app, fpl, 51);
    const off = await registerUser(app, fpl, 52);
    await registerUser(app, fpl, 53); // no subscription
    await subscribe(app, a.token, 'https://push.test/a');
    await subscribe(app, off.token, 'https://push.test/off');
    await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(off.token),
      payload: { news: true, fpl: false, live: true, community: true },
    });
    fpl.picks.set('51:9', { ...makePicks(51, 9, 1), points: 70, transfersCost: 8, overallRank: 120345 });

    await app.jobs.run('gameweek_summary', { force: true });
    await app.jobs.run('gameweek_summary', { force: true });
    expect(push.sent.map((s) => s.payload.title)).toEqual(["מחזור 9 הסתיים: 62 נק' · דירוג 120,345"]);
    expect(fpl.calls.filter((c) => c.startsWith('getEntryPicks'))).toEqual(['getEntryPicks:51:9']);
  });

  it('does nothing while the current gameweek is not finished + data checked', async () => {
    setEvents([
      gw(9, new Date(clock.now().getTime() - HOUR), { isCurrent: true, finished: true, dataChecked: false }),
    ]);
    const a = await registerUser(app, fpl, 61);
    await subscribe(app, a.token, 'https://push.test/a');
    await app.jobs.run('gameweek_summary', { force: true });
    expect(push.sent).toHaveLength(0);
  });
});
