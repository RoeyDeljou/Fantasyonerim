/**
 * The app's one scroller. On the tabs (components/AppShell.tsx) the DOCUMENT never scrolls: the shell is exactly one
 * screen tall and its content area is the only scroll container, so nothing is `position: fixed` over a scrolling
 * document (iOS 26 WebKit misplaces such elements while the page scrolls — the tab bar used to end up mid-screen).
 * Pages without the shell (onboarding, terms, admin) still scroll the document; every helper here falls back to it.
 */

/** The tab shell's content scroller, or null on a page without the shell. */
export function appScroller(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>('[data-app-scroller]');
}

/** How far the current page is scrolled (the shell's scroller, else the document). */
export function appScrollTop(): number {
  const el = appScroller();
  if (el) return el.scrollTop;
  return document.scrollingElement?.scrollTop ?? window.scrollY;
}

/** `window.scrollTo` for the app: scrolls the shell's content area, or the document without the shell. */
export function scrollAppTo(top: number, behavior: ScrollBehavior = 'auto'): void {
  const el = appScroller();
  if (el) el.scrollTo({ top, behavior });
  else window.scrollTo({ top, behavior });
}

// ---------- back/forward keeps the scroll position ----------
// The browser restores the DOCUMENT's scroll on history traversal (e.g. Community: thread → back to the feed); an
// inner scroller gets no such help, so the shell remembers each URL's position and puts it back on popstate only.
// A normal navigation (tab bar, links) starts at the top, as before.

const positions = new Map<string, number>();
/** How long a restore keeps waiting for the page to grow tall enough (rows rendering from cache). */
const RESTORE_MS = 1_500;

const locationKey = () => `${window.location.pathname}${window.location.search}`;

/** Called by the shell's scroller on every scroll. */
export function rememberScroll(top: number): void {
  positions.set(locationKey(), top);
}

let watching = false;
/** Started by AppShell (idempotent): restores the remembered position after back/forward. */
export function watchHistoryScroll(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  window.addEventListener('popstate', () => {
    // Read now: the outgoing screen may still emit scroll events under the new URL before it re-renders.
    const target = positions.get(locationKey()) ?? 0;
    const until = performance.now() + RESTORE_MS;
    let stable = 0;
    let lastHeight = -1;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    const opts: AddEventListenerOptions = { once: true, passive: true, capture: true };
    for (const type of ['touchstart', 'wheel', 'keydown', 'pointerdown'] as const) {
      window.addEventListener(type, cancel, opts);
    }
    // The screen re-renders a frame or more after popstate: keep applying until the position holds.
    const apply = () => {
      if (cancelled || performance.now() > until) return;
      const el = appScroller();
      if (el) {
        if (el.scrollHeight - el.clientHeight >= target && el.scrollTop !== target) el.scrollTop = target;
        stable = el.scrollTop === target && el.scrollHeight === lastHeight ? stable + 1 : 0;
        lastHeight = el.scrollHeight;
        if (stable >= 10) return;
      }
      requestAnimationFrame(apply);
    };
    requestAnimationFrame(apply);
  });
}
