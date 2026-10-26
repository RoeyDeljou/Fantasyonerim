'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NewsItemIdSchema } from '@fant/shared';
import type { NewsItem } from '@fant/shared';
import { useI18n } from '@/i18n';
import { pushPromptSnoozed, snoozePushPrompt } from '@/lib/localState';
import { enablePush, usePushState } from '@/lib/push';
import type { PushError } from '@/lib/push';
import { useMe, useNewsFeed, useNewsHead, useNewsItem } from '@/lib/queries';
import { useQueryParam } from '@/lib/useQueryParam';
import { AppShell, ShellSkeleton } from '@/components/AppShell';
import { BottomSheet } from '@/components/BottomSheet';
import { IosInstallSteps } from '@/components/InstallGuide';
import { pushErrorText } from '@/components/NotificationsCard';
import { ArrowUpIcon, BellIcon, CloseIcon, MicIcon, RefreshIcon } from '@/components/icons';
import { NewsCard, NewsCardSkeleton } from '@/components/news/NewsCards';
import { ProfileHeader } from '@/components/news/ProfileHeader';
import { Button, EmptyState, ErrorState, IconButton, InlineError, Spinner, errorMessage } from '@/components/ui';

export function NewsScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.news.title}>
      <Suspense fallback={<ShellSkeleton />}>
        <NewsInner />
      </Suspense>
    </AppShell>
  );
}

function NewsInner() {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const [itemParam, setItemParam] = useQueryParam('item');
  const itemId = useMemo(() => {
    const p = NewsItemIdSchema.safeParse(itemParam);
    return p.success ? p.data : null;
  }, [itemParam]);

  return (
    <div className="flex flex-col gap-4">
      <ProfileHeader />
      <PushPrompt />
      {itemId && <Highlighted id={itemId} isAdmin={isAdmin} onClose={() => setItemParam(null)} />}
      <Feed isAdmin={isAdmin} skipId={itemId} />
    </div>
  );
}

// ---------- deep link (?item=) ----------

function Highlighted({ id, isAdmin, onClose }: { id: NewsItem['id']; isAdmin: boolean; onClose(): void }) {
  const { t } = useI18n();
  const item = useNewsItem(id);
  const ref = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    if (item.data && !scrolled.current && ref.current) {
      scrolled.current = true;
      ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [item.data]);

  return (
    <div ref={ref} className="flex scroll-mt-20 flex-col gap-2" data-testid="news-highlighted">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-primary">{t.news.highlighted}</span>
        <IconButton label={t.news.closeHighlight} onClick={onClose} className="-me-2">
          <CloseIcon size={20} />
        </IconButton>
      </div>
      {item.isPending ? (
        <NewsCardSkeleton />
      ) : item.isError ? (
        <ErrorState
          error={item.error}
          onRetry={() => item.refetch()}
          overrides={{ not_found: t.news.itemNotFound }}
        />
      ) : (
        <NewsCard item={item.data} isAdmin={isAdmin} highlighted />
      )}
    </div>
  );
}

// ---------- push prompt ----------

function PushPrompt() {
  const { t } = useI18n();
  const push = usePushState();
  const [snoozed, setSnoozed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PushError | null>(null);
  const [guide, setGuide] = useState(false);

  useEffect(() => setSnoozed(pushPromptSnoozed(Date.now())), []);

  if (snoozed) return null;
  if (push.state !== 'disabled' && push.state !== 'needs-install') return null;

  const dismiss = () => {
    snoozePushPrompt(Date.now());
    setSnoozed(true);
  };
  const enable = async () => {
    setBusy(true);
    setError(null);
    const r = await enablePush();
    push.setState(r.state);
    if (r.error && r.error !== 'dismissed') setError(r.error);
    setBusy(false);
  };

  return (
    <section
      className="relative flex flex-col gap-3 rounded-3xl bg-accent p-4 text-on-accent"
      data-testid="push-prompt"
    >
      <div className="flex items-start gap-3 pe-8">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
          <BellIcon size={20} />
        </span>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px] leading-snug font-bold">{t.push.promptTitle}</h2>
          <p className="text-xs opacity-80">{t.push.promptBody}</p>
        </div>
      </div>
      <IconButton
        label={t.push.promptLater}
        onClick={dismiss}
        className="absolute end-1 top-1 text-on-accent hover:bg-surface/30"
      >
        <CloseIcon size={18} />
      </IconButton>
      {error && <InlineError>{pushErrorText(t, error)}</InlineError>}
      <div className="flex gap-2">
        {push.state === 'needs-install' ? (
          <Button className="flex-1" onClick={() => setGuide(true)}>
            {t.push.promptInstall}
          </Button>
        ) : (
          <Button className="flex-1" onClick={() => void enable()} disabled={busy}>
            {busy ? <Spinner /> : <BellIcon size={18} />}
            {t.push.promptEnable}
          </Button>
        )}
        <Button variant="ghost" className="text-on-accent" onClick={dismiss}>
          {t.push.promptLater}
        </Button>
      </div>
      <BottomSheet open={guide} onClose={() => setGuide(false)} title={t.profile.installTitle}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t.push.needsInstallHelp}</p>
          <IosInstallSteps />
        </div>
      </BottomSheet>
    </section>
  );
}

// ---------- feed ----------

function Feed({ isAdmin, skipId }: { isAdmin: boolean; skipId: NewsItem['id'] | null }) {
  const { t } = useI18n();
  const feed = useNewsFeed();
  const head = useNewsHead(feed.isSuccess);
  const sentinel = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: NewsItem[] = [];
    for (const p of feed.data?.pages ?? []) {
      for (const i of p.items) {
        if (seen.has(i.id) || i.id === skipId || i.source === 'instagram_story') continue;
        seen.add(i.id);
        out.push(i);
      }
    }
    return out;
  }, [feed.data, skipId]);

  // Newer items on the server than the top of our list → offer the pill.
  const newest = feed.data?.pages[0]?.items[0];
  const hasNewer =
    !!newest &&
    !!head.data?.items.some((i) => i.id !== newest.id && Date.parse(i.publishedAt) > Date.parse(newest.publishedAt));

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
        <NewsCardSkeleton />
        <NewsCardSkeleton />
        <NewsCardSkeleton />
      </div>
    );
  }
  // A failed *next page* keeps the loaded pages (status is "error" but data is present).
  if (!feed.data) return <ErrorState error={feed.error} onRetry={() => feed.refetch()} />;
  if (items.length === 0 && !skipId) {
    return (
      <EmptyState
        icon={<MicIcon width={32} height={32} />}
        title={t.news.emptyTitle}
        body={t.news.emptyBody}
      />
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
            {t.news.newPosts}
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-4" data-testid="news-feed">
        {items.map((item) => (
          <li key={item.id}>
            <NewsCard item={item} isAdmin={isAdmin} />
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
        ) : !hasNextPage && items.length > 0 ? (
          <span className="text-sm text-muted">{t.news.end}</span>
        ) : null}
      </div>
    </>
  );
}
