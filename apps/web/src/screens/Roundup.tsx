'use client';

import { memo, useCallback, useState } from 'react';
import { FplEntryIdSchema, GameweekSchema } from '@fant/shared';
import type {
  FplEntryId,
  FplPlayerId,
  Gameweek,
  GameweekRoundup,
  RoundupBench,
  RoundupCaptain,
  RoundupKing,
  RoundupMover,
  RoundupPlayerPoints,
  RoundupRow,
  RoundupTransfer,
  RoundupTransferPick,
} from '@fant/shared';
import { fmt, plural, useI18n } from '@/i18n';
import { useConfig, useFplIndex, useLeagueRoundup, useLivePollInterval, useMe } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { useQueryParam } from '@/lib/useQueryParam';
import { previewRows, rankCaptains, roundupSections, transferSummary } from '@/lib/roundup';
import { ImageWithFallback, fplImage } from '@/components/FplImages';
import {
  ArrowDownIcon,
  ArrowEndIcon,
  ArrowUpIcon,
  ClockIcon,
  CrownIcon,
  RefreshIcon,
  TableIcon,
} from '@/components/icons';
import { ManagerSheet } from '@/components/lazySheets';
import { CaptainCard, captainKindLabel } from '@/components/team/CaptainCard';
import { ChipIcon } from '@/components/team/ChipIcon';
import { FindMyTeam } from '@/components/team/FindMyTeam';
import { GwSelector } from '@/components/team/TeamParts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Ltr,
  Num,
  SectionTitle,
  Skeleton,
  Spinner,
  cx,
} from '@/components/ui';
import { Movement, NoLeague } from './Table';

/**
 * Gameweek Roundup ("סיכום מחזור") — the League tab's second sub-tab (`/table/?view=roundup&gw=N`). The podcast
 * league's official results for one finished GW, built by the API once FPL marks it official. Every section is
 * optional: a GW without that data simply doesn't show it (never an empty card).
 */
export function RoundupView() {
  const { t } = useI18n();
  const config = useConfig();
  const leagueSet = !!config.data?.league;
  const fpl = useFplIndex();
  const [gwParam, setGwParam] = useQueryParam('gw');
  const parsedGw = GameweekSchema.safeParse(gwParam === null ? undefined : Number(gwParam));
  const requested = parsedGw.success ? parsedGw.data : null;
  const roundup = useLeagueRoundup(requested, leagueSet);
  const data = roundup.data;

  // The picker survives a GW that failed to load (its query has no data): keep the last list of GWs seen.
  const [events, setEvents] = useState<readonly Gameweek[]>([]);
  if (data && data.events !== events) setEvents(data.events);

  const onGw = useCallback((gw: Gameweek) => setGwParam(String(gw)), [setGwParam]);

  if (config.isPending) return <RoundupSkeleton />;
  if (config.isError) return <ErrorState error={config.error} onRetry={() => config.refetch()} />;
  if (!leagueSet) return <NoLeague />;
  if (fpl.isError) return <ErrorState error={fpl.error} onRetry={() => fpl.refetch()} />;

  // While another GW loads, the previous roundup is kept as placeholder: show the GW being opened + a skeleton.
  const switching = roundup.isPlaceholderData;
  const shown = data && !switching ? data : null;
  const event = requested ?? data?.event ?? null;
  const picker =
    event !== null && events.length > 0 ? (
      <GwSelector
        value={event}
        max={Math.max(...events) as Gameweek}
        events={events}
        selectLabel={t.roundup.pickGw}
        onChange={onGw}
      />
    ) : null;

  let body;
  if (roundup.isError && !shown) {
    body = <ErrorState error={roundup.error} onRetry={() => roundup.refetch()} />;
  } else if (!shown || !fpl.index) {
    body = <RoundupBodySkeleton />;
  } else if (shown.status === 'pending') {
    body = (
      <EmptyState
        icon={<ClockIcon width={32} height={32} />}
        title={t.roundup.pendingTitle}
        body={t.roundup.pendingBody}
      />
    );
  } else if (shown.status === 'building') {
    body = (
      <EmptyState
        icon={<Spinner className="size-8" />}
        title={t.roundup.buildingTitle}
        body={t.roundup.buildingBody}
        action={
          <Button variant="secondary" onClick={() => roundup.refetch()} disabled={roundup.isFetching}>
            <RefreshIcon size={18} />
            {t.common.retry}
          </Button>
        }
      />
    );
  } else if (shown.status === 'unavailable') {
    body = (
      <EmptyState
        icon={<TableIcon width={32} height={32} />}
        title={t.roundup.unavailableTitle}
        body={t.roundup.unavailableBody}
      />
    );
  } else {
    body = <ReadyRoundup data={shown} index={fpl.index} />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="roundup" data-status={shown?.status ?? 'loading'}>
      {picker ?? (!roundup.isError && <Skeleton className="h-13 rounded-2xl" />)}
      {body}
    </div>
  );
}

export function RoundupSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true">
      <Skeleton className="h-13 rounded-2xl" />
      <RoundupBodySkeleton />
    </div>
  );
}

function RoundupBodySkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true" data-testid="roundup-skeleton">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-48 rounded-2xl" />
      <Skeleton className="h-24 rounded-2xl" />
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}

// ---------- ready ----------

function ReadyRoundup({ data, index }: { data: GameweekRoundup; index: FplIndex }) {
  const { t, f } = useI18n();
  const show = roundupSections(data);
  const any = Object.values(show).some(Boolean);
  return (
    <>
      <header>
        <h1 className="text-xl font-extrabold text-ink">{fmt(t.roundup.title, { gw: data.event })}</h1>
        {(data.league || data.participants !== null) && (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
            {data.league && (
              <span dir="auto" className="name-start min-w-0 truncate">
                {data.league.name}
              </span>
            )}
            {data.league && data.participants !== null && <span aria-hidden="true">·</span>}
            {data.participants !== null && (
              <span className="shrink-0">{fmt(t.roundup.participants, { n: f.num(data.participants) })}</span>
            )}
          </p>
        )}
      </header>
      {!any && <EmptyState icon={<TableIcon width={32} height={32} />} title={t.roundup.emptyTitle} />}
      {data.king && <KingCard king={data.king} index={index} />}
      {show.averages && data.averages && (
        <Averages league={data.averages.league} world={data.averages.world} />
      )}
      {show.captains && <Captains rows={data.captains} index={index} />}
      {show.table && <RoundupTable data={data} index={index} />}
      {show.movers && <Movers climb={data.biggestClimb} drop={data.biggestDrop} />}
      {data.benchPoints && <BenchCard bench={data.benchPoints} index={index} />}
      {data.bestTransfer && <TransferPickCard pick={data.bestTransfer} best index={index} />}
      {data.worstTransfer && <TransferPickCard pick={data.worstTransfer} best={false} index={index} />}
    </>
  );
}

/** Team name over manager name (any script, truncated). */
function TeamName({
  entryName,
  managerName,
  big = false,
}: {
  entryName: string;
  managerName: string;
  big?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-col">
      <span
        dir="auto"
        className={cx('name-start min-w-0 truncate font-bold text-ink', big ? 'text-lg font-extrabold' : '')}
      >
        {entryName}
      </span>
      <span dir="auto" className="name-start min-w-0 truncate text-xs text-muted">
        {managerName}
      </span>
    </span>
  );
}

function playerOf(index: FplIndex, id: FplPlayerId | null) {
  const player = id === null ? undefined : index.players.get(id);
  return { player, team: player ? index.teams.get(player.teamId) : undefined };
}

function PlayerPhoto({
  index,
  id,
  className,
  fallbackClassName,
}: {
  index: FplIndex;
  id: FplPlayerId | null;
  className: string;
  fallbackClassName: string;
}) {
  const { player } = playerOf(index, id);
  return (
    <ImageWithFallback
      src={player ? fplImage.photo(player.photoCode) : null}
      name={player?.webName ?? '?'}
      fallbackText={player ? undefined : '?'}
      className={className}
      fallbackClassName={fallbackClassName}
    />
  );
}

function playerName(index: FplIndex, id: FplPlayerId): string {
  return index.players.get(id)?.webName ?? '?';
}

// ---------- king ----------

function KingCard({ king, index }: { king: RoundupKing; index: FplIndex }) {
  const { t } = useI18n();
  return (
    <Card className="border-primary ring-2 ring-primary/30" data-testid="roundup-king">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary"
        >
          <CrownIcon size={24} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-xs font-extrabold text-primary">{t.roundup.king}</h2>
          <TeamName entryName={king.entryName} managerName={king.managerName} big />
          {(king.chip || king.benchBoostPoints !== null) && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {king.chip && <ChipIcon chip={king.chip} withName size="md" />}
              {king.benchBoostPoints !== null && (
                <Badge tone="warning">
                  <span className="sr-only">
                    {fmt(t.roundup.benchBoostAdded, { n: king.benchBoostPoints })}
                  </span>
                  <span aria-hidden="true">
                    <Num value={king.benchBoostPoints} signed />
                  </span>
                </Badge>
              )}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-center rounded-2xl bg-primary px-3 py-2 text-on-primary">
          <span className="text-3xl leading-none font-extrabold">
            <Num value={king.points} />
          </span>
          <span className="mt-1 text-[11px] font-semibold opacity-90">{t.myTeam.gwPoints}</span>
        </div>
      </div>
      {king.topPlayers.length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-xs font-bold text-muted">{t.roundup.topPlayers}</h3>
          <ul className="grid grid-cols-4 gap-2">
            {king.topPlayers.map((p) => (
              <PlayerTile
                key={p.playerId}
                p={p}
                index={index}
                captain={p.playerId === king.captainPlayerId}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function PlayerTile({ p, index, captain }: { p: RoundupPlayerPoints; index: FplIndex; captain: boolean }) {
  const { t } = useI18n();
  return (
    <li
      className="relative flex min-w-0 flex-col items-center gap-1 rounded-xl bg-surface-2 px-1 pt-2 pb-1.5"
      data-captain={captain ? 'true' : undefined}
    >
      {captain && (
        <span
          role="img"
          aria-label={t.roundup.captain}
          title={t.roundup.captain}
          className="absolute start-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-extrabold text-on-primary"
        >
          C
        </span>
      )}
      <PlayerPhoto
        index={index}
        id={p.playerId}
        className="h-12 w-10 rounded-lg object-cover object-top"
        fallbackClassName="size-10 text-xs"
      />
      <span dir="auto" className="w-full truncate text-center text-[11px] font-semibold text-ink">
        {playerName(index, p.playerId)}
      </span>
      <span className="text-base leading-none font-extrabold text-primary">
        <Num value={p.points} />
      </span>
    </li>
  );
}

// ---------- averages ----------

function Averages({ league, world }: { league: number | null; world: number | null }) {
  const { t, f } = useI18n();
  return (
    <Card data-testid="roundup-averages">
      <SectionTitle>{t.roundup.averages}</SectionTitle>
      <dl className="grid grid-cols-2 gap-2">
        <div className="flex flex-col rounded-xl bg-primary-soft px-3 py-2">
          <dt className="text-xs font-semibold text-on-primary-soft">{t.roundup.leagueAverage}</dt>
          <dd className="text-2xl font-extrabold text-on-primary-soft tabular">
            {league === null ? '—' : <Ltr>{f.decimal(league, 1)}</Ltr>}
          </dd>
        </div>
        <div className="flex flex-col rounded-xl bg-surface-2 px-3 py-2">
          <dt className="text-xs font-semibold text-muted">{t.roundup.worldAverage}</dt>
          <dd className="text-2xl font-extrabold text-ink">
            <Num value={world} />
          </dd>
        </div>
      </dl>
    </Card>
  );
}

// ---------- captain battle ----------

function Captains({ rows, index }: { rows: readonly RoundupCaptain[]; index: FplIndex }) {
  const { t } = useI18n();
  return (
    <section data-testid="roundup-captains">
      <SectionTitle>{t.liveAction.viewCaptains}</SectionTitle>
      <ol className="flex flex-col gap-2">
        {rankCaptains(rows).map(({ row, rank }) => (
          <RoundupCaptainRow key={row.key} row={row} rank={rank} index={index} />
        ))}
      </ol>
    </section>
  );
}

function RoundupCaptainRow({
  row,
  rank,
  index,
}: {
  row: RoundupCaptain;
  rank: number | null;
  index: FplIndex;
}) {
  const { t } = useI18n();
  const { player, team } = playerOf(index, row.playerId);
  return (
    <CaptainCard
      rank={rank}
      player={player}
      team={team}
      kindLabel={captainKindLabel(t, row.kind)}
      label={row.label}
      mine={row.kind === 'mine'}
      multiplier={row.multiplier}
      points={row.playerId === null ? null : row.captainPoints}
      fallback={<span className="text-sm text-muted">{t.roundup.noCaptain}</span>}
    />
  );
}

// ---------- table ----------

function RoundupTable({ data, index }: { data: GameweekRoundup; index: FplIndex }) {
  const { t } = useI18n();
  const me = useMe();
  const myEntry = me.data?.entryId ?? null;
  const { interval } = useLivePollInterval();
  // Expanded per GW: opening another GW starts collapsed again.
  const [expandedGw, setExpandedGw] = useState<number | null>(null);
  const expanded = expandedGw === data.event;
  const rows = previewRows(data.table, expanded);
  // Rows the collapsed table leaves out (0 = the whole table fits: no button).
  const hidden = data.table.length - previewRows(data.table, false).length;
  const [entryParam, setEntryParam] = useQueryParam('entry');
  const selectedId = FplEntryIdSchema.safeParse(entryParam ?? undefined);
  const selected = selectedId.success ? data.table.find((r) => r.entryId === selectedId.data) : undefined;
  const openEntry = useCallback((id: FplEntryId) => setEntryParam(String(id)), [setEntryParam]);
  const mineInTable = myEntry !== null && data.table.some((r) => r.entryId === myEntry);

  return (
    <section data-testid="roundup-table">
      <SectionTitle>{t.roundup.table}</SectionTitle>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_3rem_3.5rem] items-center gap-2 border-b border-line px-3 py-2 text-xs font-semibold text-muted">
          <span>{t.table.rank}</span>
          <span>{t.table.team}</span>
          <span className="text-center">{t.table.gwPts}</span>
          <span className="text-end">{t.table.total}</span>
        </div>
        <ol className="divide-y divide-line">
          {rows.map((r) => (
            <RoundupRowItem
              key={r.entryId}
              row={r}
              index={index}
              mine={r.entryId === myEntry}
              onOpen={openEntry}
            />
          ))}
        </ol>
      </div>
      {hidden > 0 && (
        <Button
          variant="secondary"
          block
          className="mt-2"
          aria-expanded={expanded}
          onClick={() => setExpandedGw(expanded ? null : data.event)}
          data-testid="roundup-show-all"
        >
          {expanded ? t.roundup.showLess : fmt(t.roundup.showAll, { n: hidden })}
        </Button>
      )}
      <FindMyTeam
        enabled={mineInTable}
        loadPage={async () => setExpandedGw(data.event)}
        rankOf={(id) => data.table.find((r) => r.entryId === id)?.rank ?? null}
        rowsKey={rows.length}
      />
      <ManagerSheet
        entryId={selected ? selected.entryId : null}
        title={selected?.managerName ?? ''}
        event={data.event}
        index={index}
        liveInterval={interval}
        onClose={() => setEntryParam(null)}
      />
    </section>
  );
}

/**
 * One roundup table row. A phone can't fit rank / team / captain / transfers / GW / total as columns, so the
 * team cell stacks: team + chip, manager, captain (photo + name), and that GW's transfers.
 */
const RoundupRowItem = memo(function RoundupRowItem({
  row: r,
  index,
  mine,
  onOpen,
}: {
  row: RoundupRow;
  index: FplIndex;
  mine: boolean;
  onOpen(entryId: FplEntryId): void;
}) {
  const { t } = useI18n();
  const captain = r.captainPlayerId === null ? undefined : index.players.get(r.captainPlayerId);
  return (
    <li className="table-row" data-entry={r.entryId} data-mine={mine ? 'true' : undefined}>
      <button
        type="button"
        onClick={() => onOpen(r.entryId)}
        aria-label={fmt(t.table.openTeam, { name: r.managerName })}
        className={cx(
          'grid min-h-16 w-full grid-cols-[2.75rem_minmax(0,1fr)_3rem_3.5rem] items-start gap-2 px-3 py-2.5 text-start hover:bg-surface-2',
          mine && 'bg-primary-soft',
        )}
      >
        <span className="flex items-center gap-1 pt-0.5 font-bold text-ink">
          <Num value={r.rank} />
          <Movement rank={r.rank} lastRank={r.lastRank} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span dir="auto" className="name-start min-w-0 truncate font-semibold text-ink">
                {r.entryName}
              </span>
              {r.chip && <ChipIcon chip={r.chip} />}
            </span>
            <span dir="auto" className="name-start truncate text-xs text-muted">
              {r.managerName}
            </span>
          </span>
          {captain && (
            <span
              className="flex min-w-0 items-center gap-1.5 text-xs text-ink"
              data-testid="roundup-captain"
            >
              <ImageWithFallback
                src={fplImage.photo(captain.photoCode)}
                name={captain.webName}
                className="size-6 shrink-0 rounded-full bg-surface-2 object-cover object-top"
                fallbackClassName="size-6 text-[9px]"
              />
              <span className="sr-only">{t.roundup.captain}:</span>
              <span dir="auto" className="name-start min-w-0 truncate font-semibold">
                {captain.webName}
              </span>
              <Badge tone="primary" className="px-1.5 py-0 text-[10px]">
                <span aria-hidden="true">C</span>
              </Badge>
            </span>
          )}
          <Transfers transfers={r.transfers} cost={r.transferCost} index={index} />
        </span>
        <span className="pt-0.5 text-center text-lg leading-tight font-extrabold text-primary">
          <Num value={r.eventPoints} />
        </span>
        <span className="pt-0.5 text-end font-bold text-ink">
          <Num value={r.total} />
        </span>
      </button>
    </li>
  );
});

/** "out → in" for one or two transfers (the arrow points toward the reading end), else "N transfers"; plus the hit. */
function Transfers({
  transfers,
  cost,
  index,
}: {
  transfers: readonly RoundupTransfer[];
  cost: number;
  index: FplIndex;
}) {
  const { t } = useI18n();
  const summary = transferSummary(transfers);
  if (summary.kind === 'none' && cost === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted"
      data-testid="roundup-transfers"
    >
      {summary.kind === 'list' &&
        summary.items.map((tr) => {
          const out = playerName(index, tr.playerOut);
          const inn = playerName(index, tr.playerIn);
          return (
            <span
              key={`${tr.playerOut}-${tr.playerIn}`}
              className="inline-flex min-w-0 items-center gap-0.5"
              role="img"
              aria-label={fmt(t.roundup.transfer, { out, in: inn })}
            >
              <bdi className="truncate">{out}</bdi>
              <ArrowEndIcon size={12} strokeWidth={2.4} className="shrink-0" />
              <bdi className="truncate font-semibold text-ink">{inn}</bdi>
            </span>
          );
        })}
      {summary.kind === 'count' && <span>{fmt(t.roundup.transfersCount, { n: summary.n })}</span>}
      {cost > 0 && <Hit cost={cost} />}
    </span>
  );
}

function Hit({ cost }: { cost: number }) {
  const { t } = useI18n();
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-md bg-live-soft px-1 text-[10px] font-bold text-live"
      title={fmt(t.roundup.hitLabel, { n: cost })}
      data-testid="roundup-hit"
    >
      {fmt(t.roundup.hit, { n: cost })}
    </span>
  );
}

// ---------- movers ----------

function Movers({ climb, drop }: { climb: RoundupMover | null; drop: RoundupMover | null }) {
  const both = climb !== null && drop !== null;
  return (
    <div className="grid grid-cols-2 gap-3" data-testid="roundup-movers">
      {climb && <MoverCard mover={climb} up wide={!both} />}
      {drop && <MoverCard mover={drop} up={false} wide={!both} />}
    </div>
  );
}

function MoverCard({ mover, up, wide }: { mover: RoundupMover; up: boolean; wide: boolean }) {
  const { t } = useI18n();
  const places = up
    ? plural(mover.places, t.roundup.placesUpOne, t.roundup.placesUp)
    : plural(mover.places, t.roundup.placesDownOne, t.roundup.placesDown);
  return (
    <Card
      className={cx('flex min-w-0 flex-col gap-2 p-3', wide && 'col-span-2')}
      data-testid={up ? 'roundup-climb' : 'roundup-drop'}
    >
      <h2 className="flex items-center gap-1.5 text-xs font-extrabold text-ink">
        <span
          aria-hidden="true"
          className={cx(
            'flex size-6 shrink-0 items-center justify-center rounded-full',
            up ? 'bg-success-soft text-success' : 'bg-live-soft text-live',
          )}
        >
          {up ? <ArrowUpIcon size={14} strokeWidth={2.6} /> : <ArrowDownIcon size={14} strokeWidth={2.6} />}
        </span>
        <span className="min-w-0 truncate">{up ? t.roundup.climb : t.roundup.drop}</span>
      </h2>
      <TeamName entryName={mover.entryName} managerName={mover.managerName} />
      <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
        <span className={cx('font-bold', up ? 'text-success' : 'text-live')}>{places}</span>
        <span className="text-xs text-muted">
          <Num value={mover.eventPoints} /> {t.common.pts}
        </span>
      </p>
    </Card>
  );
}

// ---------- bench ----------

function BenchCard({ bench, index }: { bench: RoundupBench; index: FplIndex }) {
  const { t } = useI18n();
  return (
    <Card data-testid="roundup-bench">
      <SectionTitle
        action={
          <span className="text-2xl leading-none font-extrabold text-primary">
            <Num value={bench.points} />
          </span>
        }
      >
        {t.roundup.bench}
      </SectionTitle>
      <TeamName entryName={bench.entryName} managerName={bench.managerName} />
      {bench.players.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {bench.players.map((p) => (
            <li
              key={p.playerId}
              className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full bg-surface-2 ps-0.5 pe-2.5 text-xs"
            >
              <PlayerPhoto
                index={index}
                id={p.playerId}
                className="size-7 shrink-0 rounded-full bg-surface object-cover object-top"
                fallbackClassName="size-7 text-[9px]"
              />
              <span dir="auto" className="min-w-0 truncate font-semibold text-ink">
                {playerName(index, p.playerId)}
              </span>
              <span className="font-extrabold text-primary">
                <Num value={p.points} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------- best / worst transfer ----------

function TransferPickCard({
  pick,
  best,
  index,
}: {
  pick: RoundupTransferPick;
  best: boolean;
  index: FplIndex;
}) {
  const { t } = useI18n();
  return (
    <Card data-testid={best ? 'roundup-best-transfer' : 'roundup-worst-transfer'}>
      <SectionTitle
        action={
          <Badge tone={pick.gain > 0 ? 'success' : pick.gain < 0 ? 'live' : 'neutral'} className="text-sm">
            <span className="sr-only">{t.roundup.gain}</span>
            <Num value={pick.gain} signed />
          </Badge>
        }
      >
        {best ? t.roundup.bestTransfer : t.roundup.worstTransfer}
      </SectionTitle>
      <div className="flex items-end justify-between gap-2">
        <TeamName entryName={pick.entryName} managerName={pick.managerName} />
        {pick.transferCost > 0 && <Hit cost={pick.transferCost} />}
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <TransferSide p={pick.playerOut} caption={t.roundup.playerOut} index={index} />
        <ArrowEndIcon size={20} className="text-muted" />
        <TransferSide p={pick.playerIn} caption={t.roundup.playerIn} index={index} highlight />
      </div>
    </Card>
  );
}

function TransferSide({
  p,
  caption,
  index,
  highlight = false,
}: {
  p: RoundupPlayerPoints;
  caption: string;
  index: FplIndex;
  highlight?: boolean;
}) {
  return (
    <div
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-xl px-2 py-1.5',
        highlight ? 'bg-primary-soft' : 'bg-surface-2',
      )}
    >
      <PlayerPhoto
        index={index}
        id={p.playerId}
        className="h-11 w-9 shrink-0 rounded-md object-cover object-top"
        fallbackClassName="size-9 text-[10px]"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-[10px] font-semibold text-muted">{caption}</span>
        <span dir="auto" className="name-start min-w-0 truncate text-sm font-bold text-ink">
          {playerName(index, p.playerId)}
        </span>
        <span className="text-xs font-extrabold text-primary">
          <Num value={p.points} />
        </span>
      </span>
    </div>
  );
}
