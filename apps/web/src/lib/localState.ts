'use client';

import { useSyncExternalStore } from 'react';
import { BroadcastTargetSchema } from '@fant/shared';
import type { BroadcastTarget } from '@fant/shared';
import { readPref, removePref, writePref } from './prefs';
import { clearPersistedQueries } from './persist';

/**
 * Small device-local UI state (seen stories, push-prompt dismissal, preferred podcast app, the live-update
 * composer's last targets). All of it is cosmetic — losing it never breaks anything — so storage errors are
 * swallowed by readPref/writePref.
 */
const KEYS = {
  seenStories: 'fant.news.seenStories',
  pushPromptDismissedAt: 'fant.news.pushPromptDismissedAt',
  listenApp: 'fant.news.listenApp',
  broadcastTargets: 'fant.admin.broadcastTargets',
  adminCards: 'fant.admin.cards',
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

// ---------- live update composer: the last chosen targets ----------

/** The targets the admin picked last time (null = never sent from this device). */
export function readBroadcastTargets(): BroadcastTarget[] | null {
  const v = readJson(KEYS.broadcastTargets);
  if (!Array.isArray(v)) return null;
  return v.flatMap((x: unknown) => {
    const p = BroadcastTargetSchema.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

export function writeBroadcastTargets(targets: readonly BroadcastTarget[]): void {
  writePref(KEYS.broadcastTargets, JSON.stringify(targets));
}

// ---------- admin console: which collapsible cards are open ----------

function readCards(): Record<string, boolean> {
  const v = readJson(KEYS.adminCards);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, boolean] => typeof e[1] === 'boolean',
    ),
  );
}

/** The admin's own open/closed choice for a card on this device (null = never toggled). */
export function readCardOpen(id: string): boolean | null {
  return readCards()[id] ?? null;
}

export function writeCardOpen(id: string, open: boolean): void {
  writePref(KEYS.adminCards, JSON.stringify({ ...readCards(), [id]: open }));
}

/** Account deleted: forget everything this device remembered about it (theme and language stay — they're the device's). */
export function clearAccountLocalState(): void {
  clearPersistedQueries();
  for (const key of Object.values(KEYS)) removePref(key);
  seenCache = null;
  seenListeners.forEach((l) => l());
  listenListeners.forEach((l) => l());
}
