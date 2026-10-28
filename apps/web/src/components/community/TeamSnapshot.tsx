'use client';

import { useMemo } from 'react';
import type { Chip, FplEntryId, FplPlayerId, Gameweek, LivePick, Pick } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useEntryLive, useFplIndex } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { ShirtIcon } from '@/components/icons';
import { Pitch } from '@/components/team/Pitch';
import { ChipIcon } from '@/components/team/ChipIcon';
import { Card, Num, Skeleton, cx } from '@/components/ui';

/** What a team preview needs — a `TeamSnapshot` from a post, or picks + entry while composing. */
export interface TeamView {
  entryId: FplEntryId;
  event: Gameweek;
  teamName: string;
  managerName: string;
  points: number;
  overallRank: number | null;
  activeChip: Chip | null;
  picks: readonly Pick[];
}

function Summary({ team, large = false }: { team: TeamView; large?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cx(
          'flex shrink-0 items-center justify-center rounded-xl bg-primary-soft text-on-primary-soft',
          large ? 'size-11' : 'size-9',
        )}
      >
        <ShirtIcon size={large ? 22 : 18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <bdi dir="auto" className={cx('truncate font-bold text-ink', large ? 'text-lg' : 'text-sm')}>
          {team.teamName}
        </bdi>
        <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted">
          <bdi dir="auto" className="truncate">
            {team.managerName}
          </bdi>
          {team.activeChip && <ChipIcon chip={team.activeChip} />}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-center rounded-xl bg-primary px-2.5 py-1 text-on-primary">
        <span className={cx('leading-none font-extrabold tabular', large ? 'text-2xl' : 'text-lg')}>
          <Num value={team.points} />
        </span>
        <span className="mt-0.5 text-[10px] font-semibold opacity-90">
          {fmt(t.community.teamGw, { gw: team.event })}
        </span>
      </div>
    </div>
  );
}

/** Compact read-only pitch (XI + bench, C/V, chip, GW + points). Tapping opens the full snapshot sheet. */
export function TeamPreview({ team, onOpen }: { team: TeamView; onOpen?: (() => void) | undefined }) {
  const { t } = useI18n();
  const { index } = useFplIndex();
  const body = (
    <>
      <Summary team={team} />
      {index ? (
        <Pitch picks={team.picks} index={index} renderLabel={() => null} compact />
      ) : (
        <Skeleton className="h-52" />
      )}
    </>
  );
  const cls = 'flex w-full flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-2.5 text-start';
  if (!onOpen) {
    return (
      <div className={cls} data-testid="team-preview">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={fmt(t.community.openTeam, { name: team.teamName })}
      className={cx(cls, 'transition-colors hover:bg-surface-3')}
      data-testid="team-preview"
    >
      {body}
    </button>
  );
}

/** ManagerSheet-style full view of a shared snapshot. Per-player points come from that GW's live data. */
export function SnapshotSheet({ team, open, onClose }: { team: TeamView; open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const { index } = useFplIndex();
  return (
    <BottomSheet open={open} onClose={onClose} title={fmt(t.community.teamOf, { name: team.managerName })}>
      {open && (index ? <SnapshotBody team={team} index={index} /> : <Skeleton className="h-96" />)}
    </BottomSheet>
  );
}

function SnapshotBody({ team, index }: { team: TeamView; index: FplIndex }) {
  const { t } = useI18n();
  const live = useEntryLive(team.entryId, team.event, false);
  const byPlayer = useMemo(
    () =>
      live.data ? new Map<FplPlayerId, LivePick>(live.data.picks.map((p) => [p.playerId, p])) : undefined,
    [live.data],
  );
  return (
    <div className="flex flex-col gap-3" data-testid="snapshot-sheet">
      <Card className="flex flex-col gap-3">
        <Summary team={team} large />
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex flex-col rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">{t.myTeam.overallRank}</dt>
            <dd className="font-bold text-ink">
              <Num value={team.overallRank} />
            </dd>
          </div>
          <div className="flex flex-col rounded-xl bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">{t.myTeam.gwPoints}</dt>
            <dd className="font-bold text-ink">
              <Num value={team.points} />
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted">{t.community.snapshotNote}</p>
      </Card>
      <Pitch
        picks={team.picks}
        index={index}
        renderLabel={(pick, player) => {
          const lp = byPlayer?.get(pick.playerId);
          if (lp && (lp.fixtureStatus === 'live' || lp.fixtureStatus === 'finished'))
            return lp.effectiveMultiplier === 0 ? lp.basePoints : lp.points;
          const team = player ? index.teams.get(player.teamId) : undefined;
          return team?.shortName ?? '—';
        }}
      />
    </div>
  );
}
