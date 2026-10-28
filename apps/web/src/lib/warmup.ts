'use client';

import { onResume } from './resume';
import { HEALTH_URL, WARM_STAMP } from './warmupScript';

/**
 * The API sleeps after ~15 idle minutes (free hosting tier) and takes up to a minute to wake. Every app start and
 * every resume fires a fire-and-forget `GET /health` right away, so the wake-up starts before the first real
 * query is even built. `no-cors`: the answer is irrelevant (opaque), the request reaching the server is the point,
 * and it can never log a CORS error.
 */
/** Don't ping again within this window (start + resume signals tend to arrive together). */
const MIN_GAP_MS = 30_000;
const STAMP = WARM_STAMP;

type Stamped = Window & { [STAMP]?: number };

export function warmUpApi(): void {
  if (typeof window === 'undefined') return;
  const w = window as Stamped;
  const now = Date.now();
  if (w[STAMP] && now - w[STAMP] < MIN_GAP_MS) return;
  w[STAMP] = now;
  try {
    void fetch(HEALTH_URL, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }).catch(
      () => undefined,
    );
  } catch {
    // never let a warm-up break anything
  }
}

/** App start (no-op if the inline script just pinged) + every resume. */
export function wireWarmUp(): () => void {
  warmUpApi();
  return onResume(warmUpApi);
}
