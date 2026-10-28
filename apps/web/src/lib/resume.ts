'use client';

import { focusManager } from '@tanstack/react-query';

/**
 * "The app was reopened." A standalone PWA on iOS can sit frozen in memory for days and does not fire
 * `visibilitychange` reliably when it comes back, so every signal counts: `visibilitychange` → visible, `pageshow`
 * from the back/forward cache, window `focus`, and a heartbeat that notices the JS clock jumped (the page was
 * frozen). Bursts (they usually arrive together) are coalesced into one event.
 */
type Listener = () => void;

const resumeListeners = new Set<Listener>();
const hiddenListeners = new Set<Listener>();
const COALESCE_MS = 1_000;
const HEARTBEAT_MS = 5_000;
/** The heartbeat came back this late → the page was frozen, not just busy. */
const FROZEN_GAP_MS = 30_000;

let wired = false;
let lastResume = 0;

function visible(): boolean {
  return document.visibilityState !== 'hidden';
}

function emitResume(): void {
  const now = Date.now();
  if (now - lastResume < COALESCE_MS) return;
  lastResume = now;
  resumeListeners.forEach((l) => l());
}

function wire(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  document.addEventListener('visibilitychange', () => {
    if (visible()) emitResume();
    else hiddenListeners.forEach((l) => l());
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) emitResume();
  });
  window.addEventListener('focus', () => {
    if (visible()) emitResume();
  });
  let beat = Date.now();
  window.setInterval(() => {
    const now = Date.now();
    const gap = now - beat;
    beat = now;
    if (gap > FROZEN_GAP_MS && visible()) emitResume();
  }, HEARTBEAT_MS);
}

export function onResume(cb: Listener): () => void {
  wire();
  resumeListeners.add(cb);
  return () => resumeListeners.delete(cb);
}

export function onHidden(cb: Listener): () => void {
  wire();
  hiddenListeners.add(cb);
  return () => hiddenListeners.delete(cb);
}

/**
 * TanStack Query's own focus listener only watches `visibilitychange`. Feed it every resume signal instead, so
 * News, live scores, the Table, My Team, Community and stories refetch (when stale) within a second of reopening,
 * and pause their polling while hidden (`refetchIntervalInBackground: false` reads `focusManager.isFocused()`,
 * which falls back to `document.visibilityState`). Calling `handleFocus()` with no argument re-evaluates and
 * notifies even when the state did not change — exactly what a frozen-then-resumed iOS page needs.
 */
export function wireQueryFocus(): void {
  if (typeof window === 'undefined') return;
  focusManager.setEventListener((handleFocus) => {
    const offResume = onResume(() => handleFocus());
    const offHidden = onHidden(() => handleFocus());
    return () => {
      offResume();
      offHidden();
    };
  });
}
