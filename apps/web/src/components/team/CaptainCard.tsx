'use client';

import type { ReactNode } from 'react';
import type { Player, PlTeam } from '@fant/shared';
import { captainBadge } from '@/lib/captains';
import type { CaptainBadge, CaptainRowKind, CaptainRowSource } from '@/lib/captains';
import { useI18n } from '@/i18n';
import { ImageWithFallback, fplImage } from '../FplImages';
import { Badge, Num, cx } from '../ui';
import { ChipIcon } from './ChipIcon';

/** The FPL Lad wordmark is 264x64; drawn 14 px high with its real aspect ratio so nothing shifts when it loads. */
const FPL_LAD_LOGO = { src: '/brand/fpl-lad.png', width: 58, height: 14 } as const;

/**
 * The tag over a captain row: the admin's tag or the row's default (see lib/captains.ts). FPL Lad's row carries its
 * logo (on a light chip, so it stays legible in dark mode) right before the text, or alone when there is no text.
 */
export function CaptainTag({
  badge,
  mine = false,
  className,
}: {
  badge: CaptainBadge;
  mine?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  if (badge.text === null && !badge.logo) return null;
  return (
    <Badge
      tone={mine ? 'primary' : 'neutral'}
      className={cx('self-start px-1.5 py-0 text-[10px]', className)}
    >
      {badge.logo && (
        <span
          className="inline-flex items-center rounded-sm bg-logo-chip px-1 py-0.5"
          data-testid="fpl-lad-logo"
        >
          <img
            src={FPL_LAD_LOGO.src}
            width={FPL_LAD_LOGO.width}
            height={FPL_LAD_LOGO.height}
            alt={t.liveAction.fplLadAlt}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="block h-3.5 w-auto max-w-none"
          />
        </span>
      )}
      {badge.text !== null && (
        <bdi dir="auto" data-testid="captain-tag">
          {badge.text}
        </bdi>
      )}
    </Badge>
  );
}

/** The badge of a captain row, labels from the active language. */
export function useCaptainBadge(row: {
  kind: CaptainRowKind;
  source?: CaptainRowSource | undefined;
  tag?: string | null | undefined;
}): CaptainBadge {
  const { t } = useI18n();
  return captainBadge(row, {
    mine: t.liveAction.mine,
    community: t.liveAction.kindCommunity,
    linkedTeam: t.liveAction.linkedTeam,
  });
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
  badge,
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
  badge: CaptainBadge;
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
        {/* The label gets the full line (user-entered, any script); the tag sits above it. */}
        <CaptainTag badge={badge} mine={mine} />
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
