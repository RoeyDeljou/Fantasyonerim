'use client';

import type { ReactNode } from 'react';
import type { Player, PlTeam } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { captainVote } from '@/i18n/sections/captainVote';
import { useSection } from '@/i18n/section';
import { availabilityFlag } from '@/lib/captainVote';
import { ImageWithFallback, fplImage } from '../FplImages';
import { CheckIcon } from '../icons';
import { Badge, Ltr, cx } from '../ui';

/**
 * "Your pick:" — the chosen player's photo, name, club, current form (and an availability flag when FPL says he may
 * not play) and who he plays that gameweek. `children` are the buttons (Confirm / Change pick); the card is read-only
 * when there are none (locked vote).
 */
export function PickCard({
  player,
  team,
  opponent,
  confirmed,
  note,
  children,
  label,
}: {
  player: Player;
  team: PlTeam | undefined;
  opponent: string;
  confirmed: boolean;
  note?: string | undefined;
  /** Replaces the "Your pick:" heading (e.g. "You voted" on a locked vote). */
  label?: string | undefined;
  children?: ReactNode;
}) {
  const s = useSection(captainVote);
  const { f, t } = useI18n();
  const { positions } = t;
  const flag = availabilityFlag(player);
  const chance = player.chanceOfPlayingNextRound;
  return (
    <section
      className={cx(
        'flex flex-col gap-3 rounded-3xl border bg-surface p-4 shadow-card',
        confirmed ? 'border-success/40' : 'border-primary',
      )}
      data-testid="cv-pick"
      data-state={confirmed ? 'confirmed' : 'draft'}
      data-player={player.id}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-muted">{label ?? s.yourPick}</h2>
        {confirmed && (
          <span data-testid="cv-confirmed">
            <Badge tone="success" className="px-2.5 py-1 text-xs">
              <CheckIcon size={14} />
              {s.confirmed}
            </Badge>
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <ImageWithFallback
          src={fplImage.photo(player.photoCode)}
          name={player.webName}
          className="h-20 w-16 shrink-0 rounded-xl bg-surface-2 object-cover object-top"
          fallbackClassName="size-16 text-lg"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p
            dir="auto"
            className="name-start truncate text-xl leading-tight font-extrabold text-ink"
            data-testid="cv-pick-name"
          >
            {player.webName}
          </p>
          <p className="truncate text-sm text-muted">
            <bdi>{team?.name ?? team?.shortName ?? ''}</bdi> · {positions[player.position]}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span data-testid="cv-form">
              <Badge tone="primary" className="px-2.5 py-1 text-xs">
                {s.form}
                <Ltr className="tabular">{f.decimal(player.form, 1)}</Ltr>
              </Badge>
            </span>
            {flag && (
              <span data-testid="cv-flag">
                <Badge tone={flag === 'doubtful' ? 'warning' : 'live'} className="px-2.5 py-1 text-xs">
                  {s[flag]}
                  {chance !== null && flag === 'doubtful' && (
                    <span className="font-normal">· {fmt(s.chance, { n: f.num(chance) })}</span>
                  )}
                </Badge>
              </span>
            )}
          </div>
        </div>
      </div>
      <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-ink" data-testid="cv-pick-fixture">
        <span className="font-semibold text-muted">{s.plays}: </span>
        <span className="font-semibold">{opponent}</span>
      </p>
      {note && <p className="text-sm text-muted">{note}</p>}
      {children}
    </section>
  );
}
