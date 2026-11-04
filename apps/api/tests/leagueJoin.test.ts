import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminSettingsSchema,
  CaptainBattleSchema,
  LeaguePositionSchema,
  MeSchema,
  PublicConfigSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_LEAGUE_ID, DEFAULT_LEAGUE_CODE, FPL_LEAGUE_JOIN_URL_TEMPLATE } from '../src/league/config.js';
import { LEAGUE_POSITION_TTL_MS } from '../src/perf/hotData.js';
import { makeFixtureDetail, makePicks, type FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  type TestClock,
} from './helpers.js';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let admin: string;

const NO_SOCIALS = { spotifyUrl: null, appleUrl: null, instagramUrl: null, xUrl: null, whatsappUrl: null };

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl, clock } = await buildTestApp(prisma));
  fpl.leagues.set(CLIENT_LEAGUE_ID, { id: CLIENT_LEAGUE_ID, name: 'Fantasyonerim' });
  fpl.leagues.set(314, { id: 314, name: 'Another League' });
  admin = await adminToken(app, prisma);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function putSettings(body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/admin/settings',
    headers: bearer(admin),
    payload: { deadlineReminderMinutes: [1440, 120], socials: NO_SOCIALS, ...body },
  });
  return res;
}

const config = async () =>
  PublicConfigSchema.parse((await app.inject({ method: 'GET', url: '/v1/config' })).json());
const adminSettings = async () =>
  AdminSettingsSchema.parse(
    (await app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(admin) })).json(),
  );
const joinUrl = (code: string) => FPL_LEAGUE_JOIN_URL_TEMPLATE.replace('{code}', code);

describe('league code + "Join our league"', () => {
  it('the client league gets its default code; config carries the FPL auto-join link', async () => {
    expect(DEFAULT_LEAGUE_CODE).toBe('KJJGKB');
    expect((await config()).leagueJoin).toBeNull(); // no league yet
    expect((await putSettings({ leagueId: CLIENT_LEAGUE_ID })).statusCode).toBe(200);
    expect((await adminSettings()).leagueCode).toBe('KJJGKB');
    expect((await config()).leagueJoin).toEqual({
      code: 'KJJGKB',
      url: 'https://fantasy.premierleague.com/leagues/auto-join/KJJGKB',
    });
    expect((await prisma.appSettings.findFirstOrThrow()).leagueCode).toBeNull(); // the default isn't stored
  });

  it('an admin override wins (upper-cased), survives saves that omit it, and null restores the default', async () => {
    await putSettings({ leagueId: CLIENT_LEAGUE_ID });
    expect((await config()).leagueJoin?.code).toBe('KJJGKB'); // cached in the hot config…
    const saved = await putSettings({ leagueId: CLIENT_LEAGUE_ID, leagueCode: ' ab12cd ' });
    expect(saved.statusCode).toBe(200);
    expect(AdminSettingsSchema.parse(saved.json()).leagueCode).toBe('AB12CD');
    // …and the save invalidated it at once.
    expect((await config()).leagueJoin).toEqual({ code: 'AB12CD', url: joinUrl('AB12CD') });
    // A save without leagueCode keeps the stored one.
    await putSettings({ leagueId: CLIENT_LEAGUE_ID, deadlineReminderMinutes: [60] });
    expect((await adminSettings()).leagueCode).toBe('AB12CD');
    // Clearing it falls back to the configured default.
    await putSettings({ leagueId: CLIENT_LEAGUE_ID, leagueCode: null });
    expect((await adminSettings()).leagueCode).toBe('KJJGKB');
    expect((await config()).leagueJoin?.code).toBe('KJJGKB');
  });

  it('another league has no default code (leagueJoin null until one is set); bad codes are 400', async () => {
    await putSettings({ leagueId: 314 });
    expect((await adminSettings()).leagueCode).toBeNull();
    expect((await config()).leagueJoin).toBeNull();
    await putSettings({ leagueId: 314, leagueCode: 'zz99zz' });
    expect((await config()).leagueJoin).toEqual({ code: 'ZZ99ZZ', url: joinUrl('ZZ99ZZ') });
    for (const bad of ['ABC', 'TOOLONG1', 'AB-12C']) {
      expect((await putSettings({ leagueId: 314, leagueCode: bad })).statusCode, bad).toBe(400);
    }
    // No league → no join link even with a stored code.
    await putSettings({ leagueId: null });
    expect((await config()).leagueJoin).toBeNull();
  });

  it('migration: additive, nullable column', () => {
    const dir = resolve(API_DIR, 'prisma/migrations');
    const name = readdirSync(dir).find((d) => d.endsWith('_league_code'));
    expect(name).toBeDefined();
    const sql = readFileSync(resolve(dir, name!, 'migration.sql'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    expect(sql).toEqual(['ALTER TABLE "AppSettings" ADD COLUMN     "leagueCode" TEXT;']);
  });
});

describe('GET /v1/league/position: member', () => {
  const position = async (token: string) =>
    LeaguePositionSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/league/position', headers: bearer(token) })).json(),
    );

  beforeEach(async () => {
    fpl.standingsPageCount = 1;
    fpl.standingsByPage = new Map([
      [
        1,
        [
          {
            rank: 1,
            lastRank: 1,
            entryId: 7001,
            entryName: 'A',
            managerName: 'a',
            total: 600,
            eventTotal: 60,
          },
          {
            rank: 2,
            lastRank: 2,
            entryId: 7002,
            entryName: 'B',
            managerName: 'b',
            total: 590,
            eventTotal: 50,
          },
        ],
      ],
    ]);
    fpl.newEntries.set(CLIENT_LEAGUE_ID, [7100]);
    await putSettings({ leagueId: CLIENT_LEAGUE_ID });
  });

  it('a ranked member, a new entry (unranked), a non-member, an account without a team', async () => {
    const ranked = await registerUser(app, fpl, 7002);
    const fresh = await registerUser(app, fpl, 7100);
    const outsider = await registerUser(app, fpl, 7999);
    expect(await position(ranked.token)).toEqual({ entryId: 7002, page: 1, rank: 2, member: true });
    expect(await position(fresh.token)).toEqual({ entryId: 7100, page: null, rank: null, member: true });
    expect(await position(outsider.token)).toEqual({ entryId: 7999, page: null, rank: null, member: false });
    const noTeam = await adminToken(app, prisma, 'teamless');
    expect(await position(noTeam)).toEqual({ entryId: null, page: null, rank: null, member: false });
  });

  it('new entries are read once and shared (in flight too), re-read after the TTL', async () => {
    const fans = await Promise.all([7101, 7102, 7103, 7104].map((id) => registerUser(app, fpl, id)));
    fpl.newEntries.set(CLIENT_LEAGUE_ID, [7101, 7103]);
    fpl.calls = [];
    const results = await Promise.all(fans.map((f) => position(f.token)));
    expect(results.map((r) => r.member)).toEqual([true, false, true, false]);
    expect(fpl.calls.filter((c) => c.startsWith('getLeagueNewEntries'))).toEqual([
      `getLeagueNewEntries:${CLIENT_LEAGUE_ID}`,
    ]);
    // 7102 joins; visible after the TTL.
    fpl.newEntries.set(CLIENT_LEAGUE_ID, [7101, 7102, 7103]);
    expect((await position(fans[1]!.token)).member).toBe(false);
    clock.advance(LEAGUE_POSITION_TTL_MS);
    expect((await position(fans[1]!.token)).member).toBe(true);
  });

  it('FPL failing on new entries → member false (not an error), retried next time', async () => {
    const fresh = await registerUser(app, fpl, 7100);
    const original = fpl.getLeagueNewEntries.bind(fpl);
    fpl.getLeagueNewEntries = async () => {
      throw new Error('FPL down');
    };
    const res = await app.inject({ method: 'GET', url: '/v1/league/position', headers: bearer(fresh.token) });
    expect(res.statusCode).toBe(200);
    expect(LeaguePositionSchema.parse(res.json()).member).toBe(false);
    fpl.getLeagueNewEntries = original;
    expect((await position(fresh.token)).member).toBe(true);
  });
});

describe('registration and guests', () => {
  it('a fan whose team is not in the league registers and stays signed in', async () => {
    await putSettings({ leagueId: CLIENT_LEAGUE_ID });
    const fan = await registerUser(app, fpl, 88_001);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(fan.token) });
    expect(me.statusCode).toBe(200);
    expect(MeSchema.parse(me.json()).entryId).toBe(88_001);
    clock.advance(30 * 24 * 3_600_000);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(fan.token) })).statusCode).toBe(
      200,
    );
  });

  it('every public read works without an account (guest mode)', async () => {
    await putSettings({ leagueId: CLIENT_LEAGUE_ID });
    fpl.addEntry(777);
    fpl.picks.set('777:9', makePicks(777, 9, 1, 2));
    fpl.fixtureDetails.set(100, makeFixtureDetail(100));
    const battle = await app.inject({
      method: 'PUT',
      url: '/v1/admin/captain-battle',
      headers: bearer(admin),
      payload: {
        event: 9,
        entries: [
          { label: 'Dor', source: 'entry', entryId: 777, kind: 'custom' },
          { label: 'Community', source: 'player', playerId: 3, kind: 'community' },
        ],
      },
    });
    expect(battle.statusCode).toBe(200);
    const author = await registerUser(app, fpl, 5005);
    const post = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: bearer(author.token),
      payload: { text: 'hello guests' },
    });
    expect(post.statusCode).toBe(201);
    const postId = (post.json() as { id: string }).id;
    const item = await prisma.newsItem.create({
      data: { dedupeKey: 'x:guest', source: 'x_post', text: 'news', links: {}, publishedAt: clock.now() },
    });
    app.hot.invalidateNews();

    const routes = [
      '/health',
      '/v1/config',
      '/v1/news',
      `/v1/news/${item.id}`,
      '/v1/news/stories',
      '/v1/news/filters',
      '/v1/league/standings',
      '/v1/league/live',
      '/v1/captain-battle',
      '/v1/fpl/bootstrap',
      '/v1/fpl/fixtures?event=9',
      '/v1/fpl/fixtures/100',
      '/v1/fpl/entries/777',
      '/v1/fpl/entries/777/picks?event=9',
      '/v1/fpl/entries/777/live?event=9',
      '/v1/community/posts',
      `/v1/community/posts/${postId}`,
      `/v1/community/posts/${postId}/comments`,
    ];
    for (const url of routes) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
    }
    // The captain battle for a guest has no "mine" row; community has nothing liked or "mine".
    const forGuest = CaptainBattleSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/captain-battle' })).json(),
    );
    expect(forGuest.rows.some((r) => r.kind === 'mine')).toBe(false);
    const feed = (await app.inject({ method: 'GET', url: '/v1/community/posts' })).json() as {
      items: { mine: boolean; likedByMe: boolean }[];
    };
    expect(feed.items.every((p) => !p.mine && !p.likedByMe)).toBe(true);
    // Per-user routes still say 401 to a guest.
    for (const url of ['/v1/me', '/v1/league/position', '/v1/me/notification-prefs']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });
});
