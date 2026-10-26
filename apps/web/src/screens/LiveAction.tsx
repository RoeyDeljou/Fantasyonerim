'use client';

import { Suspense, useEffect, useRef } from 'react';
import { FplEntryIdSchema } from '@fant/shared';
import type { CaptainBattleRow, Fixture, LiveLeagueRow, PlTeam } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Formatters, Messages } from '@/i18n';
import { isApiError } from '@/lib/api';
import {
  useCaptainBattle,
  useConfig,
  useFixtures,
  useFplIndex,
  useLiveLeague,
  useLivePollInterval,
  useMe,
} from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { useQueryParam } from '@/lib/useQueryParam';
import { AppShell, ShellSkeleton } from '@/components/AppShell';
import { ImageWithFallback, fplImage } from '@/components/FplImages';
import { ClockIcon, ShirtIcon, TableIcon } from '@/components/icons';
import { ManagerSheet } from '@/components/team/ManagerSheet';
import { chipName } from '@/components/team/TeamParts';
import { BonusBadge } from '@/components/team/BonusBadge';
import { fixtureScoreText, fixtureStatusText } from '@/components/team/fixtureText';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  LiveDot,
  Num,
  Segmented,
  Skeleton,
  SkeletonList,
  Spinner,
  cx,
  errorMessage,
} from '@/components/ui';
import { Movement, NoLeague } from './Table';

type View = 'table' | 'captains';

export function LiveActionScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.liveAction.title}>
      <Suspense fallback={<ShellSkeleton />}>
        <LiveActionInner />
      </Suspense>
    </AppShell>
  );
}

function LiveActionInner() {
  const { t } = useI18n();
  const [viewParam, setView] = useQueryParam('view');
  const view: View = viewParam === 'captains' ? 'captains' : 'table';
  const fpl = useFplIndex();
  const { interval, isLive } = useLivePollInterval();

  return (
    <div className="flex flex-col gap-3">
      <Segmented<View>
        label={t.myTeam.viewsLabel}
        value={view}
        onChange={(v) => setView(v === 'captains' ? 'captains' : null)}
        options={[
          { value: 'table', label: t.liveAction.viewTable },
          { value: 'captains', label: t.liveAction.viewCaptains },
        ]}
      />
      {isLive && (
        <p className="flex items-center gap-2 text-xs font-semibold text-live">
          <LiveDot />
          {t.live.pollingLive}
        </p>
      )}
      {fpl.isPending ? (
        <SkeletonList rows={8} />
      ) : fpl.isError || !fpl.index ? (
        <ErrorState error={fpl.error} onRetry={() => fpl.refetch()} />
      ) : view === 'table' ? (
        <LiveTable index={fpl.index} interval={interval} />
      ) : (
        <CaptainBattleView index={fpl.index} interval={interval} />
      )}
    </div>
  );
}

// ---------- fixtures strip ----------

/** Chronological by kickoff; the strip scrolls itself to the first live match (else the next one to start). */
function FixturesStrip({ index }: { index: FplIndex }) {
  const { t, f } = useI18n();
  const fixtures = useFixtures(index.bootstrap.currentEvent);
  const listRef = useRef<HTMLUListElement>(null);
  const sorted = [...(fixtures.data ?? [])].sort(
    (a, b) => (a.kickoffTime ?? '9').localeCompare(b.kickoffTime ?? '9') || a.id - b.id,
  );
  const focusId =
    sorted.find((fx) => fx.status === 'live')?.id ?? sorted.find((fx) => fx.status === 'not_started')?.id ?? null;

  useEffect(() => {
    if (focusId === null || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-fixture="${focusId}"]`);
    if (!el) return;
    const list = listRef.current;
    // Scroll only the strip (never the page): align the card's start edge with the list's start edge.
    const rtl = getComputedStyle(list).direction === 'rtl';
    const listRect = list.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = rtl ? elRect.right - listRect.right + 16 : elRect.left - listRect.left - 16;
    list.scrollBy({ left: delta, behavior: 'auto' });
  }, [focusId, fixtures.dataUpdatedAt]);

  return (
    <section aria-label={t.liveAction.fixtures}>
      <h2 className="mb-2 text-base font-bold text-ink">{t.liveAction.fixtures}</h2>
      {index.bootstrap.currentEvent === null ? (
        <p className="text-sm text-muted">{t.liveAction.noFixtures}</p>
      ) : fixtures.isPending ? (
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-44 shrink-0" />
          ))}
        </div>
      ) : fixtures.isError ? (
        <ErrorState error={fixtures.error} onRetry={() => fixtures.refetch()} />
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted">{t.liveAction.noFixtures}</p>
      ) : (
        <ul ref={listRef} className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1">
          {sorted.map((fx) => (
            <FixtureCard key={fx.id} fx={fx} index={index} t={t} f={f} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamSide({ team }: { team: PlTeam | undefined }) {
  return (
    <span className="flex min-w-0 flex-col items-center gap-1">
      {team ? (
        <ImageWithFallback
          src={fplImage.badge(team.code)}
          name={team.shortName}
          fallbackText={team.shortName}
          className="size-8"
          fallbackClassName="size-8 text-[10px]"
        />
      ) : (
        <span className="size-8" />
      )}
      <span className="text-xs font-bold text-ink">{team?.shortName ?? '?'}</span>
    </span>
  );
}

/**
 * [home | home score – away score | away] as grid cells, so each score sits next to its own team in both
 * directions (RTL draws home on the right, with the home score right of the dash).
 */
function FixtureCard({ fx, index, t, f }: { fx: Fixture; index: FplIndex; t: Messages; f: Formatters }) {
  const home = index.teams.get(fx.teamH);
  const away = index.teams.get(fx.teamA);
  const started = fx.status !== 'not_started';
  const live = fx.status === 'live';
  return (
    <li
      data-fixture={fx.id}
      className={cx(
        'flex w-44 shrink-0 snap-start flex-col items-center gap-1 rounded-2xl border bg-surface px-2 py-2 shadow-card',
        live ? 'border-live' : 'border-line',
      )}
    >
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-1">
        <TeamSide team={home} />
        <span
          className="grid grid-cols-[1fr_auto_1fr] items-center gap-1 text-xl font-extrabold whitespace-nowrap text-ink tabular"
          aria-label={
            started ? `${home?.shortName ?? ''} ${fx.teamHScore ?? 0}, ${away?.shortName ?? ''} ${fx.teamAScore ?? 0}` : undefined
          }
        >
          {started ? (
            <>
              <span className="text-center">{f.num(fx.teamHScore ?? 0)}</span>
              <span aria-hidden="true">–</span>
              <span className="text-center">{f.num(fx.teamAScore ?? 0)}</span>
            </>
          ) : (
            <span className="col-span-3 text-center text-muted">–</span>
          )}
        </span>
        <TeamSide team={away} />
      </div>
      <span
        className={cx(
          'flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap',
          live ? 'text-live' : started ? 'text-muted' : 'text-ink',
        )}
      >
        {live && <LiveDot />}
        <bdi>{fixtureScoreText(fx, t, f)}</bdi>
      </span>
    </li>
  );
}

// ---------- live table ----------

function LiveTable({ index, interval }: { index: FplIndex; interval: number }) {
  const { t, f } = useI18n();
  const config = useConfig();
  const leagueSet = !!config.data?.league;
  const league = useLiveLeague(interval, leagueSet);
  const me = useMe();
  const [entryParam, setEntryParam] = useQueryParam('entry');
  const selectedId = FplEntryIdSchema.safeParse(entryParam ?? undefined);

  let body;
  const data = league.data;
  if (config.isPending) body = <SkeletonList rows={8} />;
  else if (config.isError) body = <ErrorState error={config.error} onRetry={() => config.refetch()} />;
  else if (!leagueSet) body = <NoLeague />;
  else if (!data) {
    body = !league.isError ? (
      <SkeletonList rows={8} />
    ) : isApiError(league.error, 'not_found') ? (
      <NoLeague />
    ) : (
      <ErrorState error={league.error} onRetry={() => league.refetch()} />
    );
  } else {
    const first = data.pages[0];
    const rows: LiveLeagueRow[] = data.pages.flatMap((p) => p.rows);
    const selected = selectedId.success ? rows.find((r) => r.entryId === selectedId.data) : undefined;
    body = (
      <>
        <header>
          <h1 dir="auto" className="truncate text-start text-xl font-extrabold text-ink">
            {first?.league.name}
          </h1>
          {first && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              <ClockIcon width={14} height={14} />
              {fmt(t.common.gw, { gw: first.event })} · {fmt(t.common.updatedAt, { time: f.time(first.updatedAt) })}
            </p>
          )}
        </header>
        {rows.length === 0 ? (
          <EmptyState icon={<TableIcon width={32} height={32} />} title={t.table.empty} />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
            <div className="grid grid-cols-[2.75rem_1fr_3rem_3.75rem] items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
              <span>{t.liveAction.liveRank}</span>
              <span>{t.table.team}</span>
              <span className="text-center">{t.table.gwPts}</span>
              <span className="text-end">{t.table.total}</span>
            </div>
            <ol className="divide-y divide-line">
              {rows.map((r) => (
                <LiveLeagueRowItem
                  key={r.entryId}
                  row={r}
                  index={index}
                  mine={r.entryId === me.data?.entryId}
                  onOpen={() => setEntryParam(String(r.entryId))}
                />
              ))}
            </ol>
          </div>
        )}
        {league.isFetchNextPageError && <InlineError>{errorMessage(t, league.error)}</InlineError>}
        {league.hasNextPage && (
          <Button variant="secondary" block disabled={league.isFetchingNextPage} onClick={() => league.fetchNextPage()}>
            {league.isFetchingNextPage && <Spinner />}
            {league.isFetchingNextPage ? t.common.loadingMore : t.common.loadMore}
          </Button>
        )}
        <ManagerSheet
          entryId={selectedId.success ? selectedId.data : null}
          title={selected?.managerName ?? ''}
          event={first?.event ?? index.bootstrap.currentEvent}
          index={index}
          liveInterval={interval}
          onClose={() => setEntryParam(null)}
        />
      </>
    );
  }

  return (
    <>
      <FixturesStrip index={index} />
      {body}
    </>
  );
}

function LiveLeagueRowItem({
  row: r,
  index,
  mine,
  onOpen,
}: {
  row: LiveLeagueRow;
  index: FplIndex;
  mine: boolean;
  onOpen(): void;
}) {
  const { t } = useI18n();
  // The armband goes to the vice when the captain didn't play — show who actually scores it.
  const effectiveId = r.effectiveCaptainPlayerId ?? r.captainPlayerId;
  const captain = effectiveId ? index.players.get(effectiveId) : undefined;
  const viceTook = r.effectiveCaptainPlayerId !== null && r.effectiveCaptainPlayerId !== r.captainPlayerId;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={fmt(t.table.openTeam, { name: r.managerName })}
        className={cx(
          'grid min-h-16 w-full grid-cols-[2.75rem_minmax(0,1fr)_3rem_3.75rem] items-center gap-2 px-3 py-2 text-start hover:bg-surface-2',
          mine && 'bg-primary-soft',
        )}
      >
        <span className="flex items-center gap-1 font-bold text-ink">
          <Num value={r.liveRank} />
          <Movement rank={r.liveRank} lastRank={r.officialRank} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span dir="auto" className="truncate text-start font-semibold text-ink">
            {r.entryName}
          </span>
          <span dir="auto" className="truncate text-start text-xs text-muted">
            {r.managerName}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted">
            {captain && (
              <Badge tone="primary" className="max-w-full px-1.5 py-0">
                <span className="shrink-0">{viceTook ? 'V' : 'C'}</span>
                <span dir="auto" className="truncate">
                  {captain.webName}
                </span>
                {viceTook && <span className="shrink-0 opacity-80">({t.liveAction.viceTook})</span>}
              </Badge>
            )}
            {r.activeChip && (
              <Badge tone="accent" className="px-1.5 py-0">
                {chipName(t, r.activeChip)}
              </Badge>
            )}
            {r.playersYetToPlay > 0 && <span>{fmt(t.liveAction.yetToPlayShort, { n: r.playersYetToPlay })}</span>}
          </span>
        </span>
        <span className="text-center text-lg font-extrabold text-primary">
          <Num value={r.livePoints} />
        </span>
        <span className="text-end font-bold text-ink">
          <Num value={r.liveTotal} />
        </span>
      </button>
    </li>
  );
}

// ---------- captain battle ----------

function CaptainBattleView({ index, interval }: { index: FplIndex; interval: number }) {
  const { t, f } = useI18n();
  const battle = useCaptainBattle(interval);
  const fixtures = useFixtures(battle.data?.event ?? null);

  const data = battle.data;
  if (!data) {
    if (!battle.isError) return <SkeletonList rows={5} />;
    if (isApiError(battle.error, 'not_found')) return <NoBattle />;
    return <ErrorState error={battle.error} onRetry={() => battle.refetch()} />;
  }
  const { event, updatedAt } = data;
  if (event === null || data.rows.length === 0) return <NoBattle />;
  // Server sorts by captain points; keep rows whose captain is still unknown at the bottom.
  const rows = [...data.rows].sort((a, b) => Number(a.playerId === null) - Number(b.playerId === null));
  const deadline = index.bootstrap.events.find((e) => e.id === event)?.deadlineTime;
  const beforeDeadline = deadline ? Date.parse(deadline) > Date.now() : false;

  let rank = 0;
  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="text-xl font-extrabold text-ink">{t.liveAction.viewCaptains}</h1>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <ClockIcon width={14} height={14} />
          {fmt(t.common.gw, { gw: event })} · {fmt(t.common.updatedAt, { time: f.time(updatedAt) })}
        </p>
      </header>
      <ol className="flex flex-col gap-2">
        {rows.map((r) => (
          <CaptainRow
            key={r.key}
            row={r}
            rank={r.playerId === null ? null : ++rank}
            index={index}
            fixtures={fixtures.data}
            beforeDeadline={beforeDeadline}
          />
        ))}
      </ol>
    </div>
  );
}

function NoBattle() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={<ShirtIcon width={32} height={32} />}
      title={t.liveAction.noBattleTitle}
      body={t.liveAction.noBattleBody}
    />
  );
}

function CaptainRow({
  row,
  rank,
  index,
  fixtures,
  beforeDeadline,
}: {
  row: CaptainBattleRow;
  rank: number | null;
  index: FplIndex;
  fixtures: readonly Fixture[] | undefined;
  beforeDeadline: boolean;
}) {
  const { t, f } = useI18n();
  const player = row.playerId ? index.players.get(row.playerId) : undefined;
  const team = player ? index.teams.get(player.teamId) : undefined;
  const mine = row.kind === 'mine';
  const kindLabel =
    row.kind === 'mine'
      ? t.liveAction.mine
      : row.kind === 'community'
        ? t.liveAction.kindCommunity
        : row.source === 'entry'
          ? t.liveAction.linkedTeam
          : t.liveAction.kindCustom;
  const live = row.live;
  return (
    <li
      className={cx(
        'flex items-center gap-3 rounded-2xl border bg-surface p-3 shadow-card',
        mine ? 'border-primary ring-2 ring-primary/30' : 'border-line',
        row.playerId === null && 'opacity-80',
      )}
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
        <span className="flex min-w-0 items-center gap-1.5">
          <span dir="auto" className="min-w-0 truncate text-start font-bold text-ink">
            {row.label}
          </span>
          <Badge tone={mine ? 'primary' : 'neutral'} className="shrink-0">
            {kindLabel}
          </Badge>
        </span>
        {player ? (
          <span className="flex min-w-0 items-center gap-1 text-sm text-ink">
            <span dir="auto" className="truncate">
              {player.webName}
            </span>
            {team && <span className="shrink-0 text-muted">· {team.shortName}</span>}
            {row.multiplier === 3 && (
              <Badge tone="accent" className="shrink-0 px-1.5">
                {t.liveAction.tc}
              </Badge>
            )}
          </span>
        ) : (
          <span className="text-sm text-muted">
            {beforeDeadline ? t.liveAction.revealedAtDeadline : t.liveAction.unavailable}
          </span>
        )}
        {live && (
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
            <span className={cx(live.fixtureStatus === 'live' && 'font-semibold text-live')}>
              {live.fixtureStatus === 'live' && <LiveDot className="me-1 align-middle" />}
              <bdi>{fixtureStatusText(live, t, f, player?.teamId, fixtures)}</bdi>
            </span>
            {(live.fixtureStatus === 'live' || live.fixtureStatus === 'finished') && (
              <span>· {fmt(t.live.minutesPlayed, { n: f.num(live.minutes) })}</span>
            )}
            <span>· {fmt(t.liveAction.base, { n: f.num(live.basePoints) })}</span>
            <BonusBadge n={live.provisionalBonus} confirmed={live.fixtureStatus === 'finished'} />
          </span>
        )}
      </div>
      <span className="flex shrink-0 flex-col items-center">
        <span className="text-2xl leading-none font-extrabold text-primary">
          {row.playerId === null ? '—' : <Num value={row.captainPoints} />}
        </span>
        <span className="mt-1 text-[10px] font-semibold text-muted">
          {t.liveAction.captainPts}
          {row.multiplier === 3 && <bdi dir="ltr"> ×3</bdi>}
        </span>
      </span>
    </li>
  );
}
