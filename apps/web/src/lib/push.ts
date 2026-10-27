'use client';

import { useCallback, useEffect, useState } from 'react';
import { WebPushSubscriptionBodySchema } from '@fant/shared';
import { api, isApiError } from './api';
import { readPref, removePref, writePref } from './prefs';
import { isIos, isStandalone } from './pwa';
import { isNativeShell } from './platform';

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

/** Subscribe with the API's VAPID key (replacing a subscription made with another key) and register it. */
async function subscribeAndSave(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('no service worker');
  const key = urlBase64ToUint8Array(await api.vapidPublicKey());
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.savePushSubscription(WebPushSubscriptionBodySchema.parse(sub.toJSON()));
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
}

/**
 * Start-up re-sync for signed-in users who have granted permission: makes sure a subscription exists
 * (browsers drop them; this also covers `pushsubscriptionchange`) and re-POSTs it — idempotent by endpoint,
 * and it re-binds the endpoint to whoever is signed in now.
 */
export async function resyncPush(): Promise<void> {
  if ((await baseState()) !== 'maybe' || (await permission()) !== 'granted') return;
  if (readPref(OPT_OUT_KEY) === '1') return;
  try {
    await subscribeAndSave();
  } catch (e) {
    console.warn('push re-sync failed', e);
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
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  return { state, setState, refresh };
}
