'use client';

import { useState } from 'react';
import type { Fixture, FplEntryId, Gameweek, LivePick } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useEntryLive, useFixtures, useLivePollInterval } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { ImageWithFallback, fplImage } from '../FplImages';
import { ClockIcon, ShirtIcon, SubInIcon, SubOutIcon } from '../icons';
import { Badge, Card, EmptyState, ErrorState, LiveDot, Num, SectionTitle, Skeleton, cx } from '../ui';
import { BonusBadge } from './BonusBadge';
import { ChipIcon } from './ChipIcon';
import { Pitch } from './Pitch';
import { PlayerSheet } from './PlayerSheet';
import { fixtureStatusText, opponentText } from './fixtureText';

/** My Team → Live: live GW points with auto-subs, provisional bonus and per-player status. */
export function LiveTeamView({
  entryId,
  event,
  index,
}: {
  entryId: FplEntryId;
  event: Gameweek;
  index: FplIndex;
}) {
  const { t, f } = useI18n();
  const { interval, isLive } = useLivePollInterval();
  const live = useEntryLive(entryId, event, interval);
  const fixtures = useFixtures(event);
  const [selected, setSelected] = useState<LivePick | null>(null);

  const d = live.data;
  if (!d && !live.isError) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-busy="true">
        <Skeleton className="h-40" />
        <Skeleton className="h-[28rem]" />
      </div>
    );
  }
  if (!d) {
    if (isApiError(live.error, 'not_found')) {
      return <EmptyState icon={<ShirtIcon width={32} height={32} />} title={t.myTeam.noData} />;
    }
    return <ErrorState error={live.error} onRetry={() => live.refetch()} />;
  }

  const sorted = [...d.picks].sort((a, b) => a.slot - b.slot);

  return (
    <>
      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="flex items-center gap-2 text-sm font-semibold text-muted">
              {isLive && <LiveDot />}
              {fmt(t.common.gw, { gw: d.event })} · {t.live.livePoints}
            </span>
            <span className="text-6xl leading-none font-extrabold text-primary tabular" aria-live="polite">
              <Num value={d.livePoints} />
            </span>
          </div>
          <div className="flex flex-col items-end gap-1 text-end">
            {d.activeChip && <ChipIcon chip={d.activeChip} withName size="md" />}
            {d.liveTotal !== null && (
              <span className="text-sm text-muted">
                {t.live.liveTotal}: <Num value={d.liveTotal} className="font-bold text-ink" />
              </span>
            )}
            {d.transfersCost > 0 && (
              <span className="text-sm font-semibold text-live tabular">
                {t.myTeam.hits} <Num value={-d.transfersCost} />
              </span>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-surface-2 py-2">
            <dt className="text-xs text-muted">{t.live.played}</dt>
            <dd className="text-lg font-bold">
              <Num value={d.playersPlayed} />
            </dd>
          </div>
          <div className="rounded-xl bg-surface-2 py-2">
            <dt className="text-xs text-muted">{t.live.yetToPlay}</dt>
            <dd className="text-lg font-bold">
              <Num value={d.playersYetToPlay} />
            </dd>
          </div>
          <div className="rounded-xl bg-surface-2 py-2">
            <dt className="text-xs text-muted">{t.live.benchPts}</dt>
            <dd className="text-lg font-bold">
              <Num value={d.benchPoints} />
            </dd>
          </div>
        </dl>
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <ClockIcon width={14} height={14} />
          {fmt(t.common.updatedAt, { time: f.time(d.updatedAt) })}
          {isLive && <> · {t.live.pollingLive}</>}
        </p>
        {!isLive && d.playersPlayed === 0 && <p className="text-sm text-muted">{t.live.nothingLive}</p>}
      </Card>

      <Pitch
        picks={d.picks}
        index={index}
        onSelect={setSelected}
        renderLabel={(p, player) =>
          p.fixtureStatus === 'not_started' || p.fixtureStatus === 'no_fixture'
            ? ((player && opponentText(player.teamId, fixtures.data, index.teams, t)) ?? '—')
            : p.effectiveMultiplier === 0
              ? p.basePoints
              : p.points
        }
      />

      <Card className="p-0">
        <div className="px-4 pt-4">
          <SectionTitle>{t.live.playersList}</SectionTitle>
        </div>
        <ul className="divide-y divide-line">
          {sorted.map((p) => (
            <LivePlayerRow
              key={p.playerId}
              pick={p}
              index={index}
              fixtures={fixtures.data}
              onSelect={() => setSelected(p)}
            />
          ))}
        </ul>
      </Card>

      <PlayerSheet pick={selected} index={index} fixtures={fixtures.data} onClose={() => setSelected(null)} />
    </>
  );
}

function LivePlayerRow({
  pick,
  index,
  fixtures,
  onSelect,
}: {
  pick: LivePick;
  index: FplIndex;
  fixtures: readonly Fixture[] | undefined;
  onSelect(): void;
}) {
  const { t, f } = useI18n();
  const player = index.players.get(pick.playerId);
  const team = player ? index.teams.get(player.teamId) : undefined;
  const bench = pick.slot > 11;
  const status = fixtureStatusText(pick, t, f, player?.teamId, fixtures);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cx(
          'flex min-h-14 w-full items-center gap-3 px-4 py-2 text-start hover:bg-surface-2',
          bench && !pick.autoSubIn && 'bg-surface-2/50',
          pick.autoSubOut && 'opacity-60',
        )}
      >
        {team ? (
          <ImageWithFallback
            src={fplImage.shirt(team.code, player?.position === 'GKP')}
            name={team.shortName}
            fallbackText={team.shortName}
            className="h-9 w-8 shrink-0"
            fallbackClassName="size-8 text-[10px]"
          />
        ) : (
          <span className="size-8 shrink-0" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span dir="auto" className="name-start truncate font-semibold text-ink">
              {player?.webName ?? '?'}
            </span>
            {pick.isCaptain && (
              <Badge tone="primary" className="px-1.5">
                {pick.multiplier === 3 ? 'TC' : 'C'}
              </Badge>
            )}
            {pick.isViceCaptain && (
              <Badge tone="neutral" className="px-1.5">
                V
              </Badge>
            )}
            {pick.autoSubIn && (
              <span className="text-success" aria-label={t.live.autoSubIn} title={t.live.autoSubIn}>
                <SubInIcon width={16} height={16} strokeWidth={2.6} />
              </span>
            )}
            {pick.autoSubOut && (
              <span className="text-live" aria-label={t.live.autoSubOut} title={t.live.autoSubOut}>
                <SubOutIcon width={16} height={16} strokeWidth={2.6} />
              </span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
            {team && <span>{team.shortName}</span>}
            <span className={cx(pick.fixtureStatus === 'live' && 'font-semibold text-live')}>
              {pick.fixtureStatus === 'live' && <LiveDot className="me-1 align-middle" />}
              <bdi>{status}</bdi>
            </span>
            {(pick.fixtureStatus === 'live' || pick.fixtureStatus === 'finished') && (
              <span>· {fmt(t.live.minutesPlayed, { n: f.num(pick.minutes) })}</span>
            )}
            <BonusBadge n={pick.bonus} confirmed={pick.bonusConfirmed} />
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="text-lg font-extrabold text-ink">
            <Num value={pick.effectiveMultiplier === 0 ? pick.basePoints : pick.points} />
          </span>
          {pick.effectiveMultiplier > 1 && (
            <bdi dir="ltr" className="text-[11px] text-muted tabular">
              {f.num(pick.basePoints)} ×{pick.effectiveMultiplier}
            </bdi>
          )}
        </span>
      </button>
    </li>
  );
}
