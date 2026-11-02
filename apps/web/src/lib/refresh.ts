'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Query, QueryKey } from '@tanstack/react-query';

/**
 * Manual refresh (header button + pull-to-refresh). A screen names the query-key prefixes it shows; a refresh
 * invalidates them (so cached-but-inactive copies are stale too) and refetches the active ones right away,
 * ignoring staleTime. Cached data stays on screen meanwhile, and the persisted copy is rewritten by the normal
 * persister once fresh data lands.
 */
export type RefreshScope = readonly (readonly unknown[])[];

/** FPL data except bootstrap (big, changes rarely; its own staleTime keeps it fresh enough). */
const FPL_LIVE: RefreshScope = [
  ['fpl', 'fixtures'],
  ['fpl', 'fixture'],
  ['fpl', 'entry'],
  ['fpl', 'picks'],
  ['fpl', 'live'],
];

export const REFRESH_SCOPES = {
  live: [['league'], ['captain-battle'], ...FPL_LIVE],
  myTeam: [...FPL_LIVE],
  table: [['league'], ...FPL_LIVE],
  news: [['news']],
} as const satisfies Record<string, RefreshScope>;

/** How long the "Updated just now" confirmation stays up. */
export const REFRESH_DONE_MS = 2_500;

function startsWith(key: QueryKey, prefix: readonly unknown[]): boolean {
  return prefix.every((p, i) => key[i] === p);
}

export function inScope(scope: RefreshScope): (q: Query) => boolean {
  return (q) => scope.some((p) => startsWith(q.queryKey, p));
}

// ---- "a manual refresh is running" — the Updating… pill stays quiet then (the button spins instead) ----
let manual = 0;
const listeners = new Set<() => void>();
function setManual(delta: number) {
  manual = Math.max(0, manual + delta);
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useManualRefreshActive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => manual > 0,
    () => false,
  );
}

export type RefreshResult = 'idle' | 'refreshing' | 'done' | 'failed';

/** Refresh the screen's queries; `state` drives the spinner and the short confirmation afterwards. */
export function useRefresh(scope: RefreshScope) {
  const qc = useQueryClient();
  const [state, setState] = useState<RefreshResult>('idle');
  const busy = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    window.clearTimeout(timer.current);
    setState('refreshing');
    setManual(1);
    const predicate = inScope(scopeRef.current);
    try {
      await qc.invalidateQueries({ predicate, refetchType: 'active' });
      const failed = qc
        .getQueryCache()
        .findAll({ predicate, type: 'active' })
        .some((q) => q.state.status === 'error' || q.state.fetchFailureCount > 0);
      setState(failed ? 'failed' : 'done');
    } catch {
      setState('failed');
    } finally {
      busy.current = false;
      setManual(-1);
      timer.current = window.setTimeout(() => setState('idle'), REFRESH_DONE_MS);
    }
  }, [qc]);

  return { state, refreshing: state === 'refreshing', refresh };
}
