'use client';

import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { NewsFilter } from '@fant/shared';
import { useI18n } from '@/i18n';
import type { NewsFilterPref } from '@/lib/localState';
import { cx } from '@/components/ui';
import { SourceBadge, filterKind } from './SourceBadge';

/** Scrolls the row sideways only (never the page) so `el` is fully visible. */
function reveal(row: HTMLElement, el: HTMLElement) {
  const r = row.getBoundingClientRect();
  const c = el.getBoundingClientRect();
  const pad = 16;
  if (c.left < r.left + pad) row.scrollBy({ left: c.left - r.left - pad });
  else if (c.right > r.right - pad) row.scrollBy({ left: c.right - r.right + pad });
}

/**
 * The News filter row: "All" + the chips the API says have content. Scrolls sideways inside itself (never the
 * page); in RTL the row starts at the right like the rest of the layout. Arrow keys / Home / End move between
 * chips (visual order, so RTL-correct), Enter / Space select.
 */
export function FilterChips({
  filters,
  value,
  onChange,
}: {
  filters: readonly NewsFilter[];
  value: NewsFilterPref;
  onChange(f: NewsFilterPref): void;
}) {
  const { t, dir } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  const options: NewsFilterPref[] = ['all', ...filters];

  // Keep the selected chip visible (e.g. restored "Updates" at the far end of the row).
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('[aria-pressed=true]');
    if (row.current && el) reveal(row.current, el);
  }, [value, filters.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const chips = Array.from(row.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const i = chips.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === forward) next = Math.min(i + 1, chips.length - 1);
    else if (e.key === back) next = Math.max(i - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = chips.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const chip = chips[next];
    if (!chip || !row.current) return;
    chip.focus({ preventScroll: true });
    reveal(row.current, chip);
  };

  return (
    <div
      ref={row}
      role="toolbar"
      aria-label={t.news.filtersLabel}
      onKeyDown={onKeyDown}
      data-testid="news-filters"
      className="no-scrollbar -mx-4 flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 py-0.5"
    >
      {options.map((f) => {
        const active = f === value;
        return (
          <button
            key={f}
            type="button"
            aria-pressed={active}
            data-filter={f}
            onClick={() => onChange(f)}
            className={cx(
              'inline-flex min-h-11 shrink-0 snap-start items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold whitespace-nowrap transition-colors',
              active
                ? 'border-primary bg-primary text-on-primary'
                : 'border-line bg-surface text-ink hover:bg-surface-2',
            )}
          >
            {f !== 'all' && <SourceBadge kind={filterKind(f)} size={20} />}
            {t.news[`filter_${f}`]}
          </button>
        );
      })}
    </div>
  );
}
