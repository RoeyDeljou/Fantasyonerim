import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import {
  BootstrapSchema,
  CaptainBattleSchema,
  CommunityPageSchema,
  LiveLeagueSchema,
  NewsPageSchema,
  PublicConfigSchema,
} from '@fant/shared';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HOT_POLICY } from '../src/perf/hotData.js';
import { makeBootstrap, makeFixture, makePicks, type FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  TEST_DATABASE_URL,
  type TestAppOptions,
  type TestClock,
} from './helpers.js';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

async function boot(options: TestAppOptions = {}) {
  ({ app, fpl, clock } = await buildTestApp(prisma, options));
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

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

async function configureLeague(): Promise<string> {
  fpl.leagues.set(314, { id: 314, name: 'Fantasyonerim League' });
  const token = await adminToken(app, prisma);
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/admin/settings',
    headers: bearer(token),
    payload: {
      leagueId: 314,
      deadlineReminderMinutes: [1440, 120],
      socials: { spotifyUrl: null, appleUrl: null, instagramUrl: null, xUrl: null, whatsappUrl: null },
    },
  });
  expect(res.statusCode).toBe(200);
  return token;
}

/** A live league page big enough (> 1 KB) to be compressed. */
function bigLiveLeague(): void {
  fpl.liveLeagueByPage = new Map([
    [
      1,
      Array.from({ length: 50 }, (_, i) => ({
        liveRank: i + 1,
        officialRank: i + 1,
        entryId: 1000 + i,
        entryName: `Team number ${i}`,
        managerName: `Manager ${i}`,
        livePoints: 80 - i,
        liveTotal: 900 - i,
        captainPlayerId: 1,
        effectiveCaptainPlayerId: 1,
        activeChip: null,
        playersYetToPlay: 3,
      })),
    ],
  ]);
}

describe('shared hot responses', () => {
  it('the live league is computed once for everybody, with ETag → 304 and a live Cache-Control', async () => {
    await configureLeague();
    fpl.calls = [];
    const many = await Promise.all(Array.from({ length: 25 }, () => get('/v1/league/live?page=1')));
    expect(many.every((r) => r.statusCode === 200)).toBe(true);
    expect(fpl.calls.filter((c) => c.startsWith('getLiveLeague'))).toEqual(['getLiveLeague:314:9:1']);
    const first = many[0]!;
    LiveLeagueSchema.parse(first.json());
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/".+"$/);
    expect(new Set(many.map((r) => r.headers.etag)).size).toBe(1);
    expect(first.headers['cache-control']).toBe('public, max-age=10, stale-while-revalidate=20');
    expect(first.headers['content-type']).toBe('application/json; charset=utf-8');

    const notModified = await get('/v1/league/live?page=1', { 'if-none-match': etag });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    expect(notModified.headers.etag).toBe(etag);
    const changed = await get('/v1/league/live?page=1', { 'if-none-match': 'W/"other"' });
    expect(changed.statusCode).toBe(200);
  });

  it('stale-while-revalidate: after the fresh window the stored table is served and refreshed once', async () => {
    await configureLeague();
    bigLiveLeague();
    const before = LiveLeagueSchema.parse((await get('/v1/league/live')).json());
    fpl.liveLeagueByPage!.get(1)![0] = { ...(fpl.liveLeagueByPage!.get(1)![0] as object), livePoints: 99 };
    // Still fresh: the same table, FPL not asked.
    fpl.calls = [];
    expect(LiveLeagueSchema.parse((await get('/v1/league/live')).json())).toEqual(before);
    expect(fpl.calls.filter((c) => c.startsWith('getLiveLeague'))).toEqual([]);
    // Stale: answered at once from the stored table, refreshed in the background.
    clock.advance(HOT_POLICY.live.freshMs + 1);
    expect(LiveLeagueSchema.parse((await get('/v1/league/live')).json()).rows[0]?.livePoints).toBe(80);
    await new Promise((r) => setTimeout(r, 20));
    expect(LiveLeagueSchema.parse((await get('/v1/league/live')).json()).rows[0]?.livePoints).toBe(99);
    expect(fpl.calls.filter((c) => c.startsWith('getLiveLeague'))).toHaveLength(1);
  });

  it('bootstrap, fixtures, config and news are shared bodies with ETags; 304 on revalidation', async () => {
    await configureLeague();
    for (const url of ['/v1/fpl/bootstrap', '/v1/fpl/fixtures?event=9', '/v1/config', '/v1/news?limit=5']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers.etag, url).toBeDefined();
      expect(res.headers.vary, url).toBe('accept-encoding');
      expect((await get(url, { 'if-none-match': String(res.headers.etag) })).statusCode, url).toBe(304);
    }
    expect((await get('/v1/fpl/bootstrap')).headers['cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=300',
    );
    expect((await get('/v1/config')).headers['cache-control']).toBe(
      'public, max-age=30, stale-while-revalidate=60',
    );
    expect((await get('/v1/news')).headers['cache-control']).toBe(
      'public, max-age=15, stale-while-revalidate=45',
    );
    // Fixtures: seconds while a match is live, a minute otherwise.
    expect((await get('/v1/fpl/fixtures?event=9')).headers['cache-control']).toBe(
      'public, max-age=15, stale-while-revalidate=15',
    );
    fpl.fixtures = [makeFixture(200, 10, 'not_started')];
    expect((await get('/v1/fpl/fixtures?event=10')).headers['cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=30',
    );
    BootstrapSchema.parse((await get('/v1/fpl/bootstrap')).json());
    PublicConfigSchema.parse((await get('/v1/config')).json());
    NewsPageSchema.parse((await get('/v1/news')).json());
  });

  it('bootstrap is serialized once while FplService returns the same object', async () => {
    const first = await get('/v1/fpl/bootstrap');
    clock.advance(HOT_POLICY.bootstrap.freshMs + HOT_POLICY.bootstrap.staleMs + 1);
    const second = await get('/v1/fpl/bootstrap');
    expect(second.headers.etag).toBe(first.headers.etag);
    fpl.bootstrap = makeBootstrap(10, 11);
    clock.advance(HOT_POLICY.bootstrap.freshMs + HOT_POLICY.bootstrap.staleMs + 1);
    const third = await get('/v1/fpl/bootstrap');
    expect(third.headers.etag).not.toBe(first.headers.etag);
    expect(BootstrapSchema.parse(third.json()).currentEvent).toBe(10);
  });

  it('an admin edit refreshes the shared config and league at once', async () => {
    const token = await configureLeague();
    const before = PublicConfigSchema.parse((await get('/v1/config')).json());
    expect(before.league?.id).toBe(314);
    fpl.leagues.set(999, { id: 999, name: 'Other League' });
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings',
      headers: bearer(token),
      payload: {
        leagueId: 999,
        deadlineReminderMinutes: [120],
        socials: {
          spotifyUrl: null,
          appleUrl: null,
          instagramUrl: null,
          xUrl: 'https://x.com/pod',
          whatsappUrl: null,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const after = PublicConfigSchema.parse((await get('/v1/config')).json());
    expect(after.league).toEqual({ id: 999, name: 'Other League' });
    expect(after.socials.xUrl).toBe('https://x.com/pod');
    expect(LiveLeagueSchema.parse((await get('/v1/league/live')).json()).league.id).toBe(999);
  });

  it('an admin news hide drops the shared news pages at once', async () => {
    const item = await prisma.newsItem.create({
      data: { dedupeKey: 'x:1', source: 'x_post', text: 'hello', links: {}, publishedAt: clock.now() },
    });
    app.hot.invalidateNews();
    expect(NewsPageSchema.parse((await get('/v1/news')).json()).items.map((i) => i.id)).toEqual([item.id]);
    const token = await adminToken(app, prisma);
    const hide = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/news/${item.id}`,
      headers: bearer(token),
    });
    expect(hide.statusCode).toBe(204);
    expect(NewsPageSchema.parse((await get('/v1/news')).json()).items).toEqual([]);
  });

  it('captain battle: the shared part is computed once; each viewer still gets their own row', async () => {
    fpl.playerPoints.set(1, 6).set(2, 13).set(3, 2);
    fpl.addEntry(777);
    fpl.picks.set('777:9', makePicks(777, 9, 1, 2));
    const token = await adminToken(app, prisma);
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(token),
      payload: {
        event: 9,
        entries: [
          { label: 'Dor', source: 'entry', entryId: 777, kind: 'custom' },
          { label: 'Community', source: 'player', playerId: 3, kind: 'community' },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    const a = await registerUser(app, fpl, 501);
    const b = await registerUser(app, fpl, 502);
    fpl.picks.set('501:9', makePicks(501, 9, 2, 3));
    fpl.picks.set('502:9', makePicks(502, 9, 3, 2));
    fpl.calls = [];
    const anon = CaptainBattleSchema.parse((await get('/v1/captain-battle')).json());
    const forA = await get('/v1/captain-battle', bearer(a.token));
    const forB = CaptainBattleSchema.parse((await get('/v1/captain-battle', bearer(b.token))).json());
    expect(anon.rows.map((r) => r.label)).toEqual(['Dor', 'Community']);
    expect(CaptainBattleSchema.parse(forA.json()).rows.map((r) => [r.label, r.captainPoints])).toEqual([
      [a.user.name, 39],
      ['Dor', 12],
      ['Community', 4],
    ]);
    expect(forA.headers['cache-control']).toBe('private, no-cache');
    expect(forB.rows.map((r) => [r.label, r.captainPoints])).toEqual([
      ['Dor', 12],
      ['Community', 4],
      [b.user.name, 4], // ties keep the battle's order, the viewer's row last (as before)
    ]);
    // The battle's own team picks were read once for all three requests.
    expect(fpl.calls.filter((c) => c === 'getEntryPicks:777:9')).toHaveLength(1);
  });
});

describe('compression', () => {
  it('hot bodies: br or gzip per Accept-Encoding, identity when not accepted, identical JSON', async () => {
    await configureLeague();
    bigLiveLeague();
    const plain = await get('/v1/league/live');
    expect(plain.headers['content-encoding']).toBeUndefined();
    const json = plain.json();
    const br = await get('/v1/league/live', { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString())).toEqual(json);
    expect(br.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
    const gz = await get('/v1/league/live', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toEqual(json);
    expect(gz.headers.etag).toBe(plain.headers.etag);
  });

  it('small bodies are never compressed; dynamic JSON ≥ 1 KB is (and gets an ETag)', async () => {
    const small = await get('/health', { 'accept-encoding': 'br' });
    expect(small.headers['content-encoding']).toBeUndefined();
    const user = await registerUser(app, fpl, 601);
    for (let i = 0; i < 12; i += 1) {
      await prisma.communityPost.create({
        data: { authorId: user.user.id, text: `post ${i} ${'x'.repeat(80)}` },
      });
    }
    const res = await get('/v1/community/posts', { ...bearer(user.token), 'accept-encoding': 'gzip' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(CommunityPageSchema.parse(JSON.parse(gunzipSync(res.rawPayload).toString())).items).toHaveLength(
      12,
    );
    const etag = String(res.headers.etag);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const again = await get('/v1/community/posts', { ...bearer(user.token), 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('My Team live: per-entry ETag + live Cache-Control (304 when nothing moved)', async () => {
    fpl.addEntry(42);
    const res = await get('/v1/fpl/entries/42/live?event=9');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=10, stale-while-revalidate=20');
    expect(
      (await get('/v1/fpl/entries/42/live?event=9', { 'if-none-match': String(res.headers.etag) }))
        .statusCode,
    ).toBe(304);
  });
});

describe('sessions + rate limits under polling', () => {
  it('reads reuse the resolved session; logout and bans apply immediately', async () => {
    const user = await registerUser(app, fpl, 701);
    expect((await get('/v1/me', bearer(user.token))).statusCode).toBe(200);
    await prisma.session.deleteMany({ where: { userId: user.user.id } });
    // Deleted behind the API's back: a cached read may still pass for ≤ 30 s, a write never does.
    const write = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(user.token),
      payload: { name: 'New' },
    });
    expect(write.statusCode).toBe(401);

    const other = await registerUser(app, fpl, 702);
    expect((await get('/v1/me', bearer(other.token))).statusCode).toBe(200);
    const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(other.token) });
    expect(logout.statusCode).toBe(204);
    expect((await get('/v1/me', bearer(other.token))).statusCode).toBe(401);

    const fan = await registerUser(app, fpl, 703);
    expect((await get('/v1/me', bearer(fan.token))).json()).toMatchObject({ canPost: true });
    const admin = await adminToken(app, prisma);
    const ban = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${fan.user.id}/ban`,
      headers: bearer(admin),
      payload: { reason: 'spam' },
    });
    expect(ban.statusCode).toBe(204);
    expect((await get('/v1/me', bearer(fan.token))).json()).toMatchObject({ canPost: false });
  });

  it('signed-in requests are limited per user, not per IP (CGNAT); anonymous ones per IP', async () => {
    await app.close();
    await boot({ rateLimit: { globalMax: 5, anonymousMax: 8 } });
    const ip = { 'x-forwarded-for': '100.64.0.1' };
    const users = await Promise.all([801, 802, 803].map((id) => registerUser(app, fpl, id)));
    // Three users behind one IP (trustProxy is off: every request here comes from the same address), 4 requests
    // each: nobody is throttled although the IP made 12 (> anonymousMax 8).
    for (const u of users) {
      for (let i = 0; i < 4; i += 1) {
        expect((await get('/health', { ...ip, ...bearer(u.token) })).statusCode).toBe(200);
        expect((await get('/v1/me', { ...ip, ...bearer(u.token) })).statusCode).toBe(200);
      }
    }
    // The sixth request of one user is throttled; the others are unaffected.
    expect((await get('/v1/me', bearer(users[0]!.token))).statusCode).toBe(200);
    expect((await get('/v1/me', bearer(users[0]!.token))).statusCode).toBe(429);
    expect((await get('/v1/me', bearer(users[1]!.token))).statusCode).toBe(200);
    // A made-up token is anonymous: the per-IP ceiling applies.
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push((await get('/v1/config', { authorization: `Bearer fake${i}` })).statusCode);
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe('Neon keep-alive + quiet hours', () => {
  it('GET /health touches the database at most once a minute, never during quiet hours', async () => {
    const pings: number[] = [];
    const counting = new PrismaClient({
      datasourceUrl: TEST_DATABASE_URL,
      log: [{ emit: 'event', level: 'query' }],
    });
    counting.$on('query', (e) => {
      if (e.query.trim() === 'SELECT 1') pings.push(1);
    });
    await app.close();
    // 2026-10-25T12:00Z = 15:00 in Israel: awake hours.
    ({ app, fpl, clock } = await buildTestApp(counting, { config: { keepAlive: { quietHours: [2, 7] } } }));
    try {
      expect((await get('/health')).json()).toEqual({ ok: true });
      await get('/health');
      await until(() => pings.length >= 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(pings).toHaveLength(1);
      clock.advance(61_000);
      await get('/health');
      await until(() => pings.length >= 2);
      expect(pings).toHaveLength(2);
      // 01:30 UTC = 04:30 in Israel (winter): quiet.
      clock.advance(Date.parse('2026-10-26T01:30:00Z') - clock.now().getTime());
      await get('/health');
      await new Promise((r) => setTimeout(r, 50));
      expect(pings).toHaveLength(2);
      expect((await get('/health')).headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
      await counting.$disconnect();
      await boot();
    }
  });

  it('during quiet hours due jobs run at most every 30 minutes', async () => {
    await app.close();
    ({ app, fpl, clock } = await buildTestApp(prisma, { config: { keepAlive: { quietHours: [2, 7] } } }));
    clock.advance(Date.parse('2026-10-26T01:00:00Z') - clock.now().getTime()); // 03:00 in Israel
    expect((await app.jobs.runDue()).length).toBeGreaterThan(0);
    clock.advance(10 * 60_000);
    expect(await app.jobs.runDue()).toEqual([]);
    clock.advance(25 * 60_000);
    // 35 min later: allowed again (the 5-minute jobs are due again).
    expect((await app.jobs.runDue()).length).toBeGreaterThan(0);
  });
});

describe('live pre-warmer', () => {
  it('idles without a live fixture; with one it recomputes every live league page and the battle', async () => {
    await configureLeague();
    fpl.fixtures = [makeFixture(100, 9, 'not_started')];
    expect(await app.hot.warm()).toBe('idle: GW9 has no live fixture');
    fpl.fixtures = [makeFixture(100, 9, 'live')];
    fpl.liveLeagueByPage = new Map([
      [1, []],
      [2, []],
    ]);
    fpl.calls = [];
    expect(await app.hot.warm()).toBe('warmed GW9: 2 live league page(s), captain battle, fixtures');
    expect(fpl.calls.filter((c) => c.startsWith('getLiveLeague'))).toEqual([
      'getLiveLeague:314:9:1',
      'getLiveLeague:314:9:2',
    ]);
    // A user request right after is served from the warm copy.
    fpl.calls = [];
    expect((await get('/v1/league/live?page=2')).statusCode).toBe(200);
    expect(fpl.calls.filter((c) => c.startsWith('getLiveLeague'))).toEqual([]);
  });
});

describe('migration: NotificationLog createdAt index', () => {
  it('is additive (CREATE INDEX only) and applied', async () => {
    const dir = resolve(API_DIR, 'prisma/migrations');
    const name = readdirSync(dir).find((d) => d.endsWith('_notification_log_created_at_index'));
    expect(name).toBeDefined();
    const sql = readFileSync(resolve(dir, name!, 'migration.sql'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    expect(sql).toEqual(['CREATE INDEX "NotificationLog_createdAt_idx" ON "NotificationLog"("createdAt");']);
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'NotificationLog_createdAt_idx'`;
    expect(rows[0]?.indexdef).toMatch(/btree \("createdAt"\)/);
  });

  it('the live-alert count query can use it (bounded by the GW deadline)', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT "userId", COUNT(*) FROM "NotificationLog"
         WHERE "key" LIKE 'live:9:%' AND "createdAt" >= now() - interval '7 days' GROUP BY "userId"`,
      );
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('NotificationLog_createdAt_idx');
    });
  });
});
