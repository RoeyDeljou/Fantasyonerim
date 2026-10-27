'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { GameweekSchema } from '@fant/shared';
import type { Gameweek, Me, UploadedImage } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { api, isApiError } from '@/lib/api';
import { isBannedError, useBanned } from '@/lib/banned';
import { useBootstrap, useCreatePost, useEntry, usePicks } from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { CloseIcon, ImageIcon, InfoIcon, SendIcon } from '@/components/icons';
import {
  Button,
  EmptyState,
  InlineError,
  Skeleton,
  Spinner,
  Switch,
  cx,
  errorMessage,
} from '@/components/ui';
import { AuthorAvatar, BannedNotice, useNotify } from './parts';
import { TeamPreview } from './TeamSnapshot';
import type { TeamView } from './TeamSnapshot';

export const POST_MAX = 1000;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const HEIC = /\.(heic|heif)$/i;

type Upload =
  | { status: 'idle' }
  | { status: 'uploading'; preview: string; progress: number }
  | { status: 'done'; preview: string; uploadId: string; image: UploadedImage }
  | { status: 'error'; message: string };

function uploadError(t: Messages, e: unknown): string {
  const c = t.community;
  if (!isApiError(e)) return c.uploadFailed;
  if (e.code === 'payload_too_large' || e.status === 413) return t.errors.tooLarge;
  if (e.code === 'unsupported_media_type' || e.status === 415) return t.errors.unsupportedMedia;
  if (e.status === 429) return c.rateLimitedPost;
  if (isBannedError(e)) return c.banned;
  if (e.code === 'network') return t.errors.network;
  return c.uploadFailed;
}

/** GWs whose deadline has passed (FPL only exposes picks after it), newest first. */
function useStartedEvents(): { events: Gameweek[]; current: Gameweek | null; loading: boolean } {
  const bootstrap = useBootstrap();
  return useMemo(() => {
    if (!bootstrap.data) return { events: [], current: null, loading: bootstrap.isPending };
    const now = Date.now();
    const events = bootstrap.data.events
      .filter((e) => Date.parse(e.deadlineTime) <= now)
      .map((e) => e.id)
      .sort((a, b) => b - a);
    const cur = bootstrap.data.currentEvent;
    return {
      events,
      current: cur !== null && events.includes(cur) ? cur : (events[0] ?? null),
      loading: false,
    };
  }, [bootstrap.data, bootstrap.isPending]);
}

export function ComposerSheet({ open, onClose, me }: { open: boolean; onClose(): void; me: Me }) {
  const { t } = useI18n();
  return (
    <BottomSheet open={open} onClose={onClose} title={t.community.composerTitle}>
      {open && <ComposerForm me={me} onDone={onClose} />}
    </BottomSheet>
  );
}

function ComposerForm({ me, onDone }: { me: Me; onDone(): void }) {
  const { t } = useI18n();
  const c = t.community;
  const notify = useNotify();
  const create = useCreatePost();
  const textId = useId();
  const counterId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [text, setText] = useState('');
  const [upload, setUpload] = useState<Upload>({ status: 'idle' });
  const [shareTeam, setShareTeam] = useState(false);
  const started = useStartedEvents();
  const [gwChoice, setGwChoice] = useState<Gameweek | null>(null);
  const gw = gwChoice ?? started.current;
  const canShareTeam = me.entryId !== null;
  const banned = useBanned();

  // Revoke object URLs and cancel an in-flight upload when the sheet closes.
  const previewUrl = upload.status === 'uploading' || upload.status === 'done' ? upload.preview : null;
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const trimmed = text.trim();
  const tooLong = trimmed.length > POST_MAX;
  const teamReady = shareTeam && canShareTeam && gw !== null;
  const hasContent = trimmed.length > 0 || upload.status === 'done' || teamReady;
  const uploading = upload.status === 'uploading';
  const valid = hasContent && !tooLong && !uploading && !banned;

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/') && !HEIC.test(file.name)) {
      setUpload({ status: 'error', message: t.errors.unsupportedMedia });
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setUpload({ status: 'error', message: t.errors.tooLarge });
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const preview = URL.createObjectURL(file);
    setUpload({ status: 'uploading', preview, progress: 0 });
    api
      .upload(file, {
        signal: ctrl.signal,
        onProgress: (p) =>
          setUpload((u) => (u.status === 'uploading' && u.preview === preview ? { ...u, progress: p } : u)),
      })
      .then((r) =>
        setUpload((u) =>
          u.status === 'uploading' && u.preview === preview
            ? { status: 'done', preview, uploadId: r.uploadId, image: r.image }
            : u,
        ),
      )
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setUpload({ status: 'error', message: uploadError(t, err) });
      });
  };

  const removePhoto = () => {
    abortRef.current?.abort();
    setUpload({ status: 'idle' });
  };

  const submit = () => {
    if (!valid) return;
    create.mutate(
      {
        text: trimmed,
        uploadId: upload.status === 'done' ? upload.uploadId : null,
        shareTeamEvent: teamReady ? gw : null,
      },
      {
        onSuccess: () => {
          notify(c.posted);
          window.scrollTo({ top: 0, behavior: 'smooth' });
          onDone();
        },
      },
    );
  };

  const postError = create.isError
    ? isApiError(create.error, 'rate_limited')
      ? c.rateLimitedPost
      : isBannedError(create.error)
        ? banned
          ? null // the notice above already says it
          : c.banned
        : errorMessage(t, create.error)
    : null;

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {banned && <BannedNotice />}
      <div className="flex items-start gap-2.5">
        <AuthorAvatar
          author={{ id: me.id, name: me.name, entryId: me.entryId, teamName: me.teamName, role: me.role }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={textId} className="sr-only">
            {c.composerLabel}
          </label>
          <textarea
            id={textId}
            dir="auto"
            rows={4}
            autoFocus
            value={text}
            placeholder={c.composerPlaceholder}
            aria-describedby={counterId}
            aria-invalid={tooLong || undefined}
            onChange={(e) => setText(e.target.value)}
            className="min-h-28 w-full resize-none rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-base leading-relaxed text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          />
          <p
            id={counterId}
            className={cx('text-end text-xs tabular', tooLong ? 'font-bold text-live' : 'text-muted')}
            aria-live="polite"
          >
            <span className="sr-only">{fmt(c.counter, { n: trimmed.length, max: POST_MAX })}</span>
            <bdi dir="ltr" aria-hidden="true">
              {trimmed.length}/{POST_MAX}
            </bdi>
          </p>
        </div>
      </div>
      {tooLong && <InlineError>{c.tooLong}</InlineError>}

      {/* ---------- photo ---------- */}
      {(upload.status === 'uploading' || upload.status === 'done') && (
        <div
          className="relative overflow-hidden rounded-2xl border border-line bg-surface-2"
          data-testid="composer-photo"
        >
          <img
            src={upload.status === 'done' ? upload.image.url : upload.preview}
            alt={c.photoPreview}
            className={cx('max-h-72 w-full object-contain', uploading && 'opacity-60')}
          />
          {upload.status === 'uploading' && (
            <div className="absolute inset-x-3 bottom-3 flex flex-col gap-1" role="status">
              <span className="self-start rounded-full bg-media-scrim px-2 py-0.5 text-xs font-semibold text-on-media">
                {fmt(c.uploading, { pct: Math.round(upload.progress * 100) })}
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-media-scrim">
                <span
                  className="block h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${Math.round(upload.progress * 100)}%` }}
                />
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={removePhoto}
            aria-label={c.removePhoto}
            className="absolute end-2 top-2 flex size-11 items-center justify-center rounded-full bg-media-scrim text-on-media"
          >
            <CloseIcon size={20} />
          </button>
        </div>
      )}
      {upload.status === 'error' && <InlineError>{upload.message}</InlineError>}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.heic,.heif"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={pick}
          data-testid="composer-file"
        />
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={uploading || banned}>
          <ImageIcon size={20} />
          {upload.status === 'done' ? c.changePhoto : c.addPhoto}
        </Button>
      </div>

      {/* ---------- share my team ---------- */}
      <div className="flex flex-col gap-2 rounded-2xl border border-line p-3">
        <Switch
          label={c.shareTeam}
          description={canShareTeam ? c.shareTeamHint : c.shareTeamNoEntry}
          checked={shareTeam && canShareTeam}
          disabled={!canShareTeam || (started.events.length === 0 && !started.loading)}
          onChange={setShareTeam}
        />
        {canShareTeam && started.events.length === 0 && !started.loading && (
          <p className="text-xs text-muted">{c.shareTeamNone}</p>
        )}
        {shareTeam && canShareTeam && gw !== null && me.entryId !== null && (
          <>
            <GwPicker value={gw} options={started.events} onChange={setGwChoice} />
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-2.5 text-xs text-muted">
              <InfoIcon size={16} className="mt-px shrink-0" />
              <span>{c.shareTeamWhy}</span>
            </p>
            <TeamPreviewLoader entryId={me.entryId} event={gw} />
          </>
        )}
      </div>

      {postError && <InlineError>{postError}</InlineError>}
      {!hasContent && !create.isError && <p className="text-xs text-muted">{c.needContent}</p>}
      {uploading && <p className="text-xs text-muted">{c.waitUpload}</p>}

      <Button type="submit" block disabled={!valid || create.isPending} data-testid="composer-submit">
        {create.isPending ? <Spinner /> : <SendIcon size={18} className="rtl:-scale-x-100" />}
        {create.isPending ? c.posting : c.post}
      </Button>
    </form>
  );
}

function GwPicker({
  value,
  options,
  onChange,
}: {
  value: Gameweek;
  options: readonly Gameweek[];
  onChange(gw: Gameweek): void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {t.community.shareTeamGw}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const p = GameweekSchema.safeParse(Number(e.target.value));
          if (p.success) onChange(p.data);
        }}
        className="min-h-11 rounded-xl border border-line bg-surface-2 px-3 text-base font-semibold text-ink focus:border-primary focus:outline-none"
        data-testid="composer-gw"
      >
        {options.map((g) => (
          <option key={g} value={g}>
            {fmt(t.common.gw, { gw: g })}
          </option>
        ))}
      </select>
    </div>
  );
}

function TeamPreviewLoader({ entryId, event }: { entryId: NonNullable<Me['entryId']>; event: Gameweek }) {
  const { t } = useI18n();
  const picks = usePicks(entryId, event);
  const entry = useEntry(entryId);
  if (picks.isPending) return <Skeleton className="h-64" />;
  if (picks.isError) {
    return isApiError(picks.error, 'not_found') ? (
      <EmptyState title={t.myTeam.noData} />
    ) : (
      <InlineError>{errorMessage(t, picks.error)}</InlineError>
    );
  }
  const team: TeamView = {
    entryId,
    event,
    teamName: entry.data?.teamName ?? '—',
    managerName: entry.data?.managerName ?? '',
    points: picks.data.points,
    overallRank: picks.data.overallRank,
    activeChip: picks.data.activeChip,
    picks: picks.data.picks,
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-semibold text-muted">{t.community.teamPreview}</p>
      <TeamPreview team={team} />
    </div>
  );
}
