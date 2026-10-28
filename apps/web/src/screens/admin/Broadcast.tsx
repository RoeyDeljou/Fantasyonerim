'use client';

import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { BroadcastBodySchema } from '@fant/shared';
import type {
  BroadcastHistory,
  BroadcastResult,
  BroadcastTarget,
  BroadcastTargetResult,
  BroadcastTargetsStatus,
} from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { useDraft } from '@/lib/drafts';
import { openExternal } from '@/lib/external';
import { readBroadcastTargets, writeBroadcastTargets } from '@/lib/localState';
import { useBootstrap, useBroadcastHistory, useBroadcastTargets, useSendBroadcast } from '@/lib/queries';
import { X_MAX, xWeightedLength } from '@/lib/xLength';
import { BottomSheet } from '@/components/BottomSheet';
import { PhotoInput, PhotoPreview, usePhotoUpload } from '@/components/PhotoUpload';
import { RelativeTime } from '@/components/news/parts';
import { Collapsible, loadProblem } from '@/components/Collapsible';
import {
  BellIcon,
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronEndIcon,
  ClockIcon,
  CloseIcon,
  ExternalIcon,
  ImageIcon,
  InfoIcon,
  NewsIcon,
  SendIcon,
  XBrandIcon,
} from '@/components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  InlineError,
  Skeleton,
  Spinner,
  Switch,
  TextField,
  cx,
  errorMessage,
} from '@/components/ui';

/** Same cap as the contract (`BroadcastBodySchema.text`). X has its own weighted 280 on top. */
export const BROADCAST_MAX = 1000;
const TITLE_MAX = 80;

const TARGETS: readonly BroadcastTarget[] = ['news', 'push', 'x'];
const DEFAULT_TARGETS: readonly BroadcastTarget[] = ['news', 'push'];

const TARGET_ICONS: Record<BroadcastTarget, ComponentType<{ size?: number; className?: string }>> = {
  news: NewsIcon,
  push: BellIcon,
  x: XBrandIcon,
};

const TEMPLATES = ['goal', 'assist', 'red', 'lineups', 'deadline', 'episode'] as const;
type TemplateKey = (typeof TEMPLATES)[number];

/** Unfilled "[player]"-style placeholders left from a template. */
const PLACEHOLDER = /\[[^\]\n]{1,40}\]/;

// ---------- admin home card ----------

/** The first thing on the admin home: a big, thumb-friendly way into the live-update composer. */
export function LiveUpdateCard() {
  const { t } = useI18n();
  const b = t.broadcast;
  return (
    <Link
      href="/admin/?view=broadcast"
      data-testid="live-update-card"
      className="flex items-center gap-3 rounded-2xl bg-primary p-4 text-on-primary shadow-card transition-opacity hover:opacity-95"
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-on-primary/15">
        <BoltIcon size={26} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-lg font-extrabold">{b.title}</span>
        <span className="text-sm opacity-90">{b.homeCardBody}</span>
        <span className="mt-1 inline-flex items-center gap-1 text-sm font-bold underline-offset-2">
          {b.homeCardCta}
          <ChevronEndIcon size={18} />
        </span>
      </span>
    </Link>
  );
}

// ---------- the section ----------

export function BroadcastView() {
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [formKey, setFormKey] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      {result ? (
        <ResultsCard
          result={result}
          onNew={() => {
            setResult(null);
            setFormKey((k) => k + 1);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      ) : (
        <Composer key={formKey} onSent={setResult} />
      )}
      <HistoryCard />
    </div>
  );
}

function initialTargets(): BroadcastTarget[] {
  const saved = readBroadcastTargets();
  return saved && saved.length > 0 ? saved : [...DEFAULT_TARGETS];
}

type TargetInfo = BroadcastTargetsStatus['targets'][number];

function Composer({ onSent }: { onSent(r: BroadcastResult): void }) {
  const { t } = useI18n();
  const b = t.broadcast;
  const status = useBroadcastTargets(true);
  const bootstrap = useBootstrap();
  const send = useSendBroadcast();
  const photo = usePhotoUpload();
  const textId = useId();
  const counterId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  // Persisted until sent: a deploy mid-match must never eat a half-written live update.
  const [title, setTitle] = useDraft('broadcast.title');
  const [text, setText] = useDraft('broadcast.text');
  const [chosen, setChosen] = useState<BroadcastTarget[]>(initialTargets);
  const [confirm, setConfirm] = useState(false);
  const [tried, setTried] = useState(false);

  const info = new Map<BroadcastTarget, TargetInfo>((status.data?.targets ?? []).map((x) => [x.target, x]));
  const available = (tg: BroadcastTarget) => info.get(tg)?.available === true;
  // Only targets that are usable right now count — a remembered "X" stays off while X isn't configured.
  const targets = status.data ? TARGETS.filter((tg) => chosen.includes(tg) && available(tg)) : [];
  const xOn = targets.includes('x');

  const trimmed = text.trim();
  const xLen = xWeightedLength(trimmed);
  const xTooLong = xOn && xLen > X_MAX;
  const tooLong = trimmed.length > BROADCAST_MAX;

  const problem: string | null = !trimmed
    ? b.needText
    : tooLong
      ? fmt(b.tooLong, { max: BROADCAST_MAX })
      : targets.length === 0
        ? b.needTarget
        : xTooLong
          ? fmt(b.xTooLong, { n: xLen, max: X_MAX })
          : photo.uploading
            ? b.waitUpload
            : null;

  const toggle = (tg: BroadcastTarget, on: boolean) =>
    setChosen((c) => (on ? [...c.filter((x) => x !== tg), tg] : c.filter((x) => x !== tg)));

  const templateText = (k: TemplateKey): string => {
    if (k !== 'deadline') return b[`tplText_${k}`];
    const gw = bootstrap.data?.nextEvent ?? null;
    return fmt(b.tplText_deadline, {
      gw: gw === null ? b.tplText_deadlineNoGw : fmt(b.tplText_deadlineGw, { gw }),
    });
  };

  /** Appends the template (on its own line) and selects its first [placeholder] so typing replaces it. */
  const insertTemplate = (k: TemplateKey) => {
    const tpl = templateText(k);
    const base = text.trim() ? `${text.replace(/\s+$/, '')}\n` : '';
    const next = base + tpl;
    setText(next);
    window.requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      const m = PLACEHOLDER.exec(tpl);
      const from = m ? base.length + m.index : next.length;
      el.setSelectionRange(from, m ? from + m[0].length : from);
    });
  };

  const body = () =>
    BroadcastBodySchema.safeParse({
      title: title.trim() || null,
      text: trimmed,
      uploadId: photo.uploadId,
      targets,
    });

  const review = () => {
    setTried(true);
    if (problem || !body().success) return;
    send.reset();
    setConfirm(true);
  };

  const doSend = () => {
    const parsed = body();
    if (!parsed.success) return;
    send.mutate(parsed.data, {
      onSuccess: (r) => {
        writeBroadcastTargets(targets);
        setTitle('');
        setText('');
        setConfirm(false);
        onSent(r);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      onError: () => setConfirm(false),
    });
  };

  return (
    // The composer is what this section is for: open by default (its own toggle is still remembered).
    <Collapsible
      id="broadcast.composer"
      icon={<BoltIcon size={20} />}
      title={b.title}
      defaultOpen
      info={b.intro}
      error={loadProblem(t, status)}
      saveError={send.isError ? `${b.sendFailed} ${errorMessage(t, send.error)}` : null}
    >
      {/* ---------- templates ---------- */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold text-ink">{b.templatesLabel}</p>
        <div className="flex flex-wrap gap-2" data-testid="broadcast-templates">
          {TEMPLATES.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => insertTemplate(k)}
              className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface-2 px-3.5 text-sm font-semibold text-ink hover:bg-surface-3 active:bg-primary-soft"
            >
              {b[`tpl_${k}`]}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- message ---------- */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={textId} className="text-sm font-semibold text-ink">
          {b.text}
        </label>
        <textarea
          id={textId}
          ref={textRef}
          dir="auto"
          rows={6}
          value={text}
          placeholder={b.placeholder}
          aria-describedby={counterId}
          aria-invalid={(tried && !trimmed) || tooLong || xTooLong || undefined}
          onChange={(e) => setText(e.target.value)}
          className={cx(
            'min-h-44 w-full resize-y rounded-xl border bg-surface-2 px-3 py-3 text-lg leading-relaxed text-ink placeholder:text-muted focus:border-primary focus:outline-none',
            tooLong || xTooLong ? 'border-live' : 'border-line',
          )}
          data-testid="broadcast-text"
        />
        <div
          id={counterId}
          className="flex flex-wrap items-center justify-end gap-2 text-xs"
          aria-live="polite"
        >
          {xOn && (
            <span
              className={cx(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold',
                xTooLong ? 'bg-live-soft text-live' : 'bg-surface-2 text-muted',
              )}
              data-testid="x-counter"
              data-over={xTooLong ? 'true' : 'false'}
              title={b.xCounterNote}
            >
              <XBrandIcon size={12} />
              <span className="sr-only">{fmt(b.xCounter, { n: xLen, max: X_MAX })}</span>
              <bdi dir="ltr" aria-hidden="true" className="tabular">
                {xLen}/{X_MAX}
              </bdi>
            </span>
          )}
          <span className={cx('tabular', tooLong ? 'font-bold text-live' : 'text-muted')}>
            <span className="sr-only">{fmt(b.counter, { n: trimmed.length, max: BROADCAST_MAX })}</span>
            <bdi dir="ltr" aria-hidden="true" data-testid="broadcast-counter">
              {trimmed.length}/{BROADCAST_MAX}
            </bdi>
          </span>
        </div>
        {xTooLong && <InlineError>{fmt(b.xTooLong, { n: xLen, max: X_MAX })}</InlineError>}
      </div>

      <TextField
        label={b.headline}
        hint={b.headlineHint}
        value={title}
        maxLength={TITLE_MAX}
        dir="auto"
        onChange={(e) => setTitle(e.target.value)}
      />

      {/* ---------- photo ---------- */}
      <div className="flex flex-col gap-2">
        <PhotoPreview photo={photo} testId="broadcast-photo" />
        {photo.upload.status === 'error' && <InlineError>{photo.upload.message}</InlineError>}
        <PhotoInput photo={photo} testId="broadcast-file" />
        <Button variant="secondary" className="self-start" onClick={photo.choose} disabled={photo.uploading}>
          <ImageIcon size={20} />
          {photo.upload.status === 'done' ? t.community.changePhoto : t.community.addPhoto}
        </Button>
      </div>

      {/* ---------- targets ---------- */}
      <fieldset
        className="flex flex-col gap-1 rounded-2xl border border-line p-3"
        data-testid="broadcast-targets"
      >
        <legend className="px-1 text-sm font-semibold text-ink">{b.targetsLabel}</legend>
        {status.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : status.isError ? (
          <div className="flex flex-col gap-2">
            <InlineError>
              {b.targetsError} {errorMessage(t, status.error)}
            </InlineError>
            <Button variant="secondary" className="self-start" onClick={() => void status.refetch()}>
              {t.common.retry}
            </Button>
          </div>
        ) : (
          TARGETS.map((tg) => (
            <TargetRow
              key={tg}
              target={tg}
              info={info.get(tg)}
              checked={targets.includes(tg)}
              onChange={(on) => toggle(tg, on)}
            />
          ))
        )}
      </fieldset>

      {send.isError && (
        <InlineError>
          {b.sendFailed} {errorMessage(t, send.error)}
        </InlineError>
      )}
      {tried && problem && !send.isError && <InlineError>{problem}</InlineError>}

      <Button block className="min-h-12 text-lg" onClick={review} data-testid="broadcast-review">
        <SendIcon size={20} className="rtl:-scale-x-100" />
        {b.review}
      </Button>

      <BottomSheet open={confirm} onClose={() => !send.isPending && setConfirm(false)} title={b.confirmTitle}>
        <ConfirmBody
          title={title.trim()}
          text={trimmed}
          photoUrl={photo.upload.status === 'done' ? photo.upload.image.url : null}
          targets={targets}
          pending={send.isPending}
          onSend={doSend}
          onBack={() => setConfirm(false)}
        />
      </BottomSheet>
    </Collapsible>
  );
}

function TargetRow({
  target,
  info,
  checked,
  onChange,
}: {
  target: BroadcastTarget;
  info: TargetInfo | undefined;
  checked: boolean;
  onChange(on: boolean): void;
}) {
  const { t } = useI18n();
  const b = t.broadcast;
  const available = info?.available === true;
  const paid = info?.paidFeature === true && !available;
  const description = available
    ? b[`targetDesc_${target}`]
    : paid
      ? undefined
      : info
        ? fmt(b.unavailable, { reason: reasonText(b, info) })
        : b.unavailableNoReason;
  const note = available && info ? reasonText(b, info, '') : '';
  return (
    <div data-testid="broadcast-target" data-target={target} data-available={available ? 'true' : 'false'}>
      <Switch
        label={b[`target_${target}`]}
        description={description}
        checked={checked}
        disabled={!available}
        onChange={onChange}
      />
      {note && (
        <p
          dir="auto"
          className="-mt-1 mb-1 flex items-start gap-1.5 text-xs text-warning"
          data-testid="broadcast-target-note"
        >
          <InfoIcon size={14} className="mt-px shrink-0" />
          <span>{note}</span>
        </p>
      )}
      {paid && (
        <p
          className="-mt-1 mb-1 flex items-center gap-1.5 self-start rounded-xl bg-warning-soft px-3 py-1.5 text-xs font-bold text-warning"
          data-testid="broadcast-x-paid"
        >
          <InfoIcon size={14} className="shrink-0" />
          <span>{t.integrations.xPaid}</span>
        </p>
      )}
    </div>
  );
}

function ConfirmBody({
  title,
  text,
  photoUrl,
  targets,
  pending,
  onSend,
  onBack,
}: {
  title: string;
  text: string;
  photoUrl: string | null;
  targets: readonly BroadcastTarget[];
  pending: boolean;
  onSend(): void;
  onBack(): void;
}) {
  const { t } = useI18n();
  const b = t.broadcast;
  return (
    <div className="flex flex-col gap-3" data-testid="broadcast-confirm">
      <div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3">
        {title && (
          <p dir="auto" className="font-bold text-ink">
            {title}
          </p>
        )}
        <p
          dir="auto"
          className="text-base leading-relaxed whitespace-pre-line text-ink [overflow-wrap:anywhere]"
        >
          {text}
        </p>
        {photoUrl && (
          <div className="flex items-center gap-2 pt-1">
            <img src={photoUrl} alt="" className="size-14 rounded-lg object-cover" />
            <span className="text-xs text-muted">{b.withPhoto}</span>
          </div>
        )}
      </div>
      {PLACEHOLDER.test(text) && (
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-2.5 text-sm font-semibold text-warning">
          <InfoIcon size={18} className="shrink-0" />
          {b.placeholderWarning}
        </p>
      )}
      <div>
        <p className="mb-1.5 text-sm font-semibold text-muted">{b.confirmTo}</p>
        <ul className="flex flex-wrap gap-2">
          {targets.map((tg) => {
            const Icon = TARGET_ICONS[tg];
            return (
              <li
                key={tg}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-primary-soft px-3 text-sm font-semibold text-on-primary-soft"
              >
                <Icon size={16} />
                {b[`target_${tg}`]}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="flex gap-2 pt-1">
        <Button className="min-h-12 flex-1" onClick={onSend} disabled={pending} data-testid="broadcast-send">
          {pending ? <Spinner /> : <SendIcon size={18} className="rtl:-scale-x-100" />}
          {pending ? b.sending : b.send}
        </Button>
        <Button variant="ghost" className="min-h-12 flex-1" onClick={onBack} disabled={pending}>
          {b.backToEdit}
        </Button>
      </div>
    </div>
  );
}

// ---------- localized outcomes (the API's `code` / `reasonCode`; `detail` / `reason` are English, for logs) ----------

type BroadcastCopy = Messages['broadcast'];

function notConfigured(b: BroadcastCopy, target: BroadcastTarget): string {
  return target === 'push'
    ? b.out_not_configured_push
    : target === 'x'
      ? b.out_not_configured_x
      : b.out_not_configured;
}

/** Why a target can't be used (or a heads-up for an available one, e.g. no push subscribers yet). */
export function reasonText(b: BroadcastCopy, info: TargetInfo, fallback = b.unavailableNoReason): string {
  switch (info.reasonCode) {
    case 'no_subscribers':
      return b.out_no_subscribers;
    case 'not_configured':
      return notConfigured(b, info.target);
    case 'paid_feature':
      return b.out_not_configured_x;
    case null:
      return info.reason ?? fallback;
    default:
      return info.reason ?? fallback;
  }
}

export function outcomeText(b: BroadcastCopy, r: BroadcastTargetResult): string {
  switch (r.code) {
    case 'posted':
      return r.target === 'news' ? b.out_posted_news : r.target === 'x' ? b.out_posted_x : b.out_posted;
    case 'delivered':
      return r.delivered !== null && r.recipients !== null
        ? fmt(b.out_delivered, { delivered: r.delivered, recipients: r.recipients })
        : r.detail;
    case 'no_subscribers':
      return b.out_no_subscribers;
    case 'not_configured':
      return notConfigured(b, r.target);
    case 'too_long':
      return b.out_too_long;
    case 'failed':
      return b.out_failed;
    default:
      return r.detail;
  }
}

// ---------- results ----------

function statusTone(s: BroadcastTargetResult['status']): 'success' | 'warning' | 'live' {
  return s === 'ok' ? 'success' : s === 'skipped' ? 'warning' : 'live';
}

function StatusIcon({ status }: { status: BroadcastTargetResult['status'] }) {
  return status === 'ok' ? (
    <CheckIcon size={14} />
  ) : status === 'error' ? (
    <CloseIcon size={14} />
  ) : (
    <InfoIcon size={14} />
  );
}

/** Our own News deep links open inside the app (also in the native shell); anything else is external. */
function useOpenResult(): (r: BroadcastTargetResult) => void {
  const router = useRouter();
  return (r) => {
    if (!r.url) return;
    if (r.url.startsWith('/')) {
      router.push(r.url);
      return;
    }
    try {
      const u = new URL(r.url);
      if (r.target === 'news' && u.pathname.startsWith('/news/')) {
        router.push(`${u.pathname}${u.search}`);
        return;
      }
    } catch {
      return;
    }
    openExternal(r.url);
  };
}

function resultLinkLabel(b: Messages['broadcast'], target: BroadcastTarget): string {
  return target === 'news' ? b.openNews : target === 'x' ? b.openX : b.open;
}

function ResultList({ results, compact = false }: { results: BroadcastTargetResult[]; compact?: boolean }) {
  const { t } = useI18n();
  const b = t.broadcast;
  const open = useOpenResult();
  return (
    <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
      {results.map((r) => {
        const Icon = TARGET_ICONS[r.target];
        return (
          <li
            key={r.target}
            className={cx('flex flex-col gap-1.5 px-3', compact ? 'py-2' : 'py-3')}
            data-testid="broadcast-result"
            data-target={r.target}
            data-status={r.status}
          >
            <div className="flex items-center gap-2">
              <Icon size={18} className="shrink-0 text-muted" />
              <span className="flex-1 font-semibold text-ink">{b[`target_${r.target}`]}</span>
              <Badge tone={statusTone(r.status)}>
                <StatusIcon status={r.status} />
                {b[`status_${r.status}`]}
              </Badge>
            </div>
            <p className="text-sm break-words text-muted" data-testid="broadcast-result-text">
              {outcomeText(b, r)}
            </p>
            {r.code === 'failed' && r.detail && (
              <p dir="auto" className="text-xs break-words text-muted">
                {fmt(b.out_failedDetail, { detail: r.detail })}
              </p>
            )}
            {r.url && (
              <Button
                variant="secondary"
                className="self-start"
                onClick={() => open(r)}
                data-testid="broadcast-result-link"
              >
                {resultLinkLabel(b, r.target)}
                {r.target === 'news' ? <ChevronEndIcon size={18} /> : <ExternalIcon size={16} />}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ResultsCard({ result, onNew }: { result: BroadcastResult; onNew(): void }) {
  const { t } = useI18n();
  const b = t.broadcast;
  // "Skipped" (e.g. no push subscribers yet) is not a failure: the update went out wherever it could.
  const ok = result.results.filter((r) => r.status === 'ok').length;
  const failed = result.results.filter((r) => r.status === 'error').length;
  const all = ok > 0 && failed === 0;
  const heading = all ? b.resultsOk : ok > 0 ? b.resultsPartial : b.resultsFailed;
  return (
    <div data-testid="broadcast-results">
      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-3" role="status">
          <span
            className={cx(
              'flex size-10 shrink-0 items-center justify-center rounded-full',
              all
                ? 'bg-success-soft text-success'
                : ok > 0
                  ? 'bg-warning-soft text-warning'
                  : 'bg-live-soft text-live',
            )}
          >
            {all ? <CheckIcon size={22} /> : <InfoIcon size={22} />}
          </span>
          <h2 className="text-lg font-extrabold text-ink">{heading}</h2>
        </div>
        <ResultList results={result.results} />
        <Button block className="min-h-12 text-lg" onClick={onNew} data-testid="broadcast-new">
          <BoltIcon size={20} />
          {b.newUpdate}
        </Button>
      </Card>
    </div>
  );
}

// ---------- history ----------

function HistoryCard() {
  const { t } = useI18n();
  const b = t.broadcast;
  const history = useBroadcastHistory(true);
  let body: ReactNode;
  if (history.isPending) {
    body = (
      <div className="flex flex-col gap-2" role="status" aria-busy="true">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  } else if (history.isError) {
    body = null; // shown by the card header (also while collapsed)
  } else if (history.data.items.length === 0) {
    body = <EmptyState icon={<BoltIcon size={28} />} title={b.historyEmpty} />;
  } else {
    body = (
      <ul className="flex flex-col gap-2" data-testid="broadcast-history">
        {history.data.items.map((item) => (
          <HistoryItem key={item.id} item={item} />
        ))}
      </ul>
    );
  }
  const n = history.data?.items.length ?? 0;
  return (
    <Collapsible
      id="broadcast.history"
      icon={<ClockIcon size={18} />}
      title={b.historyTitle}
      summary={history.data ? (n > 0 ? fmt(t.adminUi.sent, { n }) : t.adminUi.noneSent) : undefined}
      error={loadProblem(t, history)}
    >
      {body}
    </Collapsible>
  );
}

function HistoryItem({ item }: { item: BroadcastHistory['items'][number] }) {
  const { t } = useI18n();
  const b = t.broadcast;
  return (
    <li
      className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-3 shadow-card"
      data-testid="broadcast-history-item"
    >
      {item.title && (
        <p dir="auto" className="truncate font-bold text-ink">
          {item.title}
        </p>
      )}
      <p dir="auto" className="line-clamp-3 text-sm whitespace-pre-line text-ink [overflow-wrap:anywhere]">
        {item.text}
      </p>
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
        <bdi dir="auto">{fmt(b.historyBy, { name: item.sentBy })}</bdi>
        <span aria-hidden="true">·</span>
        <RelativeTime iso={item.createdAt} />
      </p>
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-1.5 [&::-webkit-details-marker]:hidden">
          {item.results.map((r) => {
            const Icon = TARGET_ICONS[r.target];
            return (
              <Badge key={r.target} tone={statusTone(r.status)}>
                <Icon size={12} />
                {b[`target_${r.target}`]}
                <StatusIcon status={r.status} />
              </Badge>
            );
          })}
          <span className="ms-auto flex items-center gap-0.5 text-xs font-semibold text-primary">
            {b.historyDetails}
            <ChevronDownIcon size={16} className="transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="pt-1">
          <ResultList results={item.results} compact />
        </div>
      </details>
    </li>
  );
}
