import { describe, expect, it } from 'vitest';
import { bonusFromBps } from './bonus.js';

const scores = (...values: number[]) => values.map((value, i) => ({ element: i + 1, value }));
const awards = (...values: number[]) => Object.fromEntries(bonusFromBps(scores(...values)));

describe('bonusFromBps (FPL tie rules)', () => {
  it('awards 3/2/1 to the top three', () => {
    expect(awards(40, 30, 20, 10)).toEqual({ 1: 3, 2: 2, 3: 1 });
  });

  it('is independent of input order', () => {
    const map = bonusFromBps([
      { element: 9, value: 10 },
      { element: 7, value: 30 },
      { element: 8, value: 20 },
    ]);
    expect(Object.fromEntries(map)).toEqual({ 7: 3, 8: 2, 9: 1 });
  });

  it('tie for 1st: both get 3, next gets 1', () => {
    expect(awards(40, 40, 30, 20)).toEqual({ 1: 3, 2: 3, 3: 1 });
  });

  it('three-way tie for 1st: all get 3, nobody else', () => {
    expect(awards(40, 40, 40, 30)).toEqual({ 1: 3, 2: 3, 3: 3 });
  });

  it('tie for 2nd: both get 2, nobody gets 1', () => {
    expect(awards(40, 30, 30, 20)).toEqual({ 1: 3, 2: 2, 3: 2 });
  });

  it('tie for 3rd: all tied players get 1', () => {
    expect(awards(40, 30, 20, 20, 20, 10)).toEqual({ 1: 3, 2: 2, 3: 1, 4: 1, 5: 1 });
  });

  it('handles fewer than three players and empty lists', () => {
    expect(awards(12)).toEqual({ 1: 3 });
    expect(awards()).toEqual({});
  });
});
