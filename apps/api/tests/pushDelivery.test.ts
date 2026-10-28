import { AdminPushHealthSchema, PushTestResultSchema, type PushPayload } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NEWS_PUSH_TTL_SEC } from '../src/news/pushNews.js';
import { fitPayload, MAX_PUSH_PAYLOAD_BYTES } from '../src/push/notify.js';
import { pushServiceOf, RECENT_PUSH_BATCHES } from '../src/push/stats.js';
import { episode, fakeIntegrations, FakePushProvider, result, subscribe } from './fakes.js';
import type { FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  type TestAppOptions,
  type TestClock,
} from './helpers.js';

const prisma = createTestPrisma();
const APPLE = (n: number) => `https://web.push.apple.com/QGkSecretToken${n}AbCdEf`;
const GOOGLE = (n: number) => `https://fcm.googleapis.com/fcm/send/secret-google-${n}`;
const KEYS = { p256dh: 'p256dh-key-0123456789', auth: 'auth-1234' };

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;
let fakes: ReturnType<typeof fakeIntegrations>;
let logs: string[];

async function boot(options: TestAppOptions = {}) {
  push = new FakePushProvider();
  fakes = fakeIntegrations();
  logs = [];
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    push,
    integrations: fakes.factories,
    config: { vapidPublicKey: 'BKEY' },
    logger: { level: 'info', stream: { write: (l: string) => void logs.push(l) } },
    ...options,
  }));
}

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  await boot();
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const test = (token: string | null) =>
  app.inject({ method: 'POST', url: '/v1/push/test', ...(token === null ? {} : { headers: bearer(token) }) });

const batchLines = () =>
  logs
    .map((l) => JSON.parse(l) as { msg?: string; push?: Record<string, unknown> })
    .filter((l) => l.msg === 'push batch');

describe('push service detection', () => {
  it('derives the service from the endpoint host', () => {
    expect(pushServiceOf(APPLE(1))).toBe('apple');
    expect(pushServiceOf(GOOGLE(1))).toBe('google');
    expect(pushServiceOf('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe('mozilla');
    expect(pushServiceOf('https://wns2-db5p.notify.windows.com/w/?token=x')).toBe('microsoft');
    expect(pushServiceOf('https://push.example.org/x')).toBe('other');
    expect(pushServiceOf('not a url')).toBe('other');
  });
});

describe('POST /v1/push/test', () => {
  it('sends only to the caller’s own devices, in their language', async () => {
    const me = await registerUser(app, fpl, 1);
    const other = await registerUser(app, fpl, 2);
    await subscribe(app, me.token, APPLE(1));
    await subscribe(app, me.token, GOOGLE(1));
    await subscribe(app, other.token, APPLE(2));

    expect((await test(null)).statusCode).toBe(401);
    const res = await test(me.token);
    expect(res.statusCode).toBe(200);
    expect(PushTestResultSchema.parse(res.json())).toEqual({ devices: 2, delivered: 2, gone: 0, failed: 0 });
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual([APPLE(1), GOOGLE(1)].sort());
    expect(push.sent[0]?.payload.title).toBe('🔔 התראת בדיקה'); // Hebrew default
    expect(push.sent[0]?.options).toEqual({ ttlSec: 600, urgency: 'high' });

    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(other.token),
      payload: { locale: 'en' },
    });
    push.sent = [];
    await test(other.token);
    expect(push.sent.map((s) => s.endpoint)).toEqual([APPLE(2)]);
    expect(push.sent[0]?.payload.title).toBe('🔔 Test notification');
  });

  it('accounts gone and failed devices: dead ones are deleted, failures counted with their HTTP code', async () => {
    const me = await registerUser(app, fpl, 3);
    for (const e of [APPLE(3), APPLE(4), GOOGLE(3)]) await subscribe(app, me.token, e);
    push.results.set(APPLE(4), { result: 'gone', statusCode: 410 });
    push.results.set(GOOGLE(3), { result: 'error', statusCode: 403 });

    const res = await test(me.token);
    expect(res.json()).toEqual({ devices: 3, delivered: 1, gone: 1, failed: 1 });
    expect(await prisma.pushSubscription.count({ where: { endpoint: APPLE(4) } })).toBe(0);
    const failing = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: GOOGLE(3) } });
    expect(failing.failureCount).toBe(1);

    // Re-POSTing the same endpoint (the app re-subscribes on open) resets the counter.
    await subscribe(app, me.token, GOOGLE(3));
    expect(
      (await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: GOOGLE(3) } })).failureCount,
    ).toBe(0);

    const admin = await adminToken(app, prisma);
    const health = AdminPushHealthSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/admin/push/health', headers: bearer(admin) })).json(),
    );
    expect(health.recent[0]).toMatchObject({
      kind: 'test',
      devices: 3,
      delivered: 1,
      gone: 1,
      failed: 1,
      failureCodes: [403],
    });
  });

  it('is rate-limited to 5 per 10 minutes per user', async () => {
    const me = await registerUser(app, fpl, 5);
    await subscribe(app, me.token, APPLE(5));
    for (let i = 0; i < 5; i++) expect((await test(me.token)).statusCode).toBe(200);
    expect((await test(me.token)).statusCode).toBe(429);
    expect(push.sent).toHaveLength(5);
    // Another user has their own budget.
    const other = await registerUser(app, fpl, 6);
    expect((await test(other.token)).statusCode).toBe(200);
  });

  it('a user with no device gets zeros; push not configured → 503', async () => {
    const me = await registerUser(app, fpl, 7);
    expect((await test(me.token)).json()).toEqual({ devices: 0, delivered: 0, gone: 0, failed: 0 });
    await app.close();
    await resetDb(prisma);
    await boot({ push: null });
    const again = await registerUser(app, fpl, 7);
    expect((await test(again.token)).statusCode).toBe(503);
  });
});

describe('GET /v1/admin/push/health', () => {
  it('admin only; counts users and devices per service; never exposes endpoints or keys', async () => {
    const a = await registerUser(app, fpl, 10);
    const b = await registerUser(app, fpl, 11);
    await registerUser(app, fpl, 12); // no device
    await subscribe(app, a.token, APPLE(10));
    await subscribe(app, a.token, GOOGLE(10));
    await subscribe(app, b.token, APPLE(11));
    await test(a.token);

    expect((await app.inject({ method: 'GET', url: '/v1/admin/push/health' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/push/health', headers: bearer(a.token) }))
        .statusCode,
    ).toBe(403);
    const admin = await adminToken(app, prisma);
    const res = await app.inject({ method: 'GET', url: '/v1/admin/push/health', headers: bearer(admin) });
    expect(res.statusCode).toBe(200);
    const health = AdminPushHealthSchema.parse(res.json());
    expect(health.users).toBe(2);
    expect(health.devices).toEqual([
      { service: 'apple', count: 2 },
      { service: 'google', count: 1 },
    ]);
    expect(health.recent).toHaveLength(1);
    for (const secret of ['QGkSecretToken', 'secret-google', KEYS.p256dh, KEYS.auth, a.user.id]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it(`keeps only the last ${RECENT_PUSH_BATCHES} batches, newest first`, async () => {
    const me = await registerUser(app, fpl, 20);
    await subscribe(app, me.token, APPLE(20));
    await app.close();
    await boot({ rateLimit: { pushTestsPer10Min: 100 } });
    for (let i = 0; i < RECENT_PUSH_BATCHES + 3; i++) {
      clock.advance(1000);
      await test(me.token);
    }
    const admin = await adminToken(app, prisma);
    const health = AdminPushHealthSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/admin/push/health', headers: bearer(admin) })).json(),
    );
    expect(health.recent).toHaveLength(RECENT_PUSH_BATCHES);
    expect(health.recent[0]?.at).toBe(clock.now().toISOString());
  });
});

describe('batch logging + news delivery', () => {
  it('one structured line per batch with counts and services, never an endpoint or key', async () => {
    const me = await registerUser(app, fpl, 30);
    await subscribe(app, me.token, APPLE(30));
    await subscribe(app, me.token, GOOGLE(30));
    push.results.set(GOOGLE(30), { result: 'gone', statusCode: 410 });
    await test(me.token);
    const lines = batchLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.push).toEqual({
      kind: 'test',
      recipients: 1,
      devices: 2,
      delivered: 1,
      gone: 1,
      failed: 0,
      failureCodes: [],
      services: { apple: 1, google: 1 },
    });
    const all = logs.join('');
    for (const secret of ['QGkSecretToken', 'secret-google', 'web.push.apple.com', KEYS.p256dh, KEYS.auth]) {
      expect(all).not.toContain(secret);
    }
  });

  it('a new episode: high urgency, 24 h TTL, default prefs (no row) = news on; summary counts devices', async () => {
    const me = await registerUser(app, fpl, 40);
    expect(await prisma.notificationPrefs.count({ where: { userId: me.user.id } })).toBe(0);
    await subscribe(app, me.token, APPLE(40));
    await subscribe(app, me.token, GOOGLE(40));
    push.results.set(GOOGLE(40), { result: 'error', statusCode: 500 });
    const ago = (ms: number) => new Date(clock.now().getTime() - ms);
    fakes.podcast.next = result([episode(1, ago(48 * 3600_000))]);
    expect(await app.jobs.run('podcast', { force: true })).toBe('ok'); // backfill: silent
    // Published 30 minutes ago (feed latency) is well inside the 12 h "fresh" window.
    fakes.podcast.next = result([episode(1, ago(48 * 3600_000)), episode(2, ago(30 * 60_000))]);
    expect(await app.jobs.run('podcast', { force: true })).toBe('ok');

    expect(push.sent).toHaveLength(2);
    expect(push.sent[0]?.options).toEqual({ ttlSec: NEWS_PUSH_TTL_SEC, urgency: 'high' });
    expect(NEWS_PUSH_TTL_SEC).toBe(24 * 3600);
    const summary = logs
      .map((l) => JSON.parse(l) as { msg?: string; job?: string; summary?: string })
      .filter((l) => l.msg === 'job ok' && l.job === 'podcast')
      .at(-1)?.summary;
    expect(summary).toContain('pushed to 1 users (1/2 devices delivered, 0 gone, 1 failed)');
    expect(batchLines().at(-1)?.push).toMatchObject({ kind: 'news', failureCodes: [500] });
  });
});

describe('payload size', () => {
  it('keeps payloads under the 4 KB web push limit: image dropped first, then the body shortened', () => {
    const base: PushPayload = {
      title: 'כותרת',
      body: 'קצר',
      url: '/news/',
      tag: null,
      icon: null,
      image: 'https://media.test/x.jpg',
    };
    expect(fitPayload(base)).toEqual(base);
    const huge = fitPayload({ ...base, body: 'א'.repeat(5000) });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
    expect(huge.image).toBeNull();
    expect(huge.body.endsWith('…')).toBe(true);
    expect(huge.title).toBe('כותרת');
  });
});
