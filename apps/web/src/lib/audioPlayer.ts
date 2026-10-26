'use client';

import { useSyncExternalStore } from 'react';
import {
  readAudioPosition,
  readPlaybackRate,
  writeAudioPosition,
  writePlaybackRate,
} from './localState';
import type { PlaybackRate } from './localState';

/**
 * One app-wide <audio> element for podcast episodes: only one episode can ever play, the position is
 * remembered per episode, and the Media Session API drives the lock-screen / notification controls.
 */
export interface Episode {
  id: string;
  src: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  /** Known duration from the feed, used until the media reports its own. */
  durationSec: number | null;
}

export interface PlayerState {
  id: string | null;
  playing: boolean;
  loading: boolean;
  error: boolean;
  current: number;
  duration: number;
  rate: PlaybackRate;
}

const INITIAL: PlayerState = {
  id: null,
  playing: false,
  loading: false,
  error: false,
  current: 0,
  duration: 0,
  rate: 1,
};

let state: PlayerState = typeof window === 'undefined' ? INITIAL : { ...INITIAL, rate: readPlaybackRate() };
let audio: HTMLAudioElement | null = null;
let episode: Episode | null = null;
let lastSaved = 0;
const listeners = new Set<() => void>();

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function savePosition(force = false) {
  if (!audio || !episode) return;
  const t = audio.currentTime;
  if (!force && Math.abs(t - lastSaved) < 5) return;
  lastSaved = t;
  const nearEnd = audio.duration > 0 && audio.duration - t < 15;
  writeAudioPosition(episode.id, nearEnd ? 0 : t);
}

function updatePositionState() {
  if (!audio || !('mediaSession' in navigator)) return;
  const duration = Number.isFinite(audio.duration) ? audio.duration : (episode?.durationSec ?? 0);
  if (!(duration > 0)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, duration),
    });
  } catch {
    // some browsers reject position state mid-load
  }
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = 'metadata';
  a.addEventListener('play', () => set({ playing: true, error: false }));
  a.addEventListener('playing', () => set({ playing: true, loading: false }));
  a.addEventListener('pause', () => {
    savePosition(true);
    set({ playing: false });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  a.addEventListener('waiting', () => set({ loading: true }));
  a.addEventListener('canplay', () => set({ loading: false }));
  a.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(a.duration)) set({ duration: a.duration });
    updatePositionState();
  });
  a.addEventListener('timeupdate', () => {
    set({ current: a.currentTime });
    savePosition();
  });
  a.addEventListener('ratechange', updatePositionState);
  a.addEventListener('ended', () => {
    if (episode) writeAudioPosition(episode.id, 0);
    set({ playing: false, current: 0 });
  });
  a.addEventListener('error', () => {
    if (a.getAttribute('src')) set({ playing: false, loading: false, error: true });
  });
  audio = a;
  wireMediaSession();
  return a;
}

function wireMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ['play', () => void audio?.play()],
    ['pause', () => audio?.pause()],
    ['seekbackward', (d) => seekBy(-(d.seekOffset ?? 15))],
    ['seekforward', (d) => seekBy(d.seekOffset ?? 30)],
    ['seekto', (d) => d.seekTime !== undefined && seek(d.seekTime)],
  ];
  for (const [action, fn] of handlers) {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // action not supported on this platform
    }
  }
}

function setMetadata(ep: Episode) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ep.title,
    artist: ep.artist,
    album: ep.artist,
    artwork: ep.artworkUrl
      ? [{ src: ep.artworkUrl, sizes: '512x512' }]
      : [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

/** Play `ep` (resuming its saved position), or toggle pause when it is already the loaded episode. */
export function toggleEpisode(ep: Episode): void {
  const a = element();
  if (episode?.id === ep.id) {
    if (a.paused) void play(a);
    else a.pause();
    return;
  }
  if (episode) savePosition(true);
  a.pause();
  episode = ep;
  const rate = readPlaybackRate();
  const resume = readAudioPosition(ep.id);
  lastSaved = resume;
  set({
    id: ep.id,
    playing: false,
    loading: true,
    error: false,
    current: resume,
    duration: ep.durationSec ?? 0,
    rate,
  });
  a.src = ep.src;
  a.playbackRate = rate;
  a.defaultPlaybackRate = rate;
  if (resume > 0) {
    const jump = () => {
      a.currentTime = resume;
    };
    a.addEventListener('loadedmetadata', jump, { once: true });
  }
  setMetadata(ep);
  void play(a);
}

async function play(a: HTMLAudioElement) {
  try {
    await a.play();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  } catch (e) {
    // AbortError = superseded by another load/pause; anything else is a real failure (e.g. unsupported).
    if (!(e instanceof DOMException && e.name === 'AbortError')) set({ playing: false, loading: false, error: true });
  }
}

export function seek(sec: number): void {
  if (!audio || !episode) return;
  const max = Number.isFinite(audio.duration) ? audio.duration : state.duration;
  const t = Math.max(0, Math.min(sec, max || sec));
  audio.currentTime = t;
  set({ current: t });
  savePosition(true);
  updatePositionState();
}

export function seekBy(delta: number): void {
  if (audio) seek(audio.currentTime + delta);
}

export function setRate(rate: PlaybackRate): void {
  writePlaybackRate(rate);
  if (audio) {
    audio.playbackRate = rate;
    audio.defaultPlaybackRate = rate;
  }
  set({ rate });
}

/** Pause whatever is playing (e.g. when a story video starts). */
export function pauseAudio(): void {
  audio?.pause();
}

export function usePlayer(): PlayerState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => INITIAL,
  );
}
