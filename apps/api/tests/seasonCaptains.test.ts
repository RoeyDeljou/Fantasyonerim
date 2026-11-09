import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildGameweekRoundup,
  createFplService,
  createReplayFetch,
  type RoundupMemberInput,
} from '@fant/fpl';
import {
  CLIENT_HOSTS,
  FplEntryIdSchema,
  GameweekRoundupSchema,
  GameweekSchema,
  SeasonCaptainsSchema,
  type Chip,
} from '@fant/shared';
import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROUNDUP_BUILD_VERSION } from '../src/league/roundup.js';
import { computeSeasonCaptains } from '../src/league/seasonCaptains.js';
import { makeBootstrap, makeEvents, type FakeFplService } from './fakeFpl.js';
import {
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
const URL_PATH = '/v1/league/season-captains';

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl, clock } = await buildTestApp(prisma));
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function setLeague(id: number | null): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: { leagueId: id },
    create: { id: 1, leagueId: id },
  });
  app.hot.invalidateConfig();
}

interface Member {
  entryId: number;
  name: string;
  /** Captain player id (null = no captain that GW). */
  captain: number | null;
  chip?: Chip | null;
}
interface Special {
  kind: 'community' | 'fpl_lad' | 'custom';
  label: string;
  tag?: string | null;
  playerId: number | null;
  captainPoints: number;
}

/** Stores a roundup row exactly as buildRoundups would (core + captains + base captain points). */
async function store(
  event: number,
  members: Member[],
  basePoints: Record<number, number>,
  specials: Special[] = [],
  opts: { leagueId?: number; version?: number; leagueName?: string; legacyNoTag?: boolean } = {},
): Promise<void> {
  const table = members.map((m, i) => ({
    entryId: m.entryId,
    entryName: m.name,
    managerName: `Mgr ${m.entryId}`,
    rank: i + 1,
    lastRank: null,
    eventPoints: 50,
    total: 50,
    captainPlayerId: m.captain,
    chip: m.chip ?? null,
    transfers: [],
    transferCost: 0,
  }));
  const captainPoints: Record<string, number> = {};
  for (const m of members) if (m.captain !== null) captainPoints[m.captain] = basePoints[m.captain] ?? 0;
  const captains = specials.map((s, i) => ({
    key: `k${i}`,
    label: s.label,
    kind: s.kind,
    ...(opts.legacyNoTag ? {} : { tag: s.tag ?? null }),
    playerId: s.playerId,
    multiplier: 2,
    captainPoints: s.captainPoints,
  }));
  await prisma.gameweekRoundup.create({
    data: {
      leagueId: opts.leagueId ?? LEAGUE,
      event,
      leagueName: opts.leagueName ?? 'Podcast League',
      data: {
        event,
        participants: table.length,
        averages: null,
        king: null,
        table,
        biggestClimb: null,
        biggestDrop: null,
        benchPoints: null,
        bestTransfer: null,
        worstTransfer: null,
      } as unknown as Prisma.InputJsonObject,
      captains: captains as unknown as Prisma.InputJsonArray,
      captainPoints,
      builtAt: clock.now(),
      buildVersion: opts.version ?? ROUNDUP_BUILD_VERSION,
    },
  });
}

async function season(headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url: URL_PATH, headers });
  expect(res.statusCode).toBe(200);
  return { res, body: SeasonCaptainsSchema.parse(res.json()) };
}
const brief = (rows: { rank: number; name: string; points: number; gameweeks: number }[]) =>
  rows.map((r) => [r.rank, r.name, r.points, r.gameweeks]);

describe('GET /v1/league/season-captains', () => {
  it('is unavailable without a league', async () => {
    const { body, res } = await season();
    expect(body).toMatchObject({ status: 'unavailable', league: null, throughEvent: null, rows: [] });
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=120');
  });

  it('is building while the league has no stored roundup', async () => {
    await setLeague(LEAGUE);
    const { body } = await season();
    expect(body).toMatchObject({ status: 'building', league: null, throughEvent: null, rows: [] });
  });

  it('sums captain points over GWs (Triple Captain = ×3), ties share a rank, special captains rank with the teams', async () => {
    await setLeague(LEAGUE);
    // GW1 base points: 1 → 6, 2 → 13, 3 → 2, 4 → 9
    await store(
      1,
      [
        { entryId: 11, name: 'Alpha', captain: 2 }, // 13 × 2 = 26
        { entryId: 12, name: 'Bravo', captain: 1 }, // 6 × 2 = 12
        { entryId: 13, name: 'Charlie', captain: null }, // no captain: 0, not a GW
        { entryId: 14, name: 'Delta', captain: 1 }, // 12
      ],
      { 1: 6, 2: 13, 3: 2, 4: 9 },
      [
        { kind: 'community', label: 'Fans old', tag: 'Old', playerId: 1, captainPoints: 12 },
        { kind: 'fpl_lad', label: 'Lad old', tag: null, playerId: 3, captainPoints: 4 },
        { kind: 'custom', label: 'Producer', playerId: 2, captainPoints: 26 },
      ],
    );
    // GW2 base points: 1 → 10, 4 → 9
    await store(
      2,
      [
        { entryId: 11, name: 'Alpha', captain: 4, chip: '3xc' }, // 9 × 3 = 27 → 53 over 2 GWs
        { entryId: 12, name: 'Bravo', captain: 1 }, // 10 × 2 = 20 → 32
        { entryId: 13, name: 'Charlie', captain: 4 }, // 18 (his 1st counted GW)
        { entryId: 14, name: 'Delta', captain: 1 }, // 20 → 32: ties Bravo
      ],
      { 1: 10, 4: 9 },
      [
        { kind: 'community', label: 'Fans', tag: 'Crowd', playerId: null, captainPoints: 0 }, // not picked
        { kind: 'fpl_lad', label: 'Lad', tag: 'Lad', playerId: 4, captainPoints: 18 },
      ],
    );

    const { body, res } = await season();
    expect(body.status).toBe('ready');
    expect(body.league).toEqual({ id: LEAGUE, name: 'Podcast League' });
    expect(body.throughEvent).toBe(2);
    expect(brief(body.rows)).toEqual([
      [1, 'Alpha', 53, 2],
      [2, 'Bravo', 32, 2],
      [2, 'Delta', 32, 2],
      [4, 'Lad', 22, 2], // fpl_lad: 4 + 18, latest label
      [5, 'Charlie', 18, 1],
      [6, 'Fans', 12, 1], // community: GW2 had no player → 1 counted GW, latest label
    ]);
    expect(body.rows.map((r) => [r.kind, r.key, r.entryId, r.subtitle, r.tag])).toEqual([
      ['manager', '11', 11, 'Mgr 11', null],
      ['manager', '12', 12, 'Mgr 12', null],
      ['manager', '14', 14, 'Mgr 14', null],
      ['fpl_lad', 'fpl_lad', null, null, 'Lad'],
      ['manager', '13', 13, 'Mgr 13', null],
      ['community', 'community', null, null, 'Crowd'],
    ]);
    // Custom battle rows are not part of the season board.
    expect(body.rows.some((r) => r.name === 'Producer')).toBe(false);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=120');
    expect(res.headers['vary']).toMatch(/accept-encoding/);
    expect(res.headers['vary']).not.toMatch(/authorization/);
  });

  it('a special captain without a counted GW is omitted; a GW without any captain config still counts the teams', async () => {
    await setLeague(LEAGUE);
    await store(1, [{ entryId: 11, name: 'Alpha', captain: 2 }], { 2: 13 }, [
      { kind: 'community', label: 'Fans', playerId: null, captainPoints: 0 },
    ]);
    await store(2, [{ entryId: 11, name: 'Alpha', captain: 2 }], { 2: 5 }); // captains: []
    const { body } = await season();
    expect(brief(body.rows)).toEqual([[1, 'Alpha', 36, 2]]);
  });

  it('a team with no captain at all is listed with 0 points and 0 GWs; names follow the latest GW', async () => {
    await setLeague(LEAGUE);
    await store(1, [{ entryId: 11, name: 'Old name', captain: null }], {});
    await store(2, [{ entryId: 11, name: 'New name', captain: null }], {});
    expect(brief((await season()).body.rows)).toEqual([[1, 'New name', 0, 0]]);
  });

  it('is keyed by the configured league: other leagues are ignored, a league change starts over', async () => {
    await setLeague(LEAGUE);
    await store(1, [{ entryId: 11, name: 'Alpha', captain: 2 }], { 2: 13 });
    await store(1, [{ entryId: 99, name: 'Intruder', captain: 2 }], { 2: 13 }, [], {
      leagueId: 999,
      leagueName: 'Other',
    });
    const mine = (await season()).body;
    expect(mine.league?.name).toBe('Podcast League');
    expect(mine.rows.map((r) => r.name)).toEqual(['Alpha']);

    await setLeague(999);
    const other = (await season()).body;
    expect(other.league).toEqual({ id: 999, name: 'Other' });
    expect(other.rows.map((r) => r.name)).toEqual(['Intruder']);

    await setLeague(1234);
    expect((await season()).body.status).toBe('building');
  });

  it('rows still at an older build version are used as-is; FPL Lad stored as a community row is told apart by its label', async () => {
    await setLeague(LEAGUE);
    await store(
      1,
      [{ entryId: 11, name: 'Alpha', captain: 2 }],
      { 2: 13 },
      [
        { kind: 'community', label: 'קפטן הקהילה', playerId: 1, captainPoints: 12 },
        { kind: 'community', label: 'הקפטן של FPL LAD', playerId: 3, captainPoints: 4 },
      ],
      { version: 2, legacyNoTag: true },
    );
    const { body } = await season();
    expect(body.rows.map((r) => [r.kind, r.name, r.points, r.tag])).toEqual([
      ['manager', 'Alpha', 26, null],
      ['community', 'קפטן הקהילה', 12, null],
      ['fpl_lad', 'הקפטן של FPL LAD', 4, null],
    ]);
  });

  it('skips a stored row that no longer parses', async () => {
    await setLeague(LEAGUE);
    await store(1, [{ entryId: 11, name: 'Alpha', captain: 2 }], { 2: 13 });
    await prisma.gameweekRoundup.create({
      data: {
        leagueId: LEAGUE,
        event: 2,
        leagueName: 'x',
        data: { nonsense: true },
        captains: [],
        captainPoints: {},
        builtAt: clock.now(),
        buildVersion: ROUNDUP_BUILD_VERSION,
      },
    });
    const { body } = await season();
    expect([body.status, body.throughEvent]).toEqual(['ready', 1]);
    await prisma.gameweekRoundup.deleteMany({ where: { event: 1 } });
    app.hot.invalidateConfig();
    expect((await season()).body.status).toBe('building');
  });

  it("marks the hosts' own teams (shared CLIENT_HOSTS ids) without touching ranks or points; an absent host just does not appear", async () => {
    const dor = Number(CLIENT_HOSTS.dor.fplEntryId);
    const itay = Number(CLIENT_HOSTS.itay.fplEntryId);
    await setLeague(LEAGUE);
    // Itay's team is not in the league.
    await store(
      1,
      [
        { entryId: 11, name: 'Alpha', captain: 2 }, // 26
        { entryId: dor, name: 'Dorsenal', captain: 1 }, // 12
        { entryId: 13, name: 'Charlie', captain: 3 }, // 4
      ],
      { 1: 6, 2: 13, 3: 2 },
      [
        { kind: 'community', label: 'Fans', playerId: 1, captainPoints: 12 },
        { kind: 'fpl_lad', label: 'Lad', playerId: 3, captainPoints: 4 },
      ],
    );
    const { body, res } = await season();
    expect(body.rows.map((r) => [r.rank, r.name, r.points, r.host])).toEqual([
      [1, 'Alpha', 26, null],
      [2, 'Dorsenal', 12, 'dor'],
      [2, 'Fans', 12, null],
      [4, 'Charlie', 4, null],
      [4, 'Lad', 4, null],
    ]);
    // The cached body (what is sent) carries the field.
    expect(JSON.parse(res.body).rows.map((r: { host: unknown }) => r.host)).toEqual([
      null,
      'dor',
      null,
      null,
      null,
    ]);

    // Itay's team joins: flagged too.
    await store(2, [{ entryId: itay, name: 'ShawMustGoOn', captain: 2 }], { 2: 13 });
    clock.advance(60_000 + 120_000 + 1);
    const later = (await season()).body.rows;
    expect(later.find((r) => r.entryId === itay)?.host).toBe('itay');
    expect(later.filter((r) => r.host !== null).map((r) => r.host)).toEqual(
      expect.arrayContaining(['dor', 'itay']),
    );
  });

  it('is computed once a minute for everybody, served with an ETag, and refreshed when a roundup is stored', async () => {
    await setLeague(LEAGUE);
    await store(1, [{ entryId: 11, name: 'Alpha', captain: 2 }], { 2: 13 });
    const user = await registerUser(app, fpl, 11);
    const first = await season();
    const asUser = await season(bearer(user.token)); // nothing viewer-specific
    expect(asUser.res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=120');
    expect(asUser.body).toEqual(first.body);

    // A new roundup lands in the database: the shared copy is still the 60-second-old one...
    await store(2, [{ entryId: 11, name: 'Alpha', captain: 2 }], { 2: 13 });
    expect((await season()).body.throughEvent).toBe(1);
    // ...until it ages out.
    clock.advance(60_000 + 120_000 + 1);
    const later = await season();
    expect(later.body.throughEvent).toBe(2);
    expect(brief(later.body.rows)).toEqual([[1, 'Alpha', 52, 2]]);

    const etag = later.res.headers['etag'];
    expect(etag).toBeTruthy();
    const again = await app.inject({
      method: 'GET',
      url: URL_PATH,
      headers: { 'if-none-match': String(etag) },
    });
    expect(again.statusCode).toBe(304);
  });

  it('computeSeasonCaptains reads only the database', async () => {
    await store(1, [{ entryId: 11, name: 'Alpha', captain: 2 }], { 2: 13 });
    fpl.calls = [];
    const out = await computeSeasonCaptains(prisma, 314 as never, clock.now());
    expect(out.rows).toHaveLength(1);
    expect(fpl.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Real recorded data: league 4611, GW10
// ---------------------------------------------------------------------------------------------------------

interface RawPick {
  element: number;
  multiplier: number;
  is_captain: boolean;
}
interface RawDetail {
  entryName: string;
  managerName: string;
  history: unknown;
  transfers: unknown;
  picks: { active_chip: string | null; picks: RawPick[] };
}
interface RealFixture {
  detail: Record<string, RawDetail>;
  live: { elements: { id: number; stats: { total_points: number } }[] };
  bootstrapEvents: unknown;
}

describe('against the recorded league 4611, GW10', () => {
  it('season captain points of the 13 recorded members equal the roundup captain points (incl. Triple Captain and a vice armband)', async () => {
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../packages/fpl/dist/__fixtures__/real-4611-gw10.js',
    );
    const mod = (await import(pathToFileURL(path).href)) as { REAL_4611_GW10: RealFixture };
    const REAL = mod.REAL_4611_GW10;
    const ids = Object.keys(REAL.detail).map(Number);

    const service = createFplService({
      fetch: createReplayFetch((p) => {
        if (p === 'bootstrap-static/') return { events: REAL.bootstrapEvents, teams: [], elements: [] };
        if (p === 'event/10/live/') return REAL.live;
        let m = /^entry\/(\d+)\/history\/$/.exec(p);
        if (m) return REAL.detail[m[1] as string]?.history;
        m = /^entry\/(\d+)\/transfers\/$/.exec(p);
        if (m) return REAL.detail[m[1] as string]?.transfers;
        m = /^entry\/(\d+)\/event\/10\/picks\/$/.exec(p);
        if (m) return REAL.detail[m[1] as string]?.picks;
        return undefined;
      }),
      now: () => Date.parse('2026-11-09T12:00:00Z'),
    });
    const gw10 = GameweekSchema.parse(10);
    const playerPoints = await service.getEventPoints!(gw10);
    const members: RoundupMemberInput[] = await Promise.all(
      ids.map(async (id) => {
        const entryId = FplEntryIdSchema.parse(id);
        const detail = REAL.detail[String(id)] as RawDetail;
        return {
          entryId,
          entryName: detail.entryName,
          managerName: detail.managerName,
          history: await service.getEntryHistory!(entryId),
          transfers: await service.getEntryTransfers!(entryId),
          picks: await service.getEntryPicks(entryId, gw10),
        };
      }),
    );
    const core = buildGameweekRoundup({
      event: gw10,
      members,
      playerPoints,
      worldAverage: null,
      startEvent: GameweekSchema.parse(1),
    });
    const captainPoints: Record<string, number> = {};
    for (const r of core.table)
      if (r.captainPlayerId !== null)
        captainPoints[r.captainPlayerId] = playerPoints.get(r.captainPlayerId)?.points ?? 0;
    await setLeague(LEAGUE);
    await prisma.gameweekRoundup.create({
      data: {
        leagueId: LEAGUE,
        event: 10,
        leagueName: 'Fantasyonerim',
        data: core as unknown as Prisma.InputJsonObject,
        captains: [],
        captainPoints,
        builtAt: clock.now(),
        buildVersion: ROUNDUP_BUILD_VERSION,
      },
    });
    fpl.bootstrap = { ...makeBootstrap(10, 11), events: makeEvents(10, 10) };
    app.hot.cache.invalidate('fpl:bootstrap');

    // Independent expectation straight from the raw recording: the pick FPL gave the armband (multiplier ≥ 2, else
    // the picked captain) × its raw GW points.
    const raw = new Map(REAL.live.elements.map((e) => [e.id, e.stats.total_points]));
    const expected = new Map<number, number>();
    for (const id of ids) {
      const picks = (REAL.detail[String(id)] as RawDetail).picks;
      const armband = picks.picks.find((p) => p.multiplier >= 2) ?? picks.picks.find((p) => p.is_captain);
      if (!armband) continue;
      const multiplier = armband.multiplier >= 2 ? armband.multiplier : picks.active_chip === '3xc' ? 3 : 2;
      expected.set(id, (raw.get(armband.element) ?? 0) * multiplier);
    }
    expect(expected.size).toBe(13);
    expect([...expected.values()].some((p) => p > 0)).toBe(true);

    const { body } = await season();
    expect(body.throughEvent).toBe(10);
    expect(body.rows.filter((r) => r.kind === 'manager')).toHaveLength(13);
    for (const row of body.rows) {
      expect([row.entryId, row.points, row.gameweeks]).toEqual([
        row.entryId,
        expected.get(row.entryId ?? 0),
        1,
      ]);
    }

    // And the roundup page shows the same number for a member (their "mine" row reads the same stored data).
    const tc = ids.find((id) => (REAL.detail[String(id)] as RawDetail).picks.active_chip === '3xc');
    expect(tc).toBeDefined();
    const user = await registerUser(app, fpl, tc as number);
    const roundup = await app.inject({
      method: 'GET',
      url: '/v1/league/roundup?event=10',
      headers: bearer(user.token),
    });
    expect(roundup.statusCode).toBe(200);
    const mine = GameweekRoundupSchema.parse(roundup.json()).captains.find((c) => c.kind === 'mine');
    expect(mine?.multiplier).toBe(3);
    expect(mine?.captainPoints).toBe(body.rows.find((r) => r.entryId === tc)?.points);
  });
});
