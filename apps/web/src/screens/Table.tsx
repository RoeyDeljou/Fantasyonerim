'use client';

import { Suspense } from 'react';
import { FplEntryIdSchema } from '@fant/shared';
import type { LeagueStandingRow } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useConfig, useFplIndex, useLivePollInterval, useMe, useStandings } from '@/lib/queries';
import { useQueryParam } from '@/lib/useQueryParam';
import { AppShell, ShellSkeleton } from '@/components/AppShell';
import { ArrowDownIcon, ArrowUpIcon, ClockIcon, DotIcon, TableIcon } from '@/components/icons';
import { ManagerSheet } from '@/components/team/ManagerSheet';
import {
  Button,
  EmptyState,
  ErrorState,
  InlineError,
  Num,
  SkeletonList,
  Spinner,
  cx,
  errorMessage,
} from '@/components/ui';

export function TableScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.table.title}>
      <Suspense fallback={<ShellSkeleton />}>
        <TableInner />
      </Suspense>
    </AppShell>
  );
}

export function Movement({ rank, lastRank }: { rank: number; lastRank: number }) {
  const { t } = useI18n();
  if (lastRank <= 0 || lastRank === rank) {
    return (
      <span className="text-muted" aria-label={t.table.same} title={t.table.same}>
        <DotIcon width={14} height={14} />
      </span>
    );
  }
  const up = rank < lastRank;
  const n = Math.abs(lastRank - rank);
  const label = fmt(up ? t.table.up : t.table.down, { n });
  return (
    <span className={up ? 'text-success' : 'text-live'} aria-label={label} title={label}>
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
    <EmptyState icon={<TableIcon width={32} height={32} />} title={t.table.noLeagueTitle} body={t.table.noLeagueBody} />
  );
}

function TableInner() {
  const { t, f } = useI18n();
  const config = useConfig();
  const leagueSet = !!config.data?.league;
  const standings = useStandings(leagueSet);
  const me = useMe();
  const fpl = useFplIndex();
  const { interval } = useLivePollInterval();
  const [entryParam, setEntryParam] = useQueryParam('entry');
  const selectedId = FplEntryIdSchema.safeParse(entryParam ?? undefined);

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
        <h1 dir="auto" className="truncate text-start text-2xl font-extrabold text-ink">
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
              <li key={r.entryId}>
                <button
                  type="button"
                  onClick={() => setEntryParam(String(r.entryId))}
                  aria-label={fmt(t.table.openTeam, { name: r.managerName })}
                  className={cx(
                    'grid min-h-14 w-full grid-cols-[2.75rem_1fr_3rem_3.75rem] items-center gap-2 px-3 py-2 text-start hover:bg-surface-2',
                    r.entryId === myEntry && 'bg-primary-soft',
                  )}
                >
                  <span className="flex items-center gap-1 font-bold text-ink tabular">
                    <Num value={r.rank} />
                    <Movement rank={r.rank} lastRank={r.lastRank} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span dir="auto" className="truncate text-start font-semibold text-ink">
                      {r.entryName}
                    </span>
                    <span dir="auto" className="truncate text-start text-xs text-muted">
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
            ))}
          </ol>
        </div>
      )}

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
