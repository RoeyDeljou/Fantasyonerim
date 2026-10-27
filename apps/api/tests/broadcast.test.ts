import {
  AuthResponseSchema,
  BroadcastHistorySchema,
  BroadcastResultSchema,
  BroadcastTargetsStatusSchema,
  HiddenNewsListSchema,
  NewsPageSchema,
  type BroadcastResult,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_PUSH_TTL_SEC,
  NO_LIVE_SUBSCRIBERS,
  PUSH_NOT_CONFIGURED,
  X_NOT_CONNECTED,
} from '../src/broadcast/publishers.js';
import { encryptSecrets, ensureIntegrationRows } from '../src/integrations/store.js';
import { BROADCAST_SNIPPET_CHARS } from '../src/push/copy.js';
import { devSecretsKey } from '../src/secrets.js';
import { makeImage, upload } from './communityFixtures.js';
import { FakePushProvider, MemoryMediaStore, fakeIntegrations, result, subscribe, xPost } from './fakes.js';
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
const VAPID = 'BARW9HWQIO3yvIxl8aHJdD2VxTpVSCtUsgyoQFb35AeAH';
const X_SECRETS = {
  bearerToken: 'bearer-SECRET-1111',
  apiKey: 'api-key-SECRET-2222',
  apiSecret: 'api-secret-SECRET-3333',
  accessToken: 'access-token-SECRET-4444',
  accessSecret: 'access-secret-SECRET-5555',
};

/** MediaStore that can read back (like the local disk store), so the X target gets the upload's bytes. */
class ReadableMediaStore extends MemoryMediaStore {
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
}

interface XRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

/** Fake fetch for api.x.com: media upload + create post (or a scripted failure). */
function fakeXFetch() {
  const state = {
    requests: [] as XRequest[],
    fail: null as null | { status: number; body: unknown },
    postId: 1850000000000000001n,
  };
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    state.requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: new Headers(init?.headers),
    });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (state.fail !== null) return json(state.fail.body, state.fail.status);
    if (url === 'https://api.x.com/2/media/upload') return json({ data: { id: '1880000000000000001' } });
    if (url === 'https://api.x.com/2/tweets') {
      state.postId += 1n;
      return json({ data: { id: String(state.postId), text: 'x' } }, 201);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: impl as typeof fetch, state };
}

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let fakes: ReturnType<typeof fakeIntegrations>;
let push: FakePushProvider;
let media: ReadableMediaStore;
let x: ReturnType<typeof fakeXFetch>;
let admin: string;

async function boot(options: TestAppOptions = {}) {
  push = new FakePushProvider();
  media = new ReadableMediaStore();
  x = fakeXFetch();
  fakes = fakeIntegrations();
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    integrations: fakes.factories,
    push,
    media,
    fetch: x.fetch,
    config: { vapidPublicKey: VAPID },
    ...options,
  }));
  admin = await adminToken(app, prisma);
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

async function setXKeys(secrets: Record<string, string> = X_SECRETS) {
  await ensureIntegrationRows(prisma);
  await prisma.integrationConfig.update({
    where: { id: 'x' },
    data: {
      settings: { username: 'Fantasyonerim', userId: '4242' },
      secretsEnc: encryptSecrets(devSecretsKey(), secrets),
    },
  });
}

async function broadcast(payload: object | undefined, token = admin) {
  return app.inject({
    method: 'POST',
    url: '/v1/admin/broadcast',
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
}

async function send(payload: Record<string, unknown>): Promise<BroadcastResult> {
  const res = await broadcast(payload);
  expect(res.statusCode, res.body).toBe(201);
  return BroadcastResultSchema.parse(res.json());
}

const resultOf = (r: BroadcastResult, target: string) => r.results.find((t) => t.target === target);

/** A fan with one push device; prefs optional. */
async function fan(entryId: number, prefs?: { news: boolean; live: boolean }) {
  const auth = await registerUser(app, fpl, entryId);
  await subscribe(app, auth.token, `https://push.test/${entryId}`);
  if (prefs) {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(auth.token),
      payload: { ...prefs, fpl: true, community: true },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  return auth;
}

async function newsFeed() {
  const res = await app.inject({ method: 'GET', url: '/v1/news' });
  expect(res.statusCode).toBe(200);
  return NewsPageSchema.parse(res.json()).items;
}

describe('admin-only enforcement', () => {
  const routes = [
    { method: 'GET' as const, url: '/v1/admin/broadcast/targets' },
    { method: 'POST' as const, url: '/v1/admin/broadcast', payload: { text: 'hi', targets: ['news'] } },
    { method: 'GET' as const, url: '/v1/admin/broadcasts' },
    {
      method: 'POST' as const,
      url: '/v1/admin/me/password',
      payload: { currentPassword: 'correct horse battery', newPassword: 'a brand new password' },
    },
  ];

  it('401 without a session, 403 for a fan — and nothing is created', async () => {
    const user = await registerUser(app, fpl, 501);
    for (const route of routes) {
      expect((await app.inject(route)).statusCode, route.url).toBe(401);
      expect((await app.inject({ ...route, headers: bearer('not-a-token') })).statusCode).toBe(401);
      expect((await app.inject({ ...route, headers: bearer(user.token) })).statusCode, route.url).toBe(403);
    }
    expect(await prisma.broadcast.count()).toBe(0);
    expect(await prisma.newsItem.count()).toBe(0);
  });
});

describe('POST /v1/admin/broadcast validation', () => {
  it.each([
    ['no body', undefined, /expected object|Required|invalid/i],
    ['empty text', { text: '   ', targets: ['news'] }, /^text:/],
    ['text too long', { text: 'א'.repeat(1001), targets: ['news'] }, /^text:/],
    ['no targets', { text: 'hi', targets: [] }, /^targets:/],
    ['unknown target', { text: 'hi', targets: ['whatsapp'] }, /^targets\.0:/],
    ['duplicate target', { text: 'hi', targets: ['news', 'news'] }, /Duplicate target/],
    ['title too long', { title: 'x'.repeat(81), text: 'hi', targets: ['news'] }, /^title:/],
    ['bad uploadId', { text: 'hi', uploadId: '', targets: ['news'] }, /^uploadId:/],
  ])('%s → 400', async (_name, payload, message) => {
    const res = await broadcast(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expect(res.json().error.message).toMatch(message);
    expect(await prisma.broadcast.count()).toBe(0);
  });

  it('text over X’s 280 weighted chars with X chosen → 400 and NOTHING is created, claimed or sent', async () => {
    await setXKeys();
    await fan(601);
    const up = await upload(app, admin, await makeImage('png', 32, 32));
    const text = '⚽'.repeat(141); // 282 by X's count, well under the 1000-char body limit
    const res = await broadcast({ text, uploadId: up.uploadId, targets: ['news', 'push', 'x'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/too long for X — 282 characters.*280/);
    expect(await prisma.broadcast.count()).toBe(0);
    expect(await prisma.newsItem.count()).toBe(0);
    expect(push.sent).toHaveLength(0);
    expect(x.state.requests).toHaveLength(0);
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: up.uploadId } })).usedAt).toBeNull();

    // The same text is fine without X (News/push have no X limit).
    const ok = await send({ text, targets: ['news'] });
    expect(resultOf(ok, 'news')?.status).toBe('ok');
  });

  it('exactly 280 weighted chars is accepted for X', async () => {
    await setXKeys();
    const r = await send({ text: 'א'.repeat(280), targets: ['x'] });
    expect(resultOf(r, 'x')?.status).toBe('ok');
  });
});

describe('targets', () => {
  it('news only: an admin_update News item, no notification at all', async () => {
    await fan(701); // news + live on (defaults)
    const r = await send({ title: 'גול!', text: '⚽ גול! האלאנד 1–0 (Haaland)', targets: ['news'] });
    expect(r.results).toHaveLength(1);
    const news = resultOf(r, 'news');
    expect(news?.status).toBe('ok');
    const items = await newsFeed();
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.source).toBe('admin_update');
    expect(item?.title).toBe('גול!');
    expect(item?.text).toBe('⚽ גול! האלאנד 1–0 (Haaland)');
    expect(news?.url).toBe(`/news/?item=${item?.id}`);
    expect(push.sent).toHaveLength(0);
    expect(await prisma.notificationLog.count()).toBe(0);
  });

  it('push only: prefs.live decides (prefs.news irrelevant), high urgency, 1 h TTL, url /news/', async () => {
    const a = await fan(801); // defaults
    await fan(802, { news: true, live: false });
    const c = await fan(803, { news: false, live: true });
    await registerUser(app, fpl, 804); // no device
    const text = `⚽ גול! ${'האלאנד כובש שוב '.repeat(30)}`;
    const r = await send({ text, targets: ['push'] });

    expect(push.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.test/801',
      'https://push.test/803',
    ]);
    const sent = push.sent[0];
    expect(sent?.options).toEqual({ ttlSec: LIVE_PUSH_TTL_SEC, urgency: 'high' });
    expect(sent?.payload.title).toBe('פנטזיונרים');
    expect(sent?.payload.url).toBe('/news/');
    expect(sent?.payload.tag).toBe(`live-${r.id}`);
    expect(sent?.payload.body.length).toBeLessThanOrEqual(BROADCAST_SNIPPET_CHARS);
    expect(sent?.payload.body.endsWith('…')).toBe(true);
    expect(resultOf(r, 'push')).toEqual({
      target: 'push',
      status: 'ok',
      detail: 'Delivered to 2 of 2 devices',
      url: null,
    });
    expect(await prisma.newsItem.count()).toBe(0);
    expect(a.user.id).not.toBe(c.user.id);
  });

  it('news + push: exactly ONE notification per user, linking to the News item', async () => {
    await fan(901);
    await fan(902, { news: false, live: true });
    await fan(903, { news: true, live: false });
    const r = await send({ title: 'גול!', text: 'האלאנד 1–0', targets: ['news', 'push'] });

    const itemUrl = resultOf(r, 'news')?.url;
    expect(itemUrl).toMatch(/^\/news\/\?item=/);
    expect(push.sent).toHaveLength(2);
    expect(new Set(push.sent.map((s) => s.endpoint)).size).toBe(2);
    for (const s of push.sent) {
      expect(s.payload.url).toBe(itemUrl);
      expect(s.payload.title).toBe('גול!');
      expect(s.payload.body).toBe('האלאנד 1–0');
    }
    // The regular news push never claimed the item.
    const keys = await prisma.notificationLog.findMany({ select: { key: true } });
    expect(keys.every((k) => k.key === `broadcast:${r.id}`)).toBe(true);
  });

  it('push with no live subscribers → skipped with the reason', async () => {
    await fan(1001, { news: true, live: false });
    const r = await send({ text: 'hi', targets: ['push'] });
    expect(resultOf(r, 'push')).toMatchObject({ status: 'skipped', detail: NO_LIVE_SUBSCRIBERS });
    expect(push.sent).toHaveLength(0);
  });

  it('push devices that all fail → error with the device count; others still succeed', async () => {
    await fan(1101);
    push.results.set('https://push.test/1101', 'error');
    const r = await send({ text: 'hi', targets: ['news', 'push'] });
    expect(resultOf(r, 'push')).toMatchObject({ status: 'error', detail: 'Delivered to 0 of 1 devices' });
    expect(resultOf(r, 'news')?.status).toBe('ok');
  });

  it('push without VAPID → skipped; news still posted', async () => {
    await app.close();
    await resetDb(prisma);
    await boot({ push: null, config: {} });
    const r = await send({ text: 'hi', targets: ['news', 'push'] });
    expect(resultOf(r, 'push')).toMatchObject({ status: 'skipped', detail: PUSH_NOT_CONFIGURED });
    expect(resultOf(r, 'news')?.status).toBe('ok');
  });

  it('X not configured → skipped ("paid feature"), nothing sent to X, other targets fine', async () => {
    await fan(1201);
    const r = await send({ text: 'גול!', targets: ['news', 'push', 'x'] });
    expect(r.results.map((t) => t.target)).toEqual(['news', 'push', 'x']);
    expect(resultOf(r, 'x')).toEqual({ target: 'x', status: 'skipped', detail: X_NOT_CONNECTED, url: null });
    expect(resultOf(r, 'news')?.status).toBe('ok');
    expect(resultOf(r, 'push')?.status).toBe('ok');
    expect(x.state.requests).toHaveLength(0);
  });

  it('X with only the read token (no write keys) → skipped', async () => {
    await setXKeys({ bearerToken: X_SECRETS.bearerToken });
    const r = await send({ text: 'hi', targets: ['x'] });
    expect(resultOf(r, 'x')?.status).toBe('skipped');
    expect(x.state.requests).toHaveLength(0);
  });

  it('X configured, text only → posted; result url is the post; our own post is never re-imported', async () => {
    await setXKeys();
    const r = await send({ text: ' ⚽ גול! האלאנד 1–0 ', targets: ['x'] });
    const xr = resultOf(r, 'x');
    expect(xr?.status).toBe('ok');
    expect(xr?.url).toBe('https://x.com/Fantasyonerim/status/1850000000000000002');
    expect(x.state.requests.map((q) => q.url)).toEqual(['https://api.x.com/2/tweets']);
    const req = x.state.requests[0];
    expect(JSON.parse(String(req?.body))).toEqual({ text: '⚽ גול! האלאנד 1–0' });
    expect(req?.headers.get('authorization')).toMatch(/^OAuth .*oauth_consumer_key="api-key-SECRET-2222"/);
    // A hidden placeholder keeps the X read job from importing it as a second News item.
    const placeholder = await prisma.newsItem.findUniqueOrThrow({
      where: { dedupeKey: 'x:1850000000000000002' },
    });
    expect(placeholder.hiddenAt).not.toBeNull();
    expect(placeholder.suppressed).toBe(true);
    expect(await newsFeed()).toHaveLength(0);

    // It is not a "hidden item": absent from the hidden list (a really hidden item is listed) and not restorable.
    const real = resultOf(await send({ text: 'real item', targets: ['news'] }), 'news');
    const realId = new URL(real?.url ?? '', 'http://x').searchParams.get('item') ?? '';
    const hide = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/news/${realId}`,
      headers: bearer(admin),
    });
    expect(hide.statusCode).toBe(204);
    const hidden = await app.inject({ method: 'GET', url: '/v1/admin/news/hidden', headers: bearer(admin) });
    expect(hidden.statusCode).toBe(200);
    expect(HiddenNewsListSchema.parse(hidden.json()).items.map((i) => i.item.id)).toEqual([realId]);
    const restore = await app.inject({
      method: 'POST',
      url: `/v1/admin/news/${placeholder.id}/restore`,
      headers: bearer(admin),
    });
    expect(restore.statusCode).toBe(400);
    expect(restore.json().error.message).toBe("This item can't be restored");
    const after = await prisma.newsItem.findUniqueOrThrow({ where: { id: placeholder.id } });
    expect(after.hiddenAt).not.toBeNull();
    expect(after.suppressed).toBe(true);
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/admin/news/does-not-exist/restore',
      headers: bearer(admin),
    });
    expect(missing.statusCode).toBe(404);

    // The X read job then sees that post on the timeline: no new News item, no notification.
    await prisma.integrationConfig.update({
      where: { id: 'x' },
      data: { enabled: true, initialSyncDone: true },
    });
    await fan(1250);
    fakes.x.next = result([xPost('1850000000000000002', clock.now())]);
    expect(await app.jobs.run('x', { force: true })).toBe('ok');
    expect(await app.jobs.run('x', { force: true })).toBe('ok');
    expect(await newsFeed()).toHaveLength(0);
    expect(push.sent).toHaveLength(0);
    expect(await prisma.newsItem.count()).toBe(2); // placeholder + the hidden real item, no import
    const stillSuppressed = await prisma.newsItem.findUniqueOrThrow({ where: { id: placeholder.id } });
    expect(stillSuppressed).toMatchObject({ suppressed: true, source: 'x_post' });
    expect(stillSuppressed.hiddenAt).not.toBeNull();
  });

  it('X configured + image upload → media upload then post with media_ids; News card has the image + X link', async () => {
    await setXKeys();
    await fan(1301);
    const up = await upload(app, admin, await makeImage('png', 64, 48));
    const r = await send({ text: 'תמונה מהמגרש', uploadId: up.uploadId, targets: ['news', 'push', 'x'] });

    expect(x.state.requests.map((q) => q.url)).toEqual([
      'https://api.x.com/2/media/upload',
      'https://api.x.com/2/tweets',
    ]);
    const form = x.state.requests[0]?.body;
    expect(form).toBeInstanceOf(FormData);
    const file = (form as FormData).get('media');
    expect(file).toBeInstanceOf(Blob);
    const stored = media.objects.get(`uploads/${(await uploadOwner(up.uploadId)) ?? ''}/${up.uploadId}.webp`);
    expect(stored).toBeDefined();
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(new Uint8Array(stored?.bytes ?? []));
    expect((form as FormData).get('media_type')).toBe('image/webp');
    expect(JSON.parse(String(x.state.requests[1]?.body))).toEqual({
      text: 'תמונה מהמגרש',
      media: { media_ids: ['1880000000000000001'] },
    });

    const items = await newsFeed();
    expect(items).toHaveLength(1);
    expect(items[0]?.media).toEqual([
      { kind: 'image', url: up.image.url, posterUrl: null, width: up.image.width, height: up.image.height },
    ]);
    expect(items[0]?.links.x).toBe(resultOf(r, 'x')?.url);
    expect(push.sent[0]?.payload.image).toBe(up.image.url);
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: up.uploadId } })).usedAt).not.toBeNull();
  });

  it('X publish error is isolated and readable, and never leaks a secret', async () => {
    await setXKeys();
    await fan(1401);
    x.state.fail = {
      status: 403,
      body: { title: 'Forbidden', detail: `You are not permitted (${X_SECRETS.accessToken})` },
    };
    const r = await send({ text: 'hi', targets: ['news', 'push', 'x'] });
    expect(resultOf(r, 'news')?.status).toBe('ok');
    expect(resultOf(r, 'push')?.status).toBe('ok');
    const xr = resultOf(r, 'x');
    expect(xr?.status).toBe('error');
    expect(xr?.url).toBeNull();
    expect(xr?.detail.length).toBeGreaterThan(10);
    const everything = JSON.stringify(r) + JSON.stringify(await prisma.broadcast.findMany());
    for (const secret of Object.values(X_SECRETS)) expect(everything).not.toContain(secret);
  });

  it('X network failure → error, not a 500', async () => {
    await app.close();
    await resetDb(prisma);
    await boot({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await setXKeys();
    const r = await send({ text: 'hi', targets: ['news', 'x'] });
    expect(resultOf(r, 'x')).toMatchObject({ status: 'error' });
    expect(resultOf(r, 'x')?.detail).toMatch(/X is not responding/);
    expect(resultOf(r, 'news')?.status).toBe('ok');
  });
});

async function uploadOwner(uploadId: string): Promise<string | undefined> {
  return (await prisma.upload.findUnique({ where: { id: uploadId } }))?.ownerId;
}

describe('upload claiming', () => {
  it('needs the admin’s own, unused upload', async () => {
    const someone = await registerUser(app, fpl, 1501);
    const theirs = await upload(app, someone.token, await makeImage('jpeg', 20, 20));
    const notYours = await broadcast({ text: 'hi', uploadId: theirs.uploadId, targets: ['news'] });
    expect(notYours.statusCode).toBe(400);
    expect(notYours.json().error.message).toMatch(/^uploadId:/);

    const missing = await broadcast({ text: 'hi', uploadId: 'nope', targets: ['news'] });
    expect(missing.statusCode).toBe(400);

    const mine = await upload(app, admin, await makeImage('jpeg', 20, 20));
    await send({ text: 'first', uploadId: mine.uploadId, targets: ['news'] });
    const reused = await broadcast({ text: 'again', uploadId: mine.uploadId, targets: ['news'] });
    expect(reused.statusCode).toBe(400);

    // A post can't take it either (claimed once).
    const post = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: bearer(admin),
      payload: { text: 'x', uploadId: mine.uploadId },
    });
    expect(post.statusCode).toBe(400);
    expect(await prisma.broadcast.count()).toBe(1);
    expect(await prisma.newsItem.count()).toBe(1);
    const row = await prisma.broadcast.findFirstOrThrow();
    expect(row.uploadId).toBe(mine.uploadId);
  });
});

describe('history and targets status', () => {
  it('GET /v1/admin/broadcasts: newest first, who sent what where', async () => {
    const first = await send({ text: 'first', targets: ['news'] });
    clock.advance(60_000);
    const second = await send({ title: 'כותרת', text: 'second', targets: ['news', 'x'] });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/broadcasts', headers: bearer(admin) });
    expect(res.statusCode).toBe(200);
    const history = BroadcastHistorySchema.parse(res.json());
    expect(history.items.map((i) => i.id)).toEqual([second.id, first.id]);
    const newest = history.items.find((i) => i.id === second.id);
    expect(newest).toMatchObject({ title: 'כותרת', text: 'second', sentBy: 'admin' });
    expect(newest?.results).toEqual(second.results);
    expect(history.items.find((i) => i.id === first.id)?.title).toBeNull();
  });

  it('GET /v1/admin/broadcast/targets reflects push subscribers and X keys', async () => {
    const get = async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/broadcast/targets',
        headers: bearer(admin),
      });
      expect(res.statusCode).toBe(200);
      return Object.fromEntries(
        BroadcastTargetsStatusSchema.parse(res.json()).targets.map((t) => [t.target, t]),
      );
    };
    let t = await get();
    expect(t['news']).toEqual({ target: 'news', available: true, reason: null, paidFeature: false });
    expect(t['push']).toEqual({
      target: 'push',
      available: true,
      reason: NO_LIVE_SUBSCRIBERS,
      paidFeature: false,
    });
    expect(t['x']).toEqual({ target: 'x', available: false, reason: X_NOT_CONNECTED, paidFeature: true });

    await fan(1601, { news: false, live: true });
    await setXKeys();
    t = await get();
    expect(t['push']).toMatchObject({ available: true, reason: null });
    expect(t['x']).toEqual({ target: 'x', available: true, reason: null, paidFeature: true });

    await app.close();
    await resetDb(prisma);
    await boot({ push: null, config: {} });
    t = await get();
    expect(t['push']).toMatchObject({ available: false, reason: PUSH_NOT_CONFIGURED });
  });

  it('rate-limits broadcasts per admin', async () => {
    await app.close();
    await resetDb(prisma);
    await boot({ rateLimit: { broadcastsPerHour: 2 } });
    await send({ text: '1', targets: ['news'] });
    await send({ text: '2', targets: ['news'] });
    const third = await broadcast({ text: '3', targets: ['news'] });
    expect(third.statusCode).toBe(429);
    expect(await prisma.broadcast.count()).toBe(2);
  });
});

describe('POST /v1/admin/me/password', () => {
  const login = (password: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/admin-login', payload: { username: 'admin', password } });
  const change = (token: string, payload: object | undefined) =>
    app.inject({
      method: 'POST',
      url: '/v1/admin/me/password',
      headers: bearer(token),
      ...(payload === undefined ? {} : { payload }),
    });
  const me = (token: string) =>
    app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(token) });

  it.each([
    ['no body', undefined],
    ['new too short', { currentPassword: 'correct horse battery', newPassword: 'short' }],
    ['same password', { currentPassword: 'correct horse battery', newPassword: 'correct horse battery' }],
    ['missing current', { newPassword: 'a brand new password' }],
  ])('%s → 400', async (_name, payload) => {
    const res = await change(admin, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('wrong current password → 401, nothing changes', async () => {
    const res = await change(admin, {
      currentPassword: 'wrong password!!',
      newPassword: 'a brand new password',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/current password is incorrect/);
    expect((await login('correct horse battery')).statusCode).toBe(200);
    expect((await me(admin)).statusCode).toBe(200);
  });

  it('success: new password works, old fails, other sessions signed out, current kept', async () => {
    const otherLogin = await login('correct horse battery');
    const other = AuthResponseSchema.parse(otherLogin.json()).token;
    const fanUser = await registerUser(app, fpl, 1701);
    expect((await me(other)).statusCode).toBe(200);

    const res = await change(admin, {
      currentPassword: 'correct horse battery',
      newPassword: 'a brand new password',
    });
    expect(res.statusCode).toBe(204);
    expect((await me(admin)).statusCode).toBe(200);
    expect((await me(other)).statusCode).toBe(401);
    expect((await login('correct horse battery')).statusCode).toBe(401);
    expect((await login('a brand new password')).statusCode).toBe(200);
    // Other users' sessions are untouched.
    const fanMe = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(fanUser.token) });
    expect(fanMe.statusCode).toBe(200);
    const cred = await prisma.adminCredential.findUniqueOrThrow({ where: { username: 'admin' } });
    expect(cred.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('is rate-limited like login', async () => {
    await app.close();
    await resetDb(prisma);
    await boot({ rateLimit: { authMax: 3 } });
    // Same per-IP budget as login (counted per route).
    const bad = { currentPassword: 'wrong password!!', newPassword: 'a brand new password' };
    expect((await change(admin, bad)).statusCode).toBe(401);
    expect((await change(admin, bad)).statusCode).toBe(401);
    expect((await change(admin, bad)).statusCode).toBe(401);
    expect((await change(admin, bad)).statusCode).toBe(429);
  });

  it('admins list/create still work', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/admins',
      headers: bearer(admin),
      payload: { username: 'dor', password: 'dors password 123', name: 'Dor' },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/v1/admin/admins', headers: bearer(admin) });
    expect(list.json().map((a: { username: string }) => a.username)).toEqual(['admin', 'dor']);
    const dorLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin-login',
      payload: { username: 'dor', password: 'dors password 123' },
    });
    expect(dorLogin.statusCode).toBe(200);
  });
});
