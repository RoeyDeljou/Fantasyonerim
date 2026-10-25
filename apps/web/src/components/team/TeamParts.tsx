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
import { Badge, Card, IconButton, SectionTitle, Skeleton, cx } from '../ui';
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
}: {
  entry: EntrySummary | undefined;
  picks: EntryPicks;
  pointsOverride?: ReactNode;
}) {
  const { t, f } = useI18n();
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-extrabold text-ink">{entry?.teamName ?? '—'}</h1>
          <p className="truncate text-sm text-muted">{entry?.managerName ?? ''}</p>
          {picks.activeChip && (
            <Badge tone="accent" className="mt-2">
              {chipName(t, picks.activeChip)}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center rounded-2xl bg-primary px-4 py-2 text-on-primary">
          <span className="text-3xl leading-none font-extrabold tabular">
            {pointsOverride ?? picks.points}
          </span>
          <span className="mt-1 text-[11px] font-semibold opacity-90">{t.myTeam.gwPoints}</span>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-3">
        <StatCell label={t.myTeam.overallRank} value={f.rank(picks.overallRank ?? entry?.overallRank)} />
        <StatCell label={t.myTeam.gwRank} value={f.rank(picks.rankInGameweek)} />
        <StatCell label={t.myTeam.totalPoints} value={entry ? f.num(entry.overallPoints) : '—'} />
        <StatCell label={t.myTeam.bank} value={f.price(picks.bank)} />
        <StatCell label={t.myTeam.value} value={f.price(picks.value)} />
        <StatCell
          label={t.myTeam.transfers}
          value={
            <>
              {f.num(picks.transfersMade)}
              <span
                className={cx(
                  'ms-1 text-xs font-semibold',
                  picks.transfersCost > 0 ? 'text-live' : 'text-muted',
                )}
              >
                {picks.transfersCost > 0 ? `(−${picks.transfersCost})` : `(${t.myTeam.noHits})`}
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
  onChange,
}: {
  value: Gameweek;
  max: Gameweek;
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
      <span className="text-base font-bold text-ink" aria-live="polite">
        {fmt(t.common.gw, { gw: value })}
      </span>
      <IconButton label={t.myTeam.nextGw} disabled={value >= max} onClick={() => go(value + 1)}>
        <ChevronEndIcon />
      </IconButton>
    </div>
  );
}

const MAIN_CHIPS: readonly Chip[] = ['wildcard', 'freehit', 'bboost', '3xc'];

/** Chips used / available. Renders exactly what `chipsUsed` reports — no assumption about how many exist. */
export function ChipsPanel({ picks }: { picks: EntryPicks }) {
  const { t } = useI18n();
  const extra = [...new Set(picks.chipsUsed.map((c) => c.chip))].filter((c) => !MAIN_CHIPS.includes(c));
  const chips = [...MAIN_CHIPS, ...extra];
  return (
    <Card>
      <SectionTitle>{t.myTeam.chipsTitle}</SectionTitle>
      <ul className="grid grid-cols-2 gap-2">
        {chips.map((chip) => {
          const uses = picks.chipsUsed.filter((c) => c.chip === chip).sort((a, b) => a.event - b.event);
          const active = picks.activeChip === chip;
          return (
            <li
              key={chip}
              className={cx(
                'flex min-h-16 flex-col justify-center gap-1 rounded-xl border px-3 py-2',
                active ? 'border-primary bg-primary-soft' : 'border-line bg-surface-2',
              )}
            >
              <span className="text-sm font-bold text-ink">{chipName(t, chip)}</span>
              {active && <Badge tone="primary">{t.myTeam.chipActive}</Badge>}
              {uses.length === 0 && !active && (
                <span className="text-xs font-medium text-success">{t.myTeam.chipAvailable}</span>
              )}
              {uses.map((u) => (
                <span key={u.event} className="text-xs text-muted">
                  {fmt(t.myTeam.chipUsed, { gw: u.event })}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
