import { ApiErrorSchema, LeaguePositionSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEAGUE_POSITION_TTL_MS } from '../src/perf/hotData.js';
import type { FakeFplService } from './fakeFpl.js';
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

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;

const LEAGUE = 314;
const PAGE_SIZE = 50;

/** Entry ids 5000 + rank: page p holds ranks (p−1)·50+1 … p·50. */
const entryAt = (rank: number) => 5000 + rank;

function standingsPages(pages: number): void {
  fpl.standingsPageCount = pages;
  fpl.standingsByPage = new Map(
    Array.from({ length: pages }, (_, p) => [
      p + 1,
      Array.from({ length: PAGE_SIZE }, (_, i) => {
        const rank = p * PAGE_SIZE + i + 1;
        return {
          rank,
          lastRank: rank,
          entryId: entryAt(rank),
          entryName: `Team ${rank}`,
          managerName: `Manager ${rank}`,
          total: 2000 - rank,
          eventTotal: 50,
        };
      }),
    ]),
  );
}

async function configureLeague(admin = 'admin'): Promise<void> {
  fpl.leagues.set(LEAGUE, { id: LEAGUE, name: 'Fantasyonerim League' });
  const token = await adminToken(app, prisma, admin);
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/admin/settings',
    headers: bearer(token),
    payload: {
      leagueId: LEAGUE,
      deadlineReminderMinutes: [1440, 120],
      socials: { spotifyUrl: null, appleUrl: null, instagramUrl: null, xUrl: null, whatsappUrl: null },
    },
  });
  expect(res.statusCode).toBe(200);
}

const position = (token: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/v1/league/position', headers: { ...bearer(token), ...headers } });

const standingsCalls = () => fpl.calls.filter((c) => c.startsWith(`getLeagueStandings:${LEAGUE}:`));

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl, clock } = await buildTestApp(prisma));
  standingsPages(3);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /v1/league/position', () => {
  it('finds a team on page 3: page + official rank, private + ETag (304 on revalidation)', async () => {
    await configureLeague();
    const fan = await registerUser(app, fpl, entryAt(123));
    fpl.calls = [];
    const res = await position(fan.token);
    expect(res.statusCode).toBe(200);
    expect(LeaguePositionSchema.parse(res.json())).toEqual({
      entryId: entryAt(123),
      page: 3,
      rank: 123,
      member: true,
    });
    expect(standingsCalls()).toEqual([
      `getLeagueStandings:${LEAGUE}:1`,
      `getLeagueStandings:${LEAGUE}:2`,
      `getLeagueStandings:${LEAGUE}:3`,
    ]);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const etag = String(res.headers.etag);
    expect(etag).toMatch(/^W\/".+"$/);
    expect((await position(fan.token, { 'if-none-match': etag })).statusCode).toBe(304);
  });

  it('stops at the first page that has the team', async () => {
    await configureLeague();
    const fan = await registerUser(app, fpl, entryAt(7));
    fpl.calls = [];
    expect((await position(fan.token)).json()).toEqual({
      entryId: entryAt(7),
      page: 1,
      rank: 7,
      member: true,
    });
    expect(standingsCalls()).toEqual([`getLeagueStandings:${LEAGUE}:1`]);
  });

  it('a team not in the league → page and rank null (after scanning every page once)', async () => {
    await configureLeague();
    const outsider = await registerUser(app, fpl, 9_999_999);
    fpl.calls = [];
    expect((await position(outsider.token)).json()).toEqual({
      entryId: 9_999_999,
      page: null,
      rank: null,
      member: false,
    });
    expect(standingsCalls()).toHaveLength(3);
    // Answered from the index afterwards.
    fpl.calls = [];
    expect((await position(outsider.token)).json()).toEqual({
      entryId: 9_999_999,
      page: null,
      rank: null,
      member: false,
    });
    expect(standingsCalls()).toEqual([]);
  });

  it('an account without an FPL team → all null', async () => {
    await configureLeague();
    const token = await adminToken(app, prisma, 'second-admin');
    const res = await position(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entryId: null, page: null, rank: null, member: false });
  });

  it('the index is built once for many concurrent users, and rebuilt after the standings TTL', async () => {
    await configureLeague();
    const ranks = [1, 49, 50, 51, 99, 100, 101, 120, 150, 75, 3, 140];
    const fans = await Promise.all(ranks.map((rank) => registerUser(app, fpl, entryAt(rank))));
    const outsider = await registerUser(app, fpl, 8_888_888);
    fpl.calls = [];
    const results = await Promise.all([...fans, outsider].map((f) => position(f.token)));
    expect(results.map((r) => r.json())).toEqual([
      ...ranks.map((rank) => ({
        entryId: entryAt(rank),
        page: Math.ceil(rank / PAGE_SIZE),
        rank,
        member: true,
      })),
      { entryId: 8_888_888, page: null, rank: null, member: false },
    ]);
    // Three pages read once each, for thirteen users.
    expect(standingsCalls()).toEqual([
      `getLeagueStandings:${LEAGUE}:1`,
      `getLeagueStandings:${LEAGUE}:2`,
      `getLeagueStandings:${LEAGUE}:3`,
    ]);

    // Ranks move; once the index is older than the standings TTL it is rebuilt from fresh pages.
    fpl.calls = [];
    expect((await position(fans[0]!.token)).json()).toMatchObject({ rank: 1 });
    expect(standingsCalls()).toEqual([]);
    standingsPages(3);
    const page1 = fpl.standingsByPage!.get(1)! as { rank: number; entryId: number }[];
    page1[0] = { ...page1[0]!, entryId: entryAt(1), rank: 2 };
    clock.advance(LEAGUE_POSITION_TTL_MS);
    expect((await position(fans[0]!.token)).json()).toMatchObject({ page: 1, rank: 2 });
    expect(standingsCalls()).toEqual([`getLeagueStandings:${LEAGUE}:1`]);
  });

  it('401 signed out; 404 when no league is configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/league/position' });
    expect(res.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('unauthorized');
    const fan = await registerUser(app, fpl, entryAt(5));
    const none = await position(fan.token);
    expect(none.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(none.json()).error.message).toMatch(/no league/i);
  });

  it('an admin league change drops the index', async () => {
    await configureLeague();
    const fan = await registerUser(app, fpl, entryAt(60));
    expect((await position(fan.token)).json()).toMatchObject({ page: 2, rank: 60 });
    fpl.calls = [];
    await configureLeague('another-admin'); // a settings save
    expect((await position(fan.token)).json()).toMatchObject({ page: 2, rank: 60 });
    expect(standingsCalls()).toEqual([`getLeagueStandings:${LEAGUE}:1`, `getLeagueStandings:${LEAGUE}:2`]);
  });

  it('the page is valid for the live table too (same entries on live page N as standings page N)', async () => {
    await configureLeague();
    const fan = await registerUser(app, fpl, entryAt(123));
    const { page } = LeaguePositionSchema.parse((await position(fan.token)).json());
    expect(page).toBe(3);
    // The fake's live pages mirror FplService: live page N = the managers of standings page N.
    fpl.liveLeagueByPage = new Map(
      [...fpl.standingsByPage!].map(([p, rows]) => [
        p,
        (rows as { rank: number; entryId: number; entryName: string; managerName: string }[]).map((r) => ({
          liveRank: r.rank,
          officialRank: r.rank,
          entryId: r.entryId,
          entryName: r.entryName,
          managerName: r.managerName,
          livePoints: 50,
          liveTotal: 2000,
          captainPlayerId: null,
          effectiveCaptainPlayerId: null,
          activeChip: null,
          playersYetToPlay: 0,
        })),
      ]),
    );
    const live = await app.inject({ method: 'GET', url: `/v1/league/live?page=${page}` });
    expect((live.json() as { rows: { entryId: number }[] }).rows.map((r) => r.entryId)).toContain(
      entryAt(123),
    );
  });
});
