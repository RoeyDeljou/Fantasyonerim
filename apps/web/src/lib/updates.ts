'use client';

import { useSyncExternalStore } from 'react';
import {
  CHUNK_MARK_KEY,
  RESUME_CHECK_THROTTLE_MS,
  VERSION_POLL_MS,
  canAutoReload,
  canChunkReload,
  decideUpdate,
  isChunkLoadError,
  isNewBuild,
  isOwnAssetUrl,
  parseChunkMark,
  parseReloadLog,
  parseVersionFile,
  recordReload,
} from './appVersion';
import type { UpdateTrigger } from './appVersion';
import { hasActiveDraft } from './drafts';
import { isNativeShell } from './platform';
import { onHidden, onResume } from './resume';

/**
 * Keeps an installed PWA on the latest deploy without a reinstall or a manual refresh (docs/DEPLOY.md → "How updates
 * reach installed apps"):
 *
 * - on every resume and every 15 min while visible: `registration.update()` + fetch `/version.json` (no-store);
 * - a different build id → reload now if the app was just reopened / is going to the background / is idle;
 *   otherwise (typing, an open sheet with a filled field, actively scrolling) show a small toast and reload once the
 *   draft is gone and the user pauses, or when they tap it. Drafts are also persisted (lib/drafts.ts);
 * - at most one automatic reload per target build (sessionStorage), so a CDN still rolling out cannot loop us;
 * - a lazily loaded chunk that vanished with the previous deploy → one reload to the same URL (per build).
 *
 * Production web only: no-op in `next dev` (no version.json) and in the Capacitor shell (the bundle ships inside
 * the app and is updated through the stores).
 */

const RELOAD_LOG_KEY = 'fant.update.reloads';
const SETTLE_CHECK_MS = 2_000;

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The build this page was rendered by (`<html data-build>`, set at build time from NEXT_PUBLIC_BUILD_ID). */
export function runningBuildId(): string | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement.dataset.build || null;
}

function enabled(): boolean {
  return typeof window !== 'undefined' && process.env.NODE_ENV === 'production' && !isNativeShell();
}

// ---------- state ----------

let started = false;
let pending: string | null = null;
let afterDraft = false;
let lastInteraction = Date.now();
let lastCheck = 0;
let settleTimer: number | null = null;

let prompting = false;
const listeners = new Set<() => void>();
function setPrompting(v: boolean): void {
  if (prompting === v) return;
  prompting = v;
  listeners.forEach((l) => l());
}

/** True while a new version is waiting for the user to finish (the toast is shown). */
export function useUpdatePrompt(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => prompting,
    () => false,
  );
}

// ---------- reload ----------

function reload(target: string): void {
  const s = session();
  const log = recordReload(parseReloadLog(s?.getItem(RELOAD_LOG_KEY) ?? null), target, Date.now());
  try {
    s?.setItem(RELOAD_LOG_KEY, JSON.stringify(log));
  } catch {
    // no storage → the per-tab guard is gone, but MAX one reload per check still holds
  }
  window.location.reload();
}

/** The toast's "refresh" button: always allowed (drafts are persisted). */
export function applyUpdateNow(): void {
  reload(pending ?? 'manual');
}

// ---------- the watcher ----------

function stopSettling(): void {
  if (settleTimer !== null) window.clearInterval(settleTimer);
  settleTimer = null;
}

function consider(trigger: UpdateTrigger): void {
  const target = pending;
  if (!target) return;
  const draft = hasActiveDraft();
  if (draft) afterDraft = true;
  const decision = decideUpdate({
    trigger,
    hasDraft: draft,
    idleMs: Date.now() - lastInteraction,
    afterDraft,
  });
  if (decision === 'reload') {
    if (canAutoReload(parseReloadLog(session()?.getItem(RELOAD_LOG_KEY) ?? null), target, Date.now())) {
      stopSettling();
      reload(target);
      return;
    }
    // Already reloaded for this build and still not on it (CDN rollout / offline cache): stop, no loop, no nag.
    pending = null;
    stopSettling();
    setPrompting(false);
    return;
  }
  setPrompting(true);
  if (settleTimer === null) settleTimer = window.setInterval(() => consider('settle'), SETTLE_CHECK_MS);
}

/** A new deploy's worker that is installed but still waiting gets told to take over (see sw.js `message`). */
function activateWaiting(reg: ServiceWorkerRegistration): void {
  const kick = () => reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
  kick();
  const installing = reg.installing;
  installing?.addEventListener('statechange', () => {
    if (installing.state === 'installed') kick();
  });
}

async function updateServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    await reg.update();
    activateWaiting(reg);
  } catch {
    // offline, or the browser throttled it — the next check retries
  }
}

async function check(trigger: UpdateTrigger, force = false): Promise<void> {
  if (document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (!force && now - lastCheck < RESUME_CHECK_THROTTLE_MS) return;
  lastCheck = now;
  void updateServiceWorker();
  let served: string | null = null;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    served = parseVersionFile(await res.json());
  } catch {
    return; // offline: nothing to do
  }
  if (!isNewBuild(runningBuildId(), served)) {
    pending = null;
    afterDraft = false;
    stopSettling();
    setPrompting(false);
    return;
  }
  pending = served;
  consider(trigger);
}

/** Started once from app/providers.tsx. */
export function startUpdateWatcher(): void {
  if (started || !enabled()) return;
  started = true;
  const touch = () => {
    lastInteraction = Date.now();
  };
  for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove'] as const) {
    window.addEventListener(type, touch, { capture: true, passive: true });
  }
  window.addEventListener('scroll', touch, { capture: true, passive: true });

  onResume(() => void check('resume'));
  // Going to the background with an update waiting and nothing typed: reload now, unseen.
  onHidden(() => {
    if (pending) consider('hidden');
  });
  window.setInterval(() => void check('interval', true), VERSION_POLL_MS);
  // First check shortly after boot: catches an HTML page served from the offline cache by a slow network.
  window.setTimeout(() => void check('resume', true), 3_000);
}

// ---------- chunk-load errors ----------

/** One reload to the same URL per running build (sessionStorage), so a genuinely broken deploy cannot loop. */
export function recoverFromChunkError(): boolean {
  if (!enabled()) return false;
  const running = runningBuildId() ?? 'unknown';
  const s = session();
  const now = Date.now();
  if (!canChunkReload(parseChunkMark(s?.getItem(CHUNK_MARK_KEY) ?? null), running, now)) return false;
  try {
    s?.setItem(CHUNK_MARK_KEY, JSON.stringify({ build: running, at: now }));
  } catch {
    return false; // without the mark we could loop — better to show the error screen
  }
  window.location.reload();
  return true;
}

let chunkWired = false;
/** Window-level net for chunk failures outside React (dynamic imports, script/style tags). */
export function wireChunkErrorRecovery(): void {
  if (chunkWired || !enabled()) return;
  chunkWired = true;
  window.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      const assetFailed =
        (t instanceof HTMLScriptElement && isOwnAssetUrl(t.src, location.origin)) ||
        (t instanceof HTMLLinkElement && t.rel === 'stylesheet' && isOwnAssetUrl(t.href, location.origin));
      if (assetFailed || (e instanceof ErrorEvent && isChunkLoadError(e.error ?? e.message))) {
        recoverFromChunkError();
      }
    },
    true, // resource errors don't bubble: capture them
  );
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkLoadError(e.reason) && recoverFromChunkError()) e.preventDefault();
  });
}
