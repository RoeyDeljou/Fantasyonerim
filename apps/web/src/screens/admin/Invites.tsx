'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { CreateAdminInviteBodySchema } from '@fant/shared';
import type { AdminInvite, AdminInviteCreated } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useAdminInvites, useCreateInvite, useRevokeInvite } from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { RelativeTime } from '@/components/news/parts';
import { CheckIcon, CopyIcon, InfoIcon, PlusIcon, ShareIcon } from '@/components/icons';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  InlineError,
  SectionTitle,
  Skeleton,
  Spinner,
  TextField,
  errorMessage,
} from '@/components/ui';

/**
 * Admin → Admins: one-time invite links (the hosts create their own account and are admins from the start).
 * The link is shown exactly once, in the sheet right after creating it.
 */
export function InvitesCard() {
  const { t } = useI18n();
  const v = t.invites;
  const create = useCreateInvite();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AdminInviteCreated | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateAdminInviteBodySchema.safeParse({ label });
    if (!parsed.success) {
      setError(v.labelRequired);
      return;
    }
    setError(null);
    create.mutate(parsed.data.label, {
      onSuccess: (r) => {
        setLabel('');
        setCreated(r);
      },
    });
  }

  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle>{v.title}</SectionTitle>
      <p className="-mt-1 text-sm text-muted">{v.intro}</p>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3" data-testid="invite-form">
        <TextField
          label={v.label}
          placeholder={v.labelPlaceholder}
          value={label}
          maxLength={40}
          dir="auto"
          error={error}
          onChange={(e) => {
            setLabel(e.target.value);
            setError(null);
          }}
        />
        {create.isError && <InlineError>{errorMessage(t, create.error)}</InlineError>}
        <Button type="submit" className="min-h-12" disabled={create.isPending} data-testid="invite-create">
          {create.isPending ? <Spinner /> : <PlusIcon size={18} />}
          {create.isPending ? v.creating : v.create}
        </Button>
      </form>
      <InviteList />
      <BottomSheet
        open={created !== null}
        onClose={() => setCreated(null)}
        title={created ? fmt(v.createdTitle, { label: created.invite.label }) : v.title}
      >
        {created && <CreatedSheet created={created} onDone={() => setCreated(null)} />}
      </BottomSheet>
    </Card>
  );
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function CreatedSheet({ created, onDone }: { created: AdminInviteCreated; onDone(): void }) {
  const { t } = useI18n();
  const v = t.invites;
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const copy = async () => {
    await copyText(created.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  const share = async () => {
    try {
      await navigator.share({ title: v.shareText, text: v.shareText, url: created.url });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // the user closed the share sheet
      await copyText(created.url);
      setNote(v.shareFailed);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="invite-created">
      <p className="text-sm text-muted">{fmt(v.createdBody, { label: created.invite.label })}</p>
      <p
        dir="ltr"
        className="rounded-xl bg-surface-2 px-3 py-3 font-mono text-sm break-all text-ink select-all"
        data-testid="invite-url"
      >
        {created.url}
      </p>
      <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-sm font-semibold text-warning">
        <InfoIcon size={18} className="mt-px shrink-0" />
        {v.once}
      </p>
      <div className="flex flex-col gap-2">
        {canShare && (
          <Button className="min-h-14 text-lg" onClick={() => void share()} data-testid="invite-share">
            <ShareIcon size={20} />
            {v.share}
          </Button>
        )}
        <Button
          variant={canShare ? 'secondary' : 'primary'}
          className="min-h-14 text-lg"
          onClick={() => void copy()}
          data-testid="invite-copy"
        >
          {copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
          <span aria-live="polite">{copied ? t.common.copied : v.copyLink}</span>
        </Button>
        {note && (
          <p role="status" className="text-sm text-muted">
            {note}
          </p>
        )}
        <Button variant="ghost" onClick={onDone}>
          {v.done}
        </Button>
      </div>
    </div>
  );
}

function statusChip(v: ReturnType<typeof useI18n>['t']['invites'], inv: AdminInvite) {
  switch (inv.status) {
    case 'pending':
      return <Badge tone="primary">{v.status_pending}</Badge>;
    case 'used':
      return (
        <Badge tone="success">
          <bdi dir="auto">
            {inv.usedByName ? fmt(v.status_used, { name: inv.usedByName }) : v.status_usedNoName}
          </bdi>
        </Badge>
      );
    case 'expired':
      return <Badge tone="neutral">{v.status_expired}</Badge>;
    case 'revoked':
      return <Badge tone="live">{v.status_revoked}</Badge>;
  }
}

function InviteList() {
  const { t } = useI18n();
  const v = t.invites;
  const invites = useAdminInvites(true);
  if (invites.isPending) return <Skeleton className="h-20" />;
  if (invites.isError) return <ErrorState error={invites.error} onRetry={() => void invites.refetch()} />;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="font-bold text-ink">{v.listTitle}</h3>
      {invites.data.length === 0 ? (
        <p className="text-sm text-muted">{v.empty}</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" data-testid="invite-list">
          {invites.data.map((inv) => (
            <InviteRow key={inv.id} invite={inv} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InviteRow({ invite }: { invite: AdminInvite }) {
  const { t, f } = useI18n();
  const v = t.invites;
  const revoke = useRevokeInvite();
  const [confirm, setConfirm] = useState(false);
  return (
    <li
      className="flex flex-col gap-1.5 px-3 py-2.5"
      data-testid="invite-row"
      data-status={invite.status}
      data-label={invite.label}
    >
      <div className="flex items-center gap-2">
        <bdi dir="auto" className="name-start min-w-0 flex-1 truncate font-semibold text-ink">
          {invite.label}
        </bdi>
        {statusChip(v, invite)}
      </div>
      <p className="text-xs text-muted">
        <bdi dir="auto">{invite.createdBy}</bdi> · <RelativeTime iso={invite.createdAt} />
        {invite.status === 'pending' && <> · {fmt(v.expires, { date: f.dateTime(invite.expiresAt) })}</>}
      </p>
      {invite.status === 'pending' &&
        (confirm ? (
          <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-2.5">
            <p className="text-sm text-ink">{v.revokeConfirm}</p>
            {revoke.isError && <InlineError>{errorMessage(t, revoke.error)}</InlineError>}
            <div className="flex gap-2">
              <Button
                variant="danger"
                className="flex-1"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(invite.id, { onSuccess: () => setConfirm(false) })}
                data-testid="invite-revoke-confirm"
              >
                {revoke.isPending && <Spinner />}
                {v.revokeYes}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={() => setConfirm(false)}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            className="self-start text-live"
            onClick={() => setConfirm(true)}
            data-testid="invite-revoke"
          >
            {v.revoke}
          </Button>
        ))}
    </li>
  );
}
