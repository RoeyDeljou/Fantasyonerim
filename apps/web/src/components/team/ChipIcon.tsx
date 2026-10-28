'use client';

import type { Chip } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { cx } from '../ui';

/** FPL's own short codes — the same in Hebrew and English (that is how fans say them). */
const GLYPH: Record<Chip, string> = { wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC' };

/** One colour pair per chip, from the theme tokens (no hex here). */
const TONE: Record<Chip, string> = {
  wildcard: 'bg-primary text-on-primary',
  freehit: 'bg-accent text-on-accent ring-1 ring-inset ring-line',
  bboost: 'bg-warning-soft text-warning',
  '3xc': 'bg-live-soft text-live',
};

/**
 * The chip a manager played: a compact pill ("TC") with the localized chip name as its accessible label and
 * tooltip. `withName` also prints the name next to it (headers). `played` labels it "played in GW n".
 */
export function ChipIcon({
  chip,
  withName = false,
  size = 'sm',
  gw,
  className,
}: {
  chip: Chip;
  withName?: boolean;
  size?: 'sm' | 'md';
  /** When set, the label says the chip was played in that GW. */
  gw?: number | undefined;
  className?: string;
}) {
  const { t } = useI18n();
  const name = t.chips[chip];
  const label =
    gw === undefined ? fmt(t.chipIcon.active, { chip: name }) : fmt(t.chipIcon.played, { chip: name, gw });
  const pill = (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-md font-extrabold leading-none tracking-wide',
        size === 'sm' ? 'h-4.5 min-w-6 px-1 text-[10px]' : 'h-6 min-w-8 px-1.5 text-xs',
        TONE[chip],
      )}
      dir="ltr"
      aria-hidden={withName ? true : undefined}
    >
      {GLYPH[chip]}
    </span>
  );
  if (!withName) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className={cx('inline-flex shrink-0', className)}
        data-testid="chip-icon"
        data-chip={chip}
      >
        {pill}
      </span>
    );
  }
  return (
    <span
      title={label}
      className={cx('inline-flex shrink-0 items-center gap-1.5 text-sm font-bold text-ink', className)}
      data-testid="chip-icon"
      data-chip={chip}
    >
      {pill}
      <span>{name}</span>
    </span>
  );
}
