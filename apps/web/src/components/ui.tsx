'use client';

import { useId, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useI18n, useT } from '@/i18n';
import type { Messages } from '@/i18n';
import { isApiError } from '@/lib/api';
import type { ClientErrorCode } from '@/lib/api';
import { CheckIcon, CopyIcon, RefreshIcon, WifiOffIcon } from './icons';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- buttons ----------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:opacity-90 disabled:opacity-50',
  secondary: 'bg-primary-soft text-on-primary-soft hover:bg-surface-3 disabled:opacity-50',
  ghost: 'bg-transparent text-ink hover:bg-surface-2 disabled:opacity-50',
  danger: 'bg-live-soft text-live hover:opacity-90 disabled:opacity-50',
};

export function Button({
  variant = 'primary',
  block = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; block?: boolean }) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink transition-colors hover:bg-surface-2 disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- layout ----------

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface p-4 shadow-card', className)}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-base font-bold text-ink">{children}</h2>
      {action}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'primary' | 'accent' | 'success' | 'live' | 'warning';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-surface-2 text-muted',
    primary: 'bg-primary text-on-primary',
    accent: 'bg-accent text-on-accent',
    success: 'bg-success-soft text-success',
    live: 'bg-live-soft text-live',
    warning: 'bg-warning-soft text-warning',
  } as const;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function LiveDot({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cx('live-dot inline-block size-2 rounded-full bg-live', className)} />
  );
}

// ---------- segmented control ----------

export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange(v: V): void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 rounded-2xl bg-surface-2 p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cx(
              'min-h-11 flex-1 rounded-xl px-3 text-sm font-semibold transition-colors',
              active ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- form fields ----------

export function TextField({
  label,
  hint,
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? hintId : undefined}
        className={cx(
          'min-h-12 w-full rounded-xl border bg-surface-2 px-3 text-base text-ink placeholder:text-muted focus:border-primary focus:outline-none',
          error ? 'border-live' : 'border-line',
        )}
        {...rest}
      />
      {(error || hint) && (
        <p id={hintId} className={cx('text-sm', error ? 'text-live' : 'text-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

// ---------- loading / empty / error ----------

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('skeleton rounded-xl', className)} />;
}

export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-6 py-10 text-center">
      {icon && (
        <div className="flex size-16 items-center justify-center rounded-full bg-accent text-on-accent">
          {icon}
        </div>
      )}
      <h2 className="text-lg font-bold text-ink">{title}</h2>
      {body && <p className="max-w-xs text-sm leading-relaxed text-muted">{body}</p>}
      {action}
    </div>
  );
}

export type ErrorOverrides = Partial<Record<ClientErrorCode, string>>;

/** Localized message for any client/API error code; call sites can override per code for context. */
export function errorMessage(t: Messages, error: unknown, overrides: ErrorOverrides = {}): string {
  if (!isApiError(error)) return t.errors.generic;
  const override = overrides[error.code];
  if (override) return override;
  switch (error.code) {
    case 'network':
      return t.errors.network;
    case 'upstream_unavailable':
      return t.errors.upstream;
    case 'rate_limited':
      return t.errors.rateLimited;
    case 'forbidden':
      return t.errors.forbidden;
    case 'invalid_response':
      return t.errors.invalid;
    case 'not_found':
      return t.errors.notFound;
    case 'bad_request':
      return t.errors.badRequest;
    case 'conflict':
      return t.errors.conflict;
    case 'unauthorized':
      return t.errors.unauthorized;
    case 'internal':
      return t.errors.internal;
  }
}

export function ErrorState({
  error,
  onRetry,
  overrides,
}: {
  error: unknown;
  onRetry?: () => void;
  overrides?: ErrorOverrides;
}) {
  const t = useT();
  const offline = isApiError(error, 'network');
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-8 text-center"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-live-soft text-live">
        {offline ? <WifiOffIcon /> : <RefreshIcon />}
      </div>
      <h2 className="text-base font-bold text-ink">{t.errors.title}</h2>
      <p className="max-w-xs text-sm text-muted">{errorMessage(t, error, overrides)}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          <RefreshIcon size={18} />
          {t.common.retry}
        </Button>
      )}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-xl bg-live-soft px-3 py-2 text-sm font-medium text-live">
      {children}
    </p>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-5 animate-spin rounded-full border-2 border-current border-e-transparent',
        className,
      )}
    />
  );
}

// ---------- copy ----------

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      className={className}
      onClick={async () => {
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
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
      <span aria-live="polite">{copied ? t.common.copied : t.common.copy}</span>
    </Button>
  );
}

// ---------- numbers ----------

/**
 * Every number goes through this: locale formatting + an isolated LTR run, so "−4" / "-1" never renders as
 * "4−" / "1-" inside Hebrew text. `signed` adds an explicit + for positives (e.g. rank moves, bonus).
 */
export function Num({
  value,
  signed = false,
  className,
}: {
  value: number | null | undefined;
  signed?: boolean;
  className?: string;
}) {
  const { f } = useI18n();
  const text =
    value === null || value === undefined
      ? '—'
      : value < 0
        ? `−${f.num(Math.abs(value))}`
        : `${signed && value > 0 ? '+' : ''}${f.num(value)}`;
  return (
    <bdi dir="ltr" className={cx('tabular', className)}>
      {text}
    </bdi>
  );
}

/** Wraps already-formatted LTR text (prices, ranks, scores) as an isolated run. */
export function Ltr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={className}>
      {children}
    </bdi>
  );
}
