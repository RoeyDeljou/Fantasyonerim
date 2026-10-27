'use client';

import { useSyncExternalStore } from 'react';
import { isNativeShell } from './platform';

/** Chromium's install prompt event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isBeforeInstallPrompt(e: Event): e is BeforeInstallPromptEvent {
  return 'prompt' in e && typeof (e as { prompt?: unknown }).prompt === 'function';
}

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

let wired = false;
/** Called once at boot so the event is captured even before the Profile screen mounts. */
export function wireInstallPrompt(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    if (!isBeforeInstallPrompt(e)) return;
    e.preventDefault();
    deferred = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferred = null;
    emit();
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export type InstallState = 'installed' | 'promptable' | 'ios' | 'manual' | 'unknown';

function snapshot(): InstallState {
  if (isNativeShell()) return 'unknown'; // already an app — no install card
  if (installed || isStandalone()) return 'installed';
  if (deferred) return 'promptable';
  if (isIos()) return 'ios';
  return 'manual';
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot,
    () => 'unknown',
  );
}

export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  await e.prompt();
  const choice = await e.userChoice;
  if (choice.outcome === 'accepted') installed = true;
  deferred = null;
  emit();
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (process.env.NODE_ENV !== 'production') return;
  if (isNativeShell()) return;
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
      console.warn('service worker registration failed', err);
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
