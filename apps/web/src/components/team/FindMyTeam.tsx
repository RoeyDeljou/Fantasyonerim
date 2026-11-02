'use client';

import { useEffect, useRef, useState } from 'react';
import type { FplEntryId } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useLeaguePosition, useMe } from '@/lib/queries';
import { LocateIcon } from '@/components/icons';

/** How long the row pulses after a jump (matches `.row-pulse` in globals.css). */
const PULSE_MS = 1_600;
/** Rows render a frame or two after their page arrives; give up looking after this. */
const FIND_ROW_MS = 3_000;

/** The `<li>` of a league row (Table and the live table mark rows with `data-entry`). */
function rowOf(entryId: FplEntryId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`main li[data-entry="${entryId}"]`);
}

function waitForRow(entryId: FplEntryId): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const until = performance.now() + FIND_ROW_MS;
    const look = () => {
      const el = rowOf(entryId);
      if (el || performance.now() > until) resolve(el);
      else requestAnimationFrame(look);
    };
    look();
  });
}

interface PagedQuery {
  data?: { pages: readonly unknown[] } | undefined;
  hasNextPage: boolean;
  fetchNextPage(): Promise<{
    data?: { pages: readonly unknown[] } | undefined;
    hasNextPage: boolean;
    isError: boolean;
  }>;
}

/** Loads pages of an infinite league query (the tables' "load more") until `page` is in, or there are no more. */
export async function loadPagesUntil(q: PagedQuery, page: number): Promise<void> {
  let loaded = q.data?.pages.length ?? 0;
  let hasNext = q.hasNextPage;
  while (loaded < page && hasNext) {
    const r = await q.fetchNextPage();
    if (r.isError) return;
    loaded = r.data?.pages.length ?? loaded;
    hasNext = r.hasNextPage;
  }
}

/**
 * "My team" — a floating button on the league tables that jumps to the viewer's own row: loads the pages up to it
 * (`loadPage`, the table's own infinite query), scrolls the row to the middle of the screen, pulses it and moves
 * focus to it with a spoken "your team is in place N".
 *
 * Shown only for a signed-in fan with a Team ID that is in the league (`GET /v1/league/position`, fetched only
 * while a table is open), and hidden while their row is already on screen. `rankOf` = the rank this table shows
 * for a row (official on Table, live on Live Action — the live rank can differ, so the row is found by entry id).
 */
export function FindMyTeam({
  enabled,
  loadPage,
  rankOf,
  rowsKey,
}: {
  /** The table has data (league set, first page loaded). */
  enabled: boolean;
  /** Makes sure pages 1…`page` are loaded. */
  loadPage(page: number): Promise<unknown>;
  rankOf(entryId: FplEntryId): number | null;
  /** Changes whenever rows are added (re-attaches the visibility observer). */
  rowsKey: number;
}) {
  const { t } = useI18n();
  const me = useMe();
  const entryId = me.data?.entryId ?? null;
  const position = useLeaguePosition(enabled && entryId !== null);
  const page = position.data?.page ?? null;
  const [rowVisible, setRowVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const pulseTimer = useRef<number | null>(null);

  // Hide while the viewer's own row is on screen.
  useEffect(() => {
    if (entryId === null) return;
    const el = rowOf(entryId);
    if (!el) {
      setRowVisible(false);
      return;
    }
    const io = new IntersectionObserver((entries) => setRowVisible(entries.some((e) => e.isIntersecting)), {
      // The sticky header and the tab bar cover the top / bottom edges.
      rootMargin: '-64px 0px -96px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [entryId, rowsKey]);

  useEffect(
    () => () => {
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    },
    [],
  );

  if (!enabled || entryId === null || position.isError || page === null || rowVisible) {
    return <Announcer text={announce} />;
  }

  const jump = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await loadPage(page);
      const row = await waitForRow(entryId);
      if (!row) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      row.classList.remove('row-pulse');
      void row.offsetWidth; // restart the animation on a repeat tap
      row.classList.add('row-pulse');
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => row.classList.remove('row-pulse'), PULSE_MS);
      row.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
      const rank = rankOf(entryId) ?? position.data?.rank ?? null;
      if (rank !== null) setAnnounce(fmt(t.table.myTeamAt, { rank }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Announcer text={announce} />
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-20">
        <div className="mx-auto flex max-w-xl justify-end px-4">
          <button
            type="button"
            onClick={() => void jump()}
            aria-busy={busy}
            title={t.table.findMyTeamLabel}
            data-testid="find-my-team"
            className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm font-bold text-on-primary shadow-card transition-transform active:scale-95"
          >
            <LocateIcon size={20} />
            {t.table.findMyTeam}
          </button>
        </div>
      </div>
    </>
  );
}

/** Polite live region: screen readers say where the team is after a jump. */
function Announcer({ text }: { text: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" data-testid="find-my-team-status">
      {text}
    </p>
  );
}
