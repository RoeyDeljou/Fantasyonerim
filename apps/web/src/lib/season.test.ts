import { describe, expect, it } from 'vitest';
import { gapKind, isStar, seasonPreview, seasonSummary } from './season';

type Row = {
  key: string;
  kind: 'manager' | 'community' | 'fpl_lad';
  host: 'dor' | 'itay' | null;
  entryId: number | null;
  points: number;
  rank: number;
};
const mk = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `k${i + 1}`,
    kind: 'manager' as const,
    host: null,
    entryId: 100 + i,
    points: 1000 - i * 10,
    rank: i + 1,
  }));
const withOver = (rows: Row[], at: Record<number, Partial<Row>>): Row[] =>
  rows.map((r, i) => ({ ...r, ...at[i] }));

describe('isStar', () => {
  it('hosts and special captains are stars, other teams are not', () => {
    expect(isStar({ kind: 'manager', host: null })).toBe(false);
    expect(isStar({ kind: 'manager', host: 'dor' })).toBe(true);
    expect(isStar({ kind: 'community', host: null })).toBe(true);
    expect(isStar({ kind: 'fpl_lad', host: null })).toBe(true);
  });
});

describe('seasonPreview', () => {
  const rows = withOver(mk(40), {
    14: { host: 'dor' },
    24: { kind: 'fpl_lad', entryId: null },
    25: { host: 'itay' },
  });
  const keys = (r: ReturnType<typeof seasonPreview<Row>>) =>
    r.items.map((i) => (i.type === 'row' ? i.row.key : '⋮'));

  it('top 10 + stars (+ gap markers between non-adjacent runs)', () => {
    const p = seasonPreview(rows, null, false);
    expect(keys(p)).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `k${i + 1}`),
      '⋮',
      'k15',
      '⋮',
      'k25',
      'k26',
    ]);
    expect(p.hidden).toBe(40 - 13);
  });
  it('the viewer row is kept too', () => {
    const p = seasonPreview(rows, 100 + 33, false);
    expect(keys(p).includes('k34')).toBe(true);
    expect(p.hidden).toBe(40 - 14);
  });
  it('expanded shows everything without markers; hidden still reports the collapsed count', () => {
    const p = seasonPreview(rows, null, true);
    expect(p.items).toHaveLength(40);
    expect(p.items.every((i) => i.type === 'row')).toBe(true);
    expect(p.hidden).toBe(27);
  });
  it('a list that barely exceeds the preview is shown whole', () => {
    const p = seasonPreview(mk(12), null, false);
    expect(p.items).toHaveLength(12);
    expect(p.hidden).toBe(0);
  });
  it('adjacent stars do not get a marker', () => {
    const p = seasonPreview(withOver(mk(30), { 10: { host: 'dor' }, 11: { host: 'itay' } }), null, false);
    expect(keys(p).slice(9, 13)).toEqual(['k10', 'k11', 'k12']);
  });
});

describe('seasonSummary', () => {
  const rows = withOver(mk(20), {
    0: { kind: 'community', entryId: null },
    4: { host: 'dor' },
    9: { kind: 'fpl_lad', entryId: null },
    12: { host: 'itay' },
  });
  it('lists the stars in rank order with the gap from the viewer’s side', () => {
    const s = seasonSummary(rows, 100 + 6); // 940 pts, rank 7
    expect(s.me?.rank).toBe(7);
    expect(s.stars.map((x) => x.row.key)).toEqual(['k1', 'k5', 'k10', 'k13']);
    expect(s.stars.map((x) => x.gap)).toEqual([-60, -20, 30, 60]);
    expect(s.stars.every((x) => !x.mine)).toBe(true);
  });
  it('no viewer (guest / not in the league): no me line and no gaps', () => {
    for (const my of [null, 999]) {
      const s = seasonSummary(rows, my);
      expect(s.me).toBeNull();
      expect(s.stars).toHaveLength(4);
      expect(s.stars.every((x) => x.gap === null)).toBe(true);
    }
  });
  it('a host viewing their own row has no gap against themselves', () => {
    const s = seasonSummary(rows, 100 + 4);
    const self = s.stars.find((x) => x.mine);
    expect(self?.row.host).toBe('dor');
    expect(self?.gap).toBeNull();
  });
  it('missing stars are omitted; none at all gives an empty list', () => {
    expect(seasonSummary(mk(5), null).stars).toEqual([]);
  });
});

describe('gapKind', () => {
  it('signs', () => {
    expect(gapKind(5)).toBe('ahead');
    expect(gapKind(-5)).toBe('behind');
    expect(gapKind(0)).toBe('level');
  });
});
