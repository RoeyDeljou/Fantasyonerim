'use client';

import { Suspense } from 'react';
import { FplEntryIdSchema } from '@fant/shared';
import type { CaptainBattleRow, Fixture, LiveLeagueRow, PlayerLive } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Formatters, Messages } from '@/i18n';
import { isApiError } from '@/lib/api';
import {
  useCaptainBattle,
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
import { fixtureScoreText } from '@/components/team/fixtureText';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  LiveDot,
  Segmented,
  Skeleton,
  SkeletonList,
  Spinner,
  cx,
  errorMessage,
} from '@/components/ui';
import { Movement } from './Table';

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

function FixturesStrip({ index }: { index: FplIndex }) {
  const { t, f } = useI18n();
  const fixtures = useFixtures(index.bootstrap.currentEvent);
  return (
    <section aria-label={t.liveAction.fixtures}>
      <h2 className="mb-2 text-base font-bold text-ink">{t.liveAction.fixtures}</h2>
      {index.bootstrap.currentEvent === null ? (
        <p className="text-sm text-muted">{t.liveAction.noFixtures}</p>
      ) : fixtures.isPending ? (
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-36 shrink-0" />
          ))}
        </div>
      ) : fixtures.isError ? (
        <ErrorState error={fixtures.error} onRetry={() => fixtures.refetch()} />
      ) : fixtures.data.length === 0 ? (
        <p className="text-sm text-muted">{t.liveAction.noFixtures}</p>
      ) : (
        <ul className="no-scrollbar -mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1">
          {[...fixtures.data]
            .sort((a, b) => (a.kickoffTime ?? '').localeCompare(b.kickoffTime ?? '') || a.id - b.id)
            .map((fx) => (
              <FixtureCard key={fx.id} fx={fx} index={index} t={t} f={f} />
            ))}
        </ul>
      )}
    </section>
  );
}

function FixtureCard({ fx, index, t, f }: { fx: Fixture; index: FplIndex; t: Messages; f: Formatters }) {
  const home = index.teams.get(fx.teamH);
  const away = index.teams.get(fx.teamA);
  const started = fx.status !== 'not_started';
  const live = fx.status === 'live';
  const side = (team: typeof home) => (
    <span className="flex w-12 flex-col items-center gap-1">
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
  return (
    <li
      className={cx(
        'flex w-40 shrink-0 snap-start flex-col items-center gap-1 rounded-2xl border bg-surface px-2 py-2 shadow-card',
        live ? 'border-live' : 'border-line',
      )}
    >
      {/* Home team always on the visual start side, matching "home – away" reading order. */}
      <div className="flex w-full items-center justify-between">
        {side(home)}
        <span className="text-xl font-extrabold text-ink tabular" dir="ltr">
          {started ? `${fx.teamHScore ?? 0} – ${fx.teamAScore ?? 0}` : '–'}
        </span>
        {side(away)}
      </div>
      <span
        className={cx(
          'flex items-center gap-1 text-[11px] font-semibold',
          live ? 'text-live' : started ? 'text-muted' : 'text-ink',
        )}
      >
        {live && <LiveDot />}
        {fixtureScoreText(fx, t, f)}
      </span>
    </li>
  );
}

// ---------- live table ----------

function LiveTable({ index, interval }: { index: FplIndex; interval: number }) {
  const { t, f } = useI18n();
  const league = useLiveLeague(interval);
  const me = useMe();
  const [entryParam, setEntryParam] = useQueryParam('entry');
  const selectedId = FplEntryIdSchema.safeParse(entryParam ?? undefined);

  let body;
  const data = league.data;
  if (!data) {
    body = !league.isError ? (
      <SkeletonList rows={8} />
    ) : isApiError(league.error, 'not_found') ? (
      <EmptyState
        icon={<TableIcon width={32} height={32} />}
        title={t.table.noLeagueTitle}
        body={t.table.noLeagueBody}
      />
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
          <h1 className="text-xl font-extrabold text-ink">{first?.league.name}</h1>
          {first && (
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
              <ClockIcon width={14} height={14} />
              {fmt(t.common.gw, { gw: first.event })} ·{' '}
              {fmt(t.common.updatedAt, { time: f.time(first.updatedAt) })}
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
              {rows.map((r) => {
                const captain = r.captainPlayerId ? index.players.get(r.captainPlayerId) : undefined;
                return (
                  <li key={r.entryId}>
                    <button
                      type="button"
                      onClick={() => setEntryParam(String(r.entryId))}
                      aria-label={fmt(t.table.openTeam, { name: r.managerName })}
                      className={cx(
                        'grid min-h-16 w-full grid-cols-[2.75rem_1fr_3rem_3.75rem] items-center gap-2 px-3 py-2 text-start hover:bg-surface-2',
                        r.entryId === me.data?.entryId && 'bg-primary-soft',
                      )}
                    >
                      <span className="flex items-center gap-1 font-bold text-ink tabular">
                        {r.liveRank}
                        <Movement rank={r.liveRank} lastRank={r.officialRank} />
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span dir="auto" className="truncate text-start font-semibold text-ink">
                          {r.entryName}
                        </span>
                        <span dir="auto" className="truncate text-start text-xs text-muted">
                          {r.managerName}
                        </span>
                        <span className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                          {captain && (
                            <Badge tone="primary" className="px-1.5 py-0">
                              C · {captain.webName}
                            </Badge>
                          )}
                          {r.activeChip && (
                            <Badge tone="accent" className="px-1.5 py-0">
                              {chipName(t, r.activeChip)}
                            </Badge>
                          )}
                          {r.playersYetToPlay > 0 && (
                            <span>{fmt(t.liveAction.yetToPlayShort, { n: r.playersYetToPlay })}</span>
                          )}
                        </span>
                      </span>
                      <span className="text-center text-lg font-extrabold text-primary tabular">
                        {r.livePoints}
                      </span>
                      <span className="text-end font-bold text-ink tabular">{f.num(r.liveTotal)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {league.isFetchNextPageError && <InlineError>{errorMessage(t, league.error)}</InlineError>}
        {league.hasNextPage && (
          <Button
            variant="secondary"
            block
            disabled={league.isFetchingNextPage}
            onClick={() => league.fetchNextPage()}
          >
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

// ---------- captain battle ----------

function statusText(live: PlayerLive, t: Messages): string {
  switch (live.fixtureStatus) {
    case 'live':
      return fmt(t.live.minutes, { n: live.minutes });
    case 'finished':
      return t.live.ft;
    case 'not_started':
      return t.live.notStarted;
    case 'no_fixture':
      return t.live.noFixture;
  }
}

function CaptainBattleView({ index, interval }: { index: FplIndex; interval: number }) {
  const { t, f } = useI18n();
  const battle = useCaptainBattle(interval);

  const data = battle.data;
  if (!data) {
    if (!battle.isError) return <SkeletonList rows={5} />;
    if (isApiError(battle.error, 'not_found')) return <NoBattle />;
    return <ErrorState error={battle.error} onRetry={() => battle.refetch()} />;
  }
  const { rows, event, updatedAt } = data;
  if (event === null || rows.length === 0) return <NoBattle />;

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
        {rows.map((r, i) => (
          <CaptainRow key={r.key} row={r} rank={i + 1} index={index} />
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

function CaptainRow({ row, rank, index }: { row: CaptainBattleRow; rank: number; index: FplIndex }) {
  const { t } = useI18n();
  const player = index.players.get(row.playerId);
  const team = player ? index.teams.get(player.teamId) : undefined;
  const mine = row.kind === 'mine';
  const kindLabel =
    row.kind === 'mine'
      ? t.liveAction.mine
      : row.kind === 'community'
        ? t.liveAction.kindCommunity
        : t.liveAction.kindCustom;
  return (
    <li
      className={cx(
        'flex items-center gap-3 rounded-2xl border bg-surface p-3 shadow-card',
        mine ? 'border-primary ring-2 ring-primary/30' : 'border-line',
      )}
    >
      <span
        className={cx(
          'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold tabular',
          rank === 1 ? 'bg-primary text-on-primary' : 'bg-surface-2 text-ink',
        )}
      >
        {rank}
      </span>
      <ImageWithFallback
        src={player ? fplImage.photo(player.photoCode) : null}
        name={player?.webName ?? row.label}
        className="h-14 w-11 shrink-0 rounded-lg bg-surface-2 object-cover object-top"
        fallbackClassName="size-11 text-sm"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-bold text-ink">{row.label}</span>
          <Badge tone={mine ? 'primary' : 'neutral'}>{kindLabel}</Badge>
        </span>
        <span className="truncate text-sm text-ink">
          {player?.webName ?? '?'}
          {team && <span className="text-muted"> · {team.shortName}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className={cx(row.live.fixtureStatus === 'live' && 'font-semibold text-live')}>
            {row.live.fixtureStatus === 'live' && <LiveDot className="me-1 align-middle" />}
            {statusText(row.live, t)}
          </span>
          <span>· {fmt(t.liveAction.base, { n: row.live.basePoints })}</span>
          {row.live.provisionalBonus > 0 && (
            <Badge tone="warning">{fmt(t.live.provBonus, { n: row.live.provisionalBonus })}</Badge>
          )}
        </span>
      </div>
      <span className="flex shrink-0 flex-col items-center">
        <span className="text-2xl leading-none font-extrabold text-primary tabular">{row.captainPoints}</span>
        <span className="mt-1 text-[10px] font-semibold text-muted">
          {t.liveAction.captainPts}
          {row.multiplier === 3 && ' ×3'}
        </span>
      </span>
    </li>
  );
}
