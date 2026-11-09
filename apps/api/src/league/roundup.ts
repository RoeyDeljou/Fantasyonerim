import {
  buildGameweekRoundup,
  FPL_CACHE_TTL,
  mapWithConcurrency,
  ROUNDUP_FETCH_CONCURRENCY,
  RoundupCoreSchema,
  type EntryHistory,
  type EntryTransfer,
  type EventPoints,
  type FplReadOptions,
  type FplService,
  type RoundupCore,
} from '@fant/fpl';
import {
  FplEntryIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
  RoundupCaptainSchema,
  type Bootstrap,
  type EntryPicks,
  type FplLeagueId,
  type Gameweek,
  type LeagueStandingRow,
  type RoundupCaptain,
  type RoundupMover,
  type RoundupRow,
} from '@fant/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { isFplNotFound } from '../fplErrors.js';
import { allStandingRows, fetchAllPages } from './pages.js';

/**
 * Gameweek Roundup ("סיכום מחזור") — building and storing. The pure builder lives in @fant/fpl; this module does
 * the I/O around it, following the package README's guidance: FPL requests ROUNDUP_FETCH_CONCURRENCY (4) at a
 * time, history + transfers fetched once per member and reused for every GW built in the same run, a member's
 * 404 → null, any other failure aborts the run with nothing stored for the GW being built.
 */

/**
 * Every FPL read behind a stored roundup is `fresh`: straight from FPL, never a cached copy (a live-GW picks copy
 * from before auto-subs / vice promotion) and never stale-if-error data. Failures throw and abort the build.
 */
export const FRESH: FplReadOptions = { fresh: true };

/** Build a GW only this long after we first saw it `finished && dataChecked` (history cache TTL, 5 min). */
export const ROUNDUP_BUILD_DELAY_MS = FPL_CACHE_TTL.history;
/**
 * FPL requests one job run may spend (≈ 2 per member for history + transfers, then 1 per member per GW for
 * picks). 171 members → 3 GWs a run (~860 requests, ~1 min at concurrency 4). At least one GW is always built.
 */
export const ROUNDUP_REQUEST_BUDGET = 1000;
export const ROUNDUP_CONCURRENCY = ROUNDUP_FETCH_CONCURRENCY;

/** Hot-cache key prefix of the public roundup responses (dropped when a roundup is stored). */
export const ROUNDUP_HOT_PREFIX = 'league:roundup:';

/** GWs a run may build for a league of `members` teams. */
export function roundupGwsPerRun(members: number): number {
  return Math.max(1, Math.floor((ROUNDUP_REQUEST_BUDGET - 2 * members) / (members + 1)));
}

/** The GWs FPL has made official, newest first. */
export function officialEvents(bootstrap: Bootstrap): Gameweek[] {
  return bootstrap.events
    .filter((e) => e.finished && e.dataChecked)
    .map((e) => e.id)
    .sort((a, b) => b - a);
}

/** The latest GW the picker may open: FPL's current GW (next before the season starts). */
export function currentRoundupEvent(bootstrap: Bootstrap): Gameweek {
  const current = bootstrap.currentEvent ?? bootstrap.nextEvent;
  if (current !== null) return current;
  const last = bootstrap.events.reduce((max, e) => Math.max(max, e.id), 0);
  return GameweekSchema.parse(last > 0 ? last : 1);
}

/** null for a 404 (unknown team / hidden picks); any other error propagates and aborts the build. */
async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (isFplNotFound(err)) return null;
    throw err;
  }
}

/** mapWithConcurrency that stops starting new work after the first failure, then rethrows it. */
async function mapAbortable<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  let failure: { err: unknown } | null = null;
  const results = await mapWithConcurrency(items, ROUNDUP_CONCURRENCY, async (item) => {
    if (failure !== null) return null;
    try {
      return await fn(item);
    } catch (err) {
      failure ??= { err };
      return null;
    }
  });
  if (failure !== null) throw (failure as { err: unknown }).err;
  return results as R[];
}

interface Captain {
  playerId: number;
  multiplier: 2 | 3;
}

/**
 * Who FPL gave the armband to in a finished GW: the pick with multiplier ≥ 2 (the vice when the captain didn't
 * play), else the picked captain (captain and vice both blanked) — the same rule as buildGameweekRoundup.
 */
export function effectiveCaptain(picks: EntryPicks | null): Captain | null {
  if (picks === null) return null;
  const effective = picks.picks.find((p) => p.multiplier >= 2);
  if (effective) return { playerId: effective.playerId, multiplier: effective.multiplier >= 3 ? 3 : 2 };
  const picked = picks.picks.find((p) => p.isCaptain);
  if (!picked) return null;
  return { playerId: picked.playerId, multiplier: picks.activeChip === '3xc' ? 3 : 2 };
}

/** Captain rows by captainPoints desc (stable: equal points keep their configured order). */
export function sortCaptains(rows: readonly RoundupCaptain[]): RoundupCaptain[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.captainPoints - a.row.captainPoints || a.index - b.index)
    .map((r) => r.row);
}

/**
 * The captain battle of a finished GW with final points, as the live battle showed it: the battle saved for the
 * latest GW ≤ `event`. Team-linked rows read that team's picks for `event` (captain or the vice who got the
 * armband, × the team's multiplier); hand-picked rows count only when the battle was saved for exactly this GW
 * (the live battle empties them after a rollover too) — base points × 2. No battle at all → [].
 */
export async function roundupCaptainRows(
  prisma: PrismaClient,
  fpl: FplService,
  event: Gameweek,
  points: EventPoints,
  memberPicks: ReadonlyMap<number, EntryPicks | null>,
): Promise<RoundupCaptain[]> {
  const battle = await prisma.captainBattle.findFirst({
    where: { event: { lte: event } },
    orderBy: { event: 'desc' },
    include: { entries: { orderBy: { order: 'asc' } } },
  });
  if (battle === null) return [];
  const exact = battle.event === event;
  const base = (playerId: number) => points.get(FplPlayerIdSchema.parse(playerId))?.points ?? 0;

  const linked = [
    ...new Set(
      battle.entries.flatMap((e) =>
        e.source === 'ENTRY' && e.entryId !== null && !memberPicks.has(e.entryId) ? [e.entryId] : [],
      ),
    ),
  ];
  const extraPicks = new Map<number, EntryPicks | null>();
  await mapAbortable(linked, async (entryId) => {
    extraPicks.set(entryId, await orNull(fpl.getEntryPicks(FplEntryIdSchema.parse(entryId), event, FRESH)));
  });

  const rows: RoundupCaptain[] = [];
  for (const e of battle.entries) {
    const kind = e.kind === 'COMMUNITY' ? 'community' : 'custom';
    if (e.source === 'ENTRY' && e.entryId !== null) {
      const captain = effectiveCaptain(memberPicks.get(e.entryId) ?? extraPicks.get(e.entryId) ?? null);
      rows.push({
        key: e.id,
        label: e.label,
        kind,
        playerId: captain === null ? null : FplPlayerIdSchema.parse(captain.playerId),
        multiplier: captain?.multiplier ?? 2,
        captainPoints: captain === null ? 0 : base(captain.playerId) * captain.multiplier,
      });
    } else if (exact) {
      rows.push({
        key: e.id,
        label: e.label,
        kind,
        playerId: e.playerId === null ? null : FplPlayerIdSchema.parse(e.playerId),
        multiplier: 2,
        captainPoints: e.playerId === null ? 0 : base(e.playerId) * 2,
      });
    }
  }
  return sortCaptains(z.array(RoundupCaptainSchema).parse(rows));
}

interface MemberSeason {
  row: LeagueStandingRow;
  history: EntryHistory | null;
  transfers: EntryTransfer[] | null;
}

export interface RoundupBuildResult {
  built: Gameweek[];
  /** Official GWs still missing for this league after the run. */
  remaining: number;
}

type RoundupFpl = FplService &
  Required<Pick<FplService, 'getEntryHistory' | 'getEntryTransfers' | 'getEventPoints' | 'getLeagueInfo'>>;

export function supportsRoundup(fpl: FplService): fpl is RoundupFpl {
  return (
    typeof fpl.getEntryHistory === 'function' &&
    typeof fpl.getEntryTransfers === 'function' &&
    typeof fpl.getEventPoints === 'function' &&
    typeof fpl.getLeagueInfo === 'function'
  );
}

/**
 * Builds and stores the roundups of `events` (newest first) for `leagueId`, at most roundupGwsPerRun(members)
 * of them. Each GW is stored only once complete; an FPL failure throws with nothing stored for that GW.
 */
export async function buildRoundups(
  deps: { prisma: PrismaClient; fpl: RoundupFpl; now: () => Date; onStored?: (event: Gameweek) => void },
  leagueId: FplLeagueId,
  bootstrap: Bootstrap,
  events: readonly Gameweek[],
): Promise<RoundupBuildResult> {
  const { prisma, fpl } = deps;
  if (events.length === 0) return { built: [], remaining: 0 };
  const info = await fpl.getLeagueInfo(leagueId, FRESH);
  const rows = allStandingRows(await fetchAllPages((page) => fpl.getLeagueStandings(leagueId, page, FRESH)));
  const batch = events.slice(0, roundupGwsPerRun(rows.length));

  // History + transfers once per member, reused for every GW of the batch (not needed before the league began).
  const needMembers = batch.some((gw) => gw >= info.startEvent);
  const seasons: MemberSeason[] = needMembers
    ? await mapAbortable(rows, async (row) => ({
        row,
        history: await orNull(fpl.getEntryHistory(row.entryId, FRESH)),
        transfers: await orNull(fpl.getEntryTransfers(row.entryId, FRESH)),
      }))
    : [];

  const newestOfficial = officialEvents(bootstrap)[0];
  const built: Gameweek[] = [];
  for (const event of batch) {
    const playerPoints = await fpl.getEventPoints(event, FRESH);
    // A member without a history row for this GW (team created later, or 404) isn't in its table: no picks.
    const inGw = (s: MemberSeason) => s.history?.events.some((e) => e.event === event) ?? false;
    const picks = new Map<number, EntryPicks | null>();
    if (event >= info.startEvent) {
      await mapAbortable(seasons.filter(inGw), async (s) => {
        picks.set(s.row.entryId, await orNull(fpl.getEntryPicks(s.row.entryId, event, FRESH)));
      });
    }
    const computed: RoundupCore = buildGameweekRoundup({
      event,
      startEvent: info.startEvent,
      playerPoints,
      worldAverage: bootstrap.events.find((e) => e.id === event)?.averageScore ?? null,
      members:
        event >= info.startEvent
          ? seasons.map((s) => ({
              entryId: s.row.entryId,
              entryName: s.row.entryName,
              managerName: s.row.managerName,
              history: s.history,
              transfers: s.transfers,
              picks: picks.get(s.row.entryId) ?? null,
            }))
          : [],
    });
    // The newest official GW: FPL's own league table (read fresh above) is exactly this GW's table, so its ranks,
    // last ranks and totals win over the reconstruction (FPL leaves late joiners out of last_rank). Older GWs have
    // no official table left on FPL and keep the values rebuilt from each team's history.
    const core = event === newestOfficial ? (applyOfficialStandings(computed, rows) ?? computed) : computed;
    const captains = await roundupCaptainRows(prisma, fpl, event, playerPoints, picks);
    const captainPoints: Record<string, number> = {};
    for (const r of core.table) {
      if (r.captainPlayerId !== null)
        captainPoints[r.captainPlayerId] = playerPoints.get(r.captainPlayerId)?.points ?? 0;
    }
    // Idempotent: a roundup already stored for (league, GW) is never replaced.
    const stored = await prisma.gameweekRoundup.createMany({
      data: [
        {
          leagueId,
          event,
          leagueName: info.name,
          data: core as unknown as Prisma.InputJsonObject,
          captains: captains as unknown as Prisma.InputJsonArray,
          captainPoints,
          builtAt: deps.now(),
        },
      ],
      skipDuplicates: true,
    });
    if (stored.count > 0) {
      built.push(event);
      deps.onStored?.(event);
    }
  }
  return { built, remaining: events.length - batch.length };
}

/**
 * Share of the table whose official total must equal the reconstructed total before the official standings are
 * trusted for a GW. Below it FPL's table has already moved on (a newer GW is being scored), so it isn't this GW's.
 */
export const OFFICIAL_STANDINGS_MIN_MATCH = 0.9;

/**
 * The roundup with FPL's official league table for its GW: `rank`, `lastRank` (FPL `last_rank` 0 = joined since the
 * last update → null) and `total` from the standings, the table re-ordered by official rank (then official order),
 * and biggest climb / drop recomputed from them (places, then higher GW points, then table order — the builder's
 * rules). Table rows FPL doesn't list keep their values (after the listed ones). Returns null — keep the computed
 * roundup — when the standings don't match this GW (fewer than OFFICIAL_STANDINGS_MIN_MATCH of the totals agree).
 */
export function applyOfficialStandings(
  core: RoundupCore,
  standings: readonly LeagueStandingRow[],
): RoundupCore | null {
  const official = new Map(standings.map((row, index) => [row.entryId as number, { row, index }]));
  const listed = core.table.filter((r) => official.has(r.entryId));
  if (listed.length === 0) return null;
  const matching = listed.filter((r) => official.get(r.entryId)?.row.total === r.total).length;
  if (matching / listed.length < OFFICIAL_STANDINGS_MIN_MATCH) return null;

  const order = (entryId: number) => official.get(entryId)?.index ?? Number.MAX_SAFE_INTEGER;
  const table: RoundupRow[] = core.table
    .map((r) => {
      const o = official.get(r.entryId)?.row;
      if (o === undefined) return r;
      return { ...r, rank: o.rank, lastRank: o.lastRank > 0 ? o.lastRank : null, total: o.total };
    })
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const la = official.has(a.row.entryId) ? 0 : 1;
      const lb = official.has(b.row.entryId) ? 0 : 1;
      return (
        la - lb || a.row.rank - b.row.rank || order(a.row.entryId) - order(b.row.entryId) || a.index - b.index
      );
    })
    .map((x) => x.row);

  const mover = (direction: 1 | -1): RoundupMover | null => {
    let top: { row: RoundupRow; places: number } | null = null;
    for (const row of table) {
      const places = row.lastRank === null ? 0 : (row.lastRank - row.rank) * direction;
      if (places <= 0) continue;
      if (
        top === null ||
        places > top.places ||
        (places === top.places && row.eventPoints > top.row.eventPoints)
      )
        top = { row, places };
    }
    if (top === null) return null;
    const { entryId, entryName, managerName, eventPoints } = top.row;
    return { entryId, entryName, managerName, places: top.places, eventPoints };
  };

  return RoundupCoreSchema.parse({ ...core, table, biggestClimb: mover(1), biggestDrop: mover(-1) });
}

// ---------- reading ----------

export interface StoredRoundup {
  leagueName: string;
  core: RoundupCore;
  captains: RoundupCaptain[];
  builtAt: Date;
}

const CaptainPointsSchema = z.record(z.string(), z.number().int());

/** The stored roundup, or null when there is none or it no longer parses (treated as missing, never a 500). */
export async function readRoundup(
  prisma: PrismaClient,
  leagueId: FplLeagueId,
  event: Gameweek,
): Promise<StoredRoundup | null | 'invalid'> {
  const row = await prisma.gameweekRoundup.findUnique({ where: { leagueId_event: { leagueId, event } } });
  if (row === null) return null;
  const core = RoundupCoreSchema.safeParse(row.data);
  const captains = z.array(RoundupCaptainSchema).safeParse(row.captains);
  if (!core.success || !captains.success) return 'invalid';
  return { leagueName: row.leagueName, core: core.data, captains: captains.data, builtAt: row.builtAt };
}

/** playerId → base GW points of the table's captains (empty when missing). */
export async function readCaptainPoints(
  prisma: PrismaClient,
  leagueId: FplLeagueId,
  event: Gameweek,
): Promise<Record<string, number>> {
  const row = await prisma.gameweekRoundup.findUnique({
    where: { leagueId_event: { leagueId, event } },
    select: { captainPoints: true },
  });
  const parsed = CaptainPointsSchema.safeParse(row?.captainPoints);
  return parsed.success ? parsed.data : {};
}
