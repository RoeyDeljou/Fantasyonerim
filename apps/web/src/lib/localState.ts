'use client';

import { useSyncExternalStore } from 'react';
import { readPref, writePref } from './prefs';

/**
 * Small device-local UI state for News (seen stories, push-prompt dismissal, preferred podcast app). All of it is
 * cosmetic — losing it never breaks anything — so storage errors are swallowed by readPref/writePref.
 */
const KEYS = {
  seenStories: 'fant.news.seenStories',
  pushPromptDismissedAt: 'fant.news.pushPromptDismissedAt',
  listenApp: 'fant.news.listenApp',
} as const;

function readJson(key: string): unknown {
  const raw = readPref(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// ---------- seen stories (reactive: the ring colour updates as soon as a story is viewed) ----------

const MAX_SEEN = 300;
let seenCache: string[] | null = null;
const seenListeners = new Set<() => void>();

function seenList(): string[] {
  if (seenCache) return seenCache;
  const v = readJson(KEYS.seenStories);
  seenCache = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return seenCache;
}

export function markStorySeen(id: string): void {
  const list = seenList();
  if (list.includes(id)) return;
  seenCache = [...list, id].slice(-MAX_SEEN);
  writePref(KEYS.seenStories, JSON.stringify(seenCache));
  seenListeners.forEach((l) => l());
}

const EMPTY: string[] = [];
export function useSeenStories(): readonly string[] {
  return useSyncExternalStore(
    (cb) => {
      seenListeners.add(cb);
      return () => seenListeners.delete(cb);
    },
    seenList,
    () => EMPTY,
  );
}

// ---------- push prompt ----------

export const PUSH_PROMPT_SNOOZE_MS = 14 * 86_400_000;

export function pushPromptSnoozed(now: number): boolean {
  const at = Number(readPref(KEYS.pushPromptDismissedAt));
  return Number.isFinite(at) && at > 0 && now - at < PUSH_PROMPT_SNOOZE_MS;
}

export function snoozePushPrompt(now: number): void {
  writePref(KEYS.pushPromptDismissedAt, String(now));
}

// ---------- podcast app choice ----------

/** "Where to listen": ask every time, or always open the chosen platform (changeable in Profile). */
export type ListenPref = 'ask' | 'spotify' | 'apple';
const listenListeners = new Set<() => void>();

function readListen(): ListenPref {
  const v = readPref(KEYS.listenApp);
  return v === 'spotify' || v === 'apple' ? v : 'ask';
}

export function setListenPref(p: ListenPref): void {
  writePref(KEYS.listenApp, p);
  listenListeners.forEach((l) => l());
}

export function useListenPref(): ListenPref {
  return useSyncExternalStore(
    (cb) => {
      listenListeners.add(cb);
      return () => listenListeners.delete(cb);
    },
    readListen,
    () => 'ask',
  );
}
