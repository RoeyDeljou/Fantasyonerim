'use client';

import { useEffect, useId, useState } from 'react';
import { BanBodySchema } from '@fant/shared';
import type { AdminUser, NewsItem, ReportGroup } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import type { ResolveAction } from '@/lib/api';
import {
  useAdminReports,
  useAdminUsers,
  useBanUser,
  useHiddenNews,
  useResolveReport,
  useRestoreNews,
} from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import {
  BanIcon,
  CheckIcon,
  EyeOffIcon,
  FlagIcon,
  ImageIcon,
  SearchIcon,
  ShirtIcon,
  TrashIcon,
  UndoIcon,
} from '@/components/icons';
import { AuthorAvatar, AuthorLine } from '@/components/community/parts';
import { RelativeTime } from '@/components/news/parts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineError,
  Num,
  Skeleton,
  Spinner,
  TextField,
  Toast,
  errorMessage,
} from '@/components/ui';

/** Admin → "קהילה": reports queue, users (ban / unban) and hidden News items (restore). */
export function ModerationView() {
  const [toast, setToast] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <ReportsSection onDone={setToast} />
      <UsersSection onDone={setToast} />
      <HiddenNewsSection onDone={setToast} />
      <Toast message={toast} tone="success" onDone={() => setToast(null)} />
    </div>
  );
}

// ---------- reports ----------

function ReportsSection({ onDone }: { onDone(msg: string): void }) {
  const { t } = useI18n();
  const m = t.moderation;
  const reports = useAdminReports(true);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="mod-reports">
      <div>
        <h2 id="mod-reports" className="flex items-center gap-2 text-lg font-extrabold text-ink">
          {m.reportsTitle}
          {reports.data && reports.data.length > 0 && (
            <Badge tone="live">
              <Num value={reports.data.length} />
            </Badge>
          )}
        </h2>
        <p className="text-sm text-muted">{m.reportsBody}</p>
      </div>
      {reports.isPending ? (
        <Skeleton className="h-40" />
      ) : reports.isError ? (
        <ErrorState error={reports.error} onRetry={() => reports.refetch()} />
      ) : reports.data.length === 0 ? (
        <EmptyState icon={<CheckIcon width={28} height={28} />} title={m.reportsEmpty} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="reports">
          {reports.data.map((g) => (
            <li key={g.targetId}>
              <ReportCard group={g} onDone={onDone} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function reasonLabel(t: Messages, r: ReportGroup['reasons'][number]): string {
  return t.community[`reason_${r}`];
}

function ReportCard({ group, onDone }: { group: ReportGroup; onDone(msg: string): void }) {
  const { t } = useI18n();
  const m = t.moderation;
  const resolve = useResolveReport();
  const [confirm, setConfirm] = useState<ResolveAction | null>(null);
  const target = group.target;
  const author = target.kind === 'post' ? target.post.author : target.comment.author;
  const createdAt = target.kind === 'post' ? target.post.createdAt : target.comment.createdAt;
  const text = target.kind === 'post' ? target.post.text : target.comment.text;
  const reasons = [...new Set(group.reasons)];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{target.kind === 'post' ? m.kindPost : m.kindComment}</Badge>
        <Badge tone="live">
          <FlagIcon size={12} />
          {fmt(m.reportCount, { n: group.reportCount })}
        </Badge>
        <span className="text-xs text-muted">
          {m.firstReported} <RelativeTime iso={group.firstReportedAt} />
        </span>
      </div>

      <div
        className="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-3"
        data-testid="report-target"
      >
        <div className="flex items-center gap-2">
          <AuthorAvatar author={author} size={32} />
          <AuthorLine author={author} createdAt={createdAt} compact />
        </div>
        {text && (
          <p
            dir="auto"
            className="line-clamp-4 text-sm whitespace-pre-line text-ink [overflow-wrap:anywhere]"
          >
            {text}
          </p>
        )}
        {target.kind === 'post' && (target.post.image || target.post.team) && (
          <div className="flex flex-wrap gap-2 text-xs text-muted">
            {target.post.image && (
              <img
                src={target.post.image.url}
                alt={t.community.photo}
                className="h-20 max-w-full rounded-lg border border-line object-cover"
              />
            )}
            {target.post.team && (
              <span className="inline-flex items-center gap-1 self-end">
                <ShirtIcon size={14} />
                <bdi dir="auto">{target.post.team.teamName}</bdi>
                {' · '}
                {fmt(t.community.teamGw, { gw: target.post.team.event })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {reasons.map((r) => (
          <Badge key={r} tone="warning">
            {reasonLabel(t, r)}
          </Badge>
        ))}
      </div>
      {group.notes.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-bold text-muted">{m.notes}</p>
          <ul className="flex flex-col gap-1">
            {group.notes.map((n, i) => (
              <li key={i} dir="auto" className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-ink">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="danger" className="flex-1" onClick={() => setConfirm('remove')}>
          <TrashIcon size={18} />
          {m.remove}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={() => setConfirm('dismiss')}>
          <CheckIcon size={18} />
          {m.dismiss}
        </Button>
      </div>

      <BottomSheet
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'remove' ? m.removeTitle : m.dismissTitle}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{confirm === 'remove' ? m.removeBody : m.dismissBody}</p>
          {text && (
            <p dir="auto" className="line-clamp-2 rounded-xl bg-surface-2 p-3 text-sm text-ink">
              {text}
            </p>
          )}
          {resolve.isError && <InlineError>{errorMessage(t, resolve.error)}</InlineError>}
          <div className="flex gap-2">
            <Button
              variant={confirm === 'remove' ? 'danger' : 'primary'}
              className="flex-1"
              disabled={resolve.isPending}
              data-testid="resolve-confirm"
              onClick={() => {
                if (!confirm) return;
                const action = confirm;
                resolve.mutate(
                  { group, action },
                  {
                    onSuccess: () => {
                      setConfirm(null);
                      onDone(action === 'remove' ? m.removed : m.dismissed);
                    },
                  },
                );
              }}
            >
              {resolve.isPending && <Spinner />}
              {confirm === 'remove' ? m.remove : m.dismiss}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setConfirm(null)}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </Card>
  );
}

// ---------- users ----------

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

function UsersSection({ onDone }: { onDone(msg: string): void }) {
  const { t } = useI18n();
  const m = t.moderation;
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const users = useAdminUsers(q, true);
  const [target, setTarget] = useState<AdminUser | null>(null);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="mod-users">
      <h2 id="mod-users" className="text-lg font-extrabold text-ink">
        {m.usersTitle}
      </h2>
      <div className="relative">
        <TextField
          label={m.usersSearch}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="[&_input]:ps-10"
          data-testid="users-search"
        />
        <SearchIcon size={18} className="pointer-events-none absolute start-3 bottom-[15px] text-muted" />
      </div>
      {users.isPending ? (
        <Skeleton className="h-32" />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      ) : users.data.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">{m.usersEmpty}</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface"
          data-testid="users"
        >
          {users.data.map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-3 py-2.5" data-testid="user-row">
              <AuthorAvatar author={u} size={32} />
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="flex min-w-0 items-center gap-1.5">
                  <bdi dir="auto" className="truncate font-bold text-ink">
                    {u.name}
                  </bdi>
                  {u.role === 'admin' && <Badge tone="primary">{m.adminBadge}</Badge>}
                  {u.bannedAt && <Badge tone="live">{m.bannedBadge}</Badge>}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                  {u.teamName && (
                    <bdi dir="auto" className="truncate">
                      {u.teamName}
                    </bdi>
                  )}
                  {u.entryId !== null && (
                    <bdi dir="ltr" className="tabular">
                      #{u.entryId}
                    </bdi>
                  )}
                  <span>· {fmt(m.postCount, { n: u.postCount })}</span>
                </span>
                {u.bannedAt && u.banReason && (
                  <span dir="auto" className="name-start mt-0.5 truncate text-xs text-live">
                    {fmt(m.bannedReason, { reason: u.banReason })}
                  </span>
                )}
              </div>
              {u.role !== 'admin' && (
                <Button
                  variant={u.bannedAt ? 'secondary' : 'danger'}
                  className="shrink-0 px-3 text-sm"
                  onClick={() => setTarget(u)}
                >
                  {u.bannedAt ? <UndoIcon size={16} className="rtl:-scale-x-100" /> : <BanIcon size={16} />}
                  {u.bannedAt ? m.unban : m.ban}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <BanSheet user={target} onClose={() => setTarget(null)} onDone={onDone} />
    </section>
  );
}

function BanSheet({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser | null;
  onClose(): void;
  onDone(msg: string): void;
}) {
  const { t } = useI18n();
  const m = t.moderation;
  const ban = useBanUser();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const unbanning = !!user?.bannedAt;

  useEffect(() => {
    setReason('');
    setError(null);
    ban.reset();
  }, [user?.id]);

  const submit = () => {
    if (!user) return;
    if (unbanning) {
      ban.mutate(
        { id: user.id, reason: null },
        {
          onSuccess: () => {
            onClose();
            onDone(fmt(m.unbannedDone, { name: user.name }));
          },
        },
      );
      return;
    }
    const parsed = BanBodySchema.safeParse({ reason });
    if (!parsed.success) {
      setError(m.banReasonRequired);
      return;
    }
    ban.mutate(
      { id: user.id, reason: parsed.data.reason },
      {
        onSuccess: () => {
          onClose();
          onDone(fmt(m.bannedDone, { name: user.name }));
        },
      },
    );
  };

  const name = user?.name ?? '';
  return (
    <BottomSheet
      open={user !== null}
      onClose={onClose}
      title={fmt(unbanning ? m.unbanTitle : m.banTitle, { name })}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        <p className="text-sm text-muted">{unbanning ? m.unbanBody : m.banBody}</p>
        {!unbanning && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={reasonId} className="text-sm font-semibold text-ink">
              {m.banReason}
            </label>
            <textarea
              id={reasonId}
              dir="auto"
              rows={2}
              maxLength={200}
              value={reason}
              placeholder={m.banReasonPlaceholder}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
              className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-base text-ink placeholder:text-muted focus:border-primary focus:outline-none"
            />
            {error && <p className="text-sm text-live">{error}</p>}
          </div>
        )}
        {ban.isError && <InlineError>{errorMessage(t, ban.error)}</InlineError>}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant={unbanning ? 'primary' : 'danger'}
            className="flex-1"
            disabled={ban.isPending}
            data-testid="ban-confirm"
          >
            {ban.isPending ? (
              <Spinner />
            ) : unbanning ? (
              <UndoIcon size={18} className="rtl:-scale-x-100" />
            ) : (
              <BanIcon size={18} />
            )}
            {unbanning ? m.unban : m.ban}
          </Button>
          <Button variant="ghost" className="flex-1" onClick={onClose}>
            {t.common.cancel}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

// ---------- hidden news ----------

function newsTitle(t: Messages, item: NewsItem): string {
  return item.title ?? item.text ?? t.moderation.untitled;
}

function HiddenNewsSection({ onDone }: { onDone(msg: string): void }) {
  const { t } = useI18n();
  const m = t.moderation;
  const hidden = useHiddenNews(true);
  const restore = useRestoreNews();
  const sourceLabel = (s: NewsItem['source']) =>
    ({
      podcast: t.news.sourcePodcast,
      instagram_post: t.news.sourceInstagram,
      instagram_story: t.news.sourceInstagram,
      x_post: t.news.sourceX,
      admin_update: t.news.sourceAdmin,
    })[s];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="mod-hidden">
      <div>
        <h2 id="mod-hidden" className="flex items-center gap-2 text-lg font-extrabold text-ink">
          <EyeOffIcon size={20} className="text-muted" />
          {m.hiddenTitle}
        </h2>
        <p className="text-sm text-muted">{m.hiddenBody}</p>
      </div>
      {hidden.isPending ? (
        <Skeleton className="h-24" />
      ) : hidden.isError ? (
        <ErrorState error={hidden.error} onRetry={() => hidden.refetch()} />
      ) : hidden.data.items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line py-6 text-center text-sm text-muted">
          {m.hiddenEmpty}
        </p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-line rounded-2xl border border-line bg-surface"
          data-testid="hidden-news"
        >
          {hidden.data.items.map(({ item, hiddenAt }) => {
            const busy = restore.isPending && restore.variables === item.id;
            const thumb = item.media.find((x) => x.kind === 'image')?.url ?? item.media[0]?.posterUrl ?? null;
            return (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2.5" data-testid="hidden-item">
                <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-2 text-muted">
                  {thumb ? (
                    <img src={thumb} alt="" className="size-full object-cover" />
                  ) : (
                    <ImageIcon size={20} />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span dir="auto" className="name-start line-clamp-2 text-sm font-semibold text-ink">
                    {newsTitle(t, item)}
                  </span>
                  <span className="text-xs text-muted">
                    {sourceLabel(item.source)} · {m.hiddenAt} <RelativeTime iso={hiddenAt} />
                  </span>
                </div>
                <Button
                  variant="secondary"
                  className="shrink-0 px-3 text-sm"
                  disabled={busy}
                  onClick={() => restore.mutate(item.id, { onSuccess: () => onDone(m.restored) })}
                >
                  {busy ? <Spinner /> : <UndoIcon size={16} className="rtl:-scale-x-100" />}
                  {m.restore}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {restore.isError && <InlineError>{errorMessage(t, restore.error)}</InlineError>}
    </section>
  );
}
