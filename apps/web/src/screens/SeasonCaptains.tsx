'use client';

import { memo, useCallback, useState } from 'react';
import { FplEntryIdSchema } from '@fant/shared';
import type { FplEntryId, SeasonCaptainRow } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useConfig, useFplIndex, useLivePollInterval, useMe } from '@/lib/queries';
import { useSeasonCaptains } from '@/lib/seasonCaptains';
import { gapKind, isStar, seasonPreview, seasonSummary, starPhoto } from '@/lib/season';
import type { StarLine } from '@/lib/season';
import { useQueryParam } from '@/lib/useQueryParam';
import { ClockIcon, RefreshIcon, TableIcon } from '@/components/icons';
import { ManagerSheet } from '@/components/lazySheets';
import { CaptainTag, useCaptainBadge } from '@/components/team/CaptainCard';
import { FindMyTeam } from '@/components/team/FindMyTeam';
import { STAR_PHOTOS } from '@/lib/clientConfig';
import { initials } from '@/lib/text';
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
      <span className={cx('flex items-center font-bold', star ? 'text-primary' : 'text-ink')}>
        {mine ? (
          <span
            className="inline-flex min-w-8 justify-center rounded-full bg-gold px-1.5 py-0.5 text-on-gold"
            data-testid="my-rank-gold"
          >
            <Num value={r.rank} />
          </span>
        ) : (
          <Num value={r.rank} />
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        {special && <CaptainTag badge={badge} />}
        {r.host !== null && (
          <span
            className="self-start rounded-full bg-primary px-2 text-[10px] leading-4 font-bold text-on-primary"
            data-testid="host-badge"
          >
            {r.host === 'dor' ? t.season.hostDor : t.season.hostItay}
          </span>
        )}
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
    // Stars: a primary tint and a primary start edge. The viewer's own row: a flat gold start edge (no tint).
    star && 'bg-primary-soft/55',
    (star || mine) && 'border-s-4',
    mine ? 'border-gold' : star && 'border-primary',
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
          className={cx(cls, !star && !mine && 'hover:bg-surface-2')}
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

/** Round avatar for a star: a photo (hosts, once configured), the app logo, the FPL Lad chip, or initials. */
function StarAvatar({ row, name }: { row: SeasonCaptainRow; name: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState<string | null>(null);
  const base =
    'relative flex size-12 items-center justify-center overflow-hidden rounded-full font-extrabold';
  if (row.kind === 'fpl_lad') {
    // The wordmark cropped to "FPL" on the light chip.
    return (
      <span
        role="img"
        aria-label={t.liveAction.fplLadAlt}
        className={cx(
          base,
          'bg-logo-chip bg-[url(/brand/fpl-lad.png)] bg-[length:200%_auto] bg-[position:2px_center] bg-no-repeat',
        )}
      />
    );
  }
  const src =
    row.kind === 'community'
      ? '/brand/logo-320.png'
      : row.host !== null
        ? starPhoto(STAR_PHOTOS[row.host], failed)
        : null;
  if (src !== null)
    return (
      <span className={cx(base, 'bg-primary-soft')}>
        <img
          src={src}
          alt={name}
          width={48}
          height={48}
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(src)}
          className="size-full object-cover"
        />
      </span>
    );
  return (
    <span aria-hidden="true" className={cx(base, 'bg-primary-soft text-sm text-on-primary-soft')}>
      <bdi dir="auto">{initials(name)}</bdi>
    </span>
  );
}

function GapPill({ gap }: { gap: number }) {
  const { t } = useI18n();
  const kind = gapKind(gap);
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 text-[11px] leading-[18px] font-bold whitespace-nowrap',
        kind === 'ahead' && 'bg-success/15 text-success',
        kind === 'behind' && 'bg-live/10 text-live',
        kind === 'level' && 'bg-surface-2 text-muted',
      )}
      aria-label={t.season.gap}
    >
      {kind === 'level' ? (
        t.season.level
      ) : (
        <>
          <Num value={gap} signed />
          <span aria-hidden="true" className="text-[7px]">
            {kind === 'ahead' ? '▲' : '▼'}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * "You vs. the stars": a hero strip with the viewer's rank and points (only when they are in the league), then four
 * round avatars (Dor, Itay, the community captain, FPL Lad) in rank order, each with a rank pill, the points and the
 * point gap from the viewer's side. Tapping one scrolls to its row.
 */
function SeasonSummary({
  summary: { me, stars },
  onJump,
}: {
  summary: { me: SeasonCaptainRow | null; stars: StarLine<SeasonCaptainRow>[] };
  onJump(key: string): void;
}) {
  const { t } = useI18n();
  const meQuery = useMe().data;
  if (stars.length === 0 && me === null) return null;
  return (
    <section
      className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
      aria-labelledby="season-stars-title"
      data-testid="season-summary"
    >
      {me && (
        <button
          type="button"
          onClick={() => onJump(me.key)}
          data-testid="season-me"
          className="flex min-h-16 w-full items-center gap-3 bg-primary-soft px-4 py-3 text-start text-on-primary-soft"
        >
          <span
            aria-hidden="true"
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-base font-extrabold text-on-primary"
          >
            <bdi dir="auto">{initials(meQuery?.name ?? '') || '·'}</bdi>
          </span>
          <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <span className="text-xs font-semibold opacity-80">{t.season.yourRank}</span>
            <span
              dir="ltr"
              className="rounded-xl bg-gold px-2.5 py-0.5 text-3xl leading-tight font-extrabold text-on-gold"
              data-testid="season-me-rank"
            >
              #<Num value={me.rank} />
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end">
            <span className="text-3xl leading-none font-extrabold" data-testid="season-me-points">
              <Num value={me.points} />
            </span>
            <span className="mt-1 text-xs font-semibold opacity-80">{t.liveAction.captainPts}</span>
          </span>
        </button>
      )}
      <div className="px-2 pt-3 pb-3">
        <h2 id="season-stars-title" className="mb-2.5 px-2 text-[13px] font-bold text-muted">
          {t.season.starsTitle}
        </h2>
        <ul className="flex gap-0.5">
          {stars.map(({ row, gap, mine }) => {
            const name =
              row.host === 'dor' ? t.season.hostDor : row.host === 'itay' ? t.season.hostItay : row.name;
            return (
              <li key={row.key} className="min-w-0 flex-1" data-testid="season-star" data-key={row.key}>
                <button
                  type="button"
                  onClick={() => onJump(row.key)}
                  className="flex min-h-11 w-full flex-col items-center gap-1.5"
                >
                  <span className="relative pb-2.5">
                    <span className="block rounded-full border-2 border-primary p-0.5">
                      <StarAvatar row={row} name={name} />
                    </span>
                    <span className="absolute inset-x-0 bottom-0 flex justify-center">
                      <span
                        dir="ltr"
                        className="rounded-full bg-primary px-2 text-[10px] leading-4 font-bold whitespace-nowrap text-on-primary"
                        data-testid="star-rank"
                      >
                        #<Num value={row.rank} />
                      </span>
                    </span>
                  </span>
                  <span
                    dir="auto"
                    className="line-clamp-2 flex min-h-[29px] items-center text-center text-xs leading-tight font-bold text-ink"
                  >
                    {name}
                  </span>
                  <span className="text-xs font-semibold text-muted" data-testid="star-points">
                    <Num value={row.points} />
                  </span>
                  <span data-testid="season-gap" data-gap={gap === null ? undefined : gapKind(gap)}>
                    {gap !== null ? (
                      <GapPill gap={gap} />
                    ) : mine ? (
                      <span className="rounded-full bg-gold px-2 text-[11px] leading-[18px] font-bold text-on-gold">
                        {t.season.you}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
