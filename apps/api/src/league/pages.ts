import type { FplEntryId, LeagueStandingRow, LeagueStandings, LiveLeague, LiveLeagueRow } from '@fant/shared';
import type { LeagueHighlight } from '../push/copy.js';

/** Hard cap on standings pages read by a job (50 managers each → 2,000 managers). */
export const LEAGUE_MAX_PAGES = 40;
/** Pages fetched at once by a job (each live page also loads up to 50 picks). */
export const LEAGUE_PAGE_CONCURRENCY = 2;

/**
 * Every page of a paged FPL league resource, `concurrency` pages at a time, until a page says `hasNext: false`
 * or `maxPages` is reached. A page past the end fetched speculatively is ignored (even if it fails); a needed
 * page failing rejects the whole call.
 */
export async function fetchAllPages<P extends { hasNext: boolean }>(
  fetchPage: (page: number) => Promise<P>,
  options: { maxPages?: number; concurrency?: number } = {},
): Promise<P[]> {
  const maxPages = options.maxPages ?? LEAGUE_MAX_PAGES;
  const concurrency = Math.max(1, options.concurrency ?? LEAGUE_PAGE_CONCURRENCY);
  const pages: P[] = [];
  let next = 1;
  while (next <= maxPages) {
    const batch: number[] = [];
    for (let p = next; p < next + concurrency && p <= maxPages; p += 1) batch.push(p);
    const settled = await Promise.allSettled(batch.map((p) => fetchPage(p)));
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
      pages.push(result.value);
      if (!result.value.hasNext) return pages;
    }
    next += batch.length;
  }
  return pages;
}

export function allStandingRows(pages: readonly LeagueStandings[]): LeagueStandingRow[] {
  return dedupeByEntry(pages.flatMap((p) => p.rows));
}

/**
 * The live table across every page. FplService ranks each live page on its own, so the rows are merged and
 * re-ranked league-wide (liveTotal desc, then official rank; equal liveTotals share a rank) — the same order
 * `/v1/league/live` shows within a page.
 */
export function rankLiveLeague(pages: readonly LiveLeague[]): LiveLeagueRow[] {
  const rows = dedupeByEntry(pages.flatMap((p) => p.rows)).sort(
    (a, b) => b.liveTotal - a.liveTotal || a.officialRank - b.officialRank,
  );
  let previous: { liveTotal: number; liveRank: number } | null = null;
  return rows.map((row, i) => {
    const liveRank = previous !== null && previous.liveTotal === row.liveTotal ? previous.liveRank : i + 1;
    previous = { liveTotal: row.liveTotal, liveRank };
    return { ...row, liveRank };
  });
}

/** Standings can shift between page reads (a manager moving across a page boundary): keep the first row. */
function dedupeByEntry<R extends { entryId: FplEntryId }>(rows: readonly R[]): R[] {
  const seen = new Set<number>();
  return rows.filter((r) => (seen.has(r.entryId) ? false : (seen.add(r.entryId), true)));
}

/** Highlights shown at most per GW push. */
export const MAX_LEAGUE_HIGHLIGHTS = 2;
/** Places climbed that earn a "climbed" highlight. */
export const CLIMB_HIGHLIGHT_PLACES = 3;

/**
 * A manager's positive league moments after a finished GW, in priority order, at most two.
 * `lastRank` 0 = the manager joined the league this GW: no movement-based highlight.
 */
export function leagueHighlights(row: LeagueStandingRow, leagueMaxEventTotal: number): LeagueHighlight[] {
  const out: LeagueHighlight[] = [];
  // Ties share it; nobody is "top scorer" of a GW where nobody scored.
  if (leagueMaxEventTotal > 0 && row.eventTotal === leagueMaxEventTotal)
    out.push({ kind: 'top_scorer', points: row.eventTotal });
  const known = row.lastRank > 0;
  if (row.rank === 1) {
    out.push({ kind: 'first', still: row.lastRank === 1 });
  } else if (known) {
    const climbed = row.lastRank - row.rank;
    if (climbed >= CLIMB_HIGHLIGHT_PLACES) out.push({ kind: 'climbed', places: climbed, rank: row.rank });
    if (row.rank <= 3 && row.lastRank > 3) out.push({ kind: 'top3' });
    else if (row.rank <= 10 && row.lastRank > 10) out.push({ kind: 'top10' });
  }
  return out.slice(0, MAX_LEAGUE_HIGHLIGHTS);
}
