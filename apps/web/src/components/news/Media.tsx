'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { NewsMedia } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { ChevronEndIcon, ChevronStartIcon, PlayIcon } from '@/components/icons';
import { cx } from '@/components/ui';
import { MediaImage } from './parts';

/** Aspect ratio from the first item, clamped to Instagram's range (4:5 portrait … 1.91:1 landscape). */
function ratioOf(media: readonly NewsMedia[]): number {
  const first = media[0];
  if (!first?.width || !first.height) return 1;
  return Math.min(1.91, Math.max(0.8, first.width / first.height));
}

/** Poster + play button; the <video> (with native controls) only loads once tapped — no autoplay. */
export function VideoTile({ media, className }: { media: NewsMedia; className?: string }) {
  const { t } = useI18n();
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (started) void ref.current?.play().catch(() => undefined);
  }, [started]);

  if (started) {
    return (
      <video
        ref={ref}
        src={media.url}
        poster={media.posterUrl ?? undefined}
        controls
        playsInline
        preload="auto"
        className={cx('bg-story-bg object-contain', className)}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setStarted(true)}
      aria-label={t.news.playVideo}
      className={cx('group relative block overflow-hidden bg-story-bg', className)}
    >
      {media.posterUrl ? (
        <MediaImage src={media.posterUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="block size-full bg-surface-2" />
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-media-scrim text-on-media backdrop-blur-sm transition-transform group-active:scale-95">
          <PlayIcon size={26} />
        </span>
      </span>
    </button>
  );
}

function Slide({ media, alt, eager }: { media: NewsMedia; alt: string; eager: boolean }) {
  return media.kind === 'video' ? (
    <VideoTile media={media} className="size-full" />
  ) : (
    <MediaImage
      src={media.url}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      className="size-full object-cover"
    />
  );
}

/**
 * Swipeable media carousel (native scroll-snap). In RTL the browser lays slides out right-to-left, so the
 * first item is on the right and swiping left moves forward — the same order Instagram uses in Hebrew.
 */
export function MediaCarousel({ media, alt }: { media: readonly NewsMedia[]; alt: string }) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const slides = useRef<Array<HTMLDivElement | null>>([]);
  const [index, setIndex] = useState(0);
  const ratio = ratioOf(media);

  useEffect(() => {
    const root = scroller.current;
    if (!root || media.length < 2) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setIndex(Number((e.target as HTMLElement).dataset.index ?? 0));
        }
      },
      { root, threshold: 0.6 },
    );
    slides.current.forEach((s) => s && io.observe(s));
    return () => io.disconnect();
  }, [media.length]);

  const go = (i: number) => {
    const root = scroller.current;
    if (!root) return;
    const target = Math.max(0, Math.min(media.length - 1, i));
    // RTL scroll offsets run negative from the start edge (CSSOM standard, all current engines).
    const sign = getComputedStyle(root).direction === 'rtl' ? -1 : 1;
    root.scrollTo({ left: sign * target * root.clientWidth, behavior: 'smooth' });
  };

  if (media.length === 0) return null;
  return (
    <div
      className="relative -mx-4 overflow-hidden bg-surface-2"
      style={{ aspectRatio: String(ratio) } as CSSProperties}
      role="group"
      aria-roledescription="carousel"
      aria-label={t.news.mediaLabel}
    >
      <div ref={scroller} className="snap-carousel flex size-full overflow-x-auto">
        {media.map((m, i) => (
          <div
            key={`${m.url}-${i}`}
            ref={(el) => {
              slides.current[i] = el;
            }}
            data-index={i}
            className="relative size-full shrink-0"
            aria-roledescription="slide"
            aria-label={fmt(t.news.mediaOf, { i: i + 1, n: media.length })}
          >
            <Slide media={m} alt={alt} eager={i === 0} />
          </div>
        ))}
      </div>
      {media.length > 1 && (
        <>
          <span className="absolute end-3 top-3 rounded-full bg-media-scrim px-2 py-0.5 text-xs font-semibold text-on-media tabular">
            <bdi dir="ltr">
              {index + 1}/{media.length}
            </bdi>
          </span>
          <div
            className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center gap-1.5"
            aria-hidden="true"
          >
            {media.map((m, i) => (
              <span
                key={`${m.url}-dot-${i}`}
                className={cx(
                  'size-1.5 rounded-full transition-all',
                  i === index ? 'w-4 bg-on-media' : 'bg-on-media/50',
                )}
              />
            ))}
          </div>
          {/* Arrow buttons for mouse users; touch users swipe. */}
          <button
            type="button"
            aria-label={t.news.prevMedia}
            disabled={index === 0}
            onClick={() => go(index - 1)}
            className="absolute start-2 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-media-scrim text-on-media disabled:opacity-0 pointer-fine:flex"
          >
            <ChevronStartIcon size={20} />
          </button>
          <button
            type="button"
            aria-label={t.news.nextMedia}
            disabled={index === media.length - 1}
            onClick={() => go(index + 1)}
            className="absolute end-2 top-1/2 hidden size-9 -translate-y-1/2 items-center justify-center rounded-full bg-media-scrim text-on-media disabled:opacity-0 pointer-fine:flex"
          >
            <ChevronEndIcon size={20} />
          </button>
        </>
      )}
    </div>
  );
}

/** X-style grid: 1 full, 2 side by side, 3 = one tall + two, 4 = 2×2. */
export function MediaGrid({ media, alt }: { media: readonly NewsMedia[]; alt: string }) {
  const items = media.slice(0, 4);
  if (items.length === 0) return null;
  if (items.length === 1) {
    const only = items[0];
    if (!only) return null;
    const ratio =
      only.width && only.height ? Math.min(1.91, Math.max(0.75, only.width / only.height)) : 16 / 9;
    return (
      <div
        className="overflow-hidden rounded-2xl border border-line bg-surface-2"
        style={{ aspectRatio: String(ratio) } as CSSProperties}
      >
        <Slide media={only} alt={alt} eager={false} />
      </div>
    );
  }
  return (
    <div
      className={cx(
        'grid aspect-[16/10] gap-0.5 overflow-hidden rounded-2xl border border-line bg-line',
        items.length === 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2',
      )}
    >
      {items.map((m, i) => (
        <div
          key={`${m.url}-${i}`}
          className={cx(
            'relative min-h-0 overflow-hidden bg-surface-2',
            items.length === 3 && i === 0 && 'row-span-2',
          )}
        >
          <Slide media={m} alt={alt} eager={false} />
        </div>
      ))}
    </div>
  );
}
