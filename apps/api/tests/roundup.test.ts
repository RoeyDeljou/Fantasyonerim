import { ApiErrorSchema, EntryPicksSchema, GameweekRoundupSchema, type EntryPicks } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FplNotFoundError, FplUnavailableError } from '@fant/fpl';
import {
  makeBootstrap,
  makeEvents,
  makeHistory,
  makePicks,
  makeTransfer,
  upstreamDown,
  type FakeFplService,
} from './fakeFpl.js';
import {
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  type TestClock,
} from './helpers.js';
import {
  ROUNDUP_BUILD_DELAY_MS,
  ROUNDUP_BUILD_VERSION,
  ROUNDUP_REQUEST_BUDGET,
  roundupGwsPerRun,
} from '../src/league/roundup.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;

const LEAGUE = 314;
const MINUTE = 60_000;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl, clock } = await buildTestApp(prisma));
  fpl.playerPoints.set(1, 6).set(2, 13).set(3, 2).set(4, 9);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function setBootstrap(current: number | null, officialUpTo: number, next: number | null = null): void {
  fpl.bootstrap = {
    ...makeBootstrap(current, next ?? (current === null ? 1 : current + 1)),
    events: makeEvents(current, officialUpTo),
  };
  app.hot.cache.invalidate('fpl:bootstrap');
}

async function setLeague(id: number | null): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: 1 },
    update: { leagueId: id },
    create: { id: 1, leagueId: id },
  });
  app.hot.invalidateConfig();
}

/** Picks where the captain blanked and the vice got the armband (FPL's finished-GW shape). */
function vicePicks(entryId: number, event: number, captain: number, vice: number): EntryPicks {
  const base = makePicks(entryId, event, captain);
  return EntryPicksSchema.parse({
    ...base,
    picks: base.picks.map((p) =>
      p.playerId === captain
        ? { ...p, multiplier: 0 }
        : p.playerId === vice
          ? { ...p, multiplier: 2, isViceCaptain: true }
          : { ...p, isViceCaptain: false },
    ),
  });
}

/**
 * League 314 of three teams: 11 and 12 since GW1, 13 created in GW2. Captains: 11 → Haaland (2), 12 → Salah (1),
 * 13 → Saka (4). Bootstrap: current GW 3, GWs 1–2 official.
 */
function seedLeague(): void {
  fpl.leagues.set(LEAGUE, { id: LEAGUE, name: 'Fantasyonerim League' });
  fpl.standingsPageCount = 1;
  fpl.standingsRows = [
    { rank: 1, lastRank: 1, entryId: 11, entryName: 'Alpha', managerName: 'Dor', total: 170, eventTotal: 70 },
    {
      rank: 2,
      lastRank: 2,
      entryId: 12,
      entryName: 'Bravo',
      managerName: 'Itay',
      total: 130,
      eventTotal: 84,
    },
    {
      rank: 3,
      lastRank: 3,
      entryId: 13,
      entryName: 'Charlie',
      managerName: 'Moshe',
      total: 55,
      eventTotal: 55,
    },
  ];
  fpl.histories.set(
    11,
    makeHistory(11, [
      { event: 1, points: 60 },
      { event: 2, points: 70, transfersMade: 1 },
      { event: 3, points: 40 },
    ]),
  );
  fpl.histories.set(
    12,
    makeHistory(12, [
      { event: 1, points: 50 },
      { event: 2, points: 80, transfersMade: 2, transfersCost: 4 },
      { event: 3, points: 65 },
    ]),
  );
  fpl.histories.set(
    13,
    makeHistory(13, [
      { event: 2, points: 55 },
      { event: 3, points: 30 },
    ]),
  );
  fpl.transfers.set(11, [makeTransfer(2, 3, 4)]);
  for (const gw of [1, 2, 3]) {
    fpl.picks.set(`11:${gw}`, makePicks(11, gw, 2));
    fpl.picks.set(`12:${gw}`, makePicks(12, gw, 1));
    fpl.picks.set(`13:${gw}`, makePicks(13, gw, 4));
  }
  setBootstrap(3, 2);
}

const runJob = () => app.jobs.run('gameweek_roundup', { force: true });

/** First run sees the newest official GW (starts its 5-minute wait); the second, after the wait, builds it. */
async function buildAll(): Promise<void> {
  expect(await runJob()).toBe('ok');
  clock.advance(ROUNDUP_BUILD_DELAY_MS);
  expect(await runJob()).toBe('ok');
}

const storedEvents = async (leagueId = LEAGUE) =>
  (await prisma.gameweekRoundup.findMany({ where: { leagueId }, orderBy: { event: 'asc' } })).map(
    (r) => r.event,
  );

async function getRoundup(query = '', headers: Record<string, string> = {}) {
  const res = await app.inject({ method: 'GET', url: `/v1/league/roundup${query}`, headers });
  expect(res.statusCode).toBe(200);
  return { res, body: GameweekRoundupSchema.parse(res.json()) };
}

/** A 171-member-style league with 10 official GWs (current GW 11). */
async function seedBigLeague(MEMBERS: number): Promise<void> {
  fpl.leagues.set(LEAGUE, { id: LEAGUE, name: 'Big League' });
  const rows = Array.from({ length: MEMBERS }, (_, i) => ({
    rank: i + 1,
    lastRank: i + 1,
    entryId: 1000 + i,
    entryName: `Team ${i}`,
    managerName: `Manager ${i}`,
    total: 1000 - i,
    eventTotal: 50,
  }));
  fpl.standingsPageCount = 4;
  fpl.standingsByPage = new Map([1, 2, 3, 4].map((p) => [p, rows.slice((p - 1) * 50, p * 50)]));
  for (const row of rows) {
    fpl.histories.set(
      row.entryId,
      makeHistory(
        row.entryId,
        Array.from({ length: 10 }, (_, g) => ({ event: g + 1, points: 40 + ((row.entryId + g) % 30) })),
      ),
    );
    for (let gw = 1; gw <= 10; gw++)
      fpl.picks.set(`${row.entryId}:${gw}`, makePicks(row.entryId, gw, 1 + (gw % 4)));
  }
  setBootstrap(11, 10);
  await setLeague(LEAGUE);
}

describe('gameweek_roundup job', () => {
  it('builds an official GW after the 5-minute delay, newest first, then back-fills', async () => {
    seedLeague();
    await setLeague(LEAGUE);
    expect(await runJob()).toBe('ok');
    // GW2 (newest) was only just seen official: it waits; GW1 (official long ago) is built at once.
    expect(await storedEvents()).toEqual([1]);

    clock.advance(ROUNDUP_BUILD_DELAY_MS - MINUTE);
    expect(await runJob()).toBe('ok');
    expect(await storedEvents()).toEqual([1]);

    clock.advance(MINUTE);
    expect(await runJob()).toBe('ok');
    expect(await storedEvents()).toEqual([1, 2]);

    const { body } = await getRoundup('?event=2');
    expect(body.status).toBe('ready');
    expect(body.league).toEqual({ id: LEAGUE, name: 'Fantasyonerim League' });
    expect(body.participants).toBe(3);
    expect(body.table.map((r) => [r.entryId, r.rank, r.lastRank, r.eventPoints, r.total])).toEqual([
      [11, 1, 1, 70, 130],
      [12, 2, 2, 80, 130],
      [13, 3, null, 55, 55],
    ]);
    expect(body.table[0]?.transfers).toEqual([{ playerOut: 3, playerIn: 4 }]);
    expect(body.table.map((r) => r.captainPlayerId)).toEqual([2, 1, 4]);
    expect(body.averages).toEqual({ league: 68.3, world: 52 });
    expect(body.king?.entryId).toBe(12);
    expect(body.builtAt).not.toBeNull();

    // Idempotent: nothing left to do, nothing rebuilt.
    const before = await prisma.gameweekRoundup.findMany({ orderBy: { event: 'asc' } });
    fpl.calls = [];
    expect(await runJob()).toBe('ok');
    expect(fpl.calls.filter((c) => c.startsWith('getEntry'))).toEqual([]);
    expect(await prisma.gameweekRoundup.findMany({ orderBy: { event: 'asc' } })).toEqual(before);
  });

  it('does nothing without a league', async () => {
    seedLeague();
    await buildAll();
    expect(await prisma.gameweekRoundup.count()).toBe(0);
    expect(fpl.calls.some((c) => c.startsWith('getEntryHistory'))).toBe(false);
  });

  it('spreads a back-fill over runs with a bounded request budget', async () => {
    const MEMBERS = 171;
    expect(roundupGwsPerRun(MEMBERS)).toBe(3);
    await seedBigLeague(MEMBERS);

    const requests = () =>
      fpl.calls.filter((c) =>
        /^get(EntryHistory|EntryTransfers|EntryPicks|EventPoints|LeagueStandings|LeagueInfo):/.test(c),
      ).length;
    const runs: number[][] = [];
    let previous: number[] = [];
    for (let run = 0; run < 6; run++) {
      fpl.calls = [];
      expect(await runJob()).toBe('ok');
      expect(requests()).toBeLessThanOrEqual(ROUNDUP_REQUEST_BUDGET + 10);
      const now = await storedEvents();
      runs.push(now.filter((gw) => !previous.includes(gw)));
      previous = now;
      clock.advance(ROUNDUP_BUILD_DELAY_MS);
    }
    // Run 1: GW10 waits its 5 minutes, so 9, 8, 7; run 2: GW10 first, then back-fill; …
    expect(runs).toEqual([[7, 8, 9], [5, 6, 10], [2, 3, 4], [1], [], []]);
    // History and transfers once per member per run, never per GW.
    fpl.calls = [];
    await prisma.gameweekRoundup.deleteMany({ where: { event: { in: [1, 2] } } });
    expect(await runJob()).toBe('ok');
    expect(fpl.calls.filter((c) => c.startsWith('getEntryHistory:')).length).toBe(MEMBERS);
    expect(fpl.calls.filter((c) => c.startsWith('getEntryPicks:')).length).toBe(2 * MEMBERS);
  });

  it('stores nothing partial when FPL fails mid-build and retries on the next run', async () => {
    seedLeague();
    setBootstrap(2, 1);
    await setLeague(LEAGUE);
    expect(await runJob()).toBe('ok'); // GW1 first seen official: waiting
    clock.advance(ROUNDUP_BUILD_DELAY_MS);
    fpl.failPicksFor.set(12, upstreamDown());
    expect(await runJob()).toBe('failed');
    expect(await prisma.gameweekRoundup.count()).toBe(0);
    const lease = await prisma.jobLease.findUnique({ where: { name: 'gameweek_roundup' } });
    expect(lease?.lastError).toMatch(/FPL unavailable, nothing stored/);

    fpl.failPicksFor.clear();
    fpl.failEventPoints = upstreamDown();
    expect(await runJob()).toBe('failed');
    expect(await prisma.gameweekRoundup.count()).toBe(0);

    // Recovered: built at once (the 5-minute wait already passed before the failures).
    fpl.failEventPoints = null;
    expect(await runJob()).toBe('ok');
    expect(await storedEvents()).toEqual([1]);
  });

  it('skips the FPL calls while FplService is backing off', async () => {
    seedLeague();
    await setLeague(LEAGUE);
    const retryAt = new Date(clock.now().getTime() + MINUTE).toISOString();
    Object.assign(fpl, {
      getHealth: () => ({
        state: 'degraded',
        stale: true,
        lastSuccessAt: null,
        failingSince: null,
        retryAt,
        lastError: null,
      }),
    });
    expect(await runJob()).toBe('ok');
    expect(fpl.calls).toEqual([]);
  });

  it('leaves out a member whose history is a 404 (no failure)', async () => {
    seedLeague();
    await setLeague(LEAGUE);
    fpl.failHistoryFor.set(13, new FplNotFoundError('history 13'));
    fpl.picks.delete('12:2'); // picks 404 → captain blank for that team
    await buildAll();
    const { body } = await getRoundup('?event=2');
    expect(body.table.map((r) => [r.entryId, r.captainPlayerId])).toEqual([
      [11, 2],
      [12, null],
    ]);
  });

  it('keys roundups by league: a league change never serves the old league', async () => {
    seedLeague();
    await setLeague(LEAGUE);
    await buildAll();
    expect(await storedEvents()).toEqual([1, 2]);

    fpl.leagues.set(999, { id: 999, name: 'Second Chance' });
    fpl.leagueStartEvents.set(999, 2);
    await setLeague(999);
    let { body } = await getRoundup('?event=2');
    expect(body.status).toBe('building');
    expect(body.league).toBeNull();
    expect(body.table).toEqual([]);

    await buildAll();
    ({ body } = await getRoundup('?event=2'));
    expect(body.status).toBe('ready');
    expect(body.league).toEqual({ id: 999, name: 'Second Chance' });
    // GW2 is that league's first GW: no previous ranks, totals count from GW2 only.
    expect(body.table.map((r) => [r.entryId, r.total, r.lastRank])).toEqual([
      [12, 80, null],
      [11, 70, null],
      [13, 55, null],
    ]);
    // Before the league's start: stored, but its sections are blank.
    ({ body } = await getRoundup('?event=1'));
    expect(body.status).toBe('ready');
    expect(body.participants).toBeNull();
    expect(body.table).toEqual([]);
    expect(await storedEvents(LEAGUE)).toEqual([1, 2]);
    expect(await storedEvents(999)).toEqual([1, 2]);
  });

  describe('fresh reads (never cached or stale-if-error data)', () => {
    beforeEach(async () => {
      seedLeague();
      setBootstrap(2, 1);
      await setLeague(LEAGUE);
      fpl.addEntry(77);
      fpl.picks.set('77:1', makePicks(77, 1, 2));
      await prisma.captainBattle.create({
        data: {
          event: 1,
          entries: {
            create: [
              { order: 0, label: 'Community captain', kind: 'COMMUNITY', source: 'PLAYER', playerId: 1 },
              { order: 1, label: "Itay's captain", kind: 'CUSTOM', source: 'ENTRY', entryId: 12 },
              { order: 2, label: "Dor's captain", kind: 'CUSTOM', source: 'ENTRY', entryId: 77 },
            ],
          },
        },
      });
      expect(await runJob()).toBe('ok'); // GW1 first seen official: waiting
      clock.advance(ROUNDUP_BUILD_DELAY_MS);
    });

    it('passes { fresh: true } on every FPL read behind a stored roundup', async () => {
      fpl.reads = [];
      expect(await runJob()).toBe('ok');
      expect(await storedEvents()).toEqual([1]);
      const [decision, ...build] = fpl.reads;
      // Only the "is there work?" check reads the cached bootstrap; it is re-read fresh before building.
      expect(decision).toEqual({ call: 'getBootstrap', fresh: false });
      expect(build.filter((r) => !r.fresh)).toEqual([]);
      const kinds = new Set(build.map((r) => r.call.split(':')[0]));
      expect([...kinds].sort()).toEqual(
        [
          'getBootstrap',
          'getEntryHistory',
          'getEntryPicks',
          'getEntryTransfers',
          'getEventPoints',
          'getLeagueInfo',
          'getLeagueStandings',
        ].sort(),
      );
      // The captain row's non-member team was read fresh too.
      expect(build).toContainEqual({ call: 'getEntryPicks:77:1', fresh: true });
    });

    it('stores the official data even when the cache holds stale copies (captain blanked → vice)', async () => {
      // Live-GW copy of team 12's picks: captain Palmer (3) still ×2. Official: Palmer blanked, Saka (4) ×2.
      fpl.staleData.set('getEntryPicks:12:1', makePicks(12, 1, 3));
      fpl.picks.set('12:1', vicePicks(12, 1, 3, 4));
      fpl.staleData.set('getEntryHistory:11', makeHistory(11, [{ event: 1, points: 1 }]));
      fpl.staleData.set('getEventPoints:1', new Map());
      expect(await runJob()).toBe('ok');
      const { body } = await getRoundup('?event=1');
      expect(body.table.map((r) => [r.entryId, r.eventPoints, r.captainPlayerId])).toEqual([
        [11, 60, 2],
        [12, 50, 4],
      ]);
      expect(body.captains.map((c) => [c.label, c.playerId, c.captainPoints])).toEqual([
        ["Dor's captain", 2, 26],
        ["Itay's captain", 4, 18],
        ['Community captain', 1, 12],
      ]);
    });

    it.each([
      ['503', () => upstreamDown()],
      ['backoff', () => new FplUnavailableError('FPL backing off', null, 'backoff')],
    ])('a fresh read failing (%s) stores nothing, even with a stale copy available', async (_kind, error) => {
      fpl.staleData.set('getEntryHistory:12', fpl.histories.get(12));
      fpl.failHistoryFor.set(12, error());
      expect(await runJob()).toBe('failed');
      expect(await prisma.gameweekRoundup.count()).toBe(0);

      fpl.failHistoryFor.clear();
      fpl.staleData.set('getEntryPicks:77:1', makePicks(77, 1, 1));
      fpl.failPicksFor.set(77, error()); // the captain row's team
      expect(await runJob()).toBe('failed');
      expect(await prisma.gameweekRoundup.count()).toBe(0);

      fpl.failPicksFor.clear();
      expect(await runJob()).toBe('ok');
      expect(await storedEvents()).toEqual([1]);
    });
  });

  describe('official FPL standings for the newest GW', () => {
    /** FPL's table after GW2 (totals = GW1 + GW2 net points): 13 joined in GW2 → last_rank 0. */
    const officialAfterGw2 = (shift = 0) => [
      {
        rank: 1,
        lastRank: 3,
        entryId: 12,
        entryName: 'Bravo',
        managerName: 'Itay',
        total: 130 + shift,
        eventTotal: 84,
      },
      {
        rank: 2,
        lastRank: 1,
        entryId: 11,
        entryName: 'Alpha',
        managerName: 'Dor',
        total: 130 + shift,
        eventTotal: 70,
      },
      {
        rank: 3,
        lastRank: 0,
        entryId: 13,
        entryName: 'Charlie',
        managerName: 'Moshe',
        total: 55 + shift,
        eventTotal: 55,
      },
    ];

    it('uses the official rank / last rank / total and recomputes climb and drop; older GWs stay computed', async () => {
      seedLeague();
      setBootstrap(2, 2);
      fpl.standingsRows = officialAfterGw2();
      await setLeague(LEAGUE);
      await buildAll();

      const gw2 = (await getRoundup('?event=2')).body;
      expect(
        gw2.table.map((r) => [r.entryId, r.rank, r.lastRank, r.total, r.eventPoints, r.transferCost]),
      ).toEqual([
        [12, 1, 3, 130, 80, 4],
        [11, 2, 1, 130, 70, 0],
        [13, 3, null, 55, 55, 0],
      ]);
      expect(gw2.biggestClimb).toEqual({
        entryId: 12,
        entryName: 'Bravo',
        managerName: 'Itay',
        places: 2,
        eventPoints: 80,
      });
      expect(gw2.biggestDrop).toEqual({
        entryId: 11,
        entryName: 'Alpha',
        managerName: 'Dor',
        places: 1,
        eventPoints: 70,
      });
      // Points stay net of hits; the league average is unchanged.
      expect(gw2.averages).toEqual({ league: 68.3, world: 52 });
      expect(gw2.king?.entryId).toBe(12);

      // GW1 was back-filled: FPL has no GW1 table any more, so it is rebuilt from each team's history.
      const gw1 = (await getRoundup('?event=1')).body;
      expect(gw1.table.map((r) => [r.entryId, r.rank, r.lastRank, r.total])).toEqual([
        [11, 1, null, 60],
        [12, 2, null, 50],
      ]);
      expect([gw1.biggestClimb, gw1.biggestDrop]).toEqual([null, null]);
    });

    it('keeps the computed table when the official standings have moved on to a newer GW', async () => {
      seedLeague();
      setBootstrap(2, 2);
      fpl.standingsRows = officialAfterGw2(40); // GW3 points already in FPL's totals
      await setLeague(LEAGUE);
      await buildAll();
      const gw2 = (await getRoundup('?event=2')).body;
      expect(gw2.table.map((r) => [r.entryId, r.rank, r.lastRank, r.total])).toEqual([
        [11, 1, 1, 130],
        [12, 2, 2, 130],
        [13, 3, null, 55],
      ]);
      expect([gw2.biggestClimb, gw2.biggestDrop]).toEqual([null, null]);
      expect(gw2.averages).toEqual({ league: 68.3, world: 52 });
    });

    it("keeps the computed table once FPL's current GW is past the one being built", async () => {
      seedLeague(); // current GW 3, GW2 the newest official
      fpl.standingsRows = officialAfterGw2(); // totals still match GW2
      await setLeague(LEAGUE);
      await buildAll();
      const gw2 = (await getRoundup('?event=2')).body;
      expect(gw2.table.map((r) => [r.entryId, r.rank, r.lastRank])).toEqual([
        [11, 1, 1],
        [12, 2, 2],
        [13, 3, null],
      ]);
    });
  });

  describe('builder version', () => {
    it('rebuilds an older-version row with the current rules, serving the old one until it is replaced', async () => {
      seedLeague(); // current GW 3: the official table is not used for GW2
      fpl.standingsRows = [
        {
          rank: 1,
          lastRank: 3,
          entryId: 12,
          entryName: 'Bravo',
          managerName: 'Itay',
          total: 130,
          eventTotal: 84,
        },
        {
          rank: 2,
          lastRank: 1,
          entryId: 11,
          entryName: 'Alpha',
          managerName: 'Dor',
          total: 130,
          eventTotal: 70,
        },
        {
          rank: 3,
          lastRank: 0,
          entryId: 13,
          entryName: 'Charlie',
          managerName: 'Moshe',
          total: 55,
          eventTotal: 55,
        },
      ];
      await setLeague(LEAGUE);
      await buildAll();
      // As the previous code would have stored it (computed ranks, version 1).
      await prisma.gameweekRoundup.updateMany({ where: { event: 2 }, data: { buildVersion: 1 } });
      const old = await prisma.gameweekRoundup.findFirstOrThrow({ where: { event: 2 } });

      setBootstrap(2, 2); // FPL's table is GW2's
      const before = (await getRoundup('?event=2')).body;
      expect([before.status, before.table.map((r) => r.entryId)]).toEqual(['ready', [11, 12, 13]]);

      clock.advance(MINUTE);
      expect(await runJob()).toBe('ok');
      const rows = await prisma.gameweekRoundup.findMany({ where: { event: 2 } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.buildVersion).toBe(ROUNDUP_BUILD_VERSION);
      expect(rows[0]?.builtAt.getTime()).toBeGreaterThan(old.builtAt.getTime());
      // The route's cached copy was dropped: the new table at once.
      const after = (await getRoundup('?event=2')).body;
      expect(after.table.map((r) => [r.entryId, r.rank, r.lastRank])).toEqual([
        [12, 1, 3],
        [11, 2, 1],
        [13, 3, null],
      ]);
      expect(after.biggestClimb?.entryId).toBe(12);
      // GW1 was current already: untouched.
      expect((await prisma.gameweekRoundup.findFirstOrThrow({ where: { event: 1 } })).buildVersion).toBe(
        ROUNDUP_BUILD_VERSION,
      );
    });

    it('never rebuilds a current-version row', async () => {
      seedLeague();
      await setLeague(LEAGUE);
      await buildAll();
      const before = await prisma.gameweekRoundup.findMany({ orderBy: { event: 'asc' } });
      expect(before.map((r) => r.buildVersion)).toEqual([ROUNDUP_BUILD_VERSION, ROUNDUP_BUILD_VERSION]);
      fpl.calls = [];
      clock.advance(ROUNDUP_BUILD_DELAY_MS);
      expect(await runJob()).toBe('ok');
      expect(fpl.calls.filter((c) => c.startsWith('getEntry'))).toEqual([]);
      expect(await prisma.gameweekRoundup.findMany({ orderBy: { event: 'asc' } })).toEqual(before);
    });

    it('rebuilds older-version rows newest first within the per-run budget', async () => {
      await seedBigLeague(171);
      await setLeague(LEAGUE);
      for (let run = 0; run < 4; run++) {
        expect(await runJob()).toBe('ok');
        clock.advance(ROUNDUP_BUILD_DELAY_MS);
      }
      expect(await storedEvents()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      await prisma.gameweekRoundup.updateMany({ data: { buildVersion: 1 } });
      // A missing GW and outdated ones share the budget, newest first.
      await prisma.gameweekRoundup.deleteMany({ where: { event: 9 } });

      const current = async () =>
        (await prisma.gameweekRoundup.findMany({ where: { buildVersion: ROUNDUP_BUILD_VERSION } }))
          .map((r) => r.event)
          .sort((a, b) => a - b);
      const runs: number[][] = [];
      let previous: number[] = [];
      for (let run = 0; run < 5; run++) {
        expect(await runJob()).toBe('ok');
        const now = await current();
        runs.push(now.filter((gw) => !previous.includes(gw)));
        previous = now;
        // The outdated rows are served meanwhile: always one row per GW except the missing one until rebuilt.
        expect((await prisma.gameweekRoundup.count()) >= 9).toBe(true);
        clock.advance(ROUNDUP_BUILD_DELAY_MS);
      }
      expect(runs).toEqual([[8, 9, 10], [5, 6, 7], [2, 3, 4], [1], []]);
      expect(await prisma.gameweekRoundup.count()).toBe(10);
    });
  });

  describe('captain rows', () => {
    beforeEach(async () => {
      seedLeague();
      await setLeague(LEAGUE);
      // Team 12 (a member): captain Palmer (3) blanked, vice Saka (4) got the armband → 9 × 2.
      fpl.picks.set('12:1', vicePicks(12, 1, 3, 4));
      // Team 77 (not a member): Triple Captain on Haaland (2) → 13 × 3.
      fpl.addEntry(77);
      fpl.picks.set('77:1', makePicks(77, 1, 2, 3));
      fpl.picks.set('77:2', makePicks(77, 2, 1));
      fpl.eventPoints.set(
        2,
        new Map([
          [1, 10],
          [2, 1],
          [3, 0],
          [4, 7],
        ]),
      );
    });

    it('scores player rows × 2 and team rows by the armband × the team multiplier, sorted', async () => {
      await prisma.captainBattle.create({
        data: {
          event: 1,
          entries: {
            create: [
              {
                order: 0,
                label: 'Community captain',
                kind: 'COMMUNITY',
                tag: 'Fans',
                source: 'PLAYER',
                playerId: 1,
              },
              { order: 4, label: 'FPL Lad', kind: 'FPL_LAD', source: 'PLAYER', playerId: 3 },
              { order: 1, label: "Producer's pick", kind: 'CUSTOM', source: 'PLAYER', playerId: 2 },
              { order: 2, label: "Itay's captain", kind: 'CUSTOM', source: 'ENTRY', entryId: 12 },
              { order: 3, label: "Dor's captain", kind: 'CUSTOM', source: 'ENTRY', entryId: 77 },
            ],
          },
        },
      });
      await buildAll();

      const gw1 = (await getRoundup('?event=1')).body;
      expect(
        gw1.captains.map((c) => [c.label, c.kind, c.tag, c.playerId, c.multiplier, c.captainPoints]),
      ).toEqual([
        ["Dor's captain", 'custom', null, 2, 3, 39],
        ["Producer's pick", 'custom', null, 2, 2, 26],
        ["Itay's captain", 'custom', null, 4, 2, 18],
        ['Community captain', 'community', 'Fans', 1, 2, 12],
        ['FPL Lad', 'fpl_lad', null, 3, 2, 4],
      ]);

      // GW2 has no battle of its own: the GW1 battle's team rows carry over (as in the live battle), the
      // hand-picked rows belonged to GW1.
      const gw2 = (await getRoundup('?event=2')).body;
      expect(gw2.captains.map((c) => [c.label, c.playerId, c.captainPoints])).toEqual([
        ["Itay's captain", 1, 20],
        ["Dor's captain", 1, 20],
      ]);
    });

    it('stores [] when no captain battle was configured', async () => {
      await buildAll();
      expect((await getRoundup('?event=1')).body.captains).toEqual([]);
      const rows = await prisma.gameweekRoundup.findMany();
      expect(rows.map((r) => r.captains)).toEqual([[], []]);
    });
  });
});

describe('GET /v1/league/roundup', () => {
  it('is unavailable without a league', async () => {
    seedLeague();
    const { body, res } = await getRoundup();
    expect(body.status).toBe('unavailable');
    expect(body.event).toBe(2);
    expect(body.events).toEqual([1, 2, 3]);
    expect(body.league).toBeNull();
    expect(res.headers['cache-control']).toMatch(/^public/);
  });

  it('defaults to the latest official GW; pending / building / ready per GW', async () => {
    seedLeague();
    await setLeague(LEAGUE);
    let { body } = await getRoundup();
    expect([body.event, body.status, body.captains, body.builtAt]).toEqual([2, 'building', [], null]);
    expect((await getRoundup('?event=3')).body.status).toBe('pending');
    expect((await getRoundup('?event=1')).body.status).toBe('building');

    await buildAll();
    ({ body } = await getRoundup());
    expect([body.event, body.status, body.participants]).toEqual([2, 'ready', 3]);
    expect((await getRoundup('?event=1')).body.status).toBe('ready');
    expect((await getRoundup('?event=3')).body.status).toBe('pending');
  });

  it('serves the current GW as pending before any GW is official', async () => {
    seedLeague();
    await setLeague(LEAGUE);
    setBootstrap(null, 0, 1);
    const { body } = await getRoundup();
    expect([body.event, body.status, body.events]).toEqual([1, 'pending', [1]]);
  });

  it.each(['?event=0', '?event=39', '?event=abc', '?event=1.5', '?event=4'])('400s for %s', async (query) => {
    seedLeague();
    await setLeague(LEAGUE);
    const res = await app.inject({ method: 'GET', url: `/v1/league/roundup${query}` });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('bad_request');
  });

  describe('the viewer\'s "mine" captain row and caching', () => {
    beforeEach(async () => {
      seedLeague();
      await setLeague(LEAGUE);
      await prisma.captainBattle.create({
        data: {
          event: 2,
          entries: {
            create: [
              { order: 0, label: 'Community captain', kind: 'COMMUNITY', source: 'PLAYER', playerId: 4 },
            ],
          },
        },
      });
      await buildAll();
    });

    it('rows stored before tags / fpl_lad existed (no `tag` key) still parse, with a null tag', async () => {
      const legacy = [
        {
          key: 'a',
          label: 'Community captain',
          kind: 'community',
          playerId: 4,
          multiplier: 2,
          captainPoints: 18,
        },
      ];
      await prisma.gameweekRoundup.updateMany({
        where: { event: 2 },
        data: { captains: legacy, buildVersion: 2 },
      });
      app.hot.cache.invalidate('league:roundup:');
      const { body } = await getRoundup('?event=2');
      expect(body.status).toBe('ready');
      expect(body.captains.map((c) => [c.kind, c.tag])).toEqual([['community', null]]);
    });

    it('guests get no mine row and a public, short-lived response', async () => {
      const { body, res } = await getRoundup('?event=2');
      expect(body.captains.map((c) => c.kind)).toEqual(['community']);
      expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=120');
      expect(res.headers['vary']).toMatch(/authorization/);
    });

    it('a member gets their stored captain (no FPL call) in a private response', async () => {
      const { token } = await registerUser(app, fpl, 11);
      fpl.calls = [];
      const { body, res } = await getRoundup('?event=2', bearer(token));
      expect(
        body.captains.map((c) => [c.key, c.kind, c.label, c.playerId, c.multiplier, c.captainPoints]),
      ).toEqual([
        ['me', 'mine', 'mine', 2, 2, 26],
        [expect.any(String), 'community', 'Community captain', 4, 2, 18],
      ]);
      expect(fpl.calls.filter((c) => c.startsWith('getEntryPicks'))).toEqual([]);
      expect(res.headers['cache-control']).toBe('private, no-cache');
      expect(res.headers['vary']).toMatch(/authorization/);
      // The shared response is untouched for guests.
      expect((await getRoundup('?event=2')).body.captains).toHaveLength(1);
    });

    it('a non-member gets their captain from their picks', async () => {
      const { token } = await registerUser(app, fpl, 50);
      fpl.picks.set('50:2', makePicks(50, 2, 3, 3));
      const { body } = await getRoundup('?event=2', bearer(token));
      expect(body.captains.map((c) => [c.kind, c.playerId, c.multiplier, c.captainPoints])).toEqual([
        ['community', 4, 2, 18],
        ['mine', 3, 3, 6],
      ]);
    });

    it('includes the mine row even without a captain battle for that GW', async () => {
      const { token } = await registerUser(app, fpl, 12);
      const { body } = await getRoundup('?event=1', bearer(token));
      expect(body.captains.map((c) => [c.kind, c.playerId, c.captainPoints])).toEqual([['mine', 1, 12]]);
    });

    it('a signed-in fan without a team that GW gets the shared roundup, privately', async () => {
      const { token } = await registerUser(app, fpl, 51); // no picks → 404
      const { body, res } = await getRoundup('?event=2', bearer(token));
      expect(body.captains.map((c) => c.kind)).toEqual(['community']);
      expect(res.headers['cache-control']).toBe('private, no-cache');
    });

    it('no mine row on a GW that is not ready', async () => {
      const { token } = await registerUser(app, fpl, 11);
      const { body } = await getRoundup('?event=3', bearer(token));
      expect([body.status, body.captains]).toEqual(['pending', []]);
    });
  });
});
