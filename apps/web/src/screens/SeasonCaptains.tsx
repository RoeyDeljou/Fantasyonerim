'use client';

import { memo, useCallback, useState } from 'react';
import { FplEntryIdSchema } from '@fant/shared';
import type { FplEntryId, SeasonCaptainRow } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useConfig, useFplIndex, useLivePollInterval, useMe, useSeasonCaptains } from '@/lib/queries';
import { previewRows } from '@/lib/roundup';
import { useQueryParam } from '@/lib/useQueryParam';
import { ClockIcon, RefreshIcon, TableIcon } from '@/components/icons';
import { ManagerSheet } from '@/components/lazySheets';
import { CaptainTag, useCaptainBadge } from '@/components/team/CaptainCard';
import { FindMyTeam } from '@/components/team/FindMyTeam';
import { Button, EmptyState, ErrorState, Num, Skeleton, Spinner, cx } from '@/components/ui';
import { NoLeague } from './Table';

/**
 * Season Captain Battle ("קרב קפטנים עונתי") — the Mini League tab's third sub-tab (`/table/?view=season`). Ranks the
 * league's teams and the two permanent special captains (the community's and FPL Lad's) by TOTAL captain points over
 * the season, not by wins. Its own chunk (like the roundup): fans who only open the table never download it.
 */
export function SeasonView() {
  const { t } = useI18n();
  const config = useConfig();
  const leagueSet = !!config.data?.league;
  const season = useSeasonCaptains(leagueSet);
  const data = season.data;

  if (config.isPending) return <SeasonSkeleton />;
  if (config.isError) return <ErrorState error={config.error} onRetry={() => config.refetch()} />;
  if (!leagueSet) return <NoLeague />;
  if (!data) {
    if (season.isError) return <ErrorState error={season.error} onRetry={() => season.refetch()} />;
    return <SeasonSkeleton />;
  }
  if (data.status === 'unavailable') return <NoLeague />;
  if (data.status === 'building') {
    return (
      <EmptyState
        icon={<Spinner className="size-8" />}
        title={t.season.buildingTitle}
        body={t.season.buildingBody}
        action={
          <Button variant="secondary" onClick={() => season.refetch()} disabled={season.isFetching}>
            <RefreshIcon size={18} />
            {t.common.retry}
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="season-captains">
      <header>
        <h1 className="text-xl font-extrabold text-ink">{t.season.title}</h1>
        {data.throughEvent !== null && (
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted" data-testid="season-subtitle">
            <ClockIcon width={14} height={14} className="shrink-0" />
            {fmt(t.season.subtitle, { gw: data.throughEvent })}
          </p>
        )}
        <p className="mt-1 text-xs leading-relaxed text-muted">{t.season.explain}</p>
      </header>
      {data.rows.length === 0 ? (
        <EmptyState
          icon={<TableIcon width={32} height={32} />}
          title={t.season.emptyTitle}
          body={t.season.emptyBody}
        />
      ) : (
        <SeasonList rows={data.rows} />
      )}
    </div>
  );
}

function SeasonList({ rows: all }: { rows: readonly SeasonCaptainRow[] }) {
  const { t } = useI18n();
  const me = useMe();
  const fpl = useFplIndex();
  const { interval } = useLivePollInterval();
  const myEntry = me.data?.entryId ?? null;
  const [expanded, setExpanded] = useState(false);
  const rows = previewRows(all, expanded);
  const hidden = all.length - previewRows(all, false).length;
  const [entryParam, setEntryParam] = useQueryParam('entry');
  const selectedId = FplEntryIdSchema.safeParse(entryParam ?? undefined);
  const selected = selectedId.success ? all.find((r) => r.entryId === selectedId.data) : undefined;
  const openEntry = useCallback((id: FplEntryId) => setEntryParam(String(id)), [setEntryParam]);
  const mineInList = myEntry !== null && all.some((r) => r.entryId === myEntry);

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
          <span>{t.table.rank}</span>
          <span>{t.table.team}</span>
          <span className="text-end">{t.liveAction.captainPts}</span>
        </div>
        <ol className="divide-y divide-line" data-testid="season-list">
          {rows.map((r) => (
            <SeasonRow
              key={r.key}
              row={r}
              mine={r.entryId !== null && r.entryId === myEntry}
              onOpen={openEntry}
            />
          ))}
        </ol>
      </div>
      {hidden > 0 && (
        <Button
          variant="secondary"
          block
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="season-show-all"
        >
          {expanded ? t.roundup.showLess : fmt(t.roundup.showAll, { n: hidden })}
        </Button>
      )}
      <FindMyTeam
        enabled={mineInList}
        loadPage={async () => setExpanded(true)}
        rankOf={(id) => all.find((r) => r.entryId === id)?.rank ?? null}
        rowsKey={rows.length}
      />
      <ManagerSheet
        entryId={selected && selected.entryId !== null ? selected.entryId : null}
        title={selected?.subtitle ?? selected?.name ?? ''}
        event={fpl.index?.bootstrap.currentEvent ?? null}
        index={fpl.index}
        liveInterval={interval}
        onClose={() => setEntryParam(null)}
      />
    </>
  );
}

const SeasonRow = memo(function SeasonRow({
  row: r,
  mine,
  onOpen,
}: {
  row: SeasonCaptainRow;
  mine: boolean;
  onOpen(entryId: FplEntryId): void;
}) {
  const { t } = useI18n();
  const special = r.kind !== 'manager';
  const badge = useCaptainBadge({ kind: r.kind === 'manager' ? 'custom' : r.kind, tag: r.tag });
  const gws = r.gameweeks === 1 ? t.season.gwsOne : fmt(t.season.gws, { n: r.gameweeks });
  const body = (
    <>
      <span className="flex items-center font-bold text-ink">
        <Num value={r.rank} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {special && <CaptainTag badge={badge} />}
        <span dir="auto" className="name-start min-w-0 truncate font-semibold text-ink">
          {r.name}
        </span>
        {r.subtitle !== null && (
          <span dir="auto" className="name-start truncate text-xs text-muted">
            {r.subtitle}
          </span>
        )}
        <span className="text-[11px] text-muted">{gws}</span>
      </span>
      <span className="text-end text-2xl leading-none font-extrabold text-primary">
        <Num value={r.points} />
      </span>
    </>
  );
  const cls = cx(
    'grid min-h-16 w-full grid-cols-[2.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 px-3 py-2.5 text-start',
    mine && 'bg-primary-soft',
    special && !mine && 'bg-surface-2',
  );
  return (
    <li data-entry={r.entryId ?? undefined} data-kind={r.kind} data-mine={mine ? 'true' : undefined}>
      {r.entryId !== null ? (
        <button
          type="button"
          onClick={() => onOpen(r.entryId as FplEntryId)}
          aria-label={fmt(t.table.openTeam, { name: r.subtitle ?? r.name })}
          className={cx(cls, 'hover:bg-surface-2')}
        >
          {body}
        </button>
      ) : (
        <div className={cx(cls, 'border-s-4 border-accent')}>{body}</div>
      )}
    </li>
  );
});

function SeasonSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true" data-testid="season-skeleton">
      <Skeleton className="h-8 w-56" />
      {Array.from({ length: 7 }, (_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}
