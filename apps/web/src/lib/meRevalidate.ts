'use client';

import type { QueryClient } from '@tanstack/react-query';
import { qk } from './queries';

/**
 * Warm start: the `me` restored from the device (lib/persist.ts) renders the app at once, and `/v1/me` is asked
 * only after first paint — 1.5 s after load, then when the main thread is idle — so a kickoff-time wave of app
 * opens doesn't queue session lookups in front of the data people came for. A 401 then signs out exactly as an
 * on-mount fetch would (lib/api.ts → unauthorized handler). A cold start (nothing restored) fetches as before.
 */
export const ME_REVALIDATE_DELAY_MS = 1_500;

export function scheduleMeRevalidation(qc: QueryClient): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let idle: number | null = null;
  const run = () => void qc.invalidateQueries({ queryKey: qk.me, exact: true });
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function')
      idle = window.requestIdleCallback(run, { timeout: 3_000 });
    else run();
  }, ME_REVALIDATE_DELAY_MS);
  return () => {
    window.clearTimeout(timer);
    if (idle !== null) window.cancelIdleCallback(idle);
  };
}
