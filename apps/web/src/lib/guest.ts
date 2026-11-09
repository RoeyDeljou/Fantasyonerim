'use client';

import { useSyncExternalStore } from 'react';
import { readPref, removePref, writePref } from './prefs';

/**
 * Guest mode: "continue as guest" enters the app without an account. The choice is kept on the device so
 * reopening skips onboarding. A guest never has a token, so no request carries an auth header, and no per-user
 * query runs (lib/queries.ts gates them on `isGuest()`), so nothing per-user is ever persisted.
 *
 * What the guest typed before choosing guest mode (name, Team ID) is kept too, to prefill sign-up later.
 */
const KEY = 'fant.guest';
const DRAFT_KEY = 'fant.guest.draft';

const listeners = new Set<() => void>();
let cached: boolean | null = null;

export function isGuest(): boolean {
  if (typeof window === 'undefined') return false;
  cached ??= readPref(KEY) === '1';
  return cached;
}

export function setGuest(on: boolean): void {
  cached = on;
  if (on) writePref(KEY, '1');
  else removePref(KEY);
  listeners.forEach((l) => l());
}

export function useIsGuest(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isGuest,
    () => false,
  );
}

export interface SignUpDraft {
  name: string;
  teamId: string;
  email: string;
}

export function saveSignUpDraft(d: SignUpDraft): void {
  writePref(
    DRAFT_KEY,
    JSON.stringify({
      name: d.name.slice(0, 40),
      teamId: d.teamId.replace(/\D/g, '').slice(0, 8),
      email: d.email.trim().slice(0, 254),
    }),
  );
}

export function readSignUpDraft(): SignUpDraft | null {
  const raw = readPref(DRAFT_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== 'object' || v === null) return null;
    const { name, teamId, email } = v as { name?: unknown; teamId?: unknown; email?: unknown };
    return {
      name: typeof name === 'string' ? name : '',
      teamId: typeof teamId === 'string' ? teamId : '',
      email: typeof email === 'string' ? email : '',
    };
  } catch {
    return null;
  }
}

export function clearSignUpDraft(): void {
  removePref(DRAFT_KEY);
}
