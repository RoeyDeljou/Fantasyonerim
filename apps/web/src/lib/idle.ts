/**
 * Background work that must never compete with what the user is waiting for: runs once the page is idle, and
 * only when it is cheap for the user — online, no data saver, not on a 2G-class connection.
 */

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** True when speculative downloads (prefetching a tab's data or a sheet's code) are welcome. */
export function canPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!navigator.onLine) return false;
  const c = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (c?.saveData) return false;
  if (c?.effectiveType && /(^|-)2g$/.test(c.effectiveType)) return false;
  return true;
}

/**
 * After `load`, the screen is usually still fetching its data and its first image (the LCP). Speculative work waits
 * this much longer so it never competes with them for a mobile connection.
 */
const SETTLE_MS = 2_500;

/**
 * `cb` once the page has loaded, settled (SETTLE_MS) and is idle (requestIdleCallback; iOS Safari has none, so
 * the settle timeout alone there), when `canPrefetch()`. Returns a cancel function.
 */
export function whenIdle(cb: () => void, { timeout = 4000 }: { timeout?: number } = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let cancelled = false;
  let idleId: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (!cancelled && canPrefetch()) cb();
  };
  const schedule = () => {
    if (cancelled) return;
    timer = setTimeout(() => {
      timer = null;
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function')
        idleId = window.requestIdleCallback(run, { timeout });
      else run();
    }, SETTLE_MS);
  };
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener('load', schedule);
    if (idleId !== null) window.cancelIdleCallback(idleId);
    if (timer !== null) clearTimeout(timer);
  };
}
