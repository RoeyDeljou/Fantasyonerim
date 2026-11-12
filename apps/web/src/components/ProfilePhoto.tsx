'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Me } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useSection } from '@/i18n/section';
import { profilePhoto } from '@/i18n/sections/profilePhoto';
import { AVATAR_ACCEPT, avatarProblem, checkAvatarFile } from '@/lib/avatar';
import type { AvatarProblem } from '@/lib/avatar';
import { useRemoveAvatar, useUploadAvatar } from '@/lib/avatarApi';
import { firstGrapheme } from '@/lib/text';
import { CameraIcon, CheckIcon, TrashIcon } from './icons';
import { SIGN_UP_HREF } from './SignUpPrompt';
import { UserAvatar } from './UserAvatar';
import { Button, Card, InlineError, SectionTitle, Spinner, cx } from './ui';

const BIG = 'flex size-24 shrink-0 items-center justify-center rounded-full text-3xl font-extrabold';
const PROBLEM_KEY = {
  type: 'errType',
  size: 'errSize',
  rateLimited: 'errRateLimited',
  banned: 'errBanned',
  network: 'errNetwork',
  generic: 'errGeneric',
} as const satisfies Record<AvatarProblem, string>;

/** The fan's own photo, large, with its fallback letter (the same as the name row's circle). */
function BigAvatar({ me }: { me: Me }) {
  return (
    <UserAvatar
      name={me.name}
      avatarUrl={me.avatarUrl}
      className={cx(BIG, 'bg-accent text-on-accent')}
      fallback={firstGrapheme(me.name).toLocaleUpperCase()}
    />
  );
}

/**
 * Profile → "Profile photo": the current photo (or initials), upload / change / remove. A picked file is first shown
 * as a circle — centre-cropped like the server's 256×256 crop — with Save / Cancel; the upload shows its progress.
 * Suspended fans (`canPost` false) can only remove theirs.
 */
export function ProfilePhotoCard({ me }: { me: Me }) {
  const s = useSection(profilePhoto);
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useUploadAvatar();
  const remove = useRemoveAvatar();
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState<AvatarProblem | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [done, setDone] = useState<'saved' | 'removed' | null>(null);
  const busy = upload.isPending || remove.isPending;
  const hasPhoto = me.avatarUrl !== null;

  useEffect(() => () => (picked ? URL.revokeObjectURL(picked.url) : undefined), [picked]);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(null), 2500);
    return () => window.clearTimeout(id);
  }, [done]);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same file can be picked again
    if (!file) return;
    setDone(null);
    setConfirmRemove(false);
    const bad = checkAvatarFile(file);
    setProblem(bad);
    if (bad) return;
    setPreviewFailed(false);
    setPicked({ file, url: URL.createObjectURL(file) });
  };

  const save = () => {
    if (!picked) return;
    setProblem(null);
    setProgress(0);
    upload.mutate(
      { file: picked.file, onProgress: setProgress },
      {
        onSuccess: () => {
          setPicked(null);
          setDone('saved');
        },
        onError: (e) => setProblem(avatarProblem(e)),
      },
    );
  };

  const doRemove = () => {
    setProblem(null);
    remove.mutate(undefined, {
      onSuccess: () => {
        setConfirmRemove(false);
        setDone('removed');
      },
      onError: (e) => setProblem(avatarProblem(e)),
    });
  };

  const pct = Math.round(progress * 100);
  return (
    <Card className="flex flex-col gap-3" data-testid="profile-photo">
      <div>
        <SectionTitle>{s.title}</SectionTitle>
        <p className="-mt-1 text-sm text-muted">{picked ? s.previewHint : s.body}</p>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={AVATAR_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onPick}
        data-testid="photo-file"
      />
      <div className="flex items-center gap-4">
        {picked ? (
          <span
            className={cx(BIG, 'relative overflow-hidden bg-surface-2 ring-2 ring-primary')}
            data-testid="photo-preview"
          >
            {previewFailed ? (
              <CameraIcon size={32} className="text-muted" />
            ) : (
              <img
                src={picked.url}
                alt={s.previewTitle}
                onError={() => setPreviewFailed(true)}
                className={cx('size-full object-cover', upload.isPending && 'opacity-60')}
              />
            )}
          </span>
        ) : (
          <span data-testid="profile-photo-avatar">
            <BigAvatar me={me} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {picked ? (
            <>
              <span className="font-bold text-ink">{s.previewTitle}</span>
              {previewFailed && <span className="text-xs text-muted">{s.previewUnavailable}</span>}
            </>
          ) : (
            <bdi dir="auto" className="name-start truncate text-lg font-bold text-ink">
              {me.name}
            </bdi>
          )}
          {upload.isPending && (
            <span className="flex flex-col gap-1" role="status">
              <span className="text-xs font-semibold text-muted">{fmt(s.uploading, { pct })}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <span
                  className="block h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </span>
            </span>
          )}
          {done && (
            <span
              className="flex items-center gap-1 text-xs font-semibold text-success"
              role="status"
              data-testid="photo-done"
            >
              <CheckIcon size={14} />
              {done === 'saved' ? s.saved : s.removed}
            </span>
          )}
          {!me.canPost && !picked && <span className="text-xs text-muted">{s.bannedNote}</span>}
        </div>
      </div>

      {problem && (
        <div data-testid="photo-error">
          <InlineError>{s[PROBLEM_KEY[problem]]}</InlineError>
        </div>
      )}

      {picked ? (
        <div className="flex gap-2">
          <Button className="flex-1" onClick={save} disabled={busy} data-testid="photo-save">
            {upload.isPending ? <Spinner /> : <CheckIcon size={18} />}
            {s.save}
          </Button>
          <Button
            variant="ghost"
            className="flex-1"
            disabled={upload.isPending}
            onClick={() => {
              setPicked(null);
              setProblem(null);
            }}
            data-testid="photo-cancel"
          >
            {t.common.cancel}
          </Button>
        </div>
      ) : confirmRemove ? (
        <div className="flex flex-col gap-2" data-testid="photo-remove-confirm">
          <p className="text-sm text-ink">{s.removeConfirm}</p>
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              onClick={doRemove}
              disabled={busy}
              data-testid="photo-remove-yes"
            >
              {remove.isPending ? <Spinner /> : <TrashIcon size={18} />}
              {s.remove}
            </Button>
            <Button
              variant="ghost"
              className="flex-1"
              disabled={remove.isPending}
              onClick={() => setConfirmRemove(false)}
            >
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={hasPhoto ? 'secondary' : 'primary'}
            className="flex-1"
            disabled={!me.canPost || busy}
            onClick={() => fileRef.current?.click()}
            data-testid="photo-upload"
          >
            <CameraIcon size={18} />
            {hasPhoto ? s.change : s.upload}
          </Button>
          {hasPhoto && (
            <Button
              variant="danger"
              className="flex-1"
              disabled={busy}
              onClick={() => {
                setProblem(null);
                setDone(null);
                setConfirmRemove(true);
              }}
              data-testid="photo-remove"
            >
              <TrashIcon size={18} />
              {s.remove}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** A guest: the placeholder circle and "sign up to add a photo". */
export function ProfilePhotoGuest() {
  const s = useSection(profilePhoto);
  const { t } = useI18n();
  return (
    <Card className="flex items-center gap-3" data-testid="profile-photo-guest">
      <span
        aria-hidden="true"
        className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent"
      >
        <CameraIcon size={24} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="font-bold text-ink">{s.title}</span>
        <span className="text-sm text-muted">{s.guestBody}</span>
        <Link
          href={SIGN_UP_HREF}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-full bg-primary px-5 text-sm font-bold text-on-primary"
        >
          {t.guest.signUp}
        </Link>
      </div>
    </Card>
  );
}
