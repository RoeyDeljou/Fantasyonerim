'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ReportReasonSchema } from '@fant/shared';
import type { CommunityAuthor, ReportReason } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { isBannedError } from '@/lib/banned';
import { useBlockUser, useReport } from '@/lib/queries';
import type { ReportTarget } from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { BanIcon, FlagIcon, MoreIcon, TrashIcon } from '@/components/icons';
import { Button, IconButton, InlineError, Spinner, cx, errorMessage } from '@/components/ui';
import { useNotify } from './parts';

const REASONS: readonly ReportReason[] = ReportReasonSchema.options;
const NOTE_MAX = 300;

type Mode = 'menu' | 'delete' | 'report' | 'block';

/**
 * The "⋯" menu of a post or comment: delete (own content, or any as admin — with a confirm step) and report
 * (other people's content — reason picker + optional note) and block the author (other fans, never admins or
 * yourself — App Store guideline 1.2). One sheet, one step per action.
 */
export function ContentMenu({
  target,
  canDelete,
  canReport,
  deleteTitle,
  deleteBody,
  deleting,
  deleteError,
  onDelete,
  blockAuthor = null,
  onBlocked,
}: {
  target: ReportTarget;
  canDelete: boolean;
  canReport: boolean;
  deleteTitle: string;
  deleteBody?: string | undefined;
  deleting: boolean;
  deleteError: unknown;
  onDelete(done: () => void): void;
  /** The author to offer "block" for, or null when blocking doesn't apply (own content, admins). */
  blockAuthor?: CommunityAuthor | null;
  onBlocked?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const c = t.community;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('menu');
  if (!canDelete && !canReport && !blockAuthor) return null;

  const show = (m: Mode) => {
    setMode(m);
    setOpen(true);
  };
  const close = () => setOpen(false);
  const title =
    mode === 'delete'
      ? deleteTitle
      : mode === 'report'
        ? c.reportTitle
        : mode === 'block' && blockAuthor
          ? fmt(c.blockTitle, { name: blockAuthor.name })
          : target.kind === 'post'
            ? c.actionsTitle
            : c.commentActionsTitle;

  return (
    <>
      <IconButton
        label={c.more}
        onClick={() => show('menu')}
        className="-me-2 text-muted"
        data-testid="content-menu"
      >
        <MoreIcon size={20} />
      </IconButton>
      <BottomSheet open={open} onClose={close} title={title}>
        {mode === 'menu' && (
          <ul className="flex flex-col gap-1 pb-1">
            {canDelete && (
              <li>
                <MenuItem icon={<TrashIcon size={20} />} danger onClick={() => setMode('delete')}>
                  {c.delete}
                </MenuItem>
              </li>
            )}
            {canReport && (
              <li>
                <MenuItem icon={<FlagIcon size={20} />} onClick={() => setMode('report')}>
                  {c.report}
                </MenuItem>
              </li>
            )}
            {blockAuthor && (
              <li>
                <MenuItem icon={<BanIcon size={20} />} onClick={() => setMode('block')} testId="block-user">
                  {c.block}
                </MenuItem>
              </li>
            )}
          </ul>
        )}
        {mode === 'delete' && (
          <div className="flex flex-col gap-3">
            {deleteBody && <p className="text-sm text-muted">{deleteBody}</p>}
            {deleteError !== null && deleteError !== undefined && (
              <InlineError>{errorMessage(t, deleteError)}</InlineError>
            )}
            <div className="flex gap-2">
              <Button variant="danger" className="flex-1" disabled={deleting} onClick={() => onDelete(close)}>
                {deleting ? <Spinner /> : <TrashIcon size={18} />}
                {c.deleteConfirm}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={close}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}
        {mode === 'report' && <ReportForm target={target} onDone={close} />}
        {mode === 'block' && blockAuthor && (
          <BlockConfirm
            author={blockAuthor}
            onCancel={close}
            onDone={() => {
              close();
              onBlocked?.();
            }}
          />
        )}
      </BottomSheet>
    </>
  );
}

function MenuItem({
  icon,
  danger = false,
  onClick,
  children,
  testId,
}: {
  icon: ReactNode;
  danger?: boolean;
  onClick(): void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cx(
        'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-start text-base font-semibold hover:bg-surface-2',
        danger ? 'text-live' : 'text-ink',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function ReportForm({ target, onDone }: { target: ReportTarget; onDone(): void }) {
  const { t } = useI18n();
  const c = t.community;
  const report = useReport();
  const notify = useNotify();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const noteId = useId();
  const name = useId();

  const submit = () => {
    if (!reason) return;
    const trimmed = note.trim();
    report.mutate(
      { target, body: trimmed ? { reason, note: trimmed } : { reason } },
      {
        onSuccess: () => {
          notify(c.reported);
          onDone();
        },
      },
    );
  };

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="report-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-sm text-muted">{c.reportBody}</p>
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">{c.reportTitle}</legend>
        {REASONS.map((r) => (
          <label
            key={r}
            className={cx(
              'flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 text-[15px] font-medium text-ink',
              reason === r ? 'border-primary bg-primary-soft' : 'border-line',
            )}
          >
            <input
              type="radio"
              name={name}
              value={r}
              checked={reason === r}
              onChange={() => setReason(r)}
              className="size-5 accent-[var(--primary)]"
            />
            {c[`reason_${r}`]}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className="flex justify-between text-sm font-semibold text-ink">
          <span>
            {c.reportNote} <span className="font-normal text-muted">({t.common.optional})</span>
          </span>
          <bdi dir="ltr" className="text-xs font-normal text-muted tabular">
            {note.length}/{NOTE_MAX}
          </bdi>
        </label>
        <textarea
          id={noteId}
          dir="auto"
          rows={2}
          maxLength={NOTE_MAX}
          value={note}
          placeholder={c.reportNotePlaceholder}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-base text-ink placeholder:text-muted focus:border-primary focus:outline-none"
        />
      </div>
      {report.isError && (
        <InlineError>{isBannedError(report.error) ? c.banned : errorMessage(t, report.error)}</InlineError>
      )}
      <Button type="submit" block disabled={!reason || report.isPending}>
        {report.isPending ? <Spinner /> : <FlagIcon size={18} />}
        {c.reportSubmit}
      </Button>
    </form>
  );
}

function BlockConfirm({
  author,
  onCancel,
  onDone,
}: {
  author: CommunityAuthor;
  onCancel(): void;
  onDone(): void;
}) {
  const { t } = useI18n();
  const c = t.community;
  const block = useBlockUser();
  const notify = useNotify();
  return (
    <div className="flex flex-col gap-3" data-testid="block-sheet">
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-[15px] leading-relaxed text-ink">
        <li>{fmt(c.blockBody1, { name: author.name })}</li>
        <li>{c.blockBody2}</li>
        <li>{c.blockBody3}</li>
      </ul>
      <p className="text-sm text-muted">{c.blockBody4}</p>
      {block.isError && <InlineError>{errorMessage(t, block.error)}</InlineError>}
      <div className="flex gap-2">
        <Button
          variant="danger"
          className="flex-1"
          disabled={block.isPending}
          data-testid="block-confirm"
          onClick={() =>
            block.mutate(
              { userId: author.id, blocked: true },
              {
                onSuccess: () => {
                  notify(fmt(c.blockedToast, { name: author.name }));
                  onDone();
                },
              },
            )
          }
        >
          {block.isPending ? <Spinner /> : <BanIcon size={18} />}
          {c.blockConfirm}
        </Button>
        <Button variant="ghost" className="flex-1" onClick={onCancel}>
          {t.common.cancel}
        </Button>
      </div>
    </div>
  );
}
