import { describe, expect, it } from 'vitest';
import {
  rawBootstrap,
  rawFixture,
  rawLiveElement,
  rawPicks,
  SQUAD_IDS,
  standardSquad,
  type MiniPlayer,
  type MiniStatus,
} from './__fixtures__/mini.js';
import { computeLivePoints, createGameweekContext, playerLiveInfo } from './live-engine.js';
import {
  engineFixturesOf,
  engineLiveOf,
  enginePicksOf,
  enginePlayersOf,
  mapBootstrap,
  toChip,
} from './normalize.js';
import { RawBootstrapSchema, RawFixturesSchema, RawLiveSchema, RawPicksSchema } from './raw.js';

/** Runs raw JSON through the real schemas + normalizers into the pure engine. */
function score(input: {
  players: readonly MiniPlayer[];
  fixtures: readonly unknown[];
  live: readonly unknown[];
  picks: unknown;
}) {
  const bootstrap = mapBootstrap(RawBootstrapSchema.parse(rawBootstrap(input.players)), 0);
  const ctx = createGameweekContext({
    players: enginePlayersOf(bootstrap),
    fixtures: engineFixturesOf(RawFixturesSchema.parse(input.fixtures)),
    live: engineLiveOf(RawLiveSchema.parse({ elements: input.live })),
  });
  const picks = RawPicksSchema.parse(input.picks);
  const result = computeLivePoints(ctx, {
    picks: enginePicksOf(picks),
    activeChip: toChip(picks.active_chip),
    transfersCost: picks.entry_history.event_transfers_cost,
  });
  const byId = (id: number) => result.picks.find((p) => p.playerId === id);
  return { result, byId, ctx };
}

const oneFixture = (status: MiniStatus, extra: Partial<Parameters<typeof rawFixture>[0]> = {}) => [
  rawFixture({ id: 1, h: 1, a: 2, status, ...extra }),
];

/** Every player 90 minutes and 2 points, except overrides. */
function liveFor(
  ids: readonly number[],
  overrides: Record<number, Parameters<typeof rawLiveElement>[1]> = {},
) {
  return ids.map((id) => rawLiveElement(id, overrides[id] ?? { minutes: 90, points: 2 }));
}

describe('live-points engine', () => {
  it('normal GW: XI counts, captain doubled, bench excluded', () => {
    const { result, byId } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 6: { minutes: 90, points: 8 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7 }),
    });
    // 10 starters × 2 + captain 8 × 2 = 36
    expect(result.livePoints).toBe(36);
    expect(byId(6)).toMatchObject({ basePoints: 8, points: 16, effectiveMultiplier: 2 });
    expect(byId(12)?.effectiveMultiplier).toBe(0);
    expect(result.benchPoints).toBe(8);
    expect(result.autoSubs).toEqual([]);
    expect(result.playersPlayed).toBe(11);
    expect(result.playersYetToPlay).toBe(0);
    expect(result.effectiveCaptainId).toBe(6);
  });

  it('DGW: a player with two fixtures sums both (total_points spans both games)', () => {
    const players = [...standardSquad(), { id: 16, team: 3, type: 3 as const }];
    const ids = [...SQUAD_IDS.slice(0, 5), 16, ...SQUAD_IDS.slice(6)];
    const { byId } = score({
      players,
      fixtures: [
        rawFixture({ id: 1, h: 1, a: 2, status: 'finished' }),
        rawFixture({ id: 2, h: 3, a: 4, status: 'finished' }),
        rawFixture({ id: 3, h: 3, a: 5, status: 'finished' }),
      ],
      live: liveFor(ids, { 16: { minutes: 180, points: 13 } }),
      picks: rawPicks(ids, { captain: 16, vice: 7 }),
    });
    expect(byId(16)).toMatchObject({ basePoints: 13, points: 26, fixtureStatus: 'finished' });
  });

  it('DGW: provisional bonus is summed over both unconfirmed fixtures', () => {
    const players = [...standardSquad(), { id: 16, team: 3, type: 3 as const }];
    const ids = [...SQUAD_IDS.slice(0, 5), 16, ...SQUAD_IDS.slice(6)];
    const { byId } = score({
      players,
      fixtures: [
        rawFixture({ id: 1, h: 1, a: 2, status: 'finished' }),
        rawFixture({
          id: 2,
          h: 3,
          a: 4,
          status: 'finished_provisional',
          bps: [
            [16, 40],
            [90, 20],
            [91, 10],
          ],
        }),
        rawFixture({
          id: 3,
          h: 3,
          a: 5,
          status: 'live',
          bps: [
            [92, 30],
            [16, 25],
            [93, 5],
          ],
        }),
      ],
      live: liveFor(ids, { 16: { minutes: 150, points: 9, bps: 65 } }),
      picks: rawPicks(ids, { captain: 7, vice: 8 }),
    });
    expect(byId(16)).toMatchObject({
      provisionalBonus: 5,
      basePoints: 14,
      fixtureStatus: 'live',
      bonusConfirmed: false,
    });
  });

  it('blank GW: player with no fixture is no_fixture, scores 0 and is auto-subbed', () => {
    const players = standardSquad().map((p) => (p.id === 2 ? { ...p, team: 9 } : p));
    const { result, byId } = score({
      players,
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 2: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS),
    });
    expect(byId(2)).toMatchObject({ fixtureStatus: 'no_fixture', basePoints: 0, autoSubOut: true });
    expect(byId(13)).toMatchObject({ autoSubIn: true, effectiveMultiplier: 1 });
    expect(result.autoSubs).toEqual([{ in: 13, out: 2 }]);
  });

  it('captain 0 min (match finished) → vice captain gets ×2', () => {
    const { result, byId } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 6: { minutes: 0, points: 0 }, 7: { minutes: 90, points: 5 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7 }),
    });
    expect(byId(6)?.effectiveMultiplier).toBe(0); // subbed off the XI
    expect(byId(7)).toMatchObject({ effectiveMultiplier: 2, points: 10 });
    expect(result.effectiveCaptainId).toBe(7);
  });

  it('captain 0 min on Triple Captain → vice gets ×3', () => {
    const { byId } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 6: { minutes: 0, points: 0 }, 7: { minutes: 90, points: 5 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7, chip: '3xc' }),
    });
    expect(byId(7)).toMatchObject({ effectiveMultiplier: 3, points: 15 });
  });

  it('captain still to play keeps the armband (no premature promotion)', () => {
    const { byId } = score({
      players: standardSquad(),
      fixtures: [rawFixture({ id: 1, h: 1, a: 2, status: 'not_started' })],
      live: [],
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7 }),
    });
    expect(byId(6)?.effectiveMultiplier).toBe(2);
    expect(byId(7)?.effectiveMultiplier).toBe(1);
  });

  it('captain and vice both 0 min → nobody is doubled', () => {
    const { result } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, {
        6: { minutes: 0, points: 0 },
        7: { minutes: 0, points: 0 },
        13: { minutes: 0, points: 0 },
        14: { minutes: 0, points: 0 },
        15: { minutes: 0, points: 0 },
      }),
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7 }),
    });
    expect(result.effectiveCaptainId).toBeNull();
    expect(result.picks.every((p) => p.effectiveMultiplier <= 1)).toBe(true);
    expect(result.livePoints).toBe(9 * 2);
  });

  it('Triple Captain: ×3', () => {
    const { result, byId } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 10: { minutes: 90, points: 10 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 10, vice: 11, chip: '3xc' }),
    });
    expect(byId(10)).toMatchObject({ effectiveMultiplier: 3, points: 30 });
    expect(result.livePoints).toBe(10 * 2 + 30);
  });

  it('Bench Boost: bench counts and no auto-subs happen', () => {
    const { result, byId } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 2: { minutes: 0, points: 0 }, 14: { minutes: 90, points: 6 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7, chip: 'bboost' }),
    });
    expect(result.autoSubs).toEqual([]);
    expect(byId(2)).toMatchObject({ autoSubOut: false, effectiveMultiplier: 1, points: 0 });
    expect(byId(14)).toMatchObject({ effectiveMultiplier: 1, points: 6 });
    // starters: 9 × 2 + captain 2×2 + DEF(2) 0 = 22; bench: 2 + 2 + 6 + 2 = 12
    expect(result.livePoints).toBe(22 + 12);
    expect(result.benchPoints).toBe(12);
  });

  it('auto-subs go in bench order', () => {
    const { result } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 6: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 7, vice: 8 }),
    });
    // MID out of a 4-4-2: first outfield bench player (13, a DEF) keeps a valid 5-3-2.
    expect(result.autoSubs).toEqual([{ in: 13, out: 6 }]);
  });

  it('auto-subs respect the DEF minimum (3-5-2: a DEF can only be replaced by a DEF)', () => {
    // 1 GK | 2,3,4 DEF | 5-9 MID | 10,11 FWD | 12 GK | 13 MID | 14 FWD | 15 DEF
    const types: Record<number, 1 | 2 | 3 | 4> = {
      1: 1,
      2: 2,
      3: 2,
      4: 2,
      10: 4,
      11: 4,
      12: 1,
      13: 3,
      14: 4,
      15: 2,
    };
    const players = SQUAD_IDS.map((id) => ({ id, team: (id % 2) + 1, type: types[id] ?? 3 }));
    const { result } = score({
      players,
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 2: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 5, vice: 6 }),
    });
    expect(result.autoSubs).toEqual([{ in: 15, out: 2 }]);
  });

  it('auto-subs respect the FWD minimum (4-5-1)', () => {
    // 1 GK | 2-5 DEF | 6-10 MID | 11 FWD | 12 GK | 13 DEF | 14 MID | 15 FWD
    const types: Record<number, 1 | 2 | 3 | 4> = {
      1: 1,
      2: 2,
      3: 2,
      4: 2,
      5: 2,
      11: 4,
      12: 1,
      13: 2,
      14: 3,
      15: 4,
    };
    const players = SQUAD_IDS.map((id) => ({ id, team: (id % 2) + 1, type: types[id] ?? 3 }));
    const { result } = score({
      players,
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 11: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7 }),
    });
    expect(result.autoSubs).toEqual([{ in: 15, out: 11 }]);
  });

  it('auto-subs respect the MID minimum (5-2-3)', () => {
    // 1 GK | 2-6 DEF | 7,8 MID | 9-11 FWD | 12 GK | 13 FWD | 14 DEF... (squad shape is irrelevant here)
    const types: Record<number, 1 | 2 | 3 | 4> = {
      1: 1,
      2: 2,
      3: 2,
      4: 2,
      5: 2,
      6: 2,
      7: 3,
      8: 3,
      9: 4,
      10: 4,
      11: 4,
      12: 1,
      13: 4,
      14: 2,
      15: 3,
    };
    const players = SQUAD_IDS.map((id) => ({ id, team: (id % 2) + 1, type: types[id] ?? 3 }));
    const { result } = score({
      players,
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 7: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 9, vice: 10 }),
    });
    expect(result.autoSubs).toEqual([{ in: 15, out: 7 }]);
  });

  it('goalkeeper: only the bench GK replaces a GK, and the bench GK never replaces an outfielder', () => {
    const gkOut = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 1: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 6, vice: 7 }),
    });
    expect(gkOut.result.autoSubs).toEqual([{ in: 12, out: 1 }]);

    const outfieldOut = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, {
        6: { minutes: 0, points: 0 },
        13: { minutes: 0, points: 0 },
        14: { minutes: 0, points: 0 },
        15: { minutes: 0, points: 0 },
      }),
      picks: rawPicks(SQUAD_IDS, { captain: 7, vice: 8 }),
    });
    expect(outfieldOut.result.autoSubs).toEqual([]); // bench GK 12 played but cannot come on for a MID
  });

  it('auto-sub only once the starter’s fixture is finished (incl. finished_provisional)', () => {
    for (const status of ['not_started', 'live'] as const) {
      const { result } = score({
        players: standardSquad(),
        fixtures: oneFixture(status),
        live: liveFor(SQUAD_IDS, { 6: { minutes: 0, points: 0 } }),
        picks: rawPicks(SQUAD_IDS, { captain: 7, vice: 8 }),
      });
      expect(result.autoSubs, status).toEqual([]);
    }
    const provisional = score({
      players: standardSquad(),
      fixtures: oneFixture('finished_provisional'),
      live: liveFor(SQUAD_IDS, { 6: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 7, vice: 8 }),
    });
    expect(provisional.result.autoSubs).toEqual([{ in: 13, out: 6 }]);
  });

  it('a bench player who also has 0 minutes cannot come on — the next one does', () => {
    const { result } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS, { 6: { minutes: 0, points: 0 }, 13: { minutes: 0, points: 0 } }),
      picks: rawPicks(SQUAD_IDS, { captain: 7, vice: 8 }),
    });
    expect(result.autoSubs).toEqual([{ in: 14, out: 6 }]);
  });

  it('a bench player whose match is still to come holds his place in the queue', () => {
    // Starter 6 (moved to team 3) finished with 0 min; bench 13 (team 1) has not played yet.
    const players = standardSquad().map((p) => (p.id === 6 ? { ...p, team: 3 } : p));
    const { result } = score({
      players,
      fixtures: [
        rawFixture({ id: 1, h: 1, a: 2, status: 'not_started' }),
        rawFixture({ id: 2, h: 3, a: 4, status: 'finished' }),
      ],
      live: [rawLiveElement(6, { minutes: 0, points: 0 })],
      picks: rawPicks(SQUAD_IDS, { captain: 7, vice: 8 }),
    });
    expect(result.autoSubs).toEqual([]);
  });

  it('provisional bonus from BPS when the fixture’s bonus is not confirmed', () => {
    const { result, byId } = score({
      players: standardSquad(),
      fixtures: oneFixture('live', {
        bps: [
          [3, 35],
          [5, 35],
          [7, 20],
          [9, 18],
        ],
      }),
      live: liveFor(SQUAD_IDS),
      picks: rawPicks(SQUAD_IDS, { captain: 3, vice: 5 }),
    });
    // tie for 1st: 3 and 5 get 3, 7 gets 1
    expect(byId(3)).toMatchObject({ provisionalBonus: 3, basePoints: 5, points: 10, bonusConfirmed: false });
    expect(byId(5)?.provisionalBonus).toBe(3);
    expect(byId(7)?.provisionalBonus).toBe(1);
    expect(byId(9)?.provisionalBonus).toBe(0);
    // captain 3: (2+3)×2 = 10, 5: 2+3, 7: 2+1, the other 8 starters × 2
    expect(result.livePoints).toBe(10 + 5 + 3 + 16);
  });

  it('falls back to element BPS when the fixture has no bps list yet', () => {
    const { byId } = score({
      players: standardSquad(),
      fixtures: oneFixture('live'),
      live: liveFor(SQUAD_IDS, { 4: { minutes: 30, points: 1, bps: 50 } }),
      picks: rawPicks(SQUAD_IDS),
    });
    expect(byId(4)?.provisionalBonus).toBe(3);
  });

  it('bonus already confirmed is never double counted', () => {
    // finished_provisional but FPL already published the bonus (it is inside total_points = 5)
    const confirmed = score({
      players: standardSquad(),
      fixtures: oneFixture('finished_provisional', {
        bps: [
          [3, 40],
          [5, 30],
          [7, 20],
        ],
        bonus: [
          [3, 3],
          [5, 2],
          [7, 1],
        ],
      }),
      live: liveFor(SQUAD_IDS, { 3: { minutes: 90, points: 5, bonus: 3, bps: 40 } }),
      picks: rawPicks(SQUAD_IDS),
    });
    expect(confirmed.byId(3)).toMatchObject({ provisionalBonus: 0, basePoints: 5, bonusConfirmed: true });

    // `finished` = confirmed even if the fixture stats were trimmed
    const finished = score({
      players: standardSquad(),
      fixtures: oneFixture('finished', { bps: [[3, 40]] }),
      live: liveFor(SQUAD_IDS, { 3: { minutes: 90, points: 5, bonus: 3, bps: 40 } }),
      picks: rawPicks(SQUAD_IDS),
    });
    expect(finished.byId(3)).toMatchObject({ provisionalBonus: 0, basePoints: 5 });
  });

  it('transfer hits are subtracted', () => {
    const { result } = score({
      players: standardSquad(),
      fixtures: oneFixture('finished'),
      live: liveFor(SQUAD_IDS),
      picks: rawPicks(SQUAD_IDS, { cost: 8 }),
    });
    expect(result.transfersCost).toBe(8);
    expect(result.livePoints).toBe(24 - 8);
  });

  it('counts players played / yet to play', () => {
    // team 1 (odd ids) finished, team 2 (even ids) live: 4 & 6 on the pitch, 8 and 10 not on yet.
    const players = standardSquad().map((p) => (p.team === 1 ? { ...p, team: 3 } : p));
    const { result } = score({
      players,
      fixtures: [
        rawFixture({ id: 1, h: 2, a: 5, status: 'live' }),
        rawFixture({ id: 2, h: 3, a: 4, status: 'finished' }),
      ],
      live: liveFor(SQUAD_IDS, {
        2: { minutes: 50, points: 1 },
        8: { minutes: 0, points: 0 },
        10: { minutes: 0, points: 0 },
      }),
      picks: rawPicks(SQUAD_IDS),
    });
    // XI = 1..11: team-2 starters are 2,4,6,8,10 (8 and 10 still on the bench in a live game).
    expect(result.playersPlayed).toBe(9);
    expect(result.playersYetToPlay).toBe(2);
  });

  it('playerLiveInfo reports not_started for a player whose match has not kicked off', () => {
    const { ctx } = score({
      players: standardSquad(),
      fixtures: oneFixture('not_started'),
      live: [],
      picks: rawPicks(SQUAD_IDS),
    });
    expect(playerLiveInfo(ctx, 3)).toMatchObject({
      fixtureStatus: 'not_started',
      yetToPlay: true,
      basePoints: 0,
    });
  });
});
