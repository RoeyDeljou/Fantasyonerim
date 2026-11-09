import type { GameweekRoundup, RoundupTransfer } from '@fant/shared';

/**
 * Pure presentation helpers for the Gameweek Roundup screen (screens/Roundup.tsx) and the league tables. No React
 * here, so they are unit-tested directly (roundup.test.ts).
 */

export type RankMove =
  | { dir: 'up'; places: number }
  | { dir: 'down'; places: number }
  /** Same place, or no previous rank to compare with. */
  | { dir: 'same'; places: 0 };

/**
 * How a team moved in the table. `lastRank` null / 0 / negative = no previous GW in the league → "same" (FPL uses
 * 0 for "no last rank"; the roundup contract uses null).
 */
export function rankMove(rank: number, lastRank: number | null | undefined): RankMove {
  if (lastRank === null || lastRank === undefined || lastRank <= 0 || lastRank === rank) {
    return { dir: 'same', places: 0 };
  }
  return rank < lastRank ? { dir: 'up', places: lastRank - rank } : { dir: 'down', places: rank - lastRank };
}

export type TransferSummary<T = RoundupTransfer> =
  | { kind: 'none' }
  /** Few enough to list each one as "out → in". */
  | { kind: 'list'; items: readonly T[] }
  /** Too many for one line: "N transfers". */
  | { kind: 'count'; n: number };

/** A GW's transfers for a table row: up to `max` listed, more than that collapsed to a count. */
export function transferSummary<T>(transfers: readonly T[], max = 2): TransferSummary<T> {
  if (transfers.length === 0) return { kind: 'none' };
  if (transfers.length <= max) return { kind: 'list', items: transfers };
  return { kind: 'count', n: transfers.length };
}

/** Rows shown before "show all": the full table when it is short, else the top `limit` (no 1-row tease). */
export const ROUNDUP_TABLE_PREVIEW = 10;
export function previewRows<T>(
  rows: readonly T[],
  expanded: boolean,
  limit = ROUNDUP_TABLE_PREVIEW,
): readonly T[] {
  // Hiding only one or two rows behind a button is worse than showing them.
  if (expanded || rows.length <= limit + 2) return rows;
  return rows.slice(0, limit);
}

interface RankedCaptain {
  playerId: unknown;
  captainPoints: number;
}

/**
 * Captain battle order: rows with a known captain first (server order, i.e. by captain points), unknown ones last,
 * with standard competition ranking among the known ones (16, 16, 9 → 1, 1, 3). Unknown rows get rank null.
 */
export function rankCaptains<R extends RankedCaptain>(
  rows: readonly R[],
): Array<{ row: R; rank: number | null }> {
  const sorted = [...rows].sort((a, b) => Number(a.playerId === null) - Number(b.playerId === null));
  const known = sorted.filter((r) => r.playerId !== null);
  return sorted.map((row) => ({
    row,
    rank: row.playerId === null ? null : 1 + known.filter((o) => o.captainPoints > row.captainPoints).length,
  }));
}

/** Which sections of a ready roundup have something to show (a null / empty section is omitted entirely). */
export function roundupSections(r: GameweekRoundup) {
  return {
    king: r.king !== null,
    averages: r.averages !== null && (r.averages.league !== null || r.averages.world !== null),
    captains: r.captains.length > 0,
    table: r.table.length > 0,
    movers: r.biggestClimb !== null || r.biggestDrop !== null,
    bench: r.benchPoints !== null,
    transfers: r.bestTransfer !== null || r.worstTransfer !== null,
  };
}

/** Prev / next GW in the picker's list (sorted ascending); null at either end or when `event` isn't listed. */
export function neighbourEvents<E extends number>(
  events: readonly E[],
  event: number,
): { prev: E | null; next: E | null } {
  const sorted = [...events].sort((a, b) => a - b);
  let prev: E | null = null;
  let next: E | null = null;
  for (const e of sorted) {
    if (e < event) prev = e;
    else if (e > event && next === null) next = e;
  }
  return { prev, next };
}
