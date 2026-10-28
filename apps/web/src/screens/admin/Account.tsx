'use client';

import { useCallback, useId, useState } from 'react';
import type { FormEvent, InputHTMLAttributes } from 'react';
import { fmt, useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useChangePassword, useMe } from '@/lib/queries';
import { EyeIcon, EyeOffIcon, KeyIcon } from '@/components/icons';
import { Collapsible, MoreInfo } from '@/components/Collapsible';
import { Button, InlineError, Skeleton, Spinner, Toast, cx, errorMessage } from '@/components/ui';

/** Mirrors `ChangePasswordBodySchema` (packages/shared/src/broadcast.ts). */
const NEW_MIN = 10;
const NEW_MAX = 200;
/** The API's 400 message for an admin without a password (apps/api/src/routes/admin.ts). */
const NO_PASSWORD_MESSAGE = 'This admin signs in with their app account and has no password';

type Field = 'current' | 'next' | 'confirm';

export function AccountView() {
  const { t } = useI18n();
  const a = t.account;
  const me = useMe();
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Partial<Record<Field, string | undefined>>>({});
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []);

  function validate(): Partial<Record<Field, string | undefined>> {
    const e: Partial<Record<Field, string | undefined>> = {};
    if (!current) e.current = a.currentRequired;
    if (next.length < NEW_MIN) e.next = a.tooShort;
    else if (next.length > NEW_MAX) e.next = a.tooLongPw;
    else if (current && next === current) e.next = a.same;
    if (!e.next && confirm !== next) e.confirm = a.mismatch;
    return e;
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    change.mutate(
      { currentPassword: current, newPassword: next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
          setErrors({});
          setToast(a.done);
        },
        onError: (err) => {
          if (isApiError(err) && err.status === 401) setErrors({ current: a.wrongCurrent });
        },
      },
    );
  }

  const otherError =
    change.isError && !(isApiError(change.error) && change.error.status === 401)
      ? errorMessage(t, change.error)
      : null;

  // Invited admins sign in with their app account (name + Team ID) and have no password. `Me` doesn't say so
  // directly: password admins are admin-only accounts (no Team ID). The API's own 400 for it confirms it too —
  // matched exactly, so ordinary validation 400s stay normal errors.
  const noPassword =
    (me.data?.role === 'admin' && me.data.entryId !== null) ||
    (isApiError(change.error, 'bad_request') && change.error.message === NO_PASSWORD_MESSAGE);
  if (me.isPending) return <Skeleton className="h-72" />;
  if (noPassword) {
    return (
      // The only card in this section: open by default.
      <Collapsible id="account.main" icon={<KeyIcon size={18} />} title={a.view} defaultOpen>
        <div className="flex flex-col gap-1" data-testid="no-password">
          <p className="font-bold text-ink">{a.noPassword}</p>
          {me.data && (
            <p className="text-sm text-muted">
              <bdi dir="auto">{fmt(a.signedInAs, { name: me.data.name })}</bdi>
            </p>
          )}
        </div>
        <MoreInfo>{a.noPasswordBody}</MoreInfo>
      </Collapsible>
    );
  }

  return (
    <>
      <Toast message={toast} tone="success" ms={5000} onDone={clearToast} />
      <form onSubmit={submit} noValidate data-testid="password-form">
        {/* The only card in this section: open by default. */}
        <Collapsible
          id="account.password"
          icon={<KeyIcon size={18} />}
          title={a.title}
          defaultOpen
          info={a.intro}
          saveError={otherError}
        >
          {me.data && (
            <p className="-mt-1 text-sm text-muted">
              <bdi dir="auto">{fmt(a.signedInAs, { name: me.data.name })}</bdi>
            </p>
          )}
          <PasswordField
            label={a.current}
            autoComplete="current-password"
            value={current}
            error={errors.current}
            onValue={(v) => {
              setCurrent(v);
              setErrors((e) => ({ ...e, current: undefined }));
            }}
          />
          <PasswordField
            label={a.next}
            hint={a.nextHint}
            autoComplete="new-password"
            value={next}
            error={errors.next}
            onValue={(v) => {
              setNext(v);
              setErrors((e) => ({ ...e, next: undefined }));
            }}
          />
          <PasswordField
            label={a.confirm}
            autoComplete="new-password"
            value={confirm}
            error={errors.confirm}
            onValue={(v) => {
              setConfirm(v);
              setErrors((e) => ({ ...e, confirm: undefined }));
            }}
          />
          {otherError && <InlineError>{otherError}</InlineError>}
          <Button
            type="submit"
            block
            className="min-h-12"
            disabled={change.isPending}
            data-testid="password-submit"
          >
            {change.isPending && <Spinner />}
            {a.submit}
          </Button>
        </Collapsible>
      </form>
    </>
  );
}

function PasswordField({
  label,
  hint,
  error,
  onValue,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  onValue(v: string): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const hintId = `${id}-hint`;
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      {/* LTR wrapper so the input padding and the toggle sit on the same side in both languages. */}
      <div className="relative" dir="ltr">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          dir="ltr"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? hintId : undefined}
          onChange={(e) => onValue(e.target.value)}
          className={cx(
            'min-h-12 w-full rounded-xl border bg-surface-2 ps-3 pe-12 text-base text-ink placeholder:text-muted focus:border-primary focus:outline-none',
            error ? 'border-live' : 'border-line',
          )}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? t.account.hide : t.account.show}
          aria-pressed={shown}
          aria-controls={id}
          className="absolute inset-y-0 end-0 flex w-12 items-center justify-center rounded-e-xl text-muted hover:text-ink"
        >
          {shown ? <EyeOffIcon size={20} /> : <EyeIcon size={20} />}
        </button>
      </div>
      {(error || hint) && (
        <p
          id={hintId}
          role={error ? 'alert' : undefined}
          className={cx('text-sm', error ? 'text-live' : 'text-muted')}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
