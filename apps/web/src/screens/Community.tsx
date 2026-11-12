'use client';

import { Suspense, memo, useDeferredValue, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PostIdSchema } from '@fant/shared';
import type { CommunityPost, Me } from '@fant/shared';
import { useI18n } from '@/i18n';
import { useBanned } from '@/lib/banned';
import { useCommunityFeed, useCommunityHead, useMe } from '@/lib/queries';
import { useQueryParam } from '@/lib/useQueryParam';
import { AppShell } from '@/components/AppShell';
import { ArrowUpIcon, CommunityIcon, ImageIcon, RefreshIcon, ShirtIcon } from '@/components/icons';
import { ComposerSheet, Thread } from '@/components/lazySheets';
import { PostCard, PostCardSkeleton } from '@/components/community/PostCard';
import { AuthorAvatar, BannedNotice, CommunityToastProvider } from '@/components/community/parts';
import { MediaPriority } from '@/components/news/parts';
import { SignUpPrompt } from '@/components/SignUpPrompt';
import { useIsGuest } from '@/lib/guest';
import { lazyWhenOpen } from '@/components/lazy';
import {
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  Segmented,
  Skeleton,
  SkeletonList,
  Spinner,
  errorMessage,
} from '@/components/ui';
import { appScroller, scrollAppTo } from '@/lib/scroller';

export function CommunityScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.community.title} skeleton={<CommunityShellSkeleton />}>
      <Suspense fallback={<CommunityShellSkeleton />}>
        <CommunityToastProvider>
          <CommunityInner />
        </CommunityToastProvider>
      </Suspense>
    </AppShell>
  );
}

/** Set when the thread was opened from the feed, so "back" can pop history (keeps the feed's scroll). */
let openedFromFeed = false;
export function markOpenedFromFeed(): void {
  openedFromFeed = true;
}

type View = 'feed' | 'captain';

/**
 * "My Community Captain" (screens/CaptainVote.tsx) is its own chunk, with its own strings: fans reading the feed
 * don't download it, and it is fetched in the background once the tab is idle so the sub-tab opens instantly.
 */
const CaptainVoteView = lazyWhenOpen(
  () => import('./CaptainVote').then((m) => m.CaptainVoteView),
  () => true,
  <SkeletonList rows={3} />,
);

function CommunityInner() {
  const router = useRouter();
  const { t } = useI18n();
  const [postParam] = useQueryParam('post');
  const [viewParam, setView] = useQueryParam('view');
  const view: View = viewParam === 'captain' ? 'captain' : 'feed';
  const postId = useMemo(() => {
    const p = PostIdSchema.safeParse(postParam);
    return p.success ? p.data : null;
  }, [postParam]);

  const back = useCallback(() => {
    if (openedFromFeed) {
      openedFromFeed = false;
      router.back();
    } else router.replace('/community/', { scroll: false });
  }, [router]);

  if (postId) return <Thread postId={postId} onBack={back} />;
  return (
    <div className="flex flex-col gap-4">
      <Segmented<View>
        label={t.community.viewsLabel}
        byLabel
        value={view}
        onChange={(v) => setView(v === 'feed' ? null : v)}
        options={[
          { value: 'feed', label: t.community.viewFeed },
          { value: 'captain', label: t.community.viewCaptain },
        ]}
      />
      {view === 'feed' ? <FeedView /> : <CaptainVoteView active />}
    </div>
  );
}

function FeedView() {
  const me = useMe();
  const banned = useBanned();
  const guest = useIsGuest();
  const [composing, setComposing] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {banned && <BannedNotice />}
      {/* Guests read the feed; posting needs an account. */}
      {guest && <SignUpPrompt />}
      {me.data && (
        <>
          <ComposerEntry me={me.data} disabled={banned} onOpen={() => setComposing(true)} />
          <ComposerSheet open={composing} onClose={() => setComposing(false)} me={me.data} />
        </>
      )}
      <Feed />
    </div>
  );
}

/** Disabled while `Me.canPost` is false (the banned notice above explains why). */
function ComposerEntry({ me, disabled, onOpen }: { me: Me; disabled: boolean; onOpen(): void }) {
  const { t } = useI18n();
  const c = t.community;
  return (
    <section className="flex items-center gap-2.5 rounded-3xl border border-line bg-surface p-3 shadow-card">
      <AuthorAvatar
        author={{ id: me.id, name: me.name, entryId: me.entryId, teamName: me.teamName, role: me.role, avatarUrl: me.avatarUrl }}
      />
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        aria-label={c.composerOpen}
        data-testid="composer-open"
        className="min-h-11 flex-1 truncate rounded-full bg-surface-2 px-4 text-start text-[15px] text-muted transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {c.composerPlaceholder}
      </button>
      <div className="flex shrink-0" aria-hidden="true">
        <span className="flex size-9 items-center justify-center text-primary">
          <ImageIcon size={20} />
        </span>
        {me.entryId !== null && (
          <span className="flex size-9 items-center justify-center text-primary">
            <ShirtIcon size={20} />
          </span>
        )}
      </div>
    </section>
  );
}

function Feed() {
  const { t } = useI18n();
  const c = t.community;
  const feed = useCommunityFeed();
  const head = useCommunityHead(feed.isSuccess);
  const sentinel = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: CommunityPost[] = [];
    for (const p of feed.data?.pages ?? []) {
      for (const i of p.items) {
        if (seen.has(i.id)) continue;
        seen.add(i.id);
        out.push(i);
      }
    }
    return out;
  }, [feed.data]);
  // A new page (or a poll) renders as an interruptible background update: the rows appended at the end never
  // block a scroll frame (they used to be one 150–200 ms task on a mid-range phone).
  const deferred = useDeferredValue(items);
  // The first rows render right away (they are the screen's content and LCP); only later changes are deferred.
  const shown = deferred.length === 0 ? items : deferred;

  const newest = items[0];
  const hasNewer =
    !!newest &&
    !!head.data?.items.some(
      (i) => !items.some((x) => x.id === i.id) && Date.parse(i.createdAt) > Date.parse(newest.createdAt),
    );

  const { hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchNextPageError) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      // The shell's scroller is the viewport here: against the window the margin would be clipped away.
      { root: appScroller(), rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, isFetchNextPageError, items.length]);

  if (feed.isPending) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-busy="true">
        <PostCardSkeleton />
        <PostCardSkeleton />
        <PostCardSkeleton />
      </div>
    );
  }
  if (!feed.data) return <ErrorState error={feed.error} onRetry={() => feed.refetch()} />;
  if (items.length === 0) {
    return (
      <EmptyState icon={<CommunityIcon width={32} height={32} />} title={c.emptyTitle} body={c.emptyBody} />
    );
  }

  return (
    <>
      {hasNewer && (
        <div className="pointer-events-none sticky top-2 z-20 -mb-12 flex justify-center">
          <button
            type="button"
            data-testid="new-posts"
            onClick={() => {
              scrollAppTo(0, 'smooth');
              void feed.refetch().then(() => head.refetch());
            }}
            className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm font-bold text-on-primary shadow-card"
          >
            <ArrowUpIcon size={16} />
            {c.newPosts}
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-4" data-testid="community-feed">
        {shown.map((post, i) => (
          <FeedRow key={post.id} post={post} first={i === 0} />
        ))}
      </ul>
      <div ref={sentinel} className="flex min-h-16 flex-col items-center justify-center gap-2 py-2">
        {isFetchingNextPage ? (
          <span className="flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner />
            {t.common.loadingMore}
          </span>
        ) : isFetchNextPageError ? (
          <>
            <InlineError>{errorMessage(t, feed.error)}</InlineError>
            <Button variant="secondary" onClick={() => void fetchNextPage()}>
              <RefreshIcon size={18} />
              {t.common.retry}
            </Button>
          </>
        ) : !hasNextPage ? (
          <span className="text-sm text-muted">{c.end}</span>
        ) : null}
      </div>
    </>
  );
}

/** Thread links inside the feed remember they came from here (so "back" restores the scroll position). */
function onThreadLinkClick(e: MouseEvent<HTMLLIElement>) {
  if (e.target instanceof Element && e.target.closest('a[data-testid=comments-link]')) markOpenedFromFeed();
}

/** One feed row, memoized: a refetch re-renders only posts that changed. The first post's photo loads first. */
const FeedRow = memo(function FeedRow({ post, first }: { post: CommunityPost; first: boolean }) {
  return (
    <li className="feed-item" onClickCapture={onThreadLinkClick}>
      <MediaPriority value={first}>
        <PostCard post={post} />
      </MediaPriority>
    </li>
  );
});

/** Community before anything loaded: the composer entry and two posts. */
function CommunityShellSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true">
      <Skeleton className="h-16 rounded-3xl" />
      <PostCardSkeleton />
      <PostCardSkeleton />
    </div>
  );
}
