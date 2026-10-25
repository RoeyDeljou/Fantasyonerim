import type { Chip, FixtureStatus, Position } from '@fant/shared';
import { bonusFromBps, type BpsScore } from './bonus.js';

/**
 * Pure live-points engine. No I/O, no clock: everything it needs is passed in, so every rule is
 * unit-testable and the same code scores the real API, the replay/demo dataset and the tests.
 *
 * Rules implemented (FPL 2025/26):
 * - A player's GW points = sum over all his GW fixtures (DGW sums both; blank GW = 0, 'no_fixture'),
 *   taken from `event/{gw}/live` `stats.total_points`, plus PROVISIONAL bonus for every fixture whose
 *   bonus is not yet confirmed (see `EngineFixture.bonusConfirmed`), ranked from that fixture's BPS with
 *   FPL's tie rules (`bonusFromBps`). Once bonus is confirmed it is inside `total_points`, so it is never
 *   counted twice.
 * - "Did not play" = every one of his GW fixtures is finished (finished or finished_provisional) and he
 *   has 0 minutes. Blank-GW players (no fixture) did not play.
 * - Auto-subs (not on Bench Boost): starters who did not play are replaced in XI order by the first
 *   bench player (bench order 12→15) who has minutes > 0 and keeps a valid formation (exactly 1 GKP,
 *   ≥3 DEF, ≥2 MID, ≥1 FWD — which also means a GK can only be replaced by the bench GK). A bench player
 *   who did not play is skipped. A bench player whose match is still to come (0 minutes, not finished)
 *   and who would fit the formation blocks the decision for now: FPL would use him if he plays, so we do
 *   not jump ahead to a later bench player.
 * - Captain: ×2 (×3 on Triple Captain). If the captain did not play, the vice captain gets the captain
 *   multiplier — unless the vice also did not play, then nobody is doubled.
 * - Bench Boost: all 15 count, no auto-subs. Free Hit / Wildcard don't change scoring.
 * - livePoints = Σ points of the counted players − transfer cost.
 */

export interface EnginePlayer {
  id: number;
  teamId: number;
  position: Position;
}

export interface EngineFixture {
  id: number;
  teamH: number;
  teamA: number;
  status: FixtureStatus;
  /** True when FPL has already added this fixture's bonus to the `bonus` / `total_points` stats. */
  bonusConfirmed: boolean;
  /** BPS of every player in the fixture (home + away). May be empty before FPL publishes it. */
  bps: readonly BpsScore[];
}

export interface EngineLiveStats {
  minutes: number;
  /** Includes bonus once confirmed. */
  totalPoints: number;
  goals: number;
  assists: number;
  cleanSheets: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bps: number;
}

export interface GameweekInput {
  players: ReadonlyMap<number, EnginePlayer>;
  fixtures: readonly EngineFixture[];
  live: ReadonlyMap<number, EngineLiveStats>;
}

export interface GameweekContext extends GameweekInput {
  fixturesByTeam: ReadonlyMap<number, readonly EngineFixture[]>;
  /** element → provisional bonus summed over his unconfirmed, started fixtures. */
  provisionalBonus: ReadonlyMap<number, number>;
}

export type PlayerFixtureStatus = 'no_fixture' | 'not_started' | 'live' | 'finished';

export interface PlayerLiveInfo {
  playerId: number;
  basePoints: number;
  minutes: number;
  provisionalBonus: number;
  bonusConfirmed: boolean;
  fixtureStatus: PlayerFixtureStatus;
  /** All GW fixtures finished/finished_provisional (vacuously true on a blank GW). */
  allFixturesDone: boolean;
  /** Finished all fixtures with 0 minutes (or blank GW). */
  didNotPlay: boolean;
  /** Has a fixture not started yet, or is in a live fixture without having come on yet. */
  yetToPlay: boolean;
  stats: EngineLiveStats;
}

export interface EnginePick {
  playerId: number;
  /** 1..15 — FPL `position`. 1..11 XI, 12..15 bench in order. */
  slot: number;
  /** Raw FPL multiplier as picked (0 bench, 1, 2 captain, 3 TC). */
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
}

export interface EntryInput {
  picks: readonly EnginePick[];
  activeChip: Chip | null;
  transfersCost: number;
}

export interface EngineLivePick extends EnginePick {
  basePoints: number;
  points: number;
  effectiveMultiplier: number;
  minutes: number;
  provisionalBonus: number;
  bonusConfirmed: boolean;
  fixtureStatus: PlayerFixtureStatus;
  autoSubIn: boolean;
  autoSubOut: boolean;
  goals: number;
  assists: number;
  cleanSheet: boolean;
  yellowCards: number;
  redCards: number;
  saves: number;
  bps: number;
}

export interface LivePointsResult {
  picks: EngineLivePick[];
  livePoints: number;
  benchPoints: number;
  transfersCost: number;
  playersPlayed: number;
  playersYetToPlay: number;
  /** Player who currently carries the captain multiplier (vice after promotion), or null. */
  effectiveCaptainId: number | null;
  autoSubs: { in: number; out: number }[];
}

const ZERO_STATS: EngineLiveStats = {
  minutes: 0,
  totalPoints: 0,
  goals: 0,
  assists: 0,
  cleanSheets: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bps: 0,
};

const isDone = (s: FixtureStatus): boolean => s === 'finished' || s === 'finished_provisional';

/** Pre-computes per-GW data shared by every manager (fixtures per team, provisional bonus). */
export function createGameweekContext(input: GameweekInput): GameweekContext {
  const fixturesByTeam = new Map<number, EngineFixture[]>();
  for (const f of input.fixtures) {
    for (const team of [f.teamH, f.teamA]) {
      const list = fixturesByTeam.get(team) ?? [];
      list.push(f);
      fixturesByTeam.set(team, list);
    }
  }

  const provisionalBonus = new Map<number, number>();
  for (const f of input.fixtures) {
    if (f.bonusConfirmed || f.status === 'not_started') continue;
    let scores = f.bps;
    if (scores.length === 0) {
      // Fallback: element-level BPS for players of these two teams, only when unambiguous (no DGW).
      const fallback: BpsScore[] = [];
      for (const [id, stats] of input.live) {
        const player = input.players.get(id);
        if (!player || stats.minutes <= 0) continue;
        if (player.teamId !== f.teamH && player.teamId !== f.teamA) continue;
        if ((fixturesByTeam.get(player.teamId)?.length ?? 0) !== 1) continue;
        fallback.push({ element: id, value: stats.bps });
      }
      scores = fallback;
    }
    for (const [element, bonus] of bonusFromBps(scores)) {
      provisionalBonus.set(element, (provisionalBonus.get(element) ?? 0) + bonus);
    }
  }

  return { ...input, fixturesByTeam, provisionalBonus };
}

/** Live info for a single player in this GW (also used for Captain Battle). */
export function playerLiveInfo(ctx: GameweekContext, playerId: number): PlayerLiveInfo {
  const player = ctx.players.get(playerId);
  const fixtures = player ? (ctx.fixturesByTeam.get(player.teamId) ?? []) : [];
  const stats = ctx.live.get(playerId) ?? ZERO_STATS;
  const provisionalBonus = ctx.provisionalBonus.get(playerId) ?? 0;
  const allFixturesDone = fixtures.every((f) => isDone(f.status));

  let fixtureStatus: PlayerFixtureStatus;
  if (fixtures.length === 0) fixtureStatus = 'no_fixture';
  else if (allFixturesDone) fixtureStatus = 'finished';
  else if (fixtures.every((f) => f.status === 'not_started')) fixtureStatus = 'not_started';
  else fixtureStatus = 'live'; // a fixture in progress, or a DGW with one played and one to come

  const yetToPlay = fixtures.some(
    (f) => f.status === 'not_started' || (f.status === 'live' && stats.minutes === 0),
  );

  return {
    playerId,
    basePoints: stats.totalPoints + provisionalBonus,
    minutes: stats.minutes,
    provisionalBonus,
    bonusConfirmed: fixtures.length > 0 && fixtures.every((f) => f.bonusConfirmed),
    fixtureStatus,
    allFixturesDone,
    didNotPlay: allFixturesDone && stats.minutes === 0,
    yetToPlay,
    stats,
  };
}

const MIN_BY_POSITION: Readonly<Record<Position, number>> = { GKP: 1, DEF: 3, MID: 2, FWD: 1 };

function isValidFormation(positions: readonly Position[]): boolean {
  const count: Record<Position, number> = { GKP: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of positions) count[p]++;
  if (count.GKP !== 1) return false;
  return (['DEF', 'MID', 'FWD'] as const).every((p) => count[p] >= MIN_BY_POSITION[p]);
}

/** Scores one manager's GW. Pure. */
export function computeLivePoints(ctx: GameweekContext, entry: EntryInput): LivePointsResult {
  const picks = [...entry.picks].sort((a, b) => a.slot - b.slot);
  const info = new Map<number, PlayerLiveInfo>();
  for (const p of picks) info.set(p.playerId, playerLiveInfo(ctx, p.playerId));
  const positionOf = (id: number): Position => ctx.players.get(id)?.position ?? 'MID';
  const get = (id: number): PlayerLiveInfo => info.get(id) as PlayerLiveInfo;

  const benchBoost = entry.activeChip === 'bboost';
  const starters = picks.filter((p) => p.slot <= 11);
  const bench = picks.filter((p) => p.slot > 11);

  // Counted player ids. On BB all 15 count; otherwise the XI after auto-subs.
  const counted = new Set<number>((benchBoost ? picks : starters).map((p) => p.playerId));
  const autoSubs: { in: number; out: number }[] = [];

  if (!benchBoost) {
    const usedBench = new Set<number>();
    for (const starter of starters) {
      if (!get(starter.playerId).didNotPlay) continue;
      for (const candidate of bench) {
        if (usedBench.has(candidate.playerId)) continue;
        const c = get(candidate.playerId);
        if (c.didNotPlay) continue; // a bench player with 0 minutes in finished games cannot come on
        const lineup = [...counted].filter((id) => id !== starter.playerId).concat(candidate.playerId);
        const fits = isValidFormation(lineup.map(positionOf));
        if (!fits) continue;
        if (c.minutes > 0) {
          counted.delete(starter.playerId);
          counted.add(candidate.playerId);
          usedBench.add(candidate.playerId);
          autoSubs.push({ in: candidate.playerId, out: starter.playerId });
        }
        // Either he came on, or his game is still to come and he'd be first in line: stop here.
        break;
      }
    }
  }

  const captainMultiplier = entry.activeChip === '3xc' ? 3 : 2;
  const captain = picks.find((p) => p.isCaptain);
  const vice = picks.find((p) => p.isViceCaptain);
  let effectiveCaptainId: number | null = null;
  if (captain && !get(captain.playerId).didNotPlay && counted.has(captain.playerId)) {
    effectiveCaptainId = captain.playerId;
  } else if (vice && !get(vice.playerId).didNotPlay && counted.has(vice.playerId)) {
    effectiveCaptainId = vice.playerId;
  }

  const subbedIn = new Set(autoSubs.map((s) => s.in));
  const subbedOut = new Set(autoSubs.map((s) => s.out));

  const livePicks: EngineLivePick[] = picks.map((p) => {
    const i = get(p.playerId);
    const effectiveMultiplier = !counted.has(p.playerId)
      ? 0
      : p.playerId === effectiveCaptainId
        ? captainMultiplier
        : 1;
    return {
      ...p,
      basePoints: i.basePoints,
      points: i.basePoints * effectiveMultiplier,
      effectiveMultiplier,
      minutes: i.minutes,
      provisionalBonus: i.provisionalBonus,
      bonusConfirmed: i.bonusConfirmed,
      fixtureStatus: i.fixtureStatus,
      autoSubIn: subbedIn.has(p.playerId),
      autoSubOut: subbedOut.has(p.playerId),
      goals: i.stats.goals,
      assists: i.stats.assists,
      cleanSheet: i.stats.cleanSheets > 0,
      yellowCards: i.stats.yellowCards,
      redCards: i.stats.redCards,
      saves: i.stats.saves,
      bps: i.stats.bps,
    };
  });

  const countedPicks = livePicks.filter((p) => counted.has(p.playerId));
  const gross = countedPicks.reduce((sum, p) => sum + p.points, 0);
  const benchPoints = benchBoost
    ? livePicks.filter((p) => p.slot > 11).reduce((s, p) => s + p.basePoints, 0)
    : livePicks.filter((p) => !counted.has(p.playerId)).reduce((s, p) => s + p.basePoints, 0);

  return {
    picks: livePicks,
    livePoints: gross - entry.transfersCost,
    benchPoints,
    transfersCost: entry.transfersCost,
    playersPlayed: countedPicks.filter((p) => p.minutes > 0).length,
    playersYetToPlay: countedPicks.filter((p) => get(p.playerId).yetToPlay).length,
    effectiveCaptainId,
    autoSubs,
  };
}
