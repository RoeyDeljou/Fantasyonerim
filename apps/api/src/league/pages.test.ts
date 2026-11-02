import { LeagueStandingRowSchema, LiveLeagueSchema, type LeagueStandingRow } from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { fetchAllPages, LEAGUE_MAX_PAGES, leagueHighlights, rankLiveLeague } from './pages.js';

const row = (rank: number, lastRank: number, eventTotal: number, entryId = 1): LeagueStandingRow =>
  LeagueStandingRowSchema.parse({
    rank,
    lastRank,
    entryId,
    entryName: 'T',
    managerName: 'M',
    total: 500,
    eventTotal,
  });

describe('fetchAllPages', () => {
  it('reads pages until hasNext is false, two at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const asked: number[] = [];
    const pages = await fetchAllPages(async (page) => {
      asked.push(page);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { page, hasNext: page < 5 };
    });
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(2);
    // At most one speculative page past the end.
    expect(asked).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stops at the 40-page cap', async () => {
    const asked: number[] = [];
    const pages = await fetchAllPages(async (page) => {
      asked.push(page);
      return { page, hasNext: true };
    });
    expect(pages).toHaveLength(LEAGUE_MAX_PAGES);
    expect(Math.max(...asked)).toBe(40);
  });

  it('ignores a failing page past the end, but fails on a needed page', async () => {
    const pages = await fetchAllPages(async (page) => {
      if (page === 2) throw new Error('past the end');
      return { page, hasNext: false };
    });
    expect(pages).toHaveLength(1);
    await expect(
      fetchAllPages(async (page) => {
        if (page === 2) throw new Error('boom');
        return { page, hasNext: true };
      }),
    ).rejects.toThrow('boom');
  });
});

describe('leagueHighlights', () => {
  it('orders top scorer, first place, climbs; at most two; never negative', () => {
    expect(leagueHighlights(row(1, 1, 90), 90)).toEqual([
      { kind: 'top_scorer', points: 90 },
      { kind: 'first', still: true },
    ]);
    expect(leagueHighlights(row(1, 4, 50), 90)).toEqual([{ kind: 'first', still: false }]);
    expect(leagueHighlights(row(4, 12, 50), 90)).toEqual([
      { kind: 'climbed', places: 8, rank: 4 },
      { kind: 'top10' },
    ]);
    expect(leagueHighlights(row(3, 5, 50), 90)).toEqual([{ kind: 'top3' }]);
    expect(leagueHighlights(row(2, 9, 90), 90)).toEqual([
      { kind: 'top_scorer', points: 90 },
      { kind: 'climbed', places: 7, rank: 2 },
    ]);
    // Dropped places: nothing.
    expect(leagueHighlights(row(15, 2, 30), 90)).toEqual([]);
    // New member (lastRank 0): no climb / top-N message.
    expect(leagueHighlights(row(2, 0, 30), 90)).toEqual([]);
    // Nobody scored: nobody is top scorer.
    expect(leagueHighlights(row(5, 5, 0), 0)).toEqual([]);
  });
});

describe('rankLiveLeague', () => {
  it('re-ranks every page league-wide, ties share a rank', () => {
    const live = (page: number, rows: [number, number, number][]) =>
      LiveLeagueSchema.parse({
        league: { id: 1, name: 'L' },
        event: 9,
        page,
        hasNext: page === 1,
        updatedAt: '2026-10-25T12:00:00.000Z',
        rows: rows.map(([entryId, officialRank, liveTotal]) => ({
          liveRank: 1,
          officialRank,
          entryId,
          entryName: 'T',
          managerName: 'M',
          livePoints: 40,
          liveTotal,
          captainPlayerId: null,
          effectiveCaptainPlayerId: null,
          activeChip: null,
          playersYetToPlay: 0,
        })),
      });
    const ranked = rankLiveLeague([
      live(1, [
        [1, 1, 500],
        [2, 2, 480],
      ]),
      live(2, [
        [3, 51, 520],
        [4, 52, 480],
      ]),
    ]);
    expect(ranked.map((r) => [r.entryId, r.liveRank])).toEqual([
      [3, 1],
      [1, 2],
      [2, 3],
      [4, 3],
    ]);
  });
});
