'use client';

import type { ReactNode } from 'react';
import type { FplPlayerId, LivePick, Pick, Player, PlTeam, Position } from '@fant/shared';
import { fmt, useT } from '@/i18n';
import type { FplIndex } from '@/lib/queries';
import { ImageWithFallback, fplImage } from '../FplImages';
import { SubInIcon, SubOutIcon } from '../icons';
import { Num, cx } from '../ui';
import { isLivePick } from './fixtureText';

const ROWS: readonly Position[] = ['GKP', 'DEF', 'MID', 'FWD'];

export interface PitchProps<P extends Pick | LivePick> {
  picks: readonly P[];
  index: FplIndex;
  /** Under-name label: points once the fixture started, otherwise the opponent. */
  renderLabel(pick: P, player: Player | undefined): ReactNode;
  onSelect?: ((pick: P) => void) | undefined;
  /** Live data for plain picks (My Team view) — drives the bonus / auto-sub badges. */
  liveByPlayer?: Map<FplPlayerId, LivePick> | undefined;
  /** Small read-only variant (Community post previews): smaller shirts, tighter rows. */
  compact?: boolean | undefined;
}

/** Stylized pitch (CSS stripes + SVG markings in theme colours) with the XI in formation rows and the bench. */
export function Pitch<P extends Pick | LivePick>({
  picks,
  index,
  renderLabel,
  onSelect,
  liveByPlayer,
  compact = false,
}: PitchProps<P>) {
  const t = useT();
  const sorted = [...picks].sort((a, b) => a.slot - b.slot);
  const xi = sorted.filter((p) => p.slot <= 11);
  const bench = sorted.filter((p) => p.slot > 11);
  const rows = ROWS.map((pos) => xi.filter((p) => index.players.get(p.playerId)?.position === pos)).filter(
    (r) => r.length > 0,
  );

  const token = (p: P, onBench: boolean) => (
    <PlayerToken
      key={p.playerId}
      pick={p}
      player={index.players.get(p.playerId)}
      team={(() => {
        const pl = index.players.get(p.playerId);
        return pl ? index.teams.get(pl.teamId) : undefined;
      })()}
      label={renderLabel(p, index.players.get(p.playerId))}
      onBench={onBench}
      onSelect={onSelect}
      liveByPlayer={liveByPlayer}
      compact={compact}
    />
  );

  return (
    <div
      className={cx('overflow-hidden border border-line', compact ? 'rounded-xl' : 'rounded-2xl shadow-card')}
    >
      <div
        className={cx('relative px-1', compact ? 'pt-2 pb-2.5' : 'pt-3 pb-4')}
        style={{
          background: 'repeating-linear-gradient(180deg, var(--pitch-a) 0 12.5%, var(--pitch-b) 12.5% 25%)',
        }}
      >
        <PitchMarkings />
        <div className={cx('relative flex flex-col', compact ? 'gap-1.5' : 'gap-3')}>
          {rows.map((row, i) => (
            <div key={i} className="flex justify-evenly">
              {row.map((p) => token(p, false))}
            </div>
          ))}
        </div>
      </div>
      {bench.length > 0 && (
        <div className={cx('bg-bench px-1', compact ? 'pt-1 pb-2' : 'pt-2 pb-3')}>
          <p
            className={cx(
              'text-center font-bold tracking-wide text-muted uppercase',
              compact ? 'text-[10px]' : 'mb-1 text-xs',
            )}
          >
            {t.myTeam.bench}
          </p>
          <div className="flex justify-evenly">
            {bench.map((p) => (
              <div key={p.playerId} className="flex w-[22%] max-w-[4.75rem] min-w-0 flex-col items-center">
                {!compact && (
                  <span className="mb-0.5 text-[10px] font-bold text-muted tabular">
                    {p.slot === 12 ? 'GK' : p.slot - 12}
                  </span>
                )}
                {token(p, true)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PitchMarkings() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      viewBox="0 0 100 140"
      preserveAspectRatio="none"
      fill="none"
      stroke="var(--pitch-line)"
      strokeWidth="0.6"
      vectorEffect="non-scaling-stroke"
    >
      <rect x="3" y="2" width="94" height="136" vectorEffect="non-scaling-stroke" />
      <rect x="25" y="2" width="50" height="20" vectorEffect="non-scaling-stroke" />
      <rect x="38" y="2" width="24" height="8" vectorEffect="non-scaling-stroke" />
      <path d="M40 22 a10 7 0 0 0 20 0" vectorEffect="non-scaling-stroke" />
      <line x1="3" y1="138" x2="97" y2="138" vectorEffect="non-scaling-stroke" />
      <path d="M35 138 a15 11 0 0 1 30 0" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function PlayerToken<P extends Pick | LivePick>({
  pick,
  player,
  team,
  label,
  onBench,
  onSelect,
  liveByPlayer,
  compact,
}: {
  compact: boolean;
  liveByPlayer: Map<FplPlayerId, LivePick> | undefined;
  pick: P;
  player: Player | undefined;
  team: PlTeam | undefined;
  label: ReactNode;
  onBench: boolean;
  onSelect?: ((pick: P) => void) | undefined;
}) {
  const t = useT();
  const name = player?.webName ?? '?';
  const live = isLivePick(pick) ? pick : (liveByPlayer?.get(pick.playerId) ?? null);
  const flagged = player && player.status !== 'a';
  const content = (
    <>
      <span className="relative block">
        {team ? (
          <ImageWithFallback
            src={fplImage.shirt(team.code, player?.position === 'GKP')}
            name={team.shortName}
            fallbackText={team.shortName}
            className={compact ? 'h-8 w-7 drop-shadow' : 'h-11 w-10 drop-shadow'}
            fallbackClassName={compact ? 'size-7 text-[9px]' : 'size-10 text-xs'}
          />
        ) : (
          <span className={cx('block', compact ? 'h-8 w-7' : 'h-11 w-10')} />
        )}
        {(pick.isCaptain || pick.isViceCaptain) && (
          <span
            aria-label={pick.isCaptain ? t.myTeam.captain : t.myTeam.vice}
            className={cx(
              'absolute -top-1 -end-2 flex items-center justify-center rounded-full font-extrabold ring-2 ring-surface',
              compact ? 'size-4 text-[8px]' : 'size-5 text-[10px]',
              pick.isCaptain ? 'bg-primary text-on-primary' : 'bg-surface text-ink',
            )}
          >
            {pick.isCaptain ? (pick.multiplier === 3 ? '3×' : 'C') : 'V'}
          </span>
        )}
        {flagged && (
          <span
            aria-hidden="true"
            className={cx(
              'absolute -top-1 -start-2 size-3 rounded-full ring-2 ring-surface',
              player.status === 'd' ? 'bg-warning' : 'bg-live',
            )}
          />
        )}
        {live && live.bonus > 0 && (
          <span
            title={fmt(live.bonusConfirmed ? t.live.bonus : t.live.provBonus, { n: live.bonus })}
            className={cx(
              'absolute -bottom-1 -end-2 rounded-full px-1 text-[10px] leading-4 font-extrabold ring-2 ring-surface',
              live.bonusConfirmed
                ? 'bg-success text-surface'
                : 'border border-dashed border-warning bg-warning-soft text-warning',
            )}
          >
            <bdi dir="ltr">+{live.bonus}</bdi>
          </span>
        )}
        {live?.autoSubIn && (
          <span
            aria-label={t.live.autoSubIn}
            className="absolute -bottom-1 -start-2 rounded-full bg-success p-0.5 text-surface"
          >
            <SubInIcon width={12} height={12} strokeWidth={3} />
          </span>
        )}
        {live?.autoSubOut && (
          <span
            aria-label={t.live.autoSubOut}
            className="absolute -bottom-1 -start-2 rounded-full bg-live p-0.5 text-surface"
          >
            <SubOutIcon width={12} height={12} strokeWidth={3} />
          </span>
        )}
      </span>
      <span
        dir="auto"
        className={cx(
          'mt-0.5 block w-full truncate bg-chip-label px-0.5 text-center font-semibold text-pitch-ink',
          compact ? 'rounded-md text-[9px] leading-4' : 'rounded-t-md text-[11px] leading-5',
        )}
      >
        {name}
      </span>
      {!compact && (
        <span
          dir="auto"
          className={cx(
            'block w-full truncate rounded-b-md px-1 text-center text-[11px] leading-5 font-bold tabular',
            onBench ? 'bg-surface-3 text-ink' : 'bg-primary text-on-primary',
          )}
        >
          {typeof label === 'number' ? <Num value={label} /> : label}
        </span>
      )}
    </>
  );
  const cls = cx(
    'flex min-w-0 flex-col items-center',
    onBench ? 'w-full' : 'w-[19%] max-w-[4.75rem]',
    live?.autoSubOut && 'opacity-60',
  );
  if (!onSelect) return <div className={cls}>{content}</div>;
  return (
    <button
      type="button"
      data-testid="pitch-player"
      className={cx(cls, 'rounded-lg focus-visible:outline-offset-1')}
      onClick={() => onSelect(pick)}
    >
      {content}
    </button>
  );
}
