'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Comment, PostId } from '@fant/shared';
import { useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import { isBannedError, useBanned } from '@/lib/banned';
import { useIsGuest } from '@/lib/guest';
import { SignUpPrompt } from '@/components/SignUpPrompt';
import { ShellDock } from '@/components/ShellDock';
import { useDraft } from '@/lib/drafts';
import { useComments, useCreateComment, useDeleteComment, useMe, usePost } from '@/lib/queries';
import { ChatIcon, ChevronStartIcon, RefreshIcon, SendIcon } from '@/components/icons';
import { LinkifiedText } from '@/components/news/parts';
import {
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  Skeleton,
  Spinner,
  cx,
  errorMessage,
} from '@/components/ui';
import { ContentMenu } from './ContentMenu';
import { AuthorAvatar, AuthorLine, BannedNotice, canBlock, useNotify } from './parts';
import { PostCard, PostCardSkeleton } from './PostCard';
import { scrollAppTo } from '@/lib/scroller';

const COMMENT_MAX = 500;

/** `/community/?post=<id>` — the post, its comments (oldest first) and a sticky reply bar. */
export function Thread({ postId, onBack }: { postId: PostId; onBack(): void }) {
  const { t } = useI18n();
  const c = t.community;
  const banned = useBanned();
  const guest = useIsGuest();
  const post = usePost(postId);

  useEffect(() => {
    scrollAppTo(0);
  }, [postId]);

  return (
    <div className="flex flex-col gap-4" data-testid="thread">
      <button
        type="button"
        onClick={onBack}
        className="-ms-2 inline-flex min-h-11 items-center gap-1 self-start rounded-full px-2 text-sm font-semibold text-primary hover:bg-surface-2"
      >
        <ChevronStartIcon size={18} />
        {c.backToFeed}
      </button>
      {banned && <BannedNotice />}
      {post.isPending ? (
        <PostCardSkeleton />
      ) : post.isError ? (
        <ErrorState
          error={post.error}
          onRetry={() => post.refetch()}
          overrides={{ not_found: c.postNotFound }}
        />
      ) : (
        <>
          <PostCard post={post.data} inThread onDeleted={onBack} />
          <Comments postId={postId} />
          {/* Guests read the conversation; commenting needs an account. */}
          {guest ? <SignUpPrompt /> : <CommentBar postId={postId} disabled={banned} />}
        </>
      )}
    </div>
  );
}

function Comments({ postId }: { postId: PostId }) {
  const { t } = useI18n();
  const c = t.community;
  const q = useComments(postId);
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (q.data?.pages ?? []).flatMap((p) =>
      p.items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true))),
    );
  }, [q.data]);

  return (
    <section aria-labelledby="comments-title" className="flex flex-col gap-2">
      <h2 id="comments-title" className="text-base font-bold text-ink">
        {c.commentsTitle}
      </h2>
      {q.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-busy="true">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={<ChatIcon width={28} height={28} />} title={c.noComments} />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="comments">
          {items.map((cm) => (
            <li key={cm.id}>
              <CommentItem comment={cm} />
            </li>
          ))}
        </ul>
      )}
      {q.isFetchNextPageError && <InlineError>{errorMessage(t, q.error)}</InlineError>}
      {q.hasNextPage && (
        <Button
          variant="secondary"
          onClick={() => void q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="self-center"
        >
          {q.isFetchingNextPage ? <Spinner /> : <RefreshIcon size={18} />}
          {c.loadMoreComments}
        </Button>
      )}
    </section>
  );
}

function CommentItem({ comment }: { comment: Comment }) {
  const { t } = useI18n();
  const c = t.community;
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const banned = useBanned();
  const remove = useDeleteComment(comment.postId);
  const notify = useNotify();
  return (
    <article
      id={`comment-${comment.id}`}
      data-testid="comment"
      className="flex gap-2.5 rounded-2xl border border-line bg-surface p-3"
    >
      <AuthorAvatar author={comment.author} size={32} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <AuthorLine author={comment.author} createdAt={comment.createdAt} compact />
          <ContentMenu
            target={{ kind: 'comment', id: comment.id }}
            canDelete={comment.mine || isAdmin}
            canReport={!comment.mine && !banned}
            deleteTitle={c.deleteCommentTitle}
            blockAuthor={canBlock(comment.author, comment.mine, me.data?.id) ? comment.author : null}
            deleting={remove.isPending}
            deleteError={remove.error}
            onDelete={(done) =>
              remove.mutate(comment.id, {
                onSuccess: () => {
                  done();
                  notify(c.commentDeleted);
                },
              })
            }
          />
        </div>
        <div className="space-y-1.5 text-[15px] leading-relaxed text-ink" data-testid="comment-text">
          <LinkifiedText text={comment.text} platform="none" />
        </div>
      </div>
    </article>
  );
}

/**
 * Where the browser overlays the on-screen keyboard (iOS Safari): how far to lift the reply bar from its place in
 * the shell's dock (right above the tab bar) so it sits on the keyboard, as a negative px offset; else 0.
 */
function useKeyboardLift(): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      if (covered <= 80) {
        setLift(0); // ignore toolbar wobble
        return;
      }
      // The bar's own bottom = the tab bar's top; the keyboard's top = the layout viewport's bottom − covered.
      const barTop =
        document.querySelector('[data-tab-bar]')?.getBoundingClientRect().top ?? window.innerHeight;
      setLift(Math.min(0, window.innerHeight - covered - barTop));
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return lift;
}

function CommentBar({ postId, disabled }: { postId: PostId; disabled: boolean }) {
  const { t } = useI18n();
  const c = t.community;
  const create = useCreateComment(postId);
  const [text, setText] = useDraft(`community.comment.${postId}`);
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const lift = useKeyboardLift();
  const trimmed = text.trim();
  const tooLong = trimmed.length > COMMENT_MAX;
  const valid = trimmed.length > 0 && !tooLong;

  // Grow with the text up to ~4 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const submit = () => {
    if (!valid || create.isPending) return;
    create.mutate(trimmed, {
      onSuccess: (cm) => {
        setText('');
        window.setTimeout(
          () =>
            document
              .getElementById(`comment-${cm.id}`)
              ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
          50,
        );
      },
    });
  };

  const error = create.isError
    ? isApiError(create.error, 'rate_limited')
      ? c.rateLimitedComment
      : isBannedError(create.error)
        ? c.banned
        : errorMessage(t, create.error)
    : tooLong
      ? c.commentTooLong
      : null;

  // In the shell's dock (ShellDock.tsx): a flex child above the tab bar, never fixed over scrolling content.
  return (
    <ShellDock>
      <div
        className="border-t border-line bg-surface/95 backdrop-blur"
        style={lift < 0 ? { transform: `translateY(${lift}px)` } : undefined}
        data-testid="comment-bar"
      >
        <form
          className="mx-auto flex max-w-xl flex-col gap-1 px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {error && (
            <p role="alert" className="px-1 text-xs font-semibold text-live">
              {error}
            </p>
          )}
          <div className="flex items-end gap-2">
            <label htmlFor={id} className="sr-only">
              {c.commentLabel}
            </label>
            <textarea
              ref={ref}
              id={id}
              dir="auto"
              rows={1}
              value={text}
              disabled={disabled}
              placeholder={disabled ? c.banned : c.commentPlaceholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              className={cx(
                'max-h-[120px] min-h-11 flex-1 resize-none rounded-2xl border bg-surface-2 px-3 py-2.5 text-base leading-snug text-ink placeholder:text-muted focus:border-primary focus:outline-none disabled:opacity-60',
                tooLong ? 'border-live' : 'border-line',
              )}
              data-testid="comment-input"
            />
            <button
              type="submit"
              aria-label={c.send}
              disabled={disabled || !valid || create.isPending}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition-opacity disabled:opacity-40"
              data-testid="comment-send"
            >
              {create.isPending ? <Spinner /> : <SendIcon size={20} className="rtl:-scale-x-100" />}
            </button>
          </div>
        </form>
      </div>
    </ShellDock>
  );
}
