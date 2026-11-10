import type { SeasonCaptainRow } from '@fant/shared';

/**
 * Pure helpers for the Season Captain Battle screen (screens/SeasonCaptains.tsx, its own lazy chunk): which rows are
 * "stars", the collapsed-table preview and the "you vs. the stars" summary. No React, unit-tested (season.test.ts).
 */

type RowLike = Pick<SeasonCaptainRow, 'kind' | 'host' | 'points' | 'rank' | 'key'> & {
  entryId: number | null;
};

/** The four highlighted rows: Dor's and Itay's own teams and the community / FPL Lad captains. */
export function isStar(r: Pick<SeasonCaptainRow, 'kind' | 'host'>): boolean {
  return r.kind !== 'manager' || r.host !== null;
}

export const SEASON_PREVIEW = 10;

export type PreviewItem<R> = { type: 'row'; row: R } | { type: 'gap'; key: string };

/**
 * The collapsed table: the top `limit`, every star and the viewer's own row, in the order given (rank order), with a
 * gap marker between runs that are not adjacent in the full list. A table that is barely longer than the preview (or
 * `expanded`) is shown whole. `hidden` = rows the collapsed table leaves out (0 = no "show all" button), also while expanded.
 */
export function seasonPreview<R extends RowLike>(
  rows: readonly R[],
  myEntry: number | null,
  expanded: boolean,
  limit = SEASON_PREVIEW,
): { items: PreviewItem<R>[]; hidden: number } {
  const keep = rows.map((r, i) => i < limit || isStar(r) || (myEntry !== null && r.entryId === myEntry));
  const left = rows.length - keep.filter(Boolean).length;
  // Hiding one or two rows behind a button is worse than showing them (same rule as the Roundup table).
  const hidden = left <= 2 ? 0 : left;
  const all = expanded || hidden === 0;
  const items: PreviewItem<R>[] = [];
  rows.forEach((row, i) => {
    if (!all && !keep[i]) return;
    if (!all && i > 0 && !keep[i - 1]) items.push({ type: 'gap', key: `gap-${i}` });
    items.push({ type: 'row', row });
  });
  return { items, hidden };
}

export interface StarLine<R> {
  row: R;
  /** Viewer points minus this row's points; null without a viewer, or for the viewer's own row. */
  gap: number | null;
  mine: boolean;
}

/**
 * "You vs. the stars": the viewer's row (null when signed out / not in the league) and one line per star that exists
 * in the data, ordered by rank, each with the signed gap from the viewer's side.
 */
export function seasonSummary<R extends RowLike>(
  rows: readonly R[],
  myEntry: number | null,
): { me: R | null; stars: StarLine<R>[] } {
  const me = myEntry === null ? null : (rows.find((r) => r.entryId === myEntry) ?? null);
  const stars = rows
    .filter(isStar)
    .sort((a, b) => a.rank - b.rank)
    .map((row) => {
      const mine = me !== null && row === me;
      return { row, mine, gap: me === null || mine ? null : me.points - row.points };
    });
  return { me, stars };
}

export type GapKind = 'ahead' | 'behind' | 'level';
export const gapKind = (gap: number): GapKind => (gap > 0 ? 'ahead' : gap < 0 ? 'behind' : 'level');

/** The photo to show for a star avatar: the configured path unless it already failed to load (then initials). */
export function starPhoto(configured: string | null | undefined, failed: string | null): string | null {
  return configured && configured !== failed ? configured : null;
}
