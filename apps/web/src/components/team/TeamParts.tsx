'use client';

import type { ReactNode } from 'react';
import type {
  Chip,
  EntryPicks,
  EntrySummary,
  Fixture,
  FplPlayerId,
  Gameweek,
  LivePick,
  Pick,
  Player,
} from '@fant/shared';
import { GameweekSchema } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import type { FplIndex } from '@/lib/queries';
import { ChevronEndIcon, ChevronStartIcon } from '../icons';
import { Badge, Card, IconButton, Ltr, Num, SectionTitle, Skeleton, cx } from '../ui';
import { ChipIcon } from './ChipIcon';
import { opponentText } from './fixtureText';

export function chipName(t: Messages, chip: Chip): string {
  return t.chips[chip];
}

/** Pitch label: points once the fixture has kicked off, otherwise the opponent ("ARS (H)"). */
export function pitchLabel(
  pick: Pick | LivePick,
  player: Player | undefined,
  liveByPlayer: Map<FplPlayerId, LivePick> | undefined,
  fixtures: readonly Fixture[] | undefined,
  index: FplIndex,
  t: Messages,
): ReactNode {
  const live = liveByPlayer?.get(pick.playerId);
  if (live && (live.fixtureStatus === 'live' || live.fixtureStatus === 'finished')) {
    // Bench players show what they scored (effective multiplier 0 unless Bench Boost / auto-sub).
    return live.effectiveMultiplier === 0 ? live.basePoints : live.points;
  }
  if (!player) return '—';
  return opponentText(player.teamId, fixtures, index.teams, t) ?? '—';
}

function StatCell({ label, value, tone }: { label: string; value: ReactNode; tone?: 'live' | undefined }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="truncate text-xs text-muted">{label}</dt>
      <dd className={cx('truncate text-base font-bold tabular', tone === 'live' ? 'text-live' : 'text-ink')}>
        {value}
      </dd>
    </div>
  );
}

export function TeamHeader({
  entry,
  picks,
  pointsOverride,
  total,
}: {
  entry: EntrySummary | undefined;
  picks: EntryPicks;
  /** Live GW points (current GW) — otherwise the official `picks.points`. */
  pointsOverride?: number | undefined;
  /** Season total as of the GW shown (EntryLive.liveTotal for that GW), so all numbers describe one GW. */
  total: number | null | undefined;
}) {
  const { t, f } = useI18n();
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 dir="auto" className="name-start truncate text-xl font-extrabold text-ink">
            {entry?.teamName ?? '—'}
          </h1>
          <p dir="auto" className="name-start truncate text-sm text-muted">
            {entry?.managerName ?? ''}
          </p>
          {picks.activeChip && <ChipIcon chip={picks.activeChip} withName size="md" className="mt-2" />}
        </div>
        <div className="flex shrink-0 flex-col items-center rounded-2xl bg-primary px-4 py-2 text-on-primary">
          <span className="text-3xl leading-none font-extrabold tabular">
            <Num value={pointsOverride ?? picks.points} />
          </span>
          <span className="mt-1 text-[11px] font-semibold opacity-90">{t.myTeam.gwPoints}</span>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-3">
        <StatCell label={t.myTeam.overallRank} value={<Num value={picks.overallRank} />} />
        <StatCell label={t.myTeam.gwRank} value={<Num value={picks.rankInGameweek} />} />
        <StatCell label={t.myTeam.totalPoints} value={<Num value={total} />} />
        <StatCell label={t.myTeam.bank} value={<Ltr>{f.price(picks.bank)}</Ltr>} />
        <StatCell label={t.myTeam.value} value={<Ltr>{f.price(picks.value)}</Ltr>} />
        <StatCell
          label={t.myTeam.transfers}
          value={
            <>
              <Num value={picks.transfersMade} />
              <span
                className={cx(
                  'ms-1 text-xs font-semibold',
                  picks.transfersCost > 0 ? 'text-live' : 'text-muted',
                )}
              >
                {picks.transfersCost > 0 ? <Num value={-picks.transfersCost} /> : t.myTeam.noHits}
              </span>
            </>
          }
        />
      </dl>
    </Card>
  );
}

export function TeamHeaderSkeleton() {
  return <Skeleton className="h-44 rounded-2xl" />;
}

export function GwSelector({
  value,
  max,
  chip,
  onChange,
}: {
  value: Gameweek;
  max: Gameweek;
  /** The chip played in the GW shown (marked next to the GW name). */
  chip?: Chip | null | undefined;
  onChange(gw: Gameweek): void;
}) {
  const { t } = useI18n();
  const go = (n: number) => {
    const parsed = GameweekSchema.safeParse(n);
    if (parsed.success && n <= max) onChange(parsed.data);
  };
  return (
    <div className="flex items-center justify-between rounded-2xl border border-line bg-surface px-1 py-1">
      <IconButton label={t.myTeam.prevGw} disabled={value <= 1} onClick={() => go(value - 1)}>
        <ChevronStartIcon />
      </IconButton>
      <span className="flex items-center gap-2 text-base font-bold text-ink" aria-live="polite">
        {fmt(t.common.gw, { gw: value })}
        {chip && <ChipIcon chip={chip} gw={value} />}
      </span>
      <IconButton label={t.myTeam.nextGw} disabled={value >= max} onClick={() => go(value + 1)}>
        <ChevronEndIcon />
      </IconButton>
    </div>
  );
}

const MAIN_CHIPS: readonly Chip[] = ['wildcard', 'freehit', 'bboost', '3xc'];
/** 2025/26: every chip exists twice — one set for GW1–19, one for GW20–38. */
const HALVES = [
  { from: 1, to: 19 },
  { from: 20, to: 38 },
] as const;

type HalfState =
  | { kind: 'used'; gw: number }
  | { kind: 'active' }
  | { kind: 'available' }
  | { kind: 'upcoming'; from: number }
  | { kind: 'expired' };

/** Chips per half-season: used in GW X / active / available / from GW20 / expired. */
export function ChipsPanel({ picks, currentGw }: { picks: EntryPicks; currentGw: Gameweek }) {
  const { t } = useI18n();
  const extra = [...new Set(picks.chipsUsed.map((c) => c.chip))].filter((c) => !MAIN_CHIPS.includes(c));
  const used = [...picks.chipsUsed].sort((x, y) => x.event - y.event);

  const stateOf = (chip: Chip, half: (typeof HALVES)[number]): HalfState => {
    const use = picks.chipsUsed.find((c) => c.chip === chip && c.event >= half.from && c.event <= half.to);
    if (use)
      return picks.activeChip === chip && use.event === picks.event
        ? { kind: 'active' }
        : { kind: 'used', gw: use.event };
    if (picks.activeChip === chip && picks.event >= half.from && picks.event <= half.to)
      return { kind: 'active' };
    if (currentGw < half.from) return { kind: 'upcoming', from: half.from };
    if (currentGw > half.to) return { kind: 'expired' };
    return { kind: 'available' };
  };

  const stateText = (s: HalfState) => {
    switch (s.kind) {
      case 'used':
        return <span className="text-muted">{fmt(t.myTeam.chipUsed, { gw: s.gw })}</span>;
      case 'active':
        return <Badge tone="primary">{t.myTeam.chipActive}</Badge>;
      case 'available':
        return <span className="font-semibold text-success">{t.myTeam.chipAvailable}</span>;
      case 'upcoming':
        return <span className="text-muted">{fmt(t.myTeam.chipFrom, { gw: s.from })}</span>;
      case 'expired':
        return <span className="text-muted line-through decoration-1">{t.myTeam.chipExpired}</span>;
    }
  };

  return (
    <Card>
      <SectionTitle>{t.myTeam.chipsTitle}</SectionTitle>
      {used.length > 0 && (
        <ul
          className="mb-3 flex flex-wrap gap-1.5"
          data-testid="chips-used"
          aria-label={t.chipIcon.usedLabel}
        >
          {used.map((u) => (
            <li
              key={`${u.chip}-${u.event}`}
              className="inline-flex min-h-7 items-center gap-1 rounded-full bg-surface-2 ps-1 pe-2 text-xs font-semibold text-muted"
            >
              <ChipIcon chip={u.chip} gw={u.event} />
              <span aria-hidden="true">{fmt(t.chipIcon.gwShort, { gw: u.event })}</span>
            </li>
          ))}
        </ul>
      )}
      <ul className="grid grid-cols-2 gap-2">
        {MAIN_CHIPS.map((chip) => {
          const states = HALVES.map((h) => stateOf(chip, h));
          const active = states.some((s) => s.kind === 'active');
          return (
            <li
              key={chip}
              className={cx(
                'flex flex-col gap-1.5 rounded-xl border px-3 py-2',
                active ? 'border-primary bg-primary-soft' : 'border-line bg-surface-2',
              )}
            >
              <ChipIcon chip={chip} withName />
              {HALVES.map((h, i) => (
                <span key={h.from} className="flex flex-col text-xs leading-tight">
                  <span className="text-[10px] text-muted">
                    {i === 0 ? t.myTeam.chipHalf1 : t.myTeam.chipHalf2}
                  </span>
                  {stateText(states[i] ?? { kind: 'available' })}
                </span>
              ))}
            </li>
          );
        })}
        {extra.map((chip) => (
          <li key={chip} className="flex flex-col gap-1 rounded-xl border border-line bg-surface-2 px-3 py-2">
            <ChipIcon chip={chip} withName />
            {picks.chipsUsed
              .filter((c) => c.chip === chip)
              .map((u) => (
                <span key={u.event} className="text-xs text-muted">
                  {fmt(t.myTeam.chipUsed, { gw: u.event })}
                </span>
              ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}
