'use client';

import type { ReactNode } from 'react';
import type { Fixture, LivePick, Pick } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import type { FplIndex } from '@/lib/queries';
import { BottomSheet } from '../BottomSheet';
import { ImageWithFallback, fplImage } from '../FplImages';
import { Badge, Ltr, Num } from '../ui';
import { BonusBadge } from './BonusBadge';
import { fixtureStatusText, isLivePick, opponentText } from './fixtureText';

function statusText(t: Messages, s: string): string {
  switch (s) {
    case 'a':
      return t.player.statusA;
    case 'd':
      return t.player.statusD;
    case 'i':
      return t.player.statusI;
    case 's':
      return t.player.statusS;
    case 'n':
      return t.player.statusN;
    default:
      return t.player.statusU;
  }
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface-2 px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-base font-bold text-ink tabular">{value}</dd>
    </div>
  );
}

/** Bottom sheet with a player's details, plus this GW's live stats when they are available. */
export function PlayerSheet({
  pick,
  livePick,
  index,
  fixtures,
  onClose,
}: {
  pick: Pick | LivePick | null;
  livePick?: LivePick | undefined;
  index: FplIndex;
  fixtures: readonly Fixture[] | undefined;
  onClose(): void;
}) {
  const { t, f } = useI18n();
  const player = pick ? index.players.get(pick.playerId) : undefined;
  const team = player ? index.teams.get(player.teamId) : undefined;
  const live = livePick ?? (pick && isLivePick(pick) ? pick : undefined);
  const opponent = player ? opponentText(player.teamId, fixtures, index.teams, t) : null;

  return (
    <BottomSheet open={pick !== null} onClose={onClose} title={player?.webName ?? ''}>
      {player && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <ImageWithFallback
              src={fplImage.photo(player.photoCode)}
              name={`${player.firstName} ${player.secondName}`}
              className="h-24 w-20 rounded-xl bg-surface-2"
              fallbackClassName="size-20 text-2xl"
            />
            <div className="flex min-w-0 flex-col gap-1">
              <p dir="auto" className="name-start truncate text-lg font-bold text-ink">
                {player.firstName} {player.secondName}
              </p>
              <p className="text-sm text-muted">
                {team?.name ?? '—'} · {t.positions[player.position]}
              </p>
              <div className="flex flex-wrap gap-1">
                {pick?.isCaptain && <Badge tone="primary">{t.myTeam.captain}</Badge>}
                {pick?.isViceCaptain && <Badge tone="accent">{t.myTeam.vice}</Badge>}
                <Badge tone={player.status === 'a' ? 'success' : player.status === 'd' ? 'warning' : 'live'}>
                  {statusText(t, player.status)}
                </Badge>
              </div>
            </div>
          </div>

          {player.news && (
            <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">
              {player.news}
              {player.chanceOfPlayingNextRound !== null && player.status !== 'a' && (
                <> · {fmt(t.player.chance, { n: player.chanceOfPlayingNextRound })}</>
              )}
            </p>
          )}

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label={t.player.price} value={<Ltr>{f.price(player.nowCost)}</Ltr>} />
            <Stat label={t.player.form} value={<Ltr>{f.decimal(player.form)}</Ltr>} />
            <Stat label={t.player.selectedBy} value={<Ltr>{f.percent(player.selectedByPercent)}</Ltr>} />
            <Stat label={t.player.totalPoints} value={<Num value={player.totalPoints} />} />
            {opponent && <Stat label={t.player.fixture} value={<bdi>{opponent}</bdi>} />}
          </dl>

          {live && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-base font-bold">
                {t.player.thisGw}
                <Badge tone={live.fixtureStatus === 'live' ? 'live' : 'neutral'}>
                  <bdi>{fixtureStatusText(live, t, f, player.teamId, fixtures)}</bdi>
                </Badge>
              </h3>
              <dl className="grid grid-cols-3 gap-2">
                <Stat label={t.player.basePoints} value={<Num value={live.basePoints} />} />
                <Stat label={t.player.finalPoints} value={<Num value={live.points} />} />
                <Stat label={t.player.minutesPlayed} value={<Num value={live.minutes} />} />
                <Stat label={t.player.goals} value={<Num value={live.goals} />} />
                <Stat label={t.player.assists} value={<Num value={live.assists} />} />
                <Stat label={t.player.bps} value={<Num value={live.bps} />} />
                {player.position !== 'MID' && player.position !== 'FWD' && (
                  <Stat label={t.player.cleanSheet} value={live.cleanSheet ? t.common.yes : t.common.no} />
                )}
                {player.position === 'GKP' && (
                  <Stat label={t.player.saves} value={<Num value={live.saves} />} />
                )}
                {live.yellowCards > 0 && (
                  <Stat label={t.player.yellow} value={<Num value={live.yellowCards} />} />
                )}
                {live.redCards > 0 && <Stat label={t.player.red} value={<Num value={live.redCards} />} />}
              </dl>
              {live.bonus > 0 && (
                <p className="mt-2">
                  <BonusBadge n={live.bonus} confirmed={live.bonusConfirmed} />
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
