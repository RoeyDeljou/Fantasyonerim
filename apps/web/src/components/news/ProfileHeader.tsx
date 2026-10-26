'use client';

import { useMemo, useState } from 'react';
import type { NewsItem } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useSeenStories } from '@/lib/localState';
import { useStories } from '@/lib/queries';
import { useNow } from './parts';
import { StoryViewer } from './StoryViewer';

/** Stories are shown for exactly 24 h: drop anything past `expiresAt` even before the next poll. */
function activeStories(items: readonly NewsItem[] | undefined, now: number): NewsItem[] {
  if (!items) return [];
  return items.filter((s) => s.media.length > 0 && (!s.expiresAt || new Date(s.expiresAt).getTime() > now));
}

/**
 * Instagram-profile-style header: the podcast logo in a large circle with the account name under it.
 * Unseen stories → colourful gradient ring; all seen → thin muted ring; no stories → plain circle.
 * Tapping a ringed avatar opens the story viewer at the first unseen story.
 */
export function ProfileHeader() {
  const { t, f } = useI18n();
  const stories = useStories();
  const now = useNow();
  const seen = useSeenStories();
  const [openAt, setOpenAt] = useState<number | null>(null);
  const active = useMemo(() => activeStories(stories.data?.items, now || Date.now()), [stories.data, now]);
  // Keep the list stable while the viewer is open (a poll must not yank the current story away).
  const [frozen, setFrozen] = useState<NewsItem[] | null>(null);

  const has = active.length > 0;
  const firstUnseen = active.findIndex((s) => !seen.includes(s.id));
  const allSeen = has && firstUnseen === -1;
  const latest = active[active.length - 1];

  const open = () => {
    if (!has) return;
    setFrozen(active);
    setOpenAt(firstUnseen === -1 ? 0 : firstUnseen);
  };

  const avatar = (
    <span
      className={has ? 'story-ring flex rounded-full' : 'flex rounded-full'}
      data-seen={has ? String(allSeen) : undefined}
      data-testid="profile-avatar"
      data-state={has ? (allSeen ? 'seen' : 'unseen') : 'none'}
    >
      <span className={has ? 'story-gap flex rounded-full' : 'flex rounded-full'}>
        <img
          src="/brand/logo-320.png"
          alt=""
          width={104}
          height={104}
          className="size-[6.5rem] rounded-full border border-line bg-accent object-cover"
        />
      </span>
    </span>
  );

  return (
    <section className="flex flex-col items-center gap-2 pt-2 pb-1 text-center" aria-label={t.app.name}>
      {has ? (
        <button
          type="button"
          onClick={open}
          aria-label={t.news.openStories}
          className="rounded-full transition-transform active:scale-95"
        >
          {avatar}
        </button>
      ) : (
        avatar
      )}
      <div className="flex flex-col items-center gap-0.5">
        <h1 className="text-xl font-extrabold text-ink">{t.app.name}</h1>
        {has && latest ? (
          <p className={allSeen ? 'text-sm text-muted' : 'text-sm font-semibold text-primary'}>
            {fmt(allSeen ? t.news.storySeen : t.news.newStory, {
              time: f.relative(latest.publishedAt, now || Date.now()),
            })}
          </p>
        ) : (
          <p className="text-sm text-muted">{t.news.handle}</p>
        )}
      </div>
      {openAt !== null && frozen && (
        <StoryViewer
          stories={frozen}
          startIndex={openAt}
          onClose={() => {
            setOpenAt(null);
            setFrozen(null);
          }}
        />
      )}
    </section>
  );
}
