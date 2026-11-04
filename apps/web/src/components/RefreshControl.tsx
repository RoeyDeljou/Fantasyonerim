'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { RefreshResult } from '@/lib/refresh';
import { CheckIcon, RefreshIcon } from './icons';
import { IconButton, cx } from './ui';

/** Circular-arrow button in the top bar: spins while the screen's queries refetch. */
export function RefreshButton({ refreshing, onRefresh }: { refreshing: boolean; onRefresh(): void }) {
  const t = useT();
  return (
    <IconButton
      label={t.refresh.button}
      onClick={onRefresh}
      aria-busy={refreshing}
      data-testid="refresh-button"
      data-state={refreshing ? 'refreshing' : 'idle'}
    >
      <RefreshIcon size={22} className={cx(refreshing && 'animate-spin')} />
    </IconButton>
  );
}

/** "Updated just now" (or "Couldn't refresh") for a moment after a manual refresh; same slot as "Updating…". */
export function RefreshDone({ state }: { state: RefreshResult }) {
  const t = useT();
  if (state !== 'done' && state !== 'failed') return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.5rem)] z-40 flex justify-center"
      data-testid="refresh-done"
      data-state={state}
    >
      <span
        role="status"
        className={cx(
          'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold shadow-card',
          state === 'done' ? 'bg-primary text-on-primary' : 'bg-surface text-live',
        )}
      >
        {state === 'done' && <CheckIcon size={14} />}
        {state === 'done' ? t.refresh.done : t.refresh.failed}
      </span>
    </div>
  );
}

/** Pull distance (after damping) that triggers a refresh on release. */
export const PULL_THRESHOLD = 64;
const PULL_MAX = 96;
const DAMPING = 0.5;
/** Movement before deciding whether this touch is a pull (vertical, downward, from the top) or anything else. */
const SLOP = 8;

/**
 * Touch pull-to-refresh on the page scroller (the window). Passive listeners only: it never calls
 * preventDefault, so native scrolling, iOS rubber-banding and horizontal strips (fixtures) behave exactly as
 * before — the indicator just follows a downward drag that starts while the page is at the very top. Chrome's
 * own pull-to-reload is already off (`overscroll-behavior-y: contain` on body). Direction-agnostic, so RTL-safe.
 */
export function PullToRefresh({ refreshing, onRefresh }: { refreshing: boolean; onRefresh(): void }) {
  const [pull, setPull] = useState(0);
  const pullRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  const refreshingRef = useRef(refreshing);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
    refreshingRef.current = refreshing;
  }, [onRefresh, refreshing]);

  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    let mode: 'undecided' | 'pull' | 'ignore' = 'ignore';
    const set = (v: number) => {
      pullRef.current = v;
      setPull(v);
    };
    const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;

    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      const target = e.target instanceof Element ? e.target : null;
      if (
        e.touches.length !== 1 ||
        !touch ||
        refreshingRef.current ||
        !atTop() ||
        document.querySelector('dialog[open]') ||
        target?.closest('[data-no-pull-refresh], input, textarea, select, [contenteditable="true"]')
      ) {
        start = null;
        mode = 'ignore';
        return;
      }
      start = { x: touch.clientX, y: touch.clientY };
      mode = 'undecided';
    };
    const onMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!start || !touch || mode === 'ignore') return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (mode === 'undecided') {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        mode = dy > 0 && dy > Math.abs(dx) * 1.2 && atTop() ? 'pull' : 'ignore';
        if (mode === 'ignore') return;
      }
      // The content scrolled after all (e.g. a nested scroller): let it go.
      if (!atTop() && dy <= 0) {
        mode = 'ignore';
        set(0);
        return;
      }
      set(Math.min(PULL_MAX, Math.max(0, dy - SLOP) * DAMPING));
    };
    const onEnd = () => {
      if (mode === 'pull' && pullRef.current >= PULL_THRESHOLD) onRefreshRef.current();
      start = null;
      mode = 'ignore';
      set(0);
    };

    const opts: AddEventListenerOptions = { passive: true };
    document.addEventListener('touchstart', onStart, opts);
    document.addEventListener('touchmove', onMove, opts);
    document.addEventListener('touchend', onEnd, opts);
    document.addEventListener('touchcancel', onEnd, opts);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  const visible = pull > 0 || refreshing;
  const offset = refreshing && pull === 0 ? PULL_THRESHOLD * 0.75 : pull;
  const armed = pull >= PULL_THRESHOLD;
  return (
    <div
      aria-hidden="true"
      data-testid="pull-indicator"
      data-state={refreshing ? 'refreshing' : armed ? 'armed' : pull > 0 ? 'pulling' : 'idle'}
      className={cx(
        'pointer-events-none fixed inset-x-0 top-[calc(var(--app-top)+3.5rem)] z-20 flex justify-center',
        !visible && 'invisible',
      )}
      style={{
        transform: `translateY(${offset - 40}px)`,
        opacity: visible ? Math.min(1, 0.3 + offset / PULL_THRESHOLD) : 0,
        transition: pull > 0 ? 'none' : 'transform 200ms ease-out, opacity 200ms ease-out',
      }}
    >
      <span
        className={cx(
          'flex size-10 items-center justify-center rounded-full border border-line bg-surface shadow-card',
          armed || refreshing ? 'text-primary' : 'text-muted',
        )}
      >
        <RefreshIcon
          size={20}
          className={cx(refreshing && 'animate-spin')}
          style={refreshing ? undefined : { transform: `rotate(${Math.round(pull * 3.5)}deg)` }}
        />
      </span>
    </div>
  );
}
