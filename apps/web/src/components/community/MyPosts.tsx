'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import type { UserId } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useCommunityFeed } from '@/lib/queries';
import { ChatIcon, ChevronEndIcon, HeartIcon, ImageIcon, ShirtIcon } from '@/components/icons';
import { RelativeTime } from '@/components/news/parts';
import { Button, Card, ErrorState, Num, SectionTitle, Skeleton, Spinner } from '@/components/ui';
import { threadHref } from './PostCard';

/** Profile → "My posts": the author-filtered feed as compact rows linking to each thread. */
export function MyPostsCard({ userId }: { userId: UserId }) {
  const { t } = useI18n();
  const c = t.community;
  const feed = useCommunityFeed(userId);
  const items = useMemo(() => (feed.data?.pages ?? []).flatMap((p) => p.items), [feed.data]);

  return (
    <Card className="flex flex-col gap-2">
      <SectionTitle>{c.myPosts}</SectionTitle>
      {feed.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-busy="true">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : !feed.data ? (
        <ErrorState error={feed.error} onRetry={() => feed.refetch()} />
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted">{c.myPostsEmpty}</p>
          <Link
            href="/community/"
            className="inline-flex min-h-11 items-center rounded-xl bg-primary-soft px-4 text-sm font-semibold text-on-primary-soft hover:bg-surface-3"
          >
            {c.goToCommunity}
          </Link>
        </div>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {items.map((p) => (
            <li key={p.id}>
              <Link
                href={threadHref(p.id)}
                className="flex min-h-14 items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2"
                data-testid="my-post"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span dir="auto" className="name-start truncate text-[15px] text-ink">
                    {p.text || (p.team ? fmt(c.teamOf, { name: p.team.managerName }) : c.photo)}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted">
                    <RelativeTime iso={p.createdAt} />
                    {p.image && <ImageIcon size={14} />}
                    {p.team && (
                      <span className="inline-flex items-center gap-0.5">
                        <ShirtIcon size={14} />
                        {fmt(c.teamGw, { gw: p.team.event })}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-0.5">
                      <HeartIcon size={14} />
                      <Num value={p.likeCount} />
                    </span>
                    <span className="inline-flex items-center gap-0.5">
                      <ChatIcon size={14} />
                      <Num value={p.commentCount} />
                    </span>
                  </span>
                </div>
                <ChevronEndIcon size={18} className="shrink-0 text-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {feed.hasNextPage && (
        <Button
          variant="ghost"
          onClick={() => void feed.fetchNextPage()}
          disabled={feed.isFetchingNextPage}
          className="self-center"
        >
          {feed.isFetchingNextPage && <Spinner />}
          {t.common.loadMore}
        </Button>
      )}
    </Card>
  );
}
