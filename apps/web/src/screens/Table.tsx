'use client';

import { Suspense, memo, useCallback } from 'react';
import { FplEntryIdSchema } from '@fant/shared';
import type { FplEntryId, LeagueStandingRow, LeagueStandings as LeagueStanding } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import { qk, useConfig, useFplIndex, useLivePollInterval, useMe, useStandings } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { useQueryParam } from '@/lib/useQueryParam';
import { rankMove } from '@/lib/roundup';
import { REFRESH_SCOPES } from '@/lib/refresh';
import { AppShell, TableShellSkeleton } from '@/components/AppShell';
import { ArrowDownIcon, ArrowUpIcon, ClockIcon, DotIcon, TableIcon } from '@/components/icons';
import { ChipIcon } from '@/components/team/ChipIcon';
import { ManagerSheet } from '@/components/lazySheets';
import { lazyWhenOpen } from '@/components/lazy';
import { FindMyTeam, loadPagesUntil } from '@/components/team/FindMyTeam';
import {
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  Num,
  Segmented,
  SkeletonList,
  Spinner,
  cx,
  errorMessage,
} from '@/components/ui';

export function TableScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.table.title} refresh={REFRESH_SCOPES.table} skeleton={<TableShellSkeleton tabs />}>
      <Suspense fallback={<TableShellSkeleton tabs />}>
        <TableInner />
      </Suspense>
    </AppShell>
  );
}

export function Movement({ rank, lastRank }: { rank: number; lastRank: number | null }) {
  const { t } = useI18n();
  const move = rankMove(rank, lastRank);
  if (move.dir === 'same') {
    return (
      <span className="text-muted" aria-label={t.table.same} title={t.table.same} data-move="same">
        <DotIcon width={14} height={14} />
      </span>
    );
  }
  const up = move.dir === 'up';
  const label = fmt(up ? t.table.up : t.table.down, { n: move.places });
  return (
    <span className={up ? 'text-success' : 'text-live'} aria-label={label} title={label} data-move={move.dir}>
      {up ? (
        <ArrowUpIcon width={14} height={14} strokeWidth={2.6} />
      ) : (
        <ArrowDownIcon width={14} height={14} strokeWidth={2.6} />
      )}
    </span>
  );
}

export function NoLeague() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={<TableIcon width={32} height={32} />}
      title={t.table.noLeagueTitle}
      body={t.table.noLeagueBody}
    />
  );
}

type View = 'table' | 'roundup';

/**
 * The Gameweek Roundup is its own chunk (screens/Roundup.tsx): fans opening the Table don't download it, and it is
 * fetched in the background once the tab is idle so the sub-tab opens instantly.
 */
const RoundupView = lazyWhenOpen(
  () => import('./Roundup').then((m) => m.RoundupView),
  () => true,
  <SkeletonList rows={8} />,
);

/** League tab: the official table (default) and the Gameweek Roundup (`?view=roundup`), like Live's sub-tabs. */
function TableInner() {
  const { t } = useI18n();
  const [viewParam, setView] = useQueryParam('view');
  const view: View = viewParam === 'roundup' ? 'roundup' : 'table';
  return (
    <div className="flex flex-col gap-3">
      <Segmented<View>
        label={t.roundup.viewsLabel}
        value={view}
        onChange={(v) => setView(v === 'roundup' ? 'roundup' : null)}
        options={[
          { value: 'table', label: t.roundup.viewTable },
          { value: 'roundup', label: t.roundup.tab },
        ]}
      />
      {view === 'table' ? <Standings /> : <RoundupView />}
    </div>
  );
}

function Standings() {
  const { t, f } = useI18n();
  const config = useConfig();
  const leagueSet = !!config.data?.league;
  const standings = useStandings(leagueSet);
  const me = useMe();
  const fpl = useFplIndex();
  const { interval } = useLivePollInterval();
  const qc = useQueryClient();
  const [entryParam, setEntryParam] = useQueryParam('entry');
  const selectedId = FplEntryIdSchema.safeParse(entryParam ?? undefined);
  const openEntry = useCallback(
    (id: LeagueStandingRow['entryId']) => setEntryParam(String(id)),
    [setEntryParam],
  );

  const data = standings.data;
  if (config.isPending) return <SkeletonList rows={8} />;
  if (config.isError) return <ErrorState error={config.error} onRetry={() => config.refetch()} />;
  if (!leagueSet) return <NoLeague />;
  if (!data) {
    if (standings.isError) {
      if (isApiError(standings.error, 'not_found')) {
        return <NoLeague />;
      }
      return <ErrorState error={standings.error} onRetry={() => standings.refetch()} />;
    }
    return <SkeletonList rows={8} />;
  }

  const first = data.pages[0];
  const rows: LeagueStandingRow[] = data.pages.flatMap((p) => p.rows);
  const selected = selectedId.success ? rows.find((r) => r.entryId === selectedId.data) : undefined;
  const myEntry = me.data?.entryId ?? null;

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 dir="auto" className="name-start truncate text-2xl font-extrabold text-ink">
          {first?.league.name ?? t.table.title}
        </h1>
        {first && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <ClockIcon width={14} height={14} />
            {fmt(t.common.updatedAt, { time: f.time(first.updatedAt) })}
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <EmptyState icon={<TableIcon width={32} height={32} />} title={t.table.empty} />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
          <div className="grid grid-cols-[2.75rem_1fr_3rem_3.75rem] items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
            <span>{t.table.rank}</span>
            <span>{t.table.team}</span>
            <span className="text-center">{t.table.gwPts}</span>
            <span className="text-end">{t.table.total}</span>
          </div>
          <ol className="divide-y divide-line">
            {rows.map((r) => (
              <StandingRow key={r.entryId} row={r} mine={r.entryId === myEntry} onOpen={openEntry} />
            ))}
          </ol>
        </div>
      )}

      <FindMyTeam
        enabled={rows.length > 0}
        loadPage={(page) => loadPagesUntil(standings, page)}
        rankOf={(id) => rankIn(qc.getQueryData<InfiniteData<LeagueStanding>>(qk.standings), id)}
        rowsKey={rows.length}
      />

      {standings.isFetchNextPageError && <InlineError>{errorMessage(t, standings.error)}</InlineError>}
      {standings.hasNextPage && (
        <Button
          variant="secondary"
          block
          disabled={standings.isFetchingNextPage}
          onClick={() => standings.fetchNextPage()}
        >
          {standings.isFetchingNextPage && <Spinner />}
          {standings.isFetchingNextPage ? t.common.loadingMore : t.common.loadMore}
        </Button>
      )}

      <ManagerSheet
        entryId={selectedId.success ? selectedId.data : null}
        title={selected?.managerName ?? ''}
        event={fpl.index?.bootstrap.currentEvent ?? null}
        index={fpl.index}
        liveInterval={interval}
        onClose={() => setEntryParam(null)}
      />
    </div>
  );
}

/**
 * One standings row. Memoized (a refetch re-renders only rows that changed); `.table-row` lets the browser skip
 * layout and paint of rows far off screen (globals.css), which keeps a 100+ manager league smooth to scroll.
 */
const StandingRow = memo(function StandingRow({
  row: r,
  mine,
  onOpen,
}: {
  row: LeagueStandingRow;
  mine: boolean;
  onOpen(entryId: LeagueStandingRow['entryId']): void;
}) {
  const { t } = useI18n();
  return (
    <li className="table-row" data-entry={r.entryId}>
      <button
        type="button"
        onClick={() => onOpen(r.entryId)}
        aria-label={fmt(t.table.openTeam, { name: r.managerName })}
        className={cx(
          'grid min-h-14 w-full grid-cols-[2.75rem_1fr_3rem_3.75rem] items-center gap-2 px-3 py-2 text-start hover:bg-surface-2',
          mine && 'bg-primary-soft',
        )}
      >
        <span className="flex items-center gap-1 font-bold text-ink tabular">
          <Num value={r.rank} />
          <Movement rank={r.rank} lastRank={r.lastRank} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span dir="auto" className="name-start min-w-0 truncate font-semibold text-ink">
              {r.entryName}
            </span>
            {r.activeChip && <ChipIcon chip={r.activeChip} />}
          </span>
          <span dir="auto" className="name-start truncate text-xs text-muted">
            {r.managerName}
          </span>
        </span>
        <span className="text-center font-semibold text-ink ">
          <Num value={r.eventTotal} />
        </span>
        <span className="text-end font-extrabold text-ink ">
          <Num value={r.total} />
        </span>
      </button>
    </li>
  );
});

/** Official rank of an entry in the loaded standings (null when its page isn't loaded). */
function rankIn(data: InfiniteData<LeagueStanding> | undefined, id: FplEntryId): number | null {
  for (const p of data?.pages ?? []) for (const r of p.rows) if (r.entryId === id) return r.rank;
  return null;
}
