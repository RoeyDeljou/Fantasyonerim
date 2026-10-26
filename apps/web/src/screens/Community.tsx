'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PostIdSchema } from '@fant/shared';
import type { CommunityPost, Me } from '@fant/shared';
import { useI18n } from '@/i18n';
import { useBanned } from '@/lib/banned';
import { useCommunityFeed, useCommunityHead, useMe } from '@/lib/queries';
import { useQueryParam } from '@/lib/useQueryParam';
import { AppShell, ShellSkeleton } from '@/components/AppShell';
import { ArrowUpIcon, CommunityIcon, ImageIcon, RefreshIcon, ShirtIcon } from '@/components/icons';
import { ComposerSheet } from '@/components/community/Composer';
import { PostCard, PostCardSkeleton } from '@/components/community/PostCard';
import { Thread } from '@/components/community/Thread';
import { AuthorAvatar, BannedNotice, CommunityToastProvider } from '@/components/community/parts';
import { Button, EmptyState, ErrorState, InlineError, Spinner, errorMessage } from '@/components/ui';

export function CommunityScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.community.title}>
      <Suspense fallback={<ShellSkeleton />}>
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

function CommunityInner() {
  const router = useRouter();
  const [postParam] = useQueryParam('post');
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
  return <FeedView />;
}

function FeedView() {
  const me = useMe();
  const banned = useBanned(me.data?.id);
  const [composing, setComposing] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {banned && <BannedNotice />}
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

function ComposerEntry({ me, disabled, onOpen }: { me: Me; disabled: boolean; onOpen(): void }) {
  const { t } = useI18n();
  const c = t.community;
  return (
    <section className="flex items-center gap-2.5 rounded-3xl border border-line bg-surface p-3 shadow-card">
      <AuthorAvatar
        author={{ id: me.id, name: me.name, entryId: me.entryId, teamName: me.teamName, role: me.role }}
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
      { rootMargin: '800px 0px' },
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
        <div className="pointer-events-none sticky top-[calc(4rem+env(safe-area-inset-top))] z-20 -mb-12 flex justify-center">
          <button
            type="button"
            data-testid="new-posts"
            onClick={() => {
              window.scrollTo({ top: 0, behavior: 'smooth' });
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
        {items.map((post) => (
          <li key={post.id} onClickCapture={onThreadLinkClick}>
            <PostCard post={post} />
          </li>
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
