import {
  FplEntryIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  GameweekRoundupSchema,
  GameweekSchema,
  type EntryPicks,
  type FplPlayerId,
  type Gameweek,
} from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { REAL_4611_GW10 } from './__fixtures__/real-4611-gw10.js';
import { createFplService } from './client.js';
import { createDemoFplService, DEMO_ENTRIES, DEMO_FIRST_ENTRY_ID, DEMO_ENTRY_COUNT } from './demo/index.js';
import type { EntryHistory, EntryHistoryEvent, EntryTransfer, EventPoints } from './dto.js';
import { createReplayFetch, replayStatus, type ReplayResolver } from './replay.js';
import {
  buildGameweekRoundup,
  netTransfers,
  RoundupCoreSchema,
  type RoundupCore,
  type RoundupMemberInput,
} from './roundup.js';
import { FplNotFoundError, FplUnavailableError, type FplService } from './service.js';

const gw = (n: number): Gameweek => GameweekSchema.parse(n);
const pid = (n: number): FplPlayerId => FplPlayerIdSchema.parse(n);
const eid = (n: number) => FplEntryIdSchema.parse(n);
const LEAGUE = FplLeagueIdSchema.parse(4611);

// ---------------------------------------------------------------------------------------------------------
// Real recorded data (league 4611, GW10) replayed through the real service
// ---------------------------------------------------------------------------------------------------------

interface Detail {
  entryName: string;
  managerName: string;
  history: unknown;
  transfers: unknown;
  picks: unknown;
}
const REAL = REAL_4611_GW10;
const DETAIL: Readonly<Record<string, Detail>> = REAL.detail;
const DETAIL_IDS = Object.keys(DETAIL).map(Number);
const STANDINGS = REAL.standings as readonly (readonly number[])[];
const HISTORIES = new Map(
  (REAL.histories as unknown as readonly (readonly [number, readonly (readonly number[])[]])[]).map(
    ([e, rows]) => [e, rows],
  ),
);

/** A compact history row back into FPL's raw shape (fields the builder doesn't read are filler). */
const rawHistory = (entryId: number) => {
  const detail = DETAIL[String(entryId)];
  if (detail) return detail.history;
  const rows = HISTORIES.get(entryId);
  if (!rows) return undefined;
  return {
    current: rows.map(([event, points, total, transfers, cost, bench]) => ({
      event,
      points,
      total_points: total,
      rank: null,
      overall_rank: null,
      bank: 0,
      value: 1000,
      event_transfers: transfers,
      event_transfers_cost: cost,
      points_on_bench: bench,
    })),
    past: [],
    chips: [],
  };
};

function realService(options: { calls?: string[]; override?: ReplayResolver } = {}): FplService {
  const resolve: ReplayResolver = (path, query) => {
    const o = options.override?.(path, query);
    if (o !== undefined) return o;
    if (path === 'bootstrap-static/') return { events: REAL.bootstrapEvents, teams: [], elements: [] };
    if (path === 'event/10/live/') return REAL.live;
    if (path === 'leagues-classic/4611/standings/')
      return { league: REAL.league, standings: { has_next: false, page: 1, results: [] } };
    let m = /^entry\/(\d+)\/history\/$/.exec(path);
    if (m) return rawHistory(Number(m[1]));
    m = /^entry\/(\d+)\/transfers\/$/.exec(path);
    if (m) return DETAIL[m[1] as string]?.transfers;
    m = /^entry\/(\d+)\/event\/10\/picks\/$/.exec(path);
    if (m) return DETAIL[m[1] as string]?.picks;
    return undefined;
  };
  const calls = options.calls;
  return createFplService({
    fetch: createReplayFetch(resolve, calls ? { onRequest: (k) => calls.push(k) } : {}),
    now: () => Date.parse('2026-11-09T12:00:00Z'),
  });
}

const req = <T>(f: T | undefined): T => {
  if (f === undefined) throw new Error('createFplService must implement the roundup methods');
  return f;
};

async function realMembers(service: FplService, ids: readonly number[]): Promise<RoundupMemberInput[]> {
  return Promise.all(
    ids.map(async (id): Promise<RoundupMemberInput> => {
      const detail = DETAIL[String(id)];
      const entryId = eid(id);
      return {
        entryId,
        entryName: detail?.entryName ?? `Team ${id}`,
        managerName: detail?.managerName ?? `Manager ${id}`,
        history: await req(service.getEntryHistory)(entryId),
        transfers: detail ? await req(service.getEntryTransfers)(entryId) : null,
        picks: detail ? await service.getEntryPicks(entryId, gw(10)) : null,
      };
    }),
  );
}

/** The 13 detailed members in FPL's standings order. */
const DETAIL_IN_ORDER = STANDINGS.map((r) => r[0] as number).filter((e) => DETAIL_IDS.includes(e));

async function realRoundup(): Promise<{ core: RoundupCore; service: FplService }> {
  const service = realService();
  const members = await realMembers(service, DETAIL_IN_ORDER);
  const bootstrap = await service.getBootstrap();
  const core = buildGameweekRoundup({
    event: gw(10),
    members,
    playerPoints: await req(service.getEventPoints)(gw(10)),
    worldAverage: bootstrap.events.find((e) => e.id === 10)?.averageScore ?? null,
    startEvent: (await req(service.getLeagueInfo)(LEAGUE)).startEvent,
  });
  return { core, service };
}

const rowOf = (core: RoundupCore, entry: number) => {
  const row = core.table.find((r) => r.entryId === entry);
  if (!row) throw new Error(`no row for ${entry}`);
  return row;
};

describe('FplService roundup data (real recorded FPL responses)', () => {
  it('getEntryHistory: points net of hits, gross kept, chips mapped, sorted', async () => {
    const h = await req(realService().getEntryHistory)(eid(80759));
    const gw10 = h.events.find((e) => e.event === 10) as EntryHistoryEvent;
    expect(gw10).toMatchObject({ grossPoints: 80, transfersCost: 12, points: 68, transfersMade: 4 });
    expect(h.events.map((e) => e.event)).toEqual([...h.events.map((e) => e.event)].sort((a, b) => a - b));
    // The overall total = Σ (points − cost) from the first GW.
    expect(h.events.reduce((s, e) => s + e.points, 0)).toBe(gw10.totalPoints);

    const late = await req(realService().getEntryHistory)(eid(11141975));
    expect(late.events[0]?.event).toBe(8);
    expect(late.chips).toEqual([{ chip: 'bboost', event: 10 }]);
  });

  it('getEntryTransfers: oldest first, ids branded, costs kept', async () => {
    const t = await req(realService().getEntryTransfers)(eid(219951));
    const times = t.map((x) => Date.parse(x.time));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const gw10 = t.filter((x) => x.event === 10);
    expect(gw10.map((x) => [x.playerOut, x.playerIn])).toEqual([
      [251, 560],
      [560, 1],
      [8, 566],
    ]);
    expect(gw10[0]?.playerInCost).toEqual(expect.any(Number));
  });

  it('getEventPoints: one live call for every player, memoized per live payload', async () => {
    const calls: string[] = [];
    const service = realService({ calls });
    const [a, b] = await Promise.all([
      req(service.getEventPoints)(gw(10)),
      req(service.getEventPoints)(gw(10)),
    ]);
    expect(a).toBe(b);
    expect(calls.filter((c) => c === 'event/10/live/')).toHaveLength(1);
    expect(a.size).toBe(REAL.live.elements.length);
    expect(a.get(pid(249))).toEqual({ points: 16, minutes: expect.any(Number) });
  });

  it('getLeagueInfo: start_event from the standings league block', async () => {
    expect(await req(realService().getLeagueInfo)(LEAGUE)).toEqual({
      id: 4611,
      name: 'Fantasyonerim',
      startEvent: 1,
    });
  });

  it('caches history / transfers and shares in-flight requests', async () => {
    const calls: string[] = [];
    const service = realService({ calls });
    await Promise.all([
      req(service.getEntryHistory)(eid(3690)),
      req(service.getEntryHistory)(eid(3690)),
      req(service.getEntryTransfers)(eid(3690)),
      req(service.getEntryTransfers)(eid(3690)),
    ]);
    await req(service.getEntryHistory)(eid(3690));
    await req(service.getEntryTransfers)(eid(3690));
    expect(calls.filter((c) => c === 'entry/3690/history/')).toHaveLength(1);
    expect(calls.filter((c) => c === 'entry/3690/transfers/')).toHaveLength(1);
  });

  it('unknown entry → FplNotFoundError; 503 / 429 → FplUnavailableError', async () => {
    const s = realService({
      override: (path) =>
        path === 'entry/5/transfers/'
          ? replayStatus(503)
          : path === 'entry/6/history/'
            ? replayStatus(429)
            : undefined,
    });
    await expect(req(s.getEntryHistory)(eid(999))).rejects.toBeInstanceOf(FplNotFoundError);
    await expect(req(s.getEntryTransfers)(eid(999))).rejects.toBeInstanceOf(FplNotFoundError);
    await expect(req(s.getEntryTransfers)(eid(5))).rejects.toBeInstanceOf(FplUnavailableError);
    const s2 = realService({
      override: (path) => (path === 'entry/6/history/' ? replayStatus(429) : undefined),
    });
    await expect(req(s2.getEntryHistory)(eid(6))).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('finished-GW picks: FPL multipliers already include auto-subs and the vice promotion', async () => {
    const service = realService();
    const live = await req(service.getEventPoints)(gw(10));
    for (const id of DETAIL_IDS) {
      const picks = await service.getEntryPicks(eid(id), gw(10));
      const gross = picks.points + picks.transfersCost;
      const counted = picks.picks.reduce((s, p) => s + (live.get(p.playerId)?.points ?? 0) * p.multiplier, 0);
      expect(counted, `entry ${id}`).toBe(gross);
    }
    // 2900498: captain 0 min → multiplier 0, the vice got ×2; the subbed-in bench player sits in the XI.
    const vice = await service.getEntryPicks(eid(2900498), gw(10));
    const captain = vice.picks.find((p) => p.isCaptain);
    const vc = vice.picks.find((p) => p.isViceCaptain);
    expect(captain?.multiplier).toBe(0);
    expect(vc?.multiplier).toBe(2);
    expect(vice.picks.filter((p) => p.slot <= 11).every((p) => p.multiplier > 0 || p.isCaptain)).toBe(true);
  });
});

describe('buildGameweekRoundup — real league 4611, GW10 (13 recorded members)', () => {
  it('is schema-valid, deterministic and composes into GameweekRoundup', async () => {
    const { core } = await realRoundup();
    expect(RoundupCoreSchema.parse(core)).toEqual(core);
    expect((await realRoundup()).core).toEqual(core);
    const full = GameweekRoundupSchema.parse({
      ...core,
      status: 'ready',
      events: [gw(10)],
      league: { id: LEAGUE, name: 'Fantasyonerim' },
      captains: [],
      builtAt: '2026-11-09T12:00:00.000Z',
    });
    expect(full.table).toHaveLength(13);
  });

  it('table: ranks with FPL tie-break (fewer transfers), shared rank, movement, totals', async () => {
    const { core } = await realRoundup();
    expect(core.table.map((r) => [r.entryId, r.rank, r.lastRank, r.eventPoints, r.total])).toEqual([
      [2548084, 1, 1, 81, 752],
      [219951, 2, 2, 69, 721],
      [536571, 3, 6, 79, 710],
      // 707 × 3: 570055 made 4 transfers, the other two 6 each → they share 5th.
      [570055, 4, 3, 57, 707],
      [249403, 5, 4, 61, 707],
      [3690, 5, 5, 74, 707],
      [178722, 7, 7, 63, 642],
      [80759, 8, 8, 68, 628],
      [3051237, 9, 9, 57, 585],
      [18370, 10, 10, 45, 559],
      [1037273, 11, 11, 85, 549],
      [2900498, 12, 12, 50, 473],
      [11141975, 13, 13, 85, 228],
    ]);
    expect(core.participants).toBe(13);
    expect(core.averages).toEqual({ league: 67.2, world: 55 });
  });

  it('row details: transfer hit, chips, captains (vice armband, Triple Captain)', async () => {
    const { core } = await realRoundup();
    expect(rowOf(core, 80759)).toMatchObject({ transferCost: 12, eventPoints: 68, chip: null });
    expect(rowOf(core, 80759).transfers).toHaveLength(4);
    expect(rowOf(core, 2900498).captainPlayerId).toBe(426); // the vice: the captain played 0 minutes
    expect(rowOf(core, 1037273)).toMatchObject({ chip: '3xc', captainPlayerId: 411 });
    expect(rowOf(core, 178722).chip).toBe('freehit');
    expect(rowOf(core, 18370).chip).toBe('wildcard');
    expect(rowOf(core, 3690).transfers).toEqual([]);
    // Chain 251→560, 560→1 collapses to 251→1.
    expect(rowOf(core, 219951).transfers).toEqual([
      { playerOut: 251, playerIn: 1 },
      { playerOut: 8, playerIn: 566 },
    ]);
    // Free Hit: 14 transfers with 3 chains → 11 net.
    expect(rowOf(core, 178722).transfers).toHaveLength(11);
  });

  it('king: 85-point tie goes to the higher total; TC top scorers', async () => {
    const { core } = await realRoundup();
    expect(core.king).toMatchObject({ entryId: 1037273, points: 85, chip: '3xc', captainPlayerId: 411 });
    expect(core.king?.topPlayers).toEqual([
      { playerId: 504, points: 12 },
      { playerId: 124, points: 10 },
      { playerId: 399, points: 9 },
      { playerId: 79, points: 9 },
    ]);
    expect(core.king?.benchBoostPoints).toBeNull();
  });

  it('movers: climb by places; a drop tie goes to the higher GW points', async () => {
    const { core } = await realRoundup();
    expect(core.biggestClimb).toMatchObject({ entryId: 536571, places: 3, eventPoints: 79 });
    // 570055 (3→4, 57 pts) and 249403 (4→5, 61 pts) both dropped 1.
    expect(core.biggestDrop).toMatchObject({ entryId: 249403, places: 1, eventPoints: 61 });
  });

  it('bench: highest points_on_bench without Bench Boost, with the bench players', async () => {
    const { core, service } = await realRoundup();
    const picks = await service.getEntryPicks(eid(219951), gw(10));
    const live = await req(service.getEventPoints)(gw(10));
    expect(core.benchPoints).toMatchObject({ entryId: 219951, points: 23 });
    expect(core.benchPoints?.players).toEqual(
      picks.picks
        .filter((p) => p.slot > 11)
        .map((p) => ({ playerId: p.playerId, points: live.get(p.playerId)?.points ?? 0 })),
    );
    expect(core.benchPoints?.players.reduce((s, p) => s + p.points, 0)).toBe(23);
  });

  it('best / worst transfer skip Wildcard and Free Hit; worst tie → lower in-points', async () => {
    const { core } = await realRoundup();
    expect(core.bestTransfer).toMatchObject({
      entryId: 80759,
      playerOut: { playerId: 464, points: 2 },
      playerIn: { playerId: 249, points: 16 },
      gain: 14,
      transferCost: 12,
    });
    // −3 twice: 219951 8→566 (in 3) and 249403 480→40 (in 2). The Wildcard's 399→53 (−7) and the Free
    // Hit's 124→212 (−10) don't count.
    expect(core.worstTransfer).toMatchObject({
      entryId: 249403,
      playerOut: { playerId: 480, points: 5 },
      playerIn: { playerId: 40, points: 2 },
      gain: -3,
      transferCost: 0,
    });
  });

  it('Bench Boost king: benchBoostPoints = what the bench added', async () => {
    const service = realService();
    const members = await realMembers(service, [11141975, 536571]);
    const core = buildGameweekRoundup({
      event: gw(10),
      members,
      playerPoints: await req(service.getEventPoints)(gw(10)),
      worldAverage: 55,
    });
    expect(core.king).toMatchObject({ entryId: 11141975, points: 85, chip: 'bboost', benchBoostPoints: 21 });
    // Both used Bench Boost → no "points on the bench" section.
    expect(core.benchPoints).toBeNull();
  });

  it('a team created in GW8 is absent before it, has no lastRank in its first GW', async () => {
    const service = realService();
    const members = await realMembers(service, DETAIL_IN_ORDER);
    const playerPoints: EventPoints = new Map();
    const at = (n: number) =>
      buildGameweekRoundup({ event: gw(n), members, playerPoints, worldAverage: null });
    expect(at(7).table.some((r) => r.entryId === 11141975)).toBe(false);
    expect(at(7).participants).toBe(12);
    expect(at(8).table.find((r) => r.entryId === 11141975)?.lastRank).toBeNull();
    expect(at(9).table.find((r) => r.entryId === 11141975)?.lastRank).toBe(13);
  });
});

describe('buildGameweekRoundup — whole league 4611 vs FPL’s own standings', () => {
  it('GW10 rank/total = FPL rank/total for all 171; GW9 rank = FPL last_rank', async () => {
    const service = realService();
    const order = STANDINGS.map((r) => r[0] as number);
    const members = (await realMembers(service, order)).map((m) => ({ ...m, transfers: null, picks: null }));
    const core = buildGameweekRoundup({ event: gw(10), members, playerPoints: new Map(), worldAverage: 55 });
    expect(core.table).toHaveLength(171);
    const fpl = new Map(STANDINGS.map(([e, rank, lastRank, total]) => [e, { rank, lastRank, total }]));
    for (const row of core.table) {
      expect({ entry: row.entryId, rank: row.rank, total: row.total }).toEqual({
        entry: row.entryId,
        rank: fpl.get(row.entryId)?.rank,
        total: fpl.get(row.entryId)?.total,
      });
    }
    // FPL's last_rank was computed before 3 members joined the league (last_rank 0): leave them out.
    const before = members.filter((m) => fpl.get(m.entryId)?.lastRank !== 0);
    expect(before).toHaveLength(168);
    const gw9 = buildGameweekRoundup({
      event: gw(9),
      members: before,
      playerPoints: new Map(),
      worldAverage: 47,
    });
    for (const row of gw9.table)
      expect([row.entryId, row.rank]).toEqual([row.entryId, fpl.get(row.entryId)?.lastRank]);
    // Display order of the full table = FPL's standings order (rank_sort).
    expect(core.table.map((r) => r.entryId)).toEqual(order);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Synthetic edge cases (DTO-level inputs)
// ---------------------------------------------------------------------------------------------------------

type Row = [event: number, points: number, transfers?: number, cost?: number, bench?: number];

function history(entry: number, rows: readonly Row[], chips: EntryHistory['chips'] = []): EntryHistory {
  let total = 0;
  return {
    entryId: eid(entry),
    events: rows.map(([event, points, transfers = 0, cost = 0, bench = 0]) => {
      total += points;
      return {
        event: gw(event),
        points,
        grossPoints: points + cost,
        totalPoints: total,
        transfersMade: transfers,
        transfersCost: cost,
        pointsOnBench: bench,
        overallRank: null,
        rankInGameweek: null,
        bank: 0,
        value: 1000,
      };
    }),
    chips,
  };
}

/** Picks: 15 players `base + 1 … base + 15`; captain slot 1, vice slot 2 unless overridden. */
function picks(
  entry: number,
  event: number,
  base: number,
  opts: { multipliers?: Partial<Record<number, number>>; chip?: EntryPicks['activeChip'] } = {},
): EntryPicks {
  return {
    entryId: eid(entry),
    event: gw(event),
    activeChip: opts.chip ?? null,
    chipsUsed: [],
    picks: Array.from({ length: 15 }, (_, i) => {
      const slot = i + 1;
      const dflt = slot === 1 ? (opts.chip === '3xc' ? 3 : 2) : slot <= 11 || opts.chip === 'bboost' ? 1 : 0;
      return {
        playerId: pid(base + slot),
        slot,
        multiplier: opts.multipliers?.[slot] ?? dflt,
        isCaptain: slot === 1,
        isViceCaptain: slot === 2,
      };
    }),
    points: 0,
    pointsOnBench: 0,
    transfersMade: 0,
    transfersCost: 0,
    bank: 0,
    value: 1000,
    overallRank: null,
    rankInGameweek: null,
  };
}

const transfer = (event: number, out: number, inn: number, minute = 0): EntryTransfer => ({
  event: gw(event),
  playerOut: pid(out),
  playerIn: pid(inn),
  playerInCost: null,
  playerOutCost: null,
  time: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
});

const member = (
  entry: number,
  h: EntryHistory | null,
  extra: Partial<Pick<RoundupMemberInput, 'transfers' | 'picks'>> = {},
): RoundupMemberInput => ({
  entryId: eid(entry),
  entryName: `Team ${entry}`,
  managerName: `Manager ${entry}`,
  history: h,
  transfers: extra.transfers ?? null,
  picks: extra.picks ?? null,
});

const points = (entries: Record<number, number>): EventPoints =>
  new Map(
    Object.entries(entries).map(([id, p]) => [pid(Number(id)), { points: p, minutes: p > 0 ? 90 : 0 }]),
  );

describe('buildGameweekRoundup — edge cases', () => {
  it('no members / no data: every section null, table empty', () => {
    const core = buildGameweekRoundup({
      event: gw(3),
      members: [],
      playerPoints: new Map(),
      worldAverage: null,
    });
    expect(core).toEqual({
      event: 3,
      participants: null,
      averages: null,
      king: null,
      table: [],
      biggestClimb: null,
      biggestDrop: null,
      benchPoints: null,
      bestTransfer: null,
      worstTransfer: null,
    });
    const onlyWorld = buildGameweekRoundup({
      event: gw(3),
      members: [],
      playerPoints: new Map(),
      worldAverage: 51,
    });
    expect(onlyWorld.averages).toEqual({ league: null, world: 51 });
  });

  it('a GW with no transfers: best / worst null; no bench points → bench null', () => {
    const members = [
      member(
        1,
        history(1, [
          [1, 50],
          [2, 60],
        ]),
      ),
      member(
        2,
        history(2, [
          [1, 40],
          [2, 70],
        ]),
      ),
    ];
    const core = buildGameweekRoundup({ event: gw(2), members, playerPoints: new Map(), worldAverage: 58 });
    expect(core.bestTransfer).toBeNull();
    expect(core.worstTransfer).toBeNull();
    expect(core.benchPoints).toBeNull();
    expect(core.averages).toEqual({ league: 65, world: 58 });
    expect(core.table.map((r) => r.transfers)).toEqual([[], []]);
  });

  it('start_event > 1: totals count from it; its first GW has no lastRank / movers', () => {
    const members = [
      member(
        1,
        history(1, [
          [1, 100],
          [2, 40],
          [3, 50],
        ]),
      ),
      member(
        2,
        history(2, [
          [1, 10],
          [2, 60],
          [3, 20],
        ]),
      ),
    ];
    const first = buildGameweekRoundup({
      event: gw(2),
      members,
      playerPoints: new Map(),
      worldAverage: null,
      startEvent: gw(2),
    });
    expect(first.table.map((r) => [r.entryId, r.rank, r.lastRank, r.total])).toEqual([
      [2, 1, null, 60],
      [1, 2, null, 40],
    ]);
    expect(first.biggestClimb).toBeNull();
    expect(first.biggestDrop).toBeNull();
    const next = buildGameweekRoundup({
      event: gw(3),
      members,
      playerPoints: new Map(),
      worldAverage: null,
      startEvent: gw(2),
    });
    expect(next.table.map((r) => [r.entryId, r.rank, r.lastRank, r.total])).toEqual([
      [1, 1, 2, 90],
      [2, 2, 1, 80],
    ]);
    expect(next.biggestClimb).toMatchObject({ entryId: 1, places: 1 });
    expect(next.biggestDrop).toMatchObject({ entryId: 2, places: 1 });
    // A GW before the league started: nothing.
    expect(
      buildGameweekRoundup({
        event: gw(1),
        members,
        playerPoints: new Map(),
        worldAverage: 50,
        startEvent: gw(2),
      }).table,
    ).toEqual([]);
  });

  it('ties: same total and transfers share a rank; display + king/bench ties follow member order', () => {
    const members = [
      member(1, history(1, [[1, 60, 1, 0, 8]])),
      member(2, history(2, [[1, 60, 1, 0, 8]])),
      member(3, history(3, [[1, 60, 0, 0, 2]])),
      member(4, history(4, [[1, 50, 0]])),
    ];
    const core = buildGameweekRoundup({ event: gw(1), members, playerPoints: new Map(), worldAverage: null });
    expect(core.table.map((r) => [r.entryId, r.rank])).toEqual([
      [3, 1], // fewer transfers
      [1, 2],
      [2, 2],
      [4, 4],
    ]);
    expect(core.king?.entryId).toBe(3); // 60 × 3, equal totals → table order
    expect(core.benchPoints).toMatchObject({ entryId: 1, points: 8, players: [] }); // no picks → no players
    const reversed = buildGameweekRoundup({
      event: gw(1),
      members: [...members].reverse(),
      playerPoints: new Map(),
      worldAverage: null,
    });
    expect(reversed.table.map((r) => [r.entryId, r.rank])).toEqual([
      [3, 1],
      [2, 2],
      [1, 2],
      [4, 4],
    ]);
  });

  it('captain and vice both 0 minutes: armband falls to nobody → the picked captain is shown', () => {
    const p = picks(1, 1, 100, { multipliers: { 1: 0, 2: 1 } }); // FPL: captain 0, nobody ×2
    const core = buildGameweekRoundup({
      event: gw(1),
      members: [member(1, history(1, [[1, 30]]), { picks: p })],
      playerPoints: points({ 101: 0, 102: 0, 103: 9, 104: 7, 105: 7, 106: 3, 112: 20 }),
      worldAverage: null,
    });
    expect(core.table[0]?.captainPlayerId).toBe(101);
    // Top scorers: counted players only (the bench 112's 20 points don't count), ties → slot.
    expect(core.king?.topPlayers).toEqual([
      { playerId: 103, points: 9 },
      { playerId: 104, points: 7 },
      { playerId: 105, points: 7 },
      { playerId: 106, points: 3 },
    ]);
  });

  it('Triple Captain: ×3 in the top scorers; Bench Boost: bench sum, excluded from the bench section', () => {
    const tc = picks(1, 1, 100, { chip: '3xc' });
    const bb = picks(2, 1, 200, { chip: 'bboost' });
    const core = buildGameweekRoundup({
      event: gw(1),
      members: [
        member(1, history(1, [[1, 70, 0, 0, 5]]), { picks: tc }),
        member(2, history(2, [[1, 70, 0, 0, 0]], [{ chip: 'bboost', event: gw(1) }]), { picks: bb }),
      ],
      playerPoints: points({ 101: 10, 212: 2, 213: 3, 214: 4, 215: 5, 201: 1 }),
      worldAverage: null,
    });
    expect(core.table.map((r) => r.chip)).toEqual(['3xc', 'bboost']);
    expect(core.king).toMatchObject({ entryId: 1, chip: '3xc', benchBoostPoints: null });
    expect(core.king?.topPlayers[0]).toEqual({ playerId: 101, points: 30 });
    expect(core.benchPoints).toMatchObject({ entryId: 1, points: 5 });

    const bbKing = buildGameweekRoundup({
      event: gw(1),
      members: [member(2, history(2, [[1, 70]]), { picks: bb })],
      playerPoints: points({ 212: 2, 213: 3, 214: 4, 215: 5 }),
      worldAverage: null,
    });
    expect(bbKing.king?.benchBoostPoints).toBe(14);
  });

  it('chip falls back to history when picks are missing', () => {
    const core = buildGameweekRoundup({
      event: gw(2),
      members: [
        member(
          1,
          history(
            1,
            [
              [1, 1],
              [2, 2],
            ],
            [{ chip: 'freehit', event: gw(2) }],
          ),
        ),
      ],
      playerPoints: new Map(),
      worldAverage: null,
    });
    expect(core.table[0]).toMatchObject({ chip: 'freehit', captainPlayerId: null });
  });

  it('transfers: Wildcard / Free Hit excluded from best / worst; gain uses raw GW points', () => {
    const members = [
      member(1, history(1, [[1, 50, 1, 4]]), { transfers: [transfer(1, 10, 11)], picks: picks(1, 1, 100) }),
      member(2, history(2, [[1, 50, 0]], [{ chip: 'wildcard', event: gw(1) }]), {
        transfers: [transfer(1, 20, 21), transfer(1, 22, 23)],
      }),
      member(3, history(3, [[1, 50, 0]]), {
        transfers: [transfer(1, 30, 31)],
        picks: picks(3, 1, 300, { chip: 'freehit' }),
      }),
      member(4, history(4, [[1, 40, 1]]), { transfers: [transfer(1, 40, 41), transfer(2, 42, 43)] }),
    ];
    const core = buildGameweekRoundup({
      event: gw(1),
      members,
      playerPoints: points({ 10: 2, 11: 8, 20: 0, 21: 20, 22: 20, 23: 0, 30: 0, 31: 15, 40: 5, 41: 1 }),
      worldAverage: null,
    });
    expect(core.bestTransfer).toMatchObject({ entryId: 1, gain: 6, transferCost: 4 });
    expect(core.worstTransfer).toMatchObject({ entryId: 4, gain: -4, transferCost: 0 });
    // The Wildcard row still lists its transfers; GW2's transfer isn't on GW1's row.
    expect(core.table.find((r) => r.entryId === 2)?.transfers).toHaveLength(2);
    expect(core.table.find((r) => r.entryId === 4)?.transfers).toEqual([{ playerOut: 40, playerIn: 41 }]);
  });

  it('members without history are left out', () => {
    const core = buildGameweekRoundup({
      event: gw(1),
      members: [member(1, null), member(2, history(2, [[1, 10]]))],
      playerPoints: new Map(),
      worldAverage: null,
    });
    expect(core.table.map((r) => r.entryId)).toEqual([2]);
    expect(core.participants).toBe(1);
  });
});

describe('netTransfers', () => {
  const net = (...t: [number, number][]) =>
    netTransfers(t.map(([o, i], k) => transfer(1, o, i, k))).map((x) => [x.playerOut, x.playerIn]);
  it('collapses chains, reversals and cross-merges', () => {
    expect(net([1, 2])).toEqual([[1, 2]]);
    expect(net([1, 2], [2, 3])).toEqual([[1, 3]]);
    expect(net([1, 2], [2, 1])).toEqual([]);
    expect(net([1, 2], [3, 1])).toEqual([[3, 2]]); // sold 1, bought it back for 3: net 3 → 2
    expect(net([1, 2], [3, 4], [2, 3])).toEqual([[1, 4]]);
    expect(net([1, 2], [5, 6], [2, 7])).toEqual([
      [1, 7],
      [5, 6],
    ]);
  });
});

describe('demo service serves the roundup endpoints', () => {
  it('history, transfers, event points and a full build for GW8', async () => {
    const service = createDemoFplService({ anchorMs: Date.parse('2026-11-01T12:00:00Z'), now: () => 0 });
    const ids = Array.from({ length: DEMO_ENTRY_COUNT }, (_, i) => DEMO_FIRST_ENTRY_ID + i);
    const members = await Promise.all(
      ids.map(async (id): Promise<RoundupMemberInput> => ({
        entryId: eid(id),
        entryName: `T${id}`,
        managerName: `M${id}`,
        history: await req(service.getEntryHistory)(eid(id)),
        transfers: await req(service.getEntryTransfers)(eid(id)),
        picks: await service.getEntryPicks(eid(id), gw(8)),
      })),
    );
    const core = buildGameweekRoundup({
      event: gw(8),
      members,
      playerPoints: await req(service.getEventPoints)(gw(8)),
      worldAverage: 50,
    });
    expect(core.table).toHaveLength(DEMO_ENTRY_COUNT);
    expect(core.king).not.toBeNull();
    expect(core.bestTransfer).not.toBeNull();
    const transfers = await req(service.getEntryTransfers)(eid(DEMO_ENTRIES.transferHit));
    const history = await req(service.getEntryHistory)(eid(DEMO_ENTRIES.transferHit));
    for (const h of history.events) {
      expect(transfers.filter((t) => t.event === h.event).length, `GW${h.event}`).toBe(h.transfersMade);
    }
  });
});
