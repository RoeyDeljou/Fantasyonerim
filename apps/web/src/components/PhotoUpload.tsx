'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, RefObject } from 'react';
import type { UploadedImage } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { api, isApiError, isBannedError } from '@/lib/api';
import { CloseIcon } from './icons';
import { cx } from './ui';

/**
 * One photo attached to a composer (Community post, admin live update): client-side type/size pre-checks,
 * upload through `api.upload()` (XHR, so with progress), preview, remove/replace, and friendly errors.
 */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const HEIC = /\.(heic|heif)$/i;

export type PhotoUpload =
  | { status: 'idle' }
  | { status: 'uploading'; preview: string; progress: number }
  | { status: 'done'; preview: string; uploadId: string; image: UploadedImage }
  | { status: 'error'; message: string };

export function uploadErrorMessage(t: Messages, e: unknown): string {
  const c = t.community;
  if (!isApiError(e)) return c.uploadFailed;
  if (e.code === 'payload_too_large' || e.status === 413) return t.errors.tooLarge;
  if (e.code === 'unsupported_media_type' || e.status === 415) return t.errors.unsupportedMedia;
  if (e.status === 429) return c.rateLimitedPost;
  if (isBannedError(e)) return c.banned;
  if (e.code === 'network') return t.errors.network;
  return c.uploadFailed;
}

export interface PhotoUploadApi {
  upload: PhotoUpload;
  uploading: boolean;
  /** The uploaded id once done, else null. */
  uploadId: string | null;
  fileRef: RefObject<HTMLInputElement | null>;
  /** Opens the file picker. */
  choose(): void;
  /** `onChange` of the hidden file input. */
  onPick(e: ChangeEvent<HTMLInputElement>): void;
  remove(): void;
}

export function usePhotoUpload(): PhotoUploadApi {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [upload, setUpload] = useState<PhotoUpload>({ status: 'idle' });

  // Revoke object URLs when replaced/removed, and cancel an in-flight upload on unmount.
  const previewUrl = upload.status === 'uploading' || upload.status === 'done' ? upload.preview : null;
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const onPick = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
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
          setUpload({ status: 'error', message: uploadErrorMessage(t, err) });
        });
    },
    [t],
  );

  const remove = useCallback(() => {
    abortRef.current?.abort();
    setUpload({ status: 'idle' });
  }, []);

  return {
    upload,
    uploading: upload.status === 'uploading',
    uploadId: upload.status === 'done' ? upload.uploadId : null,
    fileRef,
    choose: () => fileRef.current?.click(),
    onPick,
    remove,
  };
}

/** The hidden `<input type=file>` that `choose()` opens. */
export function PhotoInput({ photo, testId }: { photo: PhotoUploadApi; testId: string }) {
  return (
    <input
      ref={photo.fileRef}
      type="file"
      accept="image/*,.heic,.heif"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={photo.onPick}
      data-testid={testId}
    />
  );
}

/** Preview with the upload progress bar and a remove button (nothing when idle / errored). */
export function PhotoPreview({ photo, testId }: { photo: PhotoUploadApi; testId: string }) {
  const { t } = useI18n();
  const c = t.community;
  const u = photo.upload;
  if (u.status !== 'uploading' && u.status !== 'done') return null;
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-line bg-surface-2"
      data-testid={testId}
    >
      <img
        src={u.status === 'done' ? u.image.url : u.preview}
        alt={c.photoPreview}
        className={cx('max-h-72 w-full object-contain', u.status === 'uploading' && 'opacity-60')}
      />
      {u.status === 'uploading' && (
        <div className="absolute inset-x-3 bottom-3 flex flex-col gap-1" role="status">
          <span className="self-start rounded-full bg-media-scrim px-2 py-0.5 text-xs font-semibold text-on-media">
            {fmt(c.uploading, { pct: Math.round(u.progress * 100) })}
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-media-scrim">
            <span
              className="block h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${Math.round(u.progress * 100)}%` }}
            />
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={photo.remove}
        aria-label={c.removePhoto}
        className="absolute end-2 top-2 flex size-11 items-center justify-center rounded-full bg-media-scrim text-on-media"
      >
        <CloseIcon size={20} />
      </button>
    </div>
  );
}
