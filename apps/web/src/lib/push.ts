'use client';

import { useCallback, useEffect, useState } from 'react';
import { WebPushSubscriptionBodySchema } from '@fant/shared';
import { API_BASE_URL, api, isApiError } from './api';
import { readPref, removePref, writePref } from './prefs';
import { isIos, isStandalone } from './pwa';
import { isNativeShell } from './platform';
import { tokenStore } from './tokenStore';

/**
 * Web push: support detection, subscribe/unsubscribe and the start-up re-sync. The native shells will
 * replace this module's internals with FCM/APNs (POST /v1/push/devices) — callers only see `PushState`.
 */
export type PushState =
  /** Checking (first render / static HTML). */
  | 'loading'
  /** This browser has no Push API. */
  | 'unsupported'
  /** iOS Safari tab: push only works once added to the Home Screen. */
  | 'needs-install'
  /** The user blocked notifications in the browser — only the browser settings can undo it. */
  | 'denied'
  | 'disabled'
  | 'enabled';

export type PushError = 'unconfigured' | 'dismissed' | 'failed';

/** Set when the user turns push off in the app, so the start-up re-sync doesn't silently resubscribe. */
const OPT_OUT_KEY = 'fant.push.optOut';
/** The endpoint last registered with the API from this device, and when (ms). */
const LAST_ENDPOINT_KEY = 'fant.push.lastEndpoint';
const LAST_SYNC_KEY = 'fant.push.lastSyncAt';
/** An unchanged subscription is re-POSTed (idempotent upsert) at most this often. */
export const PUSH_RESYNC_MS = 12 * 60 * 60_000;

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/**
 * Notification permission from both APIs. They can disagree (older Safari, headless Chromium): "granted" from
 * either wins, then "denied", else "default".
 */
async function permission(): Promise<NotificationPermission> {
  const legacy = Notification.permission;
  let modern: PermissionState | null = null;
  try {
    modern = (await navigator.permissions.query({ name: 'notifications' })).state;
  } catch {
    // Permissions API missing or doesn't know "notifications"
  }
  if (legacy === 'granted' || modern === 'granted') return 'granted';
  if (legacy === 'denied' || modern === 'denied') return 'denied';
  return 'default';
}

/** Everything except "is there a subscription". */
async function baseState(): Promise<Exclude<PushState, 'enabled' | 'loading'> | 'maybe'> {
  if (typeof window === 'undefined') return 'unsupported';
  // The app-store builds use native push (FCM / APNs via POST /v1/push/devices) — not wired yet, docs/NATIVE.md.
  if (isNativeShell()) return 'unsupported';
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!pushSupported()) return 'unsupported';
  if ((await permission()) === 'denied') return 'denied';
  return 'maybe';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => window.setTimeout(() => r(null), ms))]);
}

/** The service worker registration, registering `/sw.js` if the boot code hasn't yet (dev builds). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
  return withTimeout(navigator.serviceWorker.ready, 10_000);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export async function readPushState(): Promise<PushState> {
  const base = await baseState();
  if (base !== 'maybe') return base;
  if ((await permission()) !== 'granted') return 'disabled';
  try {
    const sub = await currentSubscription();
    return sub && readPref(OPT_OUT_KEY) !== '1' ? 'enabled' : 'disabled';
  } catch {
    return 'disabled';
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

let vapidKey: Promise<Uint8Array<ArrayBuffer>> | null = null;
/** The API's VAPID public key, fetched once per page load (a failure is retried next time). */
function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  if (!vapidKey) {
    const p = api.vapidPublicKey().then(urlBase64ToUint8Array);
    p.catch(() => {
      if (vapidKey === p) vapidKey = null;
    });
    vapidKey = p;
  }
  return vapidKey;
}

/** Screens showing the push state re-read it when the background re-sync (re)creates a subscription. */
const changeListeners = new Set<() => void>();

async function save(sub: PushSubscription): Promise<void> {
  await api.savePushSubscription(WebPushSubscriptionBodySchema.parse(sub.toJSON()));
  writePref(LAST_ENDPOINT_KEY, sub.endpoint);
  writePref(LAST_SYNC_KEY, String(Date.now()));
  changeListeners.forEach((l) => l());
}

/**
 * Subscribe with the API's VAPID key and register it. A subscription made with another key is replaced;
 * `fresh` replaces any existing one (the server reported it dead).
 */
async function subscribeAndSave(fresh = false): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('no service worker');
  const key = await serverKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && (fresh || !sameKey(sub.options.applicationServerKey, key))) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await save(sub);
  void shareWithWorker();
}

/** Ask for permission (must run from a tap), subscribe and register with the API. */
export async function enablePush(): Promise<{ state: PushState; error?: PushError }> {
  const base = await baseState();
  if (base !== 'maybe') return { state: base };
  const asked = (await permission()) === 'granted' ? 'granted' : await Notification.requestPermission();
  if (asked === 'denied') return { state: 'denied' };
  if (asked !== 'granted') return { state: 'disabled', error: 'dismissed' };
  try {
    await subscribeAndSave();
    writePref(OPT_OUT_KEY, '0');
    return { state: 'enabled' };
  } catch (e) {
    console.warn('push subscribe failed', e);
    const unconfigured = isApiError(e) && (e.status === 503 || e.code === 'upstream_unavailable');
    return { state: 'disabled', error: unconfigured ? 'unconfigured' : 'failed' };
  }
}

export async function disablePush(): Promise<PushState> {
  writePref(OPT_OUT_KEY, '1');
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api.deletePushSubscription(sub.endpoint).catch(() => undefined);
      await sub.unsubscribe();
    }
  } catch (e) {
    console.warn('push unsubscribe failed', e);
  }
  return readPushState();
}

/**
 * The account is gone (DELETE /v1/me already removed its subscriptions server-side): drop the browser
 * subscription too, so this device stops receiving pushes and the next account starts clean.
 */
export async function forgetPushLocally(): Promise<void> {
  try {
    const sub = await currentSubscription();
    await sub?.unsubscribe();
  } catch (e) {
    console.warn('push unsubscribe failed', e);
  }
  removePref(OPT_OUT_KEY);
  removePref(LAST_ENDPOINT_KEY);
  removePref(LAST_SYNC_KEY);
}

export type PushSyncResult = 'skipped' | 'unchanged' | 'posted' | 'resubscribed';

/** Automatic re-sync is for real installs only: not the native shells (native push) and not `next dev`. */
function autoSyncAllowed(): boolean {
  return process.env.NODE_ENV === 'production' && !isNativeShell();
}

let inFlight: Promise<PushSyncResult> | null = null;

/**
 * Self-healing subscription, run on start and on every resume for signed-in users who granted permission and
 * didn't turn push off on this device. Browsers drop subscriptions silently (iOS especially), so:
 * - none → subscribe again and register it;
 * - made with another VAPID key → unsubscribe and resubscribe;
 * - present → re-POST it (idempotent upsert by endpoint, also re-binds it to whoever is signed in) when the
 *   endpoint differs from the last one registered from here (e.g. the service worker renewed it on
 *   `pushsubscriptionchange`), or at most every 12 h otherwise.
 */
export function ensurePushSubscription(force = false): Promise<PushSyncResult> {
  inFlight ??= syncOnce(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function syncOnce(force: boolean): Promise<PushSyncResult> {
  if (!autoSyncAllowed()) return 'skipped';
  if ((await baseState()) !== 'maybe' || (await permission()) !== 'granted') return 'skipped';
  if (readPref(OPT_OUT_KEY) === '1') return 'skipped';
  const reg = await registration();
  if (!reg) return 'skipped';
  void shareWithWorker();
  const key = await serverKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await save(sub);
    return 'resubscribed';
  }
  const last = Number(readPref(LAST_SYNC_KEY) ?? 0);
  const due = force || sub.endpoint !== readPref(LAST_ENDPOINT_KEY) || !(Date.now() - last < PUSH_RESYNC_MS);
  if (!due) return 'unchanged';
  await save(sub);
  return 'posted';
}

/** Fire-and-forget wrapper for the app shell (failures are logged, never thrown). */
export async function resyncPush(): Promise<void> {
  try {
    await ensurePushSubscription();
  } catch (e) {
    console.warn('push re-sync failed', e);
  }
}

/** The test button found this device's subscription dead: replace it with a brand-new one. */
export async function renewPushSubscription(): Promise<boolean> {
  if (isNativeShell() || (await permission()) !== 'granted') return false;
  try {
    await subscribeAndSave(true);
    writePref(OPT_OUT_KEY, '0');
    return true;
  } catch (e) {
    console.warn('push renew failed', e);
    return false;
  }
}

/**
 * Gives the service worker what it needs to re-register a subscription on `pushsubscriptionchange` while no
 * page is open: the API base URL, the bearer token (null = signed out) and the VAPID key. The worker keeps them
 * in IndexedDB (sw.js); the token is never part of the worker script.
 */
export async function shareWithWorker(): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || isNativeShell()) return;
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, 5_000);
    const token = await tokenStore.get();
    const key = token ? await serverKey().catch(() => null) : null;
    reg?.active?.postMessage({
      type: 'PUSH_CONTEXT',
      apiBase: API_BASE_URL,
      token,
      vapidKey: key ? Array.from(key) : null,
    });
  } catch {
    // best effort: the page re-syncs on its next start anyway
  }
}

/** Reactive push state for the UI (re-read when the tab becomes visible: permission may change in settings). */
export function usePushState() {
  const [state, setState] = useState<PushState>('loading');
  const refresh = useCallback(async () => setState(await readPushState()), []);
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onChange = () => void refresh();
    document.addEventListener('visibilitychange', onVisible);
    changeListeners.add(onChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      changeListeners.delete(onChange);
    };
  }, [refresh]);
  return { state, setState, refresh };
}
