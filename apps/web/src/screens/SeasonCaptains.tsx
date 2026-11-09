'use client';

import { memo, useCallback, useState } from 'react';
import { FplEntryIdSchema } from '@fant/shared';
import type { FplEntryId, SeasonCaptainRow } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useConfig, useFplIndex, useLivePollInterval, useMe } from '@/lib/queries';
import { useSeasonCaptains } from '@/lib/seasonCaptains';
import { gapKind, isStar, seasonPreview, seasonSummary } from '@/lib/season';
import type { StarLine } from '@/lib/season';
import { useQueryParam } from '@/lib/useQueryParam';
import { ClockIcon, RefreshIcon, TableIcon } from '@/components/icons';
import { ManagerSheet } from '@/components/lazySheets';
import { CaptainTag, useCaptainBadge } from '@/components/team/CaptainCard';
import { FindMyTeam } from '@/components/team/FindMyTeam';
import { Badge, Button, EmptyState, ErrorState, Num, Skeleton, Spinner, cx } from '@/components/ui';
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
        body={t.roundup.buildingBody}
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
        <h1 className="text-xl font-extrabold text-ink">{t.roundup.viewSeason}</h1>
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
  const { items, hidden } = seasonPreview(all, myEntry, expanded);
  const shown = items.reduce((n, i) => n + (i.type === 'row' ? 1 : 0), 0);
  const summary = seasonSummary(all, myEntry);
  // Summary line tapped: bring that row (always in the preview; expand first if not) to the middle of the screen.
  const jump = useCallback((key: string) => {
    const find = () => document.querySelector<HTMLElement>(`[data-testid=season-list] li[data-key="${key}"]`);
    const go = (el: HTMLElement) => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('row-pulse');
      void el.offsetWidth;
      el.classList.add('row-pulse');
      window.setTimeout(() => el.classList.remove('row-pulse'), 1_600);
    };
    const el = find();
    if (el) go(el);
    else {
      setExpanded(true);
      requestAnimationFrame(() => requestAnimationFrame(() => find() && go(find() as HTMLElement)));
    }
  }, []);
  const [entryParam, setEntryParam] = useQueryParam('entry');
  const selectedId = FplEntryIdSchema.safeParse(entryParam ?? undefined);
  const selected = selectedId.success ? all.find((r) => r.entryId === selectedId.data) : undefined;
  const openEntry = useCallback((id: FplEntryId) => setEntryParam(String(id)), [setEntryParam]);
  const mineInList = myEntry !== null && all.some((r) => r.entryId === myEntry);

  return (
    <>
      <SeasonSummary summary={summary} onJump={jump} />
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_4.5rem] items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
          <span>{t.table.rank}</span>
          <span>{t.table.team}</span>
          <span className="text-end">{t.liveAction.captainPts}</span>
        </div>
        <ol className="divide-y divide-line" data-testid="season-list">
          {items.map((it) =>
            it.type === 'gap' ? (
              <li
                key={it.key}
                aria-hidden="true"
                data-gap=""
                className="py-0.5 text-center text-sm leading-none text-muted"
              >
                ⋮
              </li>
            ) : (
              <SeasonRow
                key={it.row.key}
                row={it.row}
                mine={it.row.entryId !== null && it.row.entryId === myEntry}
                onOpen={openEntry}
              />
            ),
          )}
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
        rowsKey={shown}
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
  const star = isStar(r);
  const badge = useCaptainBadge({ kind: r.kind === 'manager' ? 'custom' : r.kind, tag: r.tag });
  const gws = r.gameweeks === 1 ? t.season.gwsOne : fmt(t.season.gws, { n: r.gameweeks });
  const body = (
    <>
      <span className="flex items-center font-bold text-ink">
        <Num value={r.rank} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {special && <CaptainTag badge={badge} />}
        {r.host !== null && <HostBadge host={r.host} />}
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
    star && 'border-s-4 border-star-edge bg-star-soft',
    mine && 'ring-2 ring-inset ring-primary',
    mine && !star && 'bg-primary-soft',
  );
  return (
    <li
      data-key={r.key}
      data-entry={r.entryId ?? undefined}
      data-kind={r.kind}
      data-host={r.host ?? undefined}
      data-star={star ? 'true' : undefined}
      data-mine={mine ? 'true' : undefined}
    >
      {r.entryId !== null ? (
        <button
          type="button"
          onClick={() => onOpen(r.entryId as FplEntryId)}
          aria-label={fmt(t.table.openTeam, { name: r.subtitle ?? r.name })}
          className={cx(cls, !star && 'hover:bg-surface-2')}
        >
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
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

function HostBadge({ host }: { host: 'dor' | 'itay' }) {
  const { t } = useI18n();
  return (
    <Badge tone="warning" className="self-start px-1.5 py-0 text-[10px]">
      {host === 'dor' ? t.season.hostDor : t.season.hostItay}
    </Badge>
  );
}

/** "You vs. the stars": the viewer's rank (when in the league) and one line per highlighted row, with the point gap. */
function SeasonSummary({
  summary: { me, stars },
  onJump,
}: {
  summary: { me: SeasonCaptainRow | null; stars: StarLine<SeasonCaptainRow>[] };
  onJump(key: string): void;
}) {
  const { t } = useI18n();
  if (stars.length === 0 && me === null) return null;
  const iso = (n: number) => `\u2066${n}\u2069`;
  return (
    <section
      className="flex flex-col gap-1.5 rounded-2xl border border-line bg-surface p-3 shadow-card"
      aria-labelledby="season-stars-title"
      data-testid="season-summary"
    >
      <h2 id="season-stars-title" className="text-sm font-bold text-ink">
        {t.season.starsTitle}
      </h2>
      {me && (
        <button
          type="button"
          onClick={() => onJump(me.key)}
          data-testid="season-me"
          className="min-h-11 rounded-xl bg-primary-soft px-3 text-start text-base font-extrabold text-primary"
        >
          {fmt(t.season.yourRank, { n: iso(me.rank), p: iso(me.points) })}
        </button>
      )}
      <ul className="flex flex-col gap-1">
        {stars.map(({ row, gap, mine }) => {
          const name =
            row.host === 'dor' ? t.season.hostDor : row.host === 'itay' ? t.season.hostItay : row.name;
          const kind = gap === null ? null : gapKind(gap);
          return (
            <li key={row.key} data-testid="season-star" data-key={row.key}>
              <button
                type="button"
                onClick={() => onJump(row.key)}
                className="grid min-h-11 w-full grid-cols-[2.75rem_minmax(0,1fr)_auto_3.5rem] items-center gap-2 rounded-xl border-s-4 border-star-edge bg-star-soft px-2 text-start"
              >
                <span dir="ltr" className="text-start font-extrabold text-ink">
                  #<Num value={row.rank} />
                </span>
                <span dir="auto" className="name-start min-w-0 truncate text-sm font-semibold text-ink">
                  {name}
                  {mine && <span className="text-muted"> · {t.season.you}</span>}
                </span>
                <span className="font-bold text-ink">
                  <Num value={row.points} />
                </span>
                <span
                  className="flex flex-col items-end leading-tight"
                  data-gap={kind ?? undefined}
                  data-testid="season-gap"
                >
                  {gap !== null && kind !== null && (
                    <>
                      <span className="text-[10px] text-muted">{t.season.gap}</span>
                      <span
                        className={cx(
                          'text-sm font-extrabold',
                          kind === 'ahead' && 'text-success',
                          kind === 'behind' && 'text-live',
                          kind === 'level' && 'text-muted',
                        )}
                      >
                        {kind === 'level' ? t.season.level : <Num value={gap} signed />}
                      </span>
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
