'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CommunityPost } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useBanned } from '@/lib/banned';
import { useDeletePost, useLikePost, useMe } from '@/lib/queries';
import { ChatIcon, HeartIcon } from '@/components/icons';
import { ExpandableText, LinkifiedText, MediaImage } from '@/components/news/parts';
import { Num, cx } from '@/components/ui';
import { ContentMenu } from './ContentMenu';
import { ImageViewer } from './ImageViewer';
import { AuthorAvatar, AuthorLine, useNotify } from './parts';
import { SnapshotSheet, TeamPreview } from './TeamSnapshot';

/** Uploaded photos keep their shape within sensible bounds (4:5 portrait … 1.91:1 landscape, like Instagram). */
function aspect(w: number, h: number): number {
  return Math.min(1.91, Math.max(0.8, w / h));
}

export function threadHref(id: CommunityPost['id']): string {
  return `/community/?post=${encodeURIComponent(id)}`;
}

/** A post in the feed (or at the top of its thread, `inThread`). */
export function PostCard({
  post,
  inThread = false,
  onDeleted,
}: {
  post: CommunityPost;
  inThread?: boolean;
  onDeleted?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const c = t.community;
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const remove = useDeletePost();
  const notify = useNotify();
  const [viewer, setViewer] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const imageAlt = fmt(c.imageAlt, { name: post.author.name });

  return (
    <article
      id={`post-${post.id}`}
      data-testid="post-card"
      data-post-id={post.id}
      className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-4 shadow-card"
    >
      <header className="flex items-center gap-2.5">
        <AuthorAvatar author={post.author} />
        <AuthorLine author={post.author} createdAt={post.createdAt} />
        <ContentMenu
          target={{ kind: 'post', id: post.id }}
          canDelete={post.mine || isAdmin}
          canReport={!post.mine}
          deleteTitle={c.deletePostTitle}
          deleteBody={c.deletePostBody}
          deleting={remove.isPending}
          deleteError={remove.error}
          onDelete={(done) =>
            remove.mutate(post.id, {
              onSuccess: () => {
                done();
                notify(c.postDeleted);
                onDeleted?.();
              },
            })
          }
        />
      </header>

      {post.text &&
        (inThread ? (
          <div className="space-y-2 text-[15px] leading-relaxed text-ink" data-testid="post-text">
            <LinkifiedText text={post.text} platform="none" />
          </div>
        ) : (
          <div data-testid="post-text">
            <ExpandableText text={post.text} platform="none" lines={6} />
          </div>
        ))}

      {post.image && (
        <>
          <button
            type="button"
            onClick={() => setViewer(true)}
            aria-label={c.viewImage}
            className="-mx-1 overflow-hidden rounded-2xl border border-line bg-surface-2"
            style={{ aspectRatio: aspect(post.image.width, post.image.height) }}
            data-testid="post-image"
          >
            <MediaImage src={post.image.url} alt={imageAlt} className="size-full object-cover" />
          </button>
          <ImageViewer image={post.image} alt={imageAlt} open={viewer} onClose={() => setViewer(false)} />
        </>
      )}

      {post.team && (
        <>
          <TeamPreview team={post.team} onOpen={() => setTeamOpen(true)} />
          <SnapshotSheet team={post.team} open={teamOpen} onClose={() => setTeamOpen(false)} />
        </>
      )}

      <PostActions post={post} inThread={inThread} />
    </article>
  );
}

function PostActions({ post, inThread }: { post: CommunityPost; inThread: boolean }) {
  const { t } = useI18n();
  const c = t.community;
  const me = useMe();
  const banned = useBanned(me.data?.id);
  const like = useLikePost();
  const [pop, setPop] = useState(0);

  const toggle = () => {
    const next = !post.likedByMe;
    if (next) {
      setPop((n) => n + 1);
      try {
        navigator.vibrate?.(8);
      } catch {
        // haptics are a nicety
      }
    }
    like.mutate({ id: post.id, liked: next });
  };

  const comments = (
    <>
      <ChatIcon size={20} />
      <Num value={post.commentCount} />
    </>
  );
  const commentCls =
    'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink';

  return (
    <footer className="-mx-2 -mb-1 flex items-center gap-1 border-t border-line pt-1">
      <button
        type="button"
        onClick={toggle}
        disabled={banned}
        aria-pressed={post.likedByMe}
        aria-label={`${post.likedByMe ? c.unlike : c.like} · ${fmt(c.likeCount, { n: post.likeCount })}`}
        data-testid="like-button"
        className={cx(
          'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors hover:bg-surface-2 disabled:opacity-50',
          post.likedByMe ? 'text-live' : 'text-muted hover:text-ink',
        )}
      >
        <span key={pop} className={cx('inline-flex', pop > 0 && post.likedByMe && 'like-pop')}>
          <HeartIcon size={20} filled={post.likedByMe} />
        </span>
        <Num value={post.likeCount} />
      </button>
      {inThread ? (
        <span className={commentCls} aria-label={fmt(c.commentCount, { n: post.commentCount })}>
          {comments}
        </span>
      ) : (
        <Link
          href={threadHref(post.id)}
          className={commentCls}
          aria-label={`${c.openThread} · ${fmt(c.commentCount, { n: post.commentCount })}`}
          data-testid="comments-link"
        >
          {comments}
        </Link>
      )}
    </footer>
  );
}

export function PostCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-4" aria-hidden="true">
      <div className="flex items-center gap-2.5">
        <div className="skeleton size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="skeleton h-3.5 w-28 rounded-md" />
          <div className="skeleton h-3 w-20 rounded-md" />
        </div>
      </div>
      <div className="skeleton h-4 w-full rounded-md" />
      <div className="skeleton h-4 w-2/3 rounded-md" />
      <div className="skeleton h-9 w-32 rounded-full" />
    </div>
  );
}
