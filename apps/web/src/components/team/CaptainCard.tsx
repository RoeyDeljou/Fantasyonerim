'use client';

import type { ReactNode } from 'react';
import type { CaptainBattleRow, Player, PlTeam } from '@fant/shared';
import type { Messages } from '@/i18n';
import { useI18n } from '@/i18n';
import { ImageWithFallback, fplImage } from '../FplImages';
import { Badge, Num, cx } from '../ui';
import { ChipIcon } from './ChipIcon';

/** The kind badge over a captain row: "My captain" / "Community" / "FPL team" / "Standard". */
export function captainKindLabel(
  t: Messages,
  kind: CaptainBattleRow['kind'],
  source?: CaptainBattleRow['source'],
): string {
  if (kind === 'mine') return t.liveAction.mine;
  if (kind === 'community') return t.liveAction.kindCommunity;
  return source === 'entry' ? t.liveAction.linkedTeam : t.liveAction.kindCustom;
}

/**
 * One Captain Battle row: rank, captain photo, kind badge + label, the player (or `fallback` when there is none),
 * and the captain points. Shared by the live battle (Live tab) and the Gameweek Roundup, so both look the same;
 * `details` adds lines under the player (the live battle's match status).
 */
export function CaptainCard({
  rank,
  player,
  team,
  kindLabel,
  label,
  mine,
  multiplier,
  points,
  fallback,
  details,
}: {
  rank: number | null;
  player: Player | undefined;
  team: PlTeam | undefined;
  kindLabel: string;
  label: string;
  mine: boolean;
  multiplier: number;
  /** Captain points; null = no captain (shows a dash). */
  points: number | null;
  fallback: ReactNode;
  details?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <li
      className={cx(
        'flex items-center gap-3 rounded-2xl border bg-surface p-3 shadow-card',
        mine ? 'border-primary ring-2 ring-primary/30' : 'border-line',
        points === null && 'opacity-80',
      )}
      data-captain-kind={mine ? 'mine' : undefined}
    >
      <span
        className={cx(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold',
          rank === 1 ? 'bg-primary text-on-primary' : 'bg-surface-2 text-ink',
        )}
      >
        {rank === null ? '·' : <Num value={rank} />}
      </span>
      <ImageWithFallback
        src={player ? fplImage.photo(player.photoCode) : null}
        name={player?.webName ?? '?'}
        fallbackText={player ? undefined : '?'}
        className="h-14 w-11 shrink-0 rounded-lg bg-surface-2 object-cover object-top"
        fallbackClassName="size-11 text-sm"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The label gets the full line (user-entered, any script); the kind badge sits above it. */}
        <Badge tone={mine ? 'primary' : 'neutral'} className="self-start px-1.5 py-0 text-[10px]">
          {kindLabel}
        </Badge>
        <span dir="auto" className="name-start min-w-0 truncate font-bold text-ink">
          {label}
        </span>
        {player ? (
          <span className="flex min-w-0 items-center gap-1 text-sm text-ink">
            <span dir="auto" className="name-start truncate">
              {player.webName}
            </span>
            {team && <span className="shrink-0 text-muted">· {team.shortName}</span>}
            {multiplier === 3 && <ChipIcon chip="3xc" />}
          </span>
        ) : (
          fallback
        )}
        {details}
      </div>
      <span className="flex shrink-0 flex-col items-center">
        <span className="text-2xl leading-none font-extrabold text-primary">
          {points === null ? '—' : <Num value={points} />}
        </span>
        <span className="mt-1 text-[10px] font-semibold text-muted">
          {t.liveAction.captainPts}
          {multiplier === 3 && <bdi dir="ltr"> ×3</bdi>}
        </span>
      </span>
    </li>
  );
}
