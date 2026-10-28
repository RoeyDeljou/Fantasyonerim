'use client';

import { useEffect, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { Spinner } from './ui';

/** A background refetch shorter than this never shows anything (no flicker on a warm API). */
export const UPDATING_DELAY_MS = 700;
/** A first load (nothing cached) slower than this is probably a sleeping API waking up. */
export const WAKING_DELAY_MS = 4_000;

const refetchingWithData = (q: Query) => q.state.fetchStatus === 'fetching' && q.state.data !== undefined;
const loadingWithoutData = (q: Query) => q.state.fetchStatus === 'fetching' && q.state.data === undefined;

/** True once `active` has stayed true for `ms`. */
function useSustained(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const id = window.setTimeout(() => setOn(true), ms);
    return () => window.clearTimeout(id);
  }, [active, ms]);
  return active && on;
}

/**
 * Cached content is on screen and fresh data is on its way: a small "Updating…" pill — never skeletons.
 * Skeletons are only for a true first load (nothing cached), and if that takes long, "waking up the server".
 */
export function SyncStatus() {
  const t = useT();
  const refetching = useIsFetching({ predicate: refetchingWithData }) > 0;
  const loading = useIsFetching({ predicate: loadingWithoutData }) > 0;
  const showUpdating = useSustained(refetching, UPDATING_DELAY_MS);
  const showWaking = useSustained(loading, WAKING_DELAY_MS);

  return (
    <>
      {showWaking ? (
        <div
          className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.25rem)] z-40 flex justify-center px-4"
          data-testid="waking-notice"
        >
          <div
            role="status"
            className="flex max-w-sm items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-card"
          >
            <Spinner className="shrink-0 text-primary" />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-bold text-ink">{t.sync.waking}</span>
              <span className="text-xs text-muted">{t.sync.wakingBody}</span>
            </span>
          </div>
        </div>
      ) : (
        showUpdating && (
          <div
            className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-40 flex justify-center"
            data-testid="updating-indicator"
          >
            <span
              role="status"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-on-primary shadow-card"
            >
              <span
                aria-hidden="true"
                className="inline-block size-3 animate-spin rounded-full border-2 border-current border-e-transparent"
              />
              {t.sync.updating}
            </span>
          </div>
        )
      )}
    </>
  );
}
