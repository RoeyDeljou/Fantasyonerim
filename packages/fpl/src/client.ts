import {
  LiveLeagueSchema,
  type Bootstrap,
  type EntryLive,
  type EntryPicks,
  type EntrySummary,
  type Fixture,
  type FplEntryId,
  type FplLeagueId,
  type FplPlayerId,
  type Gameweek,
  type LeagueStandings,
  type LiveLeague,
  type PlayerLive,
} from '@fant/shared';
import { mapWithConcurrency, TtlCache } from './cache.js';
import { createFplHttp } from './http.js';
import {
  computeLivePoints,
  createGameweekContext,
  playerLiveInfo,
  type GameweekContext,
} from './live-engine.js';
import {
  engineFixturesOf,
  engineLiveOf,
  enginePicksOf,
  enginePlayersOf,
  mapBootstrap,
  mapEntry,
  mapEntryLive,
  mapFixtures,
  mapPicks,
  mapPlayerLive,
  mapStandings,
  toChip,
  totalBeforeEvent,
} from './normalize.js';
import {
  RawBootstrapSchema,
  RawEntryHistorySchema,
  RawEntrySchema,
  RawFixturesSchema,
  RawLiveSchema,
  RawPicksSchema,
  RawStandingsSchema,
  type RawEntryHistory,
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
  /** Picks of a GW whose deadline has passed: the 15 players, captaincy and chip never change again. */
  picksImmutable: 12 * HOUR,
  /** Picks read for their entry_history (points/rank), which moves while the GW is in progress. */
  picksSummary: 1 * MINUTE,
  standings: 2 * MINUTE,
} as const;

/** Max parallel FPL requests when building a live league page. */
export const LIVE_LEAGUE_CONCURRENCY = 6;
/** FPL classic standings page size. */
export const STANDINGS_PAGE_SIZE = 50;

export interface CreateFplServiceExtras {
  /** Overrides for the TTLs above (ms). */
  ttl?: Partial<Record<keyof typeof FPL_CACHE_TTL, number>>;
}

interface BootstrapBundle {
  dto: Bootstrap;
  players: ReturnType<typeof enginePlayersOf>;
}

export function createFplService(options: FplServiceOptions & CreateFplServiceExtras): FplService {
  const now = options.now ?? (() => Date.now());
  const ttl = { ...FPL_CACHE_TTL, ...options.ttl };
  const getJson = createFplHttp({
    fetch: options.fetch,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  });
  const cache = new TtlCache({ now });

  const bootstrap = (): Promise<BootstrapBundle> =>
    cache.get('bootstrap', ttl.bootstrap, async () => {
      const raw = await getJson('bootstrap-static/', RawBootstrapSchema);
      const dto = mapBootstrap(raw, now());
      return { dto, players: enginePlayersOf(dto) };
    });

  const rawFixtures = (event?: number): Promise<RawFixture[]> => {
    const path = event === undefined ? 'fixtures/' : `fixtures/?event=${event}`;
    return cache.get(path, ttl.fixtures, () => getJson(path, RawFixturesSchema));
  };

  const rawLive = (event: number): Promise<RawLive> => {
    const path = `event/${event}/live/`;
    return cache.get(path, ttl.live, () => getJson(path, RawLiveSchema));
  };

  const rawPicks = (entryId: number, event: number, maxAgeMs: number): Promise<RawPicks> => {
    const path = `entry/${entryId}/event/${event}/picks/`;
    return cache.get(path, maxAgeMs, () => getJson(path, RawPicksSchema));
  };

  const rawHistory = (entryId: number): Promise<RawEntryHistory> => {
    const path = `entry/${entryId}/history/`;
    return cache.get(path, ttl.history, () => getJson(path, RawEntryHistorySchema));
  };

  // One GameweekContext per (bootstrap, fixtures, live) snapshot, shared by every manager.
  const contexts = new Map<number, { refs: readonly unknown[]; ctx: GameweekContext }>();
  const gameweekContext = async (event: number): Promise<GameweekContext> => {
    const [b, fixtures, live] = await Promise.all([bootstrap(), rawFixtures(event), rawLive(event)]);
    const memo = contexts.get(event);
    if (memo && memo.refs[0] === b && memo.refs[1] === fixtures && memo.refs[2] === live) return memo.ctx;
    const ctx = createGameweekContext({
      players: b.players,
      fixtures: engineFixturesOf(fixtures),
      live: engineLiveOf(live),
    });
    contexts.set(event, { refs: [b, fixtures, live], ctx });
    return ctx;
  };

  const liveForPicks = (ctx: GameweekContext, picks: RawPicks) =>
    computeLivePoints(ctx, {
      picks: enginePicksOf(picks),
      activeChip: toChip(picks.active_chip),
      transfersCost: picks.entry_history.event_transfers_cost,
    });

  const service: FplService = {
    async getBootstrap(): Promise<Bootstrap> {
      return (await bootstrap()).dto;
    },

    async getFixtures(event?: Gameweek): Promise<Fixture[]> {
      return mapFixtures(await rawFixtures(event));
    },

    async getEntry(entryId: FplEntryId): Promise<EntrySummary> {
      const path = `entry/${entryId}/`;
      const raw = await cache.get(path, ttl.entry, () => getJson(path, RawEntrySchema));
      return mapEntry(raw);
    },

    async getEntryPicks(entryId: FplEntryId, event: Gameweek): Promise<EntryPicks> {
      const b = await bootstrap();
      const info = b.dto.events.find((e) => e.id === event);
      // A finished + data-checked GW is final: its entry_history no longer moves either.
      const maxAge = info?.finished && info.dataChecked ? ttl.picksImmutable : ttl.picksSummary;
      const [picks, history] = await Promise.all([rawPicks(entryId, event, maxAge), rawHistory(entryId)]);
      return mapPicks(entryId, event, picks, history);
    },

    async getEntryLive(entryId: FplEntryId, event: Gameweek): Promise<EntryLive> {
      const [ctx, picks] = await Promise.all([
        gameweekContext(event),
        rawPicks(entryId, event, ttl.picksImmutable),
      ]);
      const result = liveForPicks(ctx, picks);
      return mapEntryLive(entryId, event, toChip(picks.active_chip), result, totalBeforeEvent(picks), now());
    },

    async getLeagueStandings(leagueId: FplLeagueId, page: number): Promise<LeagueStandings> {
      const p = Math.max(1, Math.trunc(page));
      const path = `leagues-classic/${leagueId}/standings/?page_standings=${p}`;
      const raw = await cache.get(path, ttl.standings, () => getJson(path, RawStandingsSchema));
      return mapStandings(raw, p, now());
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
     */
    async getLiveLeague(leagueId: FplLeagueId, event: Gameweek, page: number): Promise<LiveLeague> {
      const [standings, ctx] = await Promise.all([
        service.getLeagueStandings(leagueId, page),
        gameweekContext(event),
      ]);

      const rows = await mapWithConcurrency(standings.rows, LIVE_LEAGUE_CONCURRENCY, async (row) => {
        const base = {
          officialRank: row.rank,
          entryId: row.entryId,
          entryName: row.entryName,
          managerName: row.managerName,
        };
        try {
          const picks = await rawPicks(row.entryId, event, ttl.picksImmutable);
          const result = liveForPicks(ctx, picks);
          const captain = picks.picks.find((p) => p.is_captain);
          return {
            ...base,
            livePoints: result.livePoints,
            liveTotal: totalBeforeEvent(picks) + result.livePoints,
            captainPlayerId: captain ? captain.element : null,
            activeChip: toChip(picks.active_chip),
            playersYetToPlay: result.playersYetToPlay,
          };
        } catch (err) {
          if (!(err instanceof FplNotFoundError) && !(err instanceof FplUnavailableError)) throw err;
          const notFound = err instanceof FplNotFoundError;
          return {
            ...base,
            livePoints: notFound ? 0 : row.eventTotal,
            liveTotal: notFound ? row.total - row.eventTotal : row.total,
            captainPlayerId: null,
            activeChip: null,
            playersYetToPlay: 0,
          };
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

      return LiveLeagueSchema.parse({
        league: standings.league,
        event,
        page: standings.page,
        hasNext: standings.hasNext,
        rows: ranked,
        updatedAt: new Date(now()).toISOString(),
      });
    },

    async getPlayersLive(playerIds: readonly FplPlayerId[], event: Gameweek): Promise<PlayerLive[]> {
      const ctx = await gameweekContext(event);
      return playerIds.map((id) => mapPlayerLive(playerLiveInfo(ctx, id)));
    },
  };

  return service;
}
