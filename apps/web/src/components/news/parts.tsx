'use client';

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { linkify } from '@/lib/newsFormat';
import { openExternal } from '@/lib/external';
import type { LinkPlatform } from '@/lib/newsFormat';
import { cx } from '@/components/ui';

// ---------- a shared, minute-resolution clock for relative times ----------

let now = 0;
const nowListeners = new Set<() => void>();
let timer: number | null = null;

function subscribeNow(cb: () => void) {
  nowListeners.add(cb);
  if (timer === null) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      nowListeners.forEach((l) => l());
    }, 60_000);
  }
  return () => {
    nowListeners.delete(cb);
    if (nowListeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time, re-rendering subscribers once a minute (0 during static render). */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeNow,
    () => {
      if (!now) now = Date.now();
      return now;
    },
    () => 0,
  );
}

export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const { f } = useI18n();
  const n = useNow();
  return (
    <time dateTime={iso} title={f.dateTime(iso)} className={className} suppressHydrationWarning>
      {n === 0 ? f.date(iso) : f.relative(iso, n)}
    </time>
  );
}

// ---------- text ----------

function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  return bare.length > 32 ? `${bare.slice(0, 31)}…` : bare;
}

/**
 * Third-party text (captions, tweets, descriptions): dir="auto" per paragraph so Hebrew and English posts
 * both read correctly, URLs/@mentions isolated as LTR runs so they never scramble the surrounding sentence.
 */
export function LinkifiedText({ text, platform }: { text: string; platform: LinkPlatform }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} dir="auto" className="whitespace-pre-line [overflow-wrap:anywhere]">
          {linkify(p, platform).map((tok, j) => {
            if (tok.kind === 'text') return <span key={j}>{tok.value}</span>;
            return (
              <a
                key={j}
                href={tok.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(tok.href);
                }}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                <bdi dir={tok.kind === 'hashtag' ? 'auto' : 'ltr'}>
                  {tok.kind === 'url' ? shortUrl(tok.value) : tok.value}
                </bdi>
              </a>
            );
          })}
        </p>
      ))}
    </>
  );
}

/** Clamped to `lines` with a "more"/"less" toggle that only appears when the text actually overflows. */
export function ExpandableText({
  text,
  platform,
  lines = 3,
  className,
}: {
  text: string;
  platform: LinkPlatform;
  lines?: 3 | 4 | 6;
  className?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  const clamp = { 3: 'line-clamp-3', 4: 'line-clamp-4', 6: 'line-clamp-6' }[lines];
  return (
    <div className={className}>
      <div ref={ref} className={cx('space-y-2 text-[15px] leading-relaxed text-ink', !expanded && clamp)}>
        <LinkifiedText text={text} platform={platform} />
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="-ms-2 mt-0.5 min-h-11 rounded-lg px-2 text-sm font-semibold text-muted hover:text-ink"
        >
          {expanded ? t.news.less : t.news.more}
        </button>
      )}
    </div>
  );
}

// ---------- links ----------

export function ExternalButton({
  href,
  icon,
  children,
  tone = 'soft',
  className,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  tone?: 'soft' | 'outline' | 'primary';
  className?: string | undefined;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
      className={cx(
        'inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors',
        tone === 'soft' && 'bg-primary-soft text-on-primary-soft hover:bg-surface-3',
        tone === 'outline' && 'border border-line text-ink hover:bg-surface-2',
        tone === 'primary' && 'bg-primary text-on-primary hover:opacity-90',
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </a>
  );
}

// ---------- media ----------

/** An <img> that degrades to a tinted block (re-hosted media may still 404 on a bad sync). */
export function MediaImage({
  src,
  alt,
  className,
  loading = 'lazy',
  fallback,
  onLoad,
}: {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  fallback?: ReactNode;
  /** Gets the loaded element (e.g. to read its natural size). */
  onLoad?: ((img: HTMLImageElement) => void) | undefined;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return fallback ?? <div aria-hidden="true" className={cx('bg-surface-2', className)} />;
  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      onLoad={onLoad ? (e) => onLoad(e.currentTarget) : undefined}
      className={className}
    />
  );
}
