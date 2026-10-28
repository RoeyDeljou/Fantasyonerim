'use client';

import { useSyncExternalStore } from 'react';
import { fmt, useI18n } from '@/i18n';
import { youtubeEmbedUrl } from '@/lib/newsFormat';
import { PlayIcon } from '@/components/icons';
import { cx } from '@/components/ui';
import { MediaImage } from './parts';

// ---------- one player at a time ----------

/** The key of the player that is currently loaded (null = none). Starting one unloads the previous iframe. */
let active: string | null = null;
const listeners = new Set<() => void>();

function setActive(key: string | null) {
  active = key;
  listeners.forEach((l) => l());
}

function useActive(): string | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => active,
    () => null,
  );
}

/**
 * A YouTube thumbnail with a play overlay; tapping swaps in the official (privacy-enhanced) embed so plays count as
 * YouTube views. The iframe is only created after the tap, which keeps the feed light.
 */
export function YouTubePlayer({
  playerKey,
  videoId,
  thumbnail,
  title,
  shape,
}: {
  /** Unique per card (the news item id). */
  playerKey: string;
  videoId: string;
  thumbnail: string;
  title: string;
  shape: 'short' | 'video';
}) {
  const { t } = useI18n();
  const playing = useActive() === playerKey;
  const box = cx(
    'relative overflow-hidden rounded-2xl bg-story-bg shadow-card',
    shape === 'short' ? 'mx-auto aspect-[9/16] w-full max-w-72' : 'aspect-video w-full',
  );

  if (playing) {
    return (
      <div className={box} data-testid="youtube-player" data-shape={shape}>
        <iframe
          src={youtubeEmbedUrl(videoId)}
          title={title || t.news.youtubePlayer}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 size-full border-0"
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setActive(playerKey)}
      aria-label={title ? fmt(t.news.playOnYoutube, { title }) : t.news.playVideo}
      className={cx('group block', box)}
      data-testid="youtube-player"
      data-shape={shape}
    >
      <MediaImage src={thumbnail} alt="" className="size-full object-cover" />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-media-scrim text-on-media backdrop-blur-sm transition-transform group-active:scale-95">
          <PlayIcon size={26} />
        </span>
      </span>
    </button>
  );
}
