'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { NewsItem } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { markStorySeen } from '@/lib/localState';
import { CameraIcon, CloseIcon, MuteIcon, VolumeIcon } from '@/components/icons';
import { Logo } from '@/components/AppShell';
import { Spinner, cx } from '@/components/ui';
import { RelativeTime } from './parts';

const IMAGE_MS = 5000;
const HOLD_MS = 220;
const SWIPE_CLOSE_PX = 90;

/** Warm the browser cache for the story after `i` so advancing is instant. */
function usePreload(stories: readonly NewsItem[], i: number) {
  const keep = useRef<Array<HTMLImageElement | HTMLVideoElement>>([]);
  useEffect(() => {
    const next = stories[i + 1]?.media[0];
    if (!next) return;
    if (next.kind === 'image') {
      const img = new Image();
      img.src = next.url;
      keep.current = [img];
    } else {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.muted = true;
      v.src = next.url;
      keep.current = [v];
      if (next.posterUrl) {
        const p = new Image();
        p.src = next.posterUrl;
        keep.current.push(p);
      }
    }
  }, [stories, i]);
}

/**
 * Full-screen Instagram-style story viewer. Tap the forward side for next, the back side for previous
 * (mirrored in RTL: forward is the left side in Hebrew), hold to pause, swipe down / Esc / X to close.
 * Images show for 5 s, videos for their own duration (muted by default).
 */
export function StoryViewer({
  stories,
  startIndex,
  onClose,
}: {
  stories: readonly NewsItem[];
  startIndex: number;
  onClose(): void;
}) {
  const { t, dir } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(startIndex);
  const [muted, setMuted] = useState(true);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [dragY, setDragY] = useState(0);
  const bar = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const elapsed = useRef(0);
  const pointer = useRef<{ x: number; y: number; t: number; holdTimer: number } | null>(null);

  const story = stories[index];
  const media = story?.media[0];
  const isVideo = media?.kind === 'video';
  // Portrait stories fill the screen like Instagram; landscape/unknown media is letterboxed.
  const fit =
    media?.width && media.height && media.width / media.height < 0.75 ? 'object-cover' : 'object-contain';
  const paused = held || hidden;

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const next = useCallback(() => {
    if (index >= stories.length - 1) onClose();
    else setIndex(index + 1);
  }, [index, stories.length, onClose]);
  const prev = useCallback(() => {
    if (index > 0) setIndex(index - 1);
    else {
      elapsed.current = 0;
      if (video.current) video.current.currentTime = 0;
    }
  }, [index]);

  // New story: reset timers, mark seen.
  useEffect(() => {
    elapsed.current = 0;
    setLoaded(false);
    setFailed(false);
    if (bar.current) bar.current.style.width = '0%';
    if (story) markStorySeen(story.id);
  }, [story]);

  usePreload(stories, index);

  // Pause while the tab is hidden.
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState !== 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Image (or failed media) timer: rAF loop that only advances while not paused.
  useEffect(() => {
    if (isVideo && !failed) return;
    if (paused || (!loaded && !failed)) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsed.current += now - last;
      last = now;
      const p = Math.min(1, elapsed.current / IMAGE_MS);
      if (bar.current) bar.current.style.width = `${p * 100}%`;
      if (p >= 1) next();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isVideo, failed, paused, loaded, next]);

  // Video: play/pause with the hold state; progress from currentTime.
  useEffect(() => {
    const v = video.current;
    if (!v || !isVideo) return;
    if (paused) v.pause();
    else void v.play().catch(() => undefined);
  }, [paused, isVideo, index]);

  const toggleMute = () => setMuted((m) => !m);

  // ---------- gestures ----------
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const holdTimer = window.setTimeout(() => setHeld(true), HOLD_MS);
    pointer.current = { x: e.clientX, y: e.clientY, t: performance.now(), holdTimer };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p) return;
    const dy = e.clientY - p.y;
    if (dy > 8) {
      window.clearTimeout(p.holdTimer);
      setHeld(true);
      setDragY(dy);
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p) return;
    window.clearTimeout(p.holdTimer);
    const dy = e.clientY - p.y;
    const wasHold = performance.now() - p.t >= HOLD_MS;
    setHeld(false);
    setDragY(0);
    if (dy > SWIPE_CLOSE_PX) {
      onClose();
      return;
    }
    if (wasHold || Math.abs(dy) > 8) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const onRight = e.clientX - rect.left > rect.width / 2;
    // LTR: right = next. RTL: left = next (the reading direction runs right → left).
    const forward = dir === 'rtl' ? !onRight : onRight;
    if (forward) next();
    else prev();
  };
  const onPointerCancel = () => {
    if (pointer.current) window.clearTimeout(pointer.current.holdTimer);
    pointer.current = null;
    setHeld(false);
    setDragY(0);
  };

  if (!story || !media) return null;
  const instagramUrl = story.links.instagram;

  return (
    <dialog
      ref={dialog}
      className="story"
      aria-label={fmt(t.news.storyOf, { i: index + 1, n: stories.length })}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') (dir === 'rtl' ? prev : next)();
        if (e.key === 'ArrowLeft') (dir === 'rtl' ? next : prev)();
      }}
    >
      <div
        className="relative mx-auto flex h-full max-w-md flex-col overflow-hidden transition-transform"
        style={{
          transform: dragY ? `translateY(${dragY}px) scale(${Math.max(0.85, 1 - dragY / 1500)})` : undefined,
          opacity: dragY ? Math.max(0.4, 1 - dragY / 500) : undefined,
        }}
      >
        {/* media stage + tap zones */}
        <div
          className="absolute inset-0 touch-none select-none"
          data-testid="story-stage"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
        >
          {failed ? (
            <div className="flex size-full flex-col items-center justify-center gap-3 text-story-ink/80">
              <CameraIcon size={40} />
              <p className="text-sm">{t.story.failed}</p>
            </div>
          ) : isVideo ? (
            <video
              key={story.id}
              ref={video}
              src={media.url}
              poster={media.posterUrl ?? undefined}
              muted={muted}
              playsInline
              autoPlay
              preload="auto"
              className={cx('size-full', fit)}
              onLoadedData={() => setLoaded(true)}
              onError={() => setFailed(true)}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                if (bar.current && v.duration > 0)
                  bar.current.style.width = `${(v.currentTime / v.duration) * 100}%`;
              }}
              onEnded={next}
            />
          ) : (
            <img
              key={story.id}
              src={media.url}
              alt={story.text ?? ''}
              draggable={false}
              className={cx('size-full', fit)}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
            />
          )}
          {!loaded && !failed && (
            <div className="absolute inset-0 flex items-center justify-center text-story-ink">
              <Spinner className="size-8" />
            </div>
          )}
        </div>

        {/* tap zones aren't reachable without a pointer: keyboard / screen-reader equivalents */}
        <button type="button" className="sr-only focus-visible:not-sr-only" onClick={prev}>
          {t.story.prev}
        </button>
        <button type="button" className="sr-only focus-visible:not-sr-only" onClick={next}>
          {t.story.next}
        </button>

        {/* top chrome */}
        <div className="story-shade-top pointer-events-none relative z-10 flex flex-col gap-2 px-2 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-6">
          <div className="flex gap-1" aria-hidden="true">
            {stories.map((s, i) => (
              <span
                key={`${s.id}-${i < index ? 'done' : i === index ? 'now' : 'todo'}`}
                className="h-0.5 flex-1 overflow-hidden rounded-full bg-story-track"
              >
                <span
                  ref={i === index ? bar : undefined}
                  className="block h-full bg-story-ink"
                  style={{ width: i < index ? '100%' : '0%' }}
                />
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2 ps-1">
            <Logo size={32} />
            <span className="text-sm font-bold">{t.app.name}</span>
            <RelativeTime iso={story.publishedAt} className="text-sm text-story-ink/75" />
            {paused && <span className="text-xs text-story-ink/75">· {t.story.paused}</span>}
            <span className="ms-auto flex items-center">
              {isVideo && (
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? t.story.unmute : t.story.mute}
                  className="pointer-events-auto flex size-11 items-center justify-center rounded-full"
                >
                  {muted ? <MuteIcon /> : <VolumeIcon />}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                // Initial focus for showModal(): otherwise the first (visually hidden) prev button gets it.
                autoFocus
                aria-label={t.story.close}
                className="pointer-events-auto flex size-11 items-center justify-center rounded-full"
              >
                <CloseIcon />
              </button>
            </span>
          </div>
        </div>

        {/* bottom chrome */}
        <div
          className={cx(
            'story-shade-bottom pointer-events-none relative z-10 mt-auto flex flex-col items-center gap-3 px-4 pt-10 pb-[calc(1rem+env(safe-area-inset-bottom))]',
          )}
        >
          {story.text && (
            <p dir="auto" className="line-clamp-3 text-center text-sm whitespace-pre-line">
              {story.text}
            </p>
          )}
          {instagramUrl && (
            <a
              href={instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-story-ink/15 px-4 text-sm font-semibold backdrop-blur"
            >
              <CameraIcon size={18} />
              {t.story.openInInstagram}
            </a>
          )}
        </div>
      </div>
    </dialog>
  );
}
