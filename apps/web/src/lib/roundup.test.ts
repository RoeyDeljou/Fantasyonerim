import { describe, expect, it } from 'vitest';
import type { GameweekRoundup } from '@fant/shared';
import {
  neighbourEvents,
  previewRows,
  rankCaptains,
  rankMove,
  roundupSections,
  transferSummary,
} from './roundup';

describe('rankMove', () => {
  it('moving to a smaller rank is up, by the places gained', () => {
    expect(rankMove(3, 7)).toEqual({ dir: 'up', places: 4 });
  });
  it('moving to a bigger rank is down', () => {
    expect(rankMove(9, 2)).toEqual({ dir: 'down', places: 7 });
  });
  it('same place, or no previous rank (null / FPL 0), is "same"', () => {
    expect(rankMove(5, 5)).toEqual({ dir: 'same', places: 0 });
    expect(rankMove(5, null)).toEqual({ dir: 'same', places: 0 });
    expect(rankMove(5, 0)).toEqual({ dir: 'same', places: 0 });
    expect(rankMove(5, undefined)).toEqual({ dir: 'same', places: 0 });
  });
});

describe('transferSummary', () => {
  const t = (o: number, i: number) => ({ playerOut: o, playerIn: i });
  it('no transfers → none', () => {
    expect(transferSummary([])).toEqual({ kind: 'none' });
  });
  it('one or two are listed', () => {
    expect(transferSummary([t(1, 2)])).toEqual({ kind: 'list', items: [t(1, 2)] });
    expect(transferSummary([t(1, 2), t(3, 4)])).toEqual({ kind: 'list', items: [t(1, 2), t(3, 4)] });
  });
  it('more than two collapse to a count', () => {
    expect(transferSummary([t(1, 2), t(3, 4), t(5, 6)])).toEqual({ kind: 'count', n: 3 });
  });
  it('the cut-off is configurable', () => {
    expect(transferSummary([t(1, 2), t(3, 4)], 1)).toEqual({ kind: 'count', n: 2 });
  });
});

describe('previewRows', () => {
  const rows = Array.from({ length: 30 }, (_, i) => i + 1);
  it('a short table is shown whole', () => {
    expect(previewRows(rows.slice(0, 7), false)).toHaveLength(7);
  });
  it('never hides just one or two rows', () => {
    expect(previewRows(rows.slice(0, 12), false)).toHaveLength(12);
    expect(previewRows(rows.slice(0, 13), false)).toHaveLength(10);
  });
  it('a long table shows the top rows until expanded', () => {
    expect(previewRows(rows, false)).toEqual(rows.slice(0, 10));
    expect(previewRows(rows, true)).toHaveLength(30);
  });
});

describe('rankCaptains', () => {
  it('ties share a rank; unknown captains go last with no rank', () => {
    const rows = [
      { key: 'a', playerId: null, captainPoints: 0 },
      { key: 'b', playerId: 1, captainPoints: 16 },
      { key: 'c', playerId: 2, captainPoints: 16 },
      { key: 'd', playerId: 3, captainPoints: 9 },
    ];
    expect(rankCaptains(rows).map(({ row, rank }) => [row.key, rank])).toEqual([
      ['b', 1],
      ['c', 1],
      ['d', 3],
      ['a', null],
    ]);
  });
});

describe('neighbourEvents', () => {
  it('steps through the listed GWs, skipping gaps', () => {
    expect(neighbourEvents([1, 2, 4, 5], 4)).toEqual({ prev: 2, next: 5 });
    expect(neighbourEvents([3, 1, 2], 1)).toEqual({ prev: null, next: 2 });
    expect(neighbourEvents([1, 2, 3], 3)).toEqual({ prev: 2, next: null });
  });
});

describe('roundupSections', () => {
  const base = {
    event: 10,
    status: 'ready',
    events: [1],
    league: null,
    participants: null,
    averages: null,
    king: null,
    table: [],
    biggestClimb: null,
    biggestDrop: null,
    benchPoints: null,
    bestTransfer: null,
    worstTransfer: null,
    captains: [],
    builtAt: null,
  } as unknown as GameweekRoundup;
  it('an all-null roundup shows nothing', () => {
    expect(Object.values(roundupSections(base)).some(Boolean)).toBe(false);
  });
  it('averages with both numbers null count as empty', () => {
    expect(roundupSections({ ...base, averages: { league: null, world: null } }).averages).toBe(false);
    expect(roundupSections({ ...base, averages: { league: 51.3, world: null } }).averages).toBe(true);
  });
});
