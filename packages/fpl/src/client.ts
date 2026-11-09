import {
  LiveLeagueSchema,
  type Bootstrap,
  type Chip,
  type EntryLive,
  type EntryPicks,
  type EntrySummary,
  type Fixture,
  type FixtureDetail,
  type FplEntryId,
  type FplFixtureId,
  type FplLeagueId,
  type FplPlayerId,
  type Gameweek,
  type GameweekInfo,
  type LeagueStandings,
  type LiveLeague,
  type PlayerLive,
} from '@fant/shared';
import { FplBackoff } from './backoff.js';
import type { EntryHistory, EntryTransfer, EventPoints, LeagueInfo } from './dto.js';
import { LruMap, mapWithConcurrency, TtlCache, type CachePolicy } from './cache.js';
import { createFplHttp } from './http.js';
import {
  computeLivePoints,
  createGameweekContext,
  playerLiveInfo,
  type EngineFixture,
  type EngineLiveStats,
  type EnginePick,
  type EnginePlayer,
  type GameweekContext,
  type LivePointsResult,
} from './live-engine.js';
import {
  chipsUsedOf,
  engineFixturesOf,
  engineLiveOf,
  eventPointsOf,
  enginePicksOf,
  enginePlayersOf,
  fixtureLinesOf,
  fixtureStatusOf,
  mapBootstrap,
  mapEntry,
  mapEntryHistory,
  mapEntryLive,
  mapFixtureDetail,
  mapFixtures,
  mapLeagueInfo,
  mapNewEntries,
  mapPicks,
  mapPlayerLive,
  mapStandings,
  mapTransfers,
  toChip,
  totalBeforeEvent,
  type FixturePlayerLine,
} from './normalize.js';
import {
  RawBootstrapSchema,
  RawEntryHistorySchema,
  RawEntrySchema,
  RawFixturesSchema,
  RawLiveSchema,
  RawPicksSchema,
  RawStandingsSchema,
  RawTransfersSchema,
  type RawFixture,
  type RawLive,
  type RawPicks,
} from './raw.js';
import { FplNotFoundError, FplUnavailableError, type FplService, type FplServiceOptions } from './service.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Cache TTLs, tuned to how fast each resource changes. */
export const FPL_CACHE_TTL = {
  bootstrap: 5 * MINUTE,
  fixtures: 30 * SECOND,
  live: 30 * SECOND,
  entry: 5 * MINUTE,
  history: 5 * MINUTE,
  /** `entry/{id}/transfers/`: changes only when the manager makes a transfer. */
  transfers: 5 * MINUTE,
  /** Picks of a GW whose deadline has passed: the 15 players, captaincy and chip never change again. */
  picksImmutable: 12 * HOUR,
  /** Picks read for their entry_history (points/rank), which moves while the GW is in progress. */
  picksSummary: 1 * MINUTE,
  standings: 2 * MINUTE,
} as const;

export type FplCacheResource = keyof typeof FPL_CACHE_TTL;

/**
 * How old a value may be served when FPL fails (429 / 5xx / network / bad body). During FPL's update
 * window ("The game is being updated") every resource is served up to `outageMaxStaleMs` instead.
 */
export const FPL_STALE_IF_ERROR: Readonly<Record<FplCacheResource, number>> = {
  bootstrap: 1 * HOUR,
  fixtures: 2 * MINUTE,
  live: 2 * MINUTE,
  entry: 1 * HOUR,
  history: 1 * HOUR,
  transfers: 1 * HOUR,
  picksImmutable: 12 * HOUR,
  picksSummary: 1 * HOUR,
  standings: 10 * MINUTE,
};

/**
 * Refresh-ahead point as a fraction of the TTL: a hit older than this is served at once and refreshed in
 * the background, so with steady traffic no request waits for FPL and data is never older than the TTL.
 */
export const FPL_REFRESH_AHEAD_RATIO = 0.85;

/**
 * LRU caps (number of keys). Per-entry caches are sized for ~300 managers × 2 GWs; see
 * docs in the package README / report for the memory estimate (~3 KB per picks, ~1 KB per entry,
 * ≤ 4 KB per history, ≤ 6 KB per transfer list, ~6 KB per memoized EntryLive).
 */
export const FPL_CACHE_LIMITS = {
  /** `entry/{id}/event/{gw}/picks/` — 300 entries × 2 GWs + headroom. */
  picks: 700,
  /** `entry/{id}/` */
  entries: 350,
  /** `entry/{id}/history/` (mapped: ~38 GW rows + chips, ≈ 4 KB at season end). */
  histories: 350,
  /** `entry/{id}/transfers/` (mapped; ≈ 6 KB for a full season of ~60 transfers). */
  transfers: 350,
  /** Memoized live results / EntryLive DTOs per (entry, GW). */
  entryLive: 700,
  /** bootstrap, fixtures per GW, live per GW, standings pages. */
  shared: 300,
} as const;

/** Max parallel FPL requests when building a live league page. */
export const LIVE_LEAGUE_CONCURRENCY = 6;
/**
 * Recommended parallelism for a Gameweek Roundup build / back-fill (history + transfers + picks per member,
 * via `mapWithConcurrency`). 4 fetched 171 histories + 171 transfer lists in ~23 s and 171 picks in ~12 s
 * from FPL with no 429 (Nov 2026). See README "Gameweek Roundup".
 */
export const ROUNDUP_FETCH_CONCURRENCY = 4;
/** FPL classic standings page size. */
export const STANDINGS_PAGE_SIZE = 50;
/** Safety cap on `new_entries` pages swept by getLeagueNewEntries (FPL pages hold 50 entries). */
export const NEW_ENTRIES_MAX_PAGES = 20;
/** A 404 for picks (manager joined after this GW / before the deadline) is remembered this long. */
const PICKS_NOT_FOUND_TTL = 1 * MINUTE;

export interface CreateFplServiceExtras {
  /** Overrides for the TTLs above (ms). */
  ttl?: Partial<Record<FplCacheResource, number>>;
  /** Overrides for the LRU caps above (keys). */
  cacheLimits?: Partial<Record<keyof typeof FPL_CACHE_LIMITS, number>>;
  /** Backoff / outage tuning. */
  resilience?: {
    /** First backoff after a 429/502/503/504/network failure (doubles per failure). Default 5 s. */
    backoffBaseMs?: number;
    /** Backoff cap. Default 2 min. */
    backoffMaxMs?: number;
    /** Max age of last-good data served during FPL's update window. Default 12 h. */
    outageMaxStaleMs?: number;
  };
}

// ---------- normalized, per-fetch bundles (computed once per raw response) ----------

interface BootstrapBundle {
  dto: Bootstrap;
  players: Map<number, EnginePlayer>;
  currentEvent: number | null;
  eventsById: Map<number, GameweekInfo>;
  /** Bootstrap team of every element (incl. ones the DTO filters out). */
  teamOfPlayer: Map<number, number>;
}

interface FixturesBundle {
  raw: RawFixture[];
  byId: Map<number, RawFixture>;
  engine: EngineFixture[];
  dto: () => Fixture[];
  fetchedAt: number;
}

interface LiveBundle {
  raw: RawLive;
  engine: Map<number, EngineLiveStats>;
  /** fixture id → each player's line from that fixture's explain (one pass, lazily). */
  lines: () => Map<number, FixturePlayerLine[]>;
  fetchedAt: number;
}

interface PicksBundle {
  raw: RawPicks;
  engine: EnginePick[];
  chip: Chip | null;
  totalBefore: number;
  captainId: number | null;
}

interface StandingsBundle {
  dto: LeagueStandings;
  league: LeagueInfo;
  newEntries: { hasNext: boolean; ids: FplEntryId[] };
}

interface HistoryBundle {
  chipsUsed: { chip: Chip; event: number }[];
  dto: EntryHistory;
}

/** Everything shared by every manager for one GW snapshot. */
interface GameweekState {
  bootstrap: BootstrapBundle;
  fixtures: FixturesBundle;
  live: LiveBundle;
  ctx: GameweekContext;
  /** When the OLDER of fixtures/live was fetched (honest under stale-on-error): live DTOs' `updatedAt`. */
  fetchedAt: number;
}

function lazy<T>(compute: () => T): () => T {
  let done = false;
  let value: T | undefined;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value as T;
  };
}

export function createFplService(options: FplServiceOptions & CreateFplServiceExtras): FplService {
  const now = options.now ?? (() => Date.now());
  const ttl = { ...FPL_CACHE_TTL, ...options.ttl };
  const limits = { ...FPL_CACHE_LIMITS, ...options.cacheLimits };
  const resilience = options.resilience ?? {};
  const backoff = new FplBackoff({
    now,
    ...(resilience.backoffBaseMs !== undefined ? { baseMs: resilience.backoffBaseMs } : {}),
    ...(resilience.backoffMaxMs !== undefined ? { maxMs: resilience.backoffMaxMs } : {}),
  });
  const getJson = createFplHttp({
    fetch: options.fetch,
    backoff,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  });

  const cacheOptions = (maxEntries: number) => ({
    now,
    maxEntries,
    isOutage: () => backoff.updating,
    ...(resilience.outageMaxStaleMs !== undefined ? { outageMaxStaleMs: resilience.outageMaxStaleMs } : {}),
  });
  const shared = new TtlCache(cacheOptions(limits.shared));
  const picksCache = new TtlCache(cacheOptions(limits.picks));
  const entryCache = new TtlCache(cacheOptions(limits.entries));
  const historyCache = new TtlCache(cacheOptions(limits.histories));
  const transfersCache = new TtlCache(cacheOptions(limits.transfers));

  const policy = (resource: FplCacheResource): CachePolicy => ({
    ttlMs: ttl[resource],
    refreshAfterMs: ttl[resource] * FPL_REFRESH_AHEAD_RATIO,
    staleIfErrorMs: Math.max(FPL_STALE_IF_ERROR[resource], ttl[resource]),
  });

  // ---------- loaders: Zod-parse + normalize once per fetch ----------

  const bootstrap = (): Promise<BootstrapBundle> =>
    shared.get('bootstrap', policy('bootstrap'), async () => {
      const raw = await getJson('bootstrap-static/', RawBootstrapSchema);
      const dto = mapBootstrap(raw, now());
      return {
        dto,
        players: enginePlayersOf(dto),
        currentEvent: dto.currentEvent,
        eventsById: new Map(dto.events.map((e) => [e.id as number, e])),
        teamOfPlayer: new Map(raw.elements.map((e) => [e.id, e.team])),
      };
    });

  const fixturesFor = (event?: number): Promise<FixturesBundle> => {
    const path = event === undefined ? 'fixtures/' : `fixtures/?event=${event}`;
    return shared.get(path, policy('fixtures'), async () => {
      const raw = await getJson(path, RawFixturesSchema);
      return {
        raw,
        byId: new Map(raw.map((f) => [f.id, f])),
        engine: engineFixturesOf(raw),
        dto: lazy(() => mapFixtures(raw)),
        fetchedAt: now(),
      };
    });
  };

  const liveFor = (event: number): Promise<LiveBundle> => {
    const path = `event/${event}/live/`;
    return shared.get(path, policy('live'), async () => {
      const raw = await getJson(path, RawLiveSchema);
      return { raw, engine: engineLiveOf(raw), lines: lazy(() => fixtureLinesOf(raw)), fetchedAt: now() };
    });
  };

  /** Bumped whenever a picks response is (re)loaded: invalidates memoized live league pages. */
  let picksGeneration = 0;
  const picksNotFoundAt = new LruMap<string, number>(limits.picks);
  const loadPicks = (path: string) => async (): Promise<PicksBundle> => {
    const raw = await getJson(path, RawPicksSchema);
    picksGeneration++;
    const captain = raw.picks.find((x) => x.is_captain);
    return {
      raw,
      engine: enginePicksOf(raw),
      chip: toChip(raw.active_chip),
      totalBefore: totalBeforeEvent(raw),
      captainId: captain ? captain.element : null,
    };
  };
  const picksPath = (entryId: number, event: number) => `entry/${entryId}/event/${event}/picks/`;
  const recentlyNotFound = (path: string): boolean => {
    const missedAt = picksNotFoundAt.get(path);
    return missedAt !== undefined && now() - missedAt < PICKS_NOT_FOUND_TTL;
  };
  const picksFor = async (entryId: number, event: number, p: CachePolicy): Promise<PicksBundle> => {
    const path = picksPath(entryId, event);
    if (recentlyNotFound(path)) throw new FplNotFoundError(path);
    try {
      return await picksCache.get(path, p, loadPicks(path));
    } catch (err) {
      if (err instanceof FplNotFoundError) picksNotFoundAt.set(path, now());
      throw err;
    }
  };
  /** Sync fast path: a fresh cached bundle, `null` for a remembered 404, `undefined` → use picksFor. */
  const peekPicks = (entryId: number, event: number, p: CachePolicy): PicksBundle | null | undefined => {
    const path = picksPath(entryId, event);
    if (recentlyNotFound(path)) return null;
    return picksCache.peek(path, p, loadPicks(path));
  };

  const historyFor = (entryId: number): Promise<HistoryBundle> => {
    const path = `entry/${entryId}/history/`;
    return historyCache.get(path, policy('history'), async () => {
      const raw = await getJson(path, RawEntryHistorySchema);
      return { chipsUsed: chipsUsedOf(raw), dto: mapEntryHistory(entryId, raw) };
    });
  };

  const transfersFor = (entryId: number): Promise<EntryTransfer[]> => {
    const path = `entry/${entryId}/transfers/`;
    return transfersCache.get(path, policy('transfers'), async () =>
      mapTransfers(await getJson(path, RawTransfersSchema)),
    );
  };

  /**
   * One standings response = one standings page + one `new_entries` page. Page 1 of new entries rides on
   * every standings page fetch (FPL's default), so the member check usually costs no extra request.
   */
  const standingsPage = (
    leagueId: number,
    page: number,
    newEntriesPage: number,
  ): Promise<StandingsBundle> => {
    const query =
      newEntriesPage === 1
        ? `page_standings=${page}`
        : `page_new_entries=${newEntriesPage}&page_standings=${page}`;
    const path = `leagues-classic/${leagueId}/standings/?${query}`;
    return shared.get(path, policy('standings'), async () => {
      const raw = await getJson(path, RawStandingsSchema);
      return {
        dto: mapStandings(raw, page, now()),
        league: mapLeagueInfo(raw),
        newEntries: mapNewEntries(raw),
      };
    });
  };
  const standingsFor = async (leagueId: number, page: number): Promise<LeagueStandings> =>
    (await standingsPage(leagueId, page, 1)).dto;

  const newEntriesInflight = new Map<number, Promise<FplEntryId[]>>();
  const leagueNewEntries = async (leagueId: number): Promise<FplEntryId[]> => {
    const ids: FplEntryId[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= NEW_ENTRIES_MAX_PAGES; page++) {
      const { newEntries } = await standingsPage(leagueId, 1, page);
      for (const id of newEntries.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      if (!newEntries.hasNext || newEntries.ids.length === 0) break;
    }
    return ids;
  };

  // ---------- per-GW snapshot (shared by every manager) ----------

  const gameweeks = new LruMap<number, GameweekState>(4);
  const gameweek = async (event: number): Promise<GameweekState> => {
    const [b, fixtures, live] = await Promise.all([bootstrap(), fixturesFor(event), liveFor(event)]);
    const memo = gameweeks.get(event);
    if (memo && memo.bootstrap === b && memo.fixtures === fixtures && memo.live === live) return memo;
    const state: GameweekState = {
      bootstrap: b,
      fixtures,
      live,
      ctx: createGameweekContext({ players: b.players, fixtures: fixtures.engine, live: live.engine }),
      fetchedAt: Math.min(fixtures.fetchedAt, live.fetchedAt),
    };
    gameweeks.set(event, state);
    return state;
  };

  // ---------- per-entry live result (shared by getEntryLive and getLiveLeague) ----------

  /**
   * Memo per (entry, GW), valid while its GW snapshot and picks are the same objects. Keeps only what the
   * league table needs plus the EntryLive DTO once requested — not the engine's full per-pick result.
   */
  interface EntryResult {
    gw: GameweekState;
    picks: PicksBundle;
    livePoints: number;
    effectiveCaptainId: number | null;
    playersYetToPlay: number;
    dto: EntryLive | null;
  }
  const entryResults = new LruMap<string, EntryResult>(limits.entryLive);
  const score = (gw: GameweekState, picks: PicksBundle): LivePointsResult =>
    computeLivePoints(gw.ctx, {
      picks: picks.engine,
      activeChip: picks.chip,
      transfersCost: picks.raw.entry_history.event_transfers_cost,
    });
  const entryResult = (
    entryId: number,
    event: number,
    gw: GameweekState,
    picks: PicksBundle,
    withDto: boolean,
  ): EntryResult => {
    const key = `${entryId}:${event}`;
    let memo = entryResults.get(key);
    if (!memo || memo.gw !== gw || memo.picks !== picks) {
      const result = score(gw, picks);
      memo = {
        gw,
        picks,
        livePoints: result.livePoints,
        effectiveCaptainId: result.effectiveCaptainId,
        playersYetToPlay: result.playersYetToPlay,
        dto: withDto
          ? mapEntryLive(entryId, event, picks.chip, result, picks.totalBefore, gw.fetchedAt)
          : null,
      };
      entryResults.set(key, memo);
    } else if (withDto && memo.dto === null) {
      const result = score(gw, picks);
      memo.dto = mapEntryLive(entryId, event, picks.chip, result, picks.totalBefore, gw.fetchedAt);
    }
    return memo;
  };

  // ---------- memoized DTOs ----------

  const picksDtos = new WeakMap<PicksBundle, { history: HistoryBundle; dto: EntryPicks }>();
  const playerLiveDtos = new WeakMap<GameweekContext, Map<number, PlayerLive>>();
  const eventPointsMemo = new WeakMap<LiveBundle, EventPoints>();
  const fixtureDetails = new LruMap<
    number,
    { fixture: RawFixture; live: LiveBundle | null; bootstrap: BootstrapBundle; dto: FixtureDetail }
  >(200);

  interface LivePage {
    standings: LeagueStandings;
    gw: GameweekState;
    picksGeneration: number;
    dto: LiveLeague;
  }
  const livePages = new LruMap<string, LivePage>(100);
  const livePagesInflight = new Map<
    string,
    { standings: LeagueStandings; gw: GameweekState; promise: Promise<LiveLeague> }
  >();

  const warned = new Set<string>();
  const warnOnce = (message: string): void => {
    if (!options.onWarn || warned.has(message)) return;
    warned.add(message);
    options.onWarn(message);
  };

  /**
   * Finds a fixture's raw record. The Live tab asks about the current GW, whose list is already cached
   * by getFixtures(event); anything else falls back to the whole-season list (same TTL).
   */
  const findRawFixture = async (
    fixtureId: number,
    b: BootstrapBundle,
  ): Promise<{ fixture: RawFixture; fixtures: FixturesBundle }> => {
    if (b.currentEvent !== null) {
      const fixtures = await fixturesFor(b.currentEvent);
      const hit = fixtures.byId.get(fixtureId);
      if (hit) return { fixture: hit, fixtures };
    }
    const fixtures = await fixturesFor();
    const hit = fixtures.byId.get(fixtureId);
    if (!hit) throw new FplNotFoundError(`fixture ${fixtureId}`);
    return { fixture: hit, fixtures };
  };

  const buildLivePage = async (
    standings: LeagueStandings,
    gw: GameweekState,
    event: Gameweek,
  ): Promise<{ dto: LiveLeague; complete: boolean }> => {
    let complete = true;
    type Row = LeagueStandings['rows'][number];
    const immutable = policy('picksImmutable');
    const base = (row: Row) => ({
      officialRank: row.rank,
      entryId: row.entryId,
      entryName: row.entryName,
      managerName: row.managerName,
    });
    const scored = (row: Row, picks: PicksBundle) => {
      const result = entryResult(row.entryId, event, gw, picks, false);
      return {
        ...base(row),
        livePoints: result.livePoints,
        liveTotal: picks.totalBefore + result.livePoints,
        captainPlayerId: picks.captainId,
        effectiveCaptainPlayerId: result.effectiveCaptainId,
        activeChip: picks.chip,
        playersYetToPlay: result.playersYetToPlay,
      };
    };
    // No picks for this GW (joined later → 404): standings numbers without the GW. FPL failing for this
    // manager only: the official numbers.
    const fallback = (row: Row, notFound: boolean) => ({
      ...base(row),
      livePoints: notFound ? 0 : row.eventTotal,
      liveTotal: notFound ? row.total - row.eventTotal : row.total,
      captainPlayerId: null,
      effectiveCaptainPlayerId: null,
      activeChip: null,
      playersYetToPlay: 0,
    });

    // Cached picks are scored synchronously; only the misses go to FPL (a few at a time).
    const rows: ReturnType<typeof scored>[] = new Array(standings.rows.length);
    const misses: number[] = [];
    standings.rows.forEach((row, i) => {
      const picks = peekPicks(row.entryId, event, immutable);
      if (picks === undefined) misses.push(i);
      else rows[i] = picks === null ? fallback(row, true) : scored(row, picks);
    });
    await mapWithConcurrency(misses, LIVE_LEAGUE_CONCURRENCY, async (i) => {
      const row = standings.rows[i] as Row;
      try {
        rows[i] = scored(row, await picksFor(row.entryId, event, immutable));
      } catch (err) {
        if (!(err instanceof FplNotFoundError) && !(err instanceof FplUnavailableError)) throw err;
        const notFound = err instanceof FplNotFoundError;
        if (!notFound) complete = false;
        rows[i] = fallback(row, notFound);
      }
    });

    rows.sort((a, b) => b.liveTotal - a.liveTotal || a.officialRank - b.officialRank);
    const offset = (standings.page - 1) * STANDINGS_PAGE_SIZE;
    let previous: { liveTotal: number; liveRank: number } | null = null;
    const ranked = rows.map((r, i) => {
      const liveRank = previous && previous.liveTotal === r.liveTotal ? previous.liveRank : offset + i + 1;
      previous = { liveTotal: r.liveTotal, liveRank };
      return { liveRank, ...r };
    });

    const dto = LiveLeagueSchema.parse({
      league: standings.league,
      event,
      page: standings.page,
      hasNext: standings.hasNext,
      rows: ranked,
      updatedAt: new Date(gw.fetchedAt).toISOString(),
    });
    return { dto, complete };
  };

  const service: FplService = {
    async getBootstrap(): Promise<Bootstrap> {
      return (await bootstrap()).dto;
    },

    async getFixtures(event?: Gameweek): Promise<Fixture[]> {
      return (await fixturesFor(event)).dto();
    },

    /** Throws FplNotFoundError when the Team ID doesn't exist. */
    async getEntry(entryId: FplEntryId): Promise<EntrySummary> {
      const path = `entry/${entryId}/`;
      return entryCache.get(path, policy('entry'), async () => mapEntry(await getJson(path, RawEntrySchema)));
    },

    async getEntryPicks(entryId: FplEntryId, event: Gameweek): Promise<EntryPicks> {
      const b = await bootstrap();
      const info = b.eventsById.get(event);
      // A finished + data-checked GW is final: its entry_history no longer moves either.
      const p = info?.finished && info.dataChecked ? policy('picksImmutable') : policy('picksSummary');
      const [picks, history] = await Promise.all([picksFor(entryId, event, p), historyFor(entryId)]);
      const memo = picksDtos.get(picks);
      if (memo && memo.history === history) return memo.dto;
      const dto = mapPicks(entryId, event, picks.raw, history.chipsUsed);
      picksDtos.set(picks, { history, dto });
      return dto;
    },

    async getEntryLive(entryId: FplEntryId, event: Gameweek): Promise<EntryLive> {
      const [gw, picks] = await Promise.all([
        gameweek(event),
        picksFor(entryId, event, policy('picksImmutable')),
      ]);
      return entryResult(entryId, event, gw, picks, true).dto as EntryLive;
    },

    async getLeagueStandings(leagueId: FplLeagueId, page: number): Promise<LeagueStandings> {
      return standingsFor(leagueId, Math.max(1, Math.trunc(page)));
    },

    /**
     * Entry ids in the league's `new_entries` (joined since FPL's last standings update, not ranked yet),
     * all pages (≤ NEW_ENTRIES_MAX_PAGES), de-duplicated, in FPL's order. Same cache/TTL/stale-on-error as
     * standings. Throws FplNotFoundError for an unknown league.
     */
    getLeagueNewEntries(leagueId: FplLeagueId): Promise<FplEntryId[]> {
      const pending = newEntriesInflight.get(leagueId);
      if (pending) return pending;
      const promise = leagueNewEntries(leagueId).finally(() => newEntriesInflight.delete(leagueId));
      newEntriesInflight.set(leagueId, promise);
      return promise;
    },

    /**
     * Live league table for one standings page.
     *
     * Ranking formula. FPL's standings `total` ALREADY contains the in-progress GW's points as FPL has
     * processed them so far (updated in batches, no provisional bonus, no auto-subs, transfer cost
     * deducted), and `event_total` is that same partial GW figure. Adding our live points to `total`
     * would count the GW twice. So:
     *
     *   liveTotal = totalBeforeGW + livePoints
     *   totalBeforeGW = picks.entry_history.total_points − entry_history.points + event_transfers_cost
     *                   (exact, and stable during the GW — see `totalBeforeEvent`)
     *   livePoints   = our engine's points (auto-subs, vice promotion, provisional bonus, chips) − hits
     *
     * When a manager has no picks for this GW (joined later → 404), we fall back to the standings row:
     * livePoints = 0, liveTotal = total − event_total. If FPL fails for one manager only, that row falls
     * back to the official numbers (livePoints = event_total, liveTotal = total) instead of failing the
     * whole page.
     *
     * Rows are re-ranked WITHIN the page (liveTotal desc, then official rank); liveRank is numbered from
     * the page's first position ((page − 1) × 50 + 1) with equal liveTotals sharing a rank.
     *
     * `captainPlayerId` is the picked captain; `effectiveCaptainPlayerId` is whoever the engine applies
     * the armband multiplier to (the vice when the captain didn't play, null when neither did / no picks).
     *
     * The page is memoized per (standings page, GW snapshot, picks generation) and concurrent identical
     * requests share one build, so N users polling the same page cost one computation per data change.
     */
    async getLiveLeague(leagueId: FplLeagueId, event: Gameweek, page: number): Promise<LiveLeague> {
      const [standings, gw] = await Promise.all([
        service.getLeagueStandings(leagueId, page),
        gameweek(event),
      ]);
      const key = `${leagueId}:${event}:${standings.page}`;
      const memo = livePages.get(key);
      if (memo && memo.standings === standings && memo.gw === gw && memo.picksGeneration === picksGeneration)
        return memo.dto;
      const pending = livePagesInflight.get(key);
      if (pending && pending.standings === standings && pending.gw === gw) return pending.promise;

      const promise = (async () => {
        const { dto, complete } = await buildLivePage(standings, gw, event);
        // Pages with a transient per-manager failure are not memoized: the next call retries them.
        if (complete) livePages.set(key, { standings, gw, picksGeneration, dto });
        return dto;
      })();
      livePagesInflight.set(key, { standings, gw, promise });
      try {
        return await promise;
      } finally {
        if (livePagesInflight.get(key)?.promise === promise) livePagesInflight.delete(key);
      }
    },

    async getPlayersLive(playerIds: readonly FplPlayerId[], event: Gameweek): Promise<PlayerLive[]> {
      const { ctx } = await gameweek(event);
      let memo = playerLiveDtos.get(ctx);
      if (!memo) {
        memo = new Map();
        playerLiveDtos.set(ctx, memo);
      }
      const dtos = memo;
      return playerIds.map((id) => {
        let dto = dtos.get(id);
        if (!dto) {
          dto = mapPlayerLive(playerLiveInfo(ctx, id));
          dtos.set(id, dto);
        }
        return dto;
      });
    },

    async getEntryHistory(entryId: FplEntryId): Promise<EntryHistory> {
      return (await historyFor(entryId)).dto;
    },

    getEntryTransfers(entryId: FplEntryId): Promise<EntryTransfer[]> {
      return transfersFor(entryId);
    },

    async getEventPoints(event: Gameweek): Promise<EventPoints> {
      const live = await liveFor(event);
      let points = eventPointsMemo.get(live);
      if (!points) {
        points = eventPointsOf(live.raw);
        eventPointsMemo.set(live, points);
      }
      return points;
    },

    async getLeagueInfo(leagueId: FplLeagueId): Promise<LeagueInfo> {
      return (await standingsPage(leagueId, 1, 1)).league;
    },

    async getFixtureDetail(fixtureId: FplFixtureId): Promise<FixtureDetail> {
      const b = await bootstrap();
      const { fixture, fixtures } = await findRawFixture(fixtureId, b);
      const started = fixtureStatusOf(fixture) !== 'not_started';
      const live = started && fixture.event !== null ? await liveFor(fixture.event) : null;
      const memo = fixtureDetails.get(fixtureId);
      if (memo && memo.fixture === fixture && memo.live === live && memo.bootstrap === b) return memo.dto;
      const dto = mapFixtureDetail({
        fixture,
        live: live ? live.raw : null,
        ...(live ? { lines: live.lines().get(fixture.id) ?? [] } : {}),
        teamOfPlayer: b.teamOfPlayer,
        nowMs: live ? Math.min(fixtures.fetchedAt, live.fetchedAt) : fixtures.fetchedAt,
        onUnknownStat: (identifier) => warnOnce(`FPL fixture stat "${identifier}" is not mapped; ignored`),
      });
      fixtureDetails.set(fixtureId, { fixture, live, bootstrap: b, dto });
      return dto;
    },

    getHealth() {
      return backoff.health();
    },
  };

  return service;
}
