'use client';

import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { readCardOpen, writeCardOpen } from '@/lib/localState';
import { ChevronDownIcon, InfoIcon, RefreshIcon } from './icons';
import type { Messages } from '@/i18n';
import { cx, errorMessage } from './ui';

export type SummaryTone = 'neutral' | 'success' | 'warning' | 'live' | 'primary';

const DOT: Record<SummaryTone, string> = {
  neutral: 'bg-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  live: 'bg-live',
  primary: 'bg-primary',
};
const TEXT: Record<SummaryTone, string> = {
  neutral: 'text-muted',
  success: 'text-success',
  warning: 'text-warning',
  live: 'text-live',
  primary: 'text-primary',
};

/**
 * A collapsible card (admin console). The header is one 44 px+ button — icon, short title, at most one short
 * status — with `aria-expanded` / `aria-controls`. The body stays mounted while collapsed (unsaved form drafts
 * survive), but is `visibility: hidden` so it is out of the tab order and the accessibility tree.
 *
 * Open/closed is remembered per `id` on this device; until the user toggles it, `defaultOpen` decides (open a
 * card by default only when it needs attention, or when it is the only card in its section).
 * `alert` is shown under the header even while collapsed — errors must never hide behind a chevron.
 */
export function Collapsible({
  id,
  icon,
  title,
  summary,
  tone = 'neutral',
  defaultOpen = false,
  alert,
  error,
  saveError,
  info,
  className,
  testId,
  level = 2,
  children,
}: {
  id: string;
  /** Heading level of the title: 3 when the card sits under a section heading. */
  level?: 2 | 3;
  icon: ReactNode;
  title: string;
  summary?: ReactNode;
  tone?: SummaryTone;
  defaultOpen?: boolean;
  alert?: ReactNode;
  /**
   * The card's data failed to load. Always shown under the header (open or collapsed) as one line with a retry,
   * and the status turns into "couldn't load". Pass `errorMessage(t, query.error)` + `query.refetch`.
   */
  error?: CardProblem | null | undefined;
  /**
   * A save / action inside the card failed. The open body shows its own message; this one appears under the
   * header only while the card is collapsed, so collapsing never hides a failure.
   */
  saveError?: string | null | undefined;
  /** Longer explanatory text, behind a small "more info" toggle at the top of the body. */
  info?: ReactNode;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const uid = useId();
  const headerId = `${uid}-h`;
  const panelId = `${uid}-p`;
  // The user's own choice (remembered on this device) wins. Until then `defaultOpen` decides — and it latches:
  // a card that opened because it needed attention doesn't snap shut the moment the problem is fixed.
  const [chosen, setChosen] = useState<boolean | null>(() => readCardOpen(id));
  const [latched, setLatched] = useState(defaultOpen);
  if (defaultOpen && !latched) setLatched(true);
  const open = chosen ?? latched;
  const Heading = level === 3 ? 'h3' : 'h2';
  const { t } = useI18n();
  const shownSummary = error ? t.adminUi.loadFailed : summary;
  const shownTone: SummaryTone = error || (saveError && !open) ? 'live' : tone;
  const hasSummary = shownSummary !== undefined && shownSummary !== null && shownSummary !== '';
  const toggle = () => {
    writeCardOpen(id, !open);
    setChosen(!open);
  };

  return (
    <section
      className={cx('rounded-2xl border border-line bg-surface shadow-card', className)}
      data-testid={testId ?? 'admin-card'}
      data-card={id}
      data-open={open ? 'true' : 'false'}
    >
      <Heading className="m-0">
        <button
          type="button"
          id={headerId}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
          className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-4 py-2 text-start transition-colors hover:bg-surface-2"
          data-testid="card-toggle"
        >
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-on-primary-soft"
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1 truncate text-base font-bold text-ink">{title}</span>
          {hasSummary ? (
            <span
              className={cx(
                'flex max-w-[50%] min-w-0 shrink-0 items-center gap-1.5 text-xs font-semibold',
                TEXT[shownTone],
              )}
              data-testid="card-summary"
            >
              <StatusDot tone={shownTone} />
              <span className="truncate">{shownSummary}</span>
            </span>
          ) : (
            // No summary text: the status still shows as a dot (it only stays hidden while neutral).
            shownTone !== 'neutral' && <StatusDot tone={shownTone} />
          )}
          <ChevronDownIcon
            size={20}
            aria-hidden="true"
            className={cx(
              'shrink-0 text-muted transition-transform duration-200 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </button>
      </Heading>
      {(alert || error || (saveError && !open)) && (
        <div className="flex flex-col gap-2 px-4 pb-3">
          {error && <ProblemRow problem={error} testId="card-error" />}
          {saveError && !open && <ProblemRow problem={{ message: saveError }} testId="card-save-error" />}
          {alert}
        </div>
      )}
      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        className={cx(
          'grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none',
          open ? 'visible grid-rows-[1fr]' : 'invisible grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
            {info && <MoreInfo>{info}</MoreInfo>}
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

/** A small "more info" disclosure for helper text that would otherwise be a wall of text. */
export function MoreInfo({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('flex flex-col', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-ms-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg px-2 text-sm font-semibold text-primary hover:bg-surface-2"
      >
        <InfoIcon size={16} className="shrink-0" />
        {open ? t.adminUi.lessInfo : t.adminUi.moreInfo}
      </button>
      <div id={id} hidden={!open} className="text-sm leading-relaxed text-muted">
        {children}
      </div>
    </div>
  );
}

/** A failed query → the card's load problem (null while fine). */
export function loadProblem(
  t: Messages,
  q: { isError: boolean; error: unknown; refetch: () => unknown },
): CardProblem | null {
  return q.isError ? { message: errorMessage(t, q.error), onRetry: () => void q.refetch() } : null;
}

/** A failed mutation → its message (null while fine). */
export function saveProblem(t: Messages, m: { isError: boolean; error: unknown }): string | null {
  return m.isError ? errorMessage(t, m.error) : null;
}

export interface CardProblem {
  message: string;
  onRetry?: (() => void) | undefined;
}

/** One compact line: what went wrong + a retry (44 px target). */
function ProblemRow({ problem, testId }: { problem: CardProblem; testId: string }) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex min-h-11 items-center gap-2 rounded-xl bg-live-soft ps-3 pe-1 text-sm font-medium text-live"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1 py-1.5">{problem.message}</span>
      {problem.onRetry && (
        <button
          type="button"
          onClick={problem.onRetry}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 font-semibold hover:bg-surface-2"
        >
          <RefreshIcon size={16} />
          {t.common.retry}
        </button>
      )}
    </div>
  );
}

export function StatusDot({ tone, className }: { tone: SummaryTone; className?: string }) {
  return <span aria-hidden="true" className={cx('size-2 shrink-0 rounded-full', DOT[tone], className)} />;
}

/** A section heading over a group of collapsible cards; its explanation sits behind "more info". */
export function SectionHeading({
  title,
  info,
  className,
}: {
  title: string;
  info?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col', className)}>
      <h2 className="text-lg font-extrabold text-ink">{title}</h2>
      {info && <MoreInfo>{info}</MoreInfo>}
    </div>
  );
}
