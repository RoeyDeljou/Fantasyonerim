'use client';

import { useId, useState } from 'react';
import { fmt, useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import { flash } from '@/lib/flash';
import { clearAccountLocalState } from '@/lib/localState';
import { forgetPushLocally } from '@/lib/push';
import { useSession } from '@/lib/session';
import { useBlockUser, useBlocks, useDeleteAccount } from '@/lib/queries';
import { BottomSheet } from './BottomSheet';
import { BanIcon, TrashIcon } from './icons';
import { Button, Card, ErrorState, InlineError, Skeleton, Spinner, errorMessage } from './ui';

// ---------- Profile → blocked users ----------

export function BlockedUsersCard() {
  const { t } = useI18n();
  const c = t.community;
  const blocks = useBlocks(true);
  const unblock = useBlockUser();
  const [pending, setPending] = useState<string | null>(null);

  let body;
  if (blocks.isPending) body = <Skeleton className="h-14" />;
  else if (blocks.isError) body = <ErrorState error={blocks.error} onRetry={() => void blocks.refetch()} />;
  else if (blocks.data.length === 0)
    body = (
      <p className="text-sm text-muted" data-testid="blocked-empty">
        {c.blockedEmpty}
      </p>
    );
  else
    body = (
      <ul className="divide-y divide-line rounded-xl border border-line" data-testid="blocked-list">
        {blocks.data.map((u) => (
          <li key={u.id} className="flex min-h-14 items-center gap-3 px-3 py-1.5" data-testid="blocked-user">
            <span className="flex min-w-0 flex-1 flex-col">
              <bdi dir="auto" className="name-start truncate font-semibold text-ink">
                {u.name}
              </bdi>
              {u.teamName && (
                <bdi dir="auto" className="name-start truncate text-xs text-muted">
                  {u.teamName}
                </bdi>
              )}
            </span>
            <Button
              variant="secondary"
              disabled={pending === u.id}
              onClick={() => {
                setPending(u.id);
                unblock.mutate(
                  { userId: u.id, blocked: false },
                  {
                    onSuccess: () => flash(fmt(c.unblockedToast, { name: u.name })),
                    onSettled: () => setPending(null),
                  },
                );
              }}
            >
              {pending === u.id && <Spinner />}
              {c.unblock}
            </Button>
          </li>
        ))}
      </ul>
    );

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <BanIcon size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="font-bold text-ink">{c.blockedTitle}</h2>
          <p className="text-sm text-muted">{c.blockedBody}</p>
        </div>
      </div>
      {body}
      {unblock.isError && <InlineError>{errorMessage(t, unblock.error)}</InlineError>}
    </Card>
  );
}

// ---------- Profile → delete account (App Store 5.1.1(v)) ----------

/** Either language's word confirms — someone on the Hebrew UI may well type DELETE, and vice versa. */
function confirms(typed: string, words: readonly string[]): boolean {
  const v = typed.trim().toLocaleUpperCase();
  return words.some((w) => w.toLocaleUpperCase() === v);
}

export function DeleteAccountCard() {
  const { t } = useI18n();
  const d = t.deleteAccount;
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-col gap-3 border-live/40">
      <div>
        <h2 className="font-bold text-live">{d.title}</h2>
        <p className="text-sm text-muted">{d.cardBody}</p>
      </div>
      <Button variant="danger" block onClick={() => setOpen(true)} data-testid="delete-account-open">
        <TrashIcon size={18} />
        {d.open}
      </Button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={d.sheetTitle}>
        {open && <DeleteAccountForm onCancel={() => setOpen(false)} />}
      </BottomSheet>
    </Card>
  );
}

function DeleteAccountForm({ onCancel }: { onCancel(): void }) {
  const { t } = useI18n();
  const d = t.deleteAccount;
  const del = useDeleteAccount();
  const { forget } = useSession();
  const id = useId();
  const [typed, setTyped] = useState('');
  // Both dictionaries' words: "מחק" and "DELETE".
  const ok = confirms(typed, [d.word, 'DELETE', 'מחק']);

  const submit = () => {
    if (!ok) return;
    del.mutate(undefined, {
      onSuccess: async () => {
        await forgetPushLocally();
        clearAccountLocalState();
        flash(d.done);
        await forget(); // clears the token and goes to onboarding (or back to a stashed fan session)
      },
    });
  };

  const error = del.isError
    ? isApiError(del.error, 'conflict') || (isApiError(del.error) && del.error.status === 409)
      ? d.lastAdmin
      : errorMessage(t, del.error)
    : null;

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="delete-account-sheet"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-sm font-semibold text-ink">{d.willDelete}</p>
      <ul className="flex list-disc flex-col gap-1 ps-5 text-[15px] leading-relaxed text-ink">
        <li>{d.item1}</li>
        <li>{d.item2}</li>
        <li>{d.item3}</li>
        <li>{d.item4}</li>
      </ul>
      <p className="rounded-xl bg-surface-2 p-3 text-sm text-ink">{d.untouched}</p>
      <p className="text-sm font-bold text-live">{d.irreversible}</p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {fmt(d.typeLabel, { word: d.word })}
        </label>
        <input
          id={id}
          value={typed}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          dir="auto"
          onChange={(e) => setTyped(e.target.value)}
          className="min-h-12 w-full rounded-xl border border-line bg-surface-2 px-3 text-base text-ink focus:border-live focus:outline-none"
          data-testid="delete-account-confirm-input"
        />
      </div>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="danger"
          className="min-h-12 flex-1"
          disabled={!ok || del.isPending}
          data-testid="delete-account-submit"
        >
          {del.isPending ? <Spinner /> : <TrashIcon size={18} />}
          {del.isPending ? d.deleting : d.submit}
        </Button>
        <Button variant="ghost" className="min-h-12 flex-1" onClick={onCancel} disabled={del.isPending}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}
