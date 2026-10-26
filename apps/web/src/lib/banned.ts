'use client';

import { useSyncExternalStore } from 'react';
import type { UserId } from '@fant/shared';
import { isApiError } from './api';
import { readPref, writePref } from './prefs';

/**
 * "This account is suspended from posting" — remembered per account on this device.
 *
 * The contract has no ban flag on `Me` yet, so the client learns it from the API: every Community write by a
 * banned user is answered 403. We remember that (so the notice is shown on the next visit too) and forget it on
 * the next successful write (after an unban).
 */
const key = (id: UserId) => `fant.community.banned.${id}`;
const listeners = new Set<() => void>();
const cache = new Map<string, boolean>();

function read(id: UserId): boolean {
  const k = key(id);
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const v = readPref(k) === '1';
  cache.set(k, v);
  return v;
}

export function setBanned(id: UserId, banned: boolean): void {
  if (read(id) === banned) return;
  cache.set(key(id), banned);
  writePref(key(id), banned ? '1' : '0');
  listeners.forEach((l) => l());
}

/** A 403 on a Community write by a non-admin = banned. */
export function isBannedError(e: unknown): boolean {
  return isApiError(e) && e.status === 403;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useBanned(id: UserId | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (id ? read(id) : false),
    () => false,
  );
}
