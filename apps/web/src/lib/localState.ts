'use client';

import { useSyncExternalStore } from 'react';
import { readPref, writePref } from './prefs';

/**
 * Small device-local UI state for News (seen stories, push-prompt dismissal, audio positions). All of it is
 * cosmetic — losing it never breaks anything — so storage errors are swallowed by readPref/writePref.
 */
const KEYS = {
  seenStories: 'fant.news.seenStories',
  pushPromptDismissedAt: 'fant.news.pushPromptDismissedAt',
  audioPositions: 'fant.news.audioPositions',
  playbackRate: 'fant.news.playbackRate',
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

// ---------- audio ----------

const MAX_POSITIONS = 100;

function positions(): Record<string, number> {
  const v = readJson(KEYS.audioPositions);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  return out;
}

export function readAudioPosition(id: string): number {
  return positions()[id] ?? 0;
}

/** `sec` ≤ 0 forgets the position (finished / restarted episodes start from the top). */
export function writeAudioPosition(id: string, sec: number): void {
  const all = positions();
  delete all[id];
  if (sec > 0) all[id] = Math.floor(sec);
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_POSITIONS))) delete all[k];
  writePref(KEYS.audioPositions, JSON.stringify(all));
}

export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export function readPlaybackRate(): PlaybackRate {
  const n = Number(readPref(KEYS.playbackRate));
  return PLAYBACK_RATES.find((r) => r === n) ?? 1;
}

export function writePlaybackRate(rate: PlaybackRate): void {
  writePref(KEYS.playbackRate, String(rate));
}
