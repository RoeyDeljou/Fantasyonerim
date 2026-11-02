'use client';

import { useMemo, useState } from 'react';
import type {
  Fixture,
  FixtureDetail,
  FixturePlayerPoints,
  FixtureStatBlock,
  FixtureStatId,
  FplFixtureId,
  FplPlayerId,
  PlTeam,
} from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { fixtureInPlay, useFixtureDetail, useMe, usePicks } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { useRefresh } from '@/lib/refresh';
import type { RefreshScope } from '@/lib/refresh';
import { BottomSheet } from '../BottomSheet';
import { ImageWithFallback, fplImage } from '../FplImages';
import { ClockIcon, RefreshIcon } from '../icons';
import { Badge, EmptyState, ErrorState, IconButton, LiveDot, Segmented, Skeleton, cx } from '../ui';
import { fixtureScoreText } from './fixtureText';

type Tab = 'details' | 'players';

/** Counted stats show "(n)" only from 2 up, as FPL does ("Salah (2)"); measured stats always show it. */
const COUNTED: ReadonlySet<FixtureStatId> = new Set<FixtureStatId>([
  'goals_scored',
  'assists',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
]);

/**
 * The FPL match sheet for one fixture (Live Action → tap a fixture card): header with the score, then
 * "Match details" (stat blocks, home | away) and "Player stats" (everyone who played, by FPL points).
 * `fixture` = the card's copy from the fixtures list, shown while the sheet's own data loads.
 */
export function FixtureSheet({
  fixtureId,
  fixture,
  index,
  onClose,
}: {
  fixtureId: FplFixtureId | null;
  fixture: Fixture | undefined;
  index: FplIndex;
  onClose(): void;
}) {
  const { t } = useI18n();
  const home = fixture ? index.teams.get(fixture.teamH) : undefined;
  const away = fixture ? index.teams.get(fixture.teamA) : undefined;
  const title =
    home && away ? fmt(t.fixture.title, { home: home.name, away: away.name }) : t.fixture.tabDetails;
  const scope = useMemo<RefreshScope>(
    () =>
      fixtureId
        ? [
            ['fpl', 'fixture', fixtureId],
            ['fpl', 'fixtures'],
          ]
        : [],
    [fixtureId],
  );
  const r = useRefresh(scope);
  return (
    <BottomSheet
      open={fixtureId !== null}
      onClose={onClose}
      title={title}
      actions={
        <IconButton
          label={t.refresh.button}
          onClick={() => void r.refresh()}
          aria-busy={r.refreshing}
          data-testid="fixture-refresh"
        >
          <RefreshIcon size={20} className={cx(r.refreshing && 'animate-spin')} />
        </IconButton>
      }
    >
      {fixtureId !== null && (
        <FixtureBody
          key={fixtureId}
          fixtureId={fixtureId}
          fallback={fixture}
          index={index}
          justRefreshed={r.state === 'done'}
        />
      )}
    </BottomSheet>
  );
}

function FixtureBody({
  fixtureId,
  fallback,
  index,
  justRefreshed,
}: {
  fixtureId: FplFixtureId;
  fallback: Fixture | undefined;
  index: FplIndex;
  justRefreshed: boolean;
}) {
  const { t, f } = useI18n();
  const detail = useFixtureDetail(fixtureId, fixtureInPlay(fallback?.status));
  const [tab, setTab] = useState<Tab>('details');
  const fx = detail.data?.fixture ?? fallback;

  return (
    <div className="flex flex-col gap-3" data-testid="fixture-sheet" data-fixture={fixtureId}>
      {fx ? <MatchHeader fx={fx} index={index} /> : <Skeleton className="h-28" />}
      {detail.data && (
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted">
          <ClockIcon width={14} height={14} />
          {justRefreshed ? t.refresh.done : fmt(t.common.updatedAt, { time: f.time(detail.data.updatedAt) })}
        </p>
      )}
      {detail.isPending ? (
        <div className="flex flex-col gap-3" role="status" aria-busy="true">
          <Skeleton className="h-11" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : detail.isError && !detail.data ? (
        <ErrorState
          error={detail.error}
          onRetry={() => detail.refetch()}
          overrides={{ not_found: t.fixture.notFound }}
        />
      ) : detail.data.fixture.status === 'not_started' ? (
        <div
          className="flex flex-col items-center gap-1 rounded-2xl border border-dashed border-line bg-surface px-6 py-8 text-center"
          data-testid="fixture-not-started"
        >
          <p className="font-bold text-ink">{t.fixture.notStarted}</p>
          {detail.data.fixture.kickoffTime && (
            <p className="text-sm text-muted">
              {fmt(t.fixture.kickoff, { time: f.dateTime(detail.data.fixture.kickoffTime) })}
            </p>
          )}
        </div>
      ) : (
        <>
          <Segmented<Tab>
            label={t.fixture.viewsLabel}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'details', label: t.fixture.tabDetails },
              { value: 'players', label: t.fixture.tabPlayers },
            ]}
          />
          {tab === 'details' ? (
            <MatchDetails detail={detail.data} index={index} />
          ) : (
            <PlayerStats detail={detail.data} index={index} />
          )}
        </>
      )}
    </div>
  );
}

// ---------- header ----------

function Side({ team, side }: { team: PlTeam | undefined; side: 'home' | 'away' }) {
  return (
    <span className="flex min-w-0 flex-col items-center gap-1" data-side={side}>
      {team ? (
        <ImageWithFallback
          src={fplImage.badge(team.code)}
          name={team.shortName}
          fallbackText={team.shortName}
          className="size-12"
          fallbackClassName="size-12 text-xs"
        />
      ) : (
        <span className="size-12" />
      )}
      <span className="max-w-full truncate text-sm font-bold text-ink">{team?.name ?? '?'}</span>
    </span>
  );
}

/**
 * [home | score | away] in DOM order, like the fixture card: the grid flips with the page direction, so in
 * Hebrew home is on the right and every block below follows the same sides.
 */
function MatchHeader({ fx, index }: { fx: Fixture; index: FplIndex }) {
  const { t, f } = useI18n();
  const home = index.teams.get(fx.teamH);
  const away = index.teams.get(fx.teamA);
  const started = fx.status !== 'not_started';
  const live = fx.status === 'live';
  return (
    <div
      className="flex flex-col items-center gap-1 rounded-2xl bg-surface-2 px-3 py-3"
      data-testid="fixture-header"
    >
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <Side team={home} side="home" />
        <span
          className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 text-3xl font-extrabold whitespace-nowrap text-ink tabular"
          aria-label={
            started
              ? `${home?.name ?? ''} ${fx.teamHScore ?? 0}, ${away?.name ?? ''} ${fx.teamAScore ?? 0}`
              : undefined
          }
        >
          {started ? (
            <>
              <span className="text-center" data-score="home">
                {f.num(fx.teamHScore ?? 0)}
              </span>
              <span aria-hidden="true">–</span>
              <span className="text-center" data-score="away">
                {f.num(fx.teamAScore ?? 0)}
              </span>
            </>
          ) : (
            <span className="col-span-3 text-center text-muted">–</span>
          )}
        </span>
        <Side team={away} side="away" />
      </div>
      <span
        className={cx(
          'flex items-center gap-1 text-xs font-semibold whitespace-nowrap',
          live ? 'text-live' : 'text-muted',
        )}
      >
        {live && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-live-soft px-2 py-0.5 text-[11px] font-extrabold tracking-wide text-live"
            data-testid="fixture-live"
          >
            <LiveDot />
            {t.fixture.liveBadge}
          </span>
        )}
        {/* "62'" must read left-to-right in Hebrew too (the apostrophe is the minute mark). */}
        <bdi data-testid="fixture-status" dir={live ? 'ltr' : undefined}>
          {fixtureScoreText(fx, t, f)}
        </bdi>
        {started && fx.kickoffTime && <span className="font-normal">· {f.dateTime(fx.kickoffTime)}</span>}
      </span>
    </div>
  );
}

// ---------- match details ----------

function MatchDetails({ detail, index }: { detail: FixtureDetail; index: FplIndex }) {
  const { t } = useI18n();
  if (detail.stats.length === 0) return <EmptyState title={t.fixture.noStats} />;
  return (
    <div className="flex flex-col gap-2" data-testid="fixture-details">
      {detail.stats.map((block) => (
        <StatBlock key={block.id} block={block} index={index} />
      ))}
    </div>
  );
}

function StatBlock({ block, index }: { block: FixtureStatBlock; index: FplIndex }) {
  const { t } = useI18n();
  return (
    <section
      className="overflow-hidden rounded-2xl border border-line bg-surface"
      data-testid="fixture-stat"
      data-stat={block.id}
    >
      <h3 className="border-b border-line bg-surface-2 px-3 py-1.5 text-center text-sm font-bold text-ink">
        {t.fixture.stats[block.id]}
      </h3>
      <div className="grid grid-cols-2">
        <StatColumn values={block.home} stat={block.id} index={index} side="home" />
        <StatColumn values={block.away} stat={block.id} index={index} side="away" />
      </div>
    </section>
  );
}

function StatColumn({
  values,
  stat,
  index,
  side,
}: {
  values: FixtureStatBlock['home'];
  stat: FixtureStatId;
  index: FplIndex;
  side: 'home' | 'away';
}) {
  const { t, f } = useI18n();
  return (
    <ul
      data-side={side}
      aria-label={side === 'home' ? t.fixture.home : t.fixture.away}
      className={cx(
        'flex min-w-0 flex-col gap-0.5 px-3 py-2 text-sm',
        side === 'home' ? 'text-start' : 'border-s border-line text-end',
      )}
    >
      {values.length === 0 ? (
        <li aria-hidden="true" className="text-muted">
          –
        </li>
      ) : (
        values.map((v) => {
          const name = index.players.get(v.playerId)?.webName ?? `#${v.playerId}`;
          const showValue = !COUNTED.has(stat) || v.value > 1;
          return (
            <li key={v.playerId} className="truncate text-ink" data-player={v.playerId}>
              <bdi>{name}</bdi>
              {showValue && <span className="ms-1 text-muted tabular">({f.num(v.value)})</span>}
            </li>
          );
        })
      )}
    </ul>
  );
}

// ---------- player stats ----------

function useMySquad(event: FixtureDetail['fixture']['event']) {
  const me = useMe();
  const picks = usePicks(me.data?.entryId ?? null, event, event !== null);
  return useMemo(() => {
    const ids = new Set<FplPlayerId>();
    let captain: FplPlayerId | null = null;
    for (const p of picks.data?.picks ?? []) {
      ids.add(p.playerId);
      if (p.isCaptain) captain = p.playerId;
    }
    return { ids, captain };
  }, [picks.data]);
}

function PlayerStats({ detail, index }: { detail: FixtureDetail; index: FplIndex }) {
  const { t } = useI18n();
  const mine = useMySquad(detail.fixture.event);
  const players = useMemo(
    () => [...detail.players].sort((a, b) => b.points - a.points || b.minutes - a.minutes),
    [detail.players],
  );
  if (players.length === 0) return <EmptyState title={t.fixture.noPlayers} />;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface" data-testid="fixture-players">
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_2.75rem_2.75rem] items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
        <span aria-hidden="true" />
        <span>{t.fixture.player}</span>
        <span className="text-center">{t.fixture.minutes}</span>
        <span className="text-end">{t.fixture.points}</span>
      </div>
      <ol className="divide-y divide-line">
        {players.map((p) => (
          <PlayerRow
            key={p.playerId}
            p={p}
            index={index}
            mine={mine.ids.has(p.playerId)}
            captain={mine.captain === p.playerId}
          />
        ))}
      </ol>
    </div>
  );
}

function PlayerRow({
  p,
  index,
  mine,
  captain,
}: {
  p: FixturePlayerPoints;
  index: FplIndex;
  mine: boolean;
  captain: boolean;
}) {
  const { t, f } = useI18n();
  const player = index.players.get(p.playerId);
  const team = index.teams.get(p.teamId);
  return (
    <li
      data-testid="fixture-player"
      data-player={p.playerId}
      data-mine={mine || undefined}
      data-captain={captain || undefined}
      className={cx(
        'grid min-h-11 grid-cols-[2rem_minmax(0,1fr)_2.75rem_2.75rem] items-center gap-2 px-3 py-1.5',
        mine && 'bg-primary-soft',
      )}
    >
      {team ? (
        <ImageWithFallback
          src={fplImage.badge(team.code)}
          name={team.shortName}
          fallbackText={team.shortName}
          className="size-7"
          fallbackClassName="size-7 text-[9px]"
        />
      ) : (
        <span className="size-7" />
      )}
      <span className="flex min-w-0 items-center gap-1.5">
        <span dir="auto" className="name-start min-w-0 truncate font-semibold text-ink">
          {player?.webName ?? `#${p.playerId}`}
        </span>
        {captain && (
          <Badge tone="primary" className="shrink-0 px-1.5 py-0">
            <span aria-label={t.fixture.captain}>C</span>
          </Badge>
        )}
        {mine && <span className="sr-only">{t.fixture.mine}</span>}
      </span>
      <span
        className="text-center text-sm text-muted tabular"
        aria-label={fmt(t.fixture.minutesLabel, { n: p.minutes })}
      >
        {f.num(p.minutes)}
      </span>
      <span
        className="text-end text-lg font-extrabold text-primary tabular"
        aria-label={fmt(t.fixture.pointsLabel, { n: p.points })}
      >
        {p.points < 0 ? `−${f.num(-p.points)}` : f.num(p.points)}
      </span>
    </li>
  );
}
