import { FPL_CACHE_TTL, mapWithConcurrency, type FplService } from '@fant/fpl';
import {
  BootstrapSchema,
  CaptainBattleSchema,
  FixtureDetailSchema,
  FixtureSchema,
  FplEntryIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  PublicConfigSchema,
  type Bootstrap,
  type CaptainBattle,
  type CaptainBattleRow,
  type Chip,
  type EntryPicks,
  type Fixture,
  type FixtureDetail,
  type FplEntryId,
  type FplFixtureId,
  type FplLeagueId,
  type Gameweek,
  type LeagueStandings,
  type LiveLeague,
  type PlayerLive,
  type PublicConfig,
} from '@fant/shared';
import type { AppSettings, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../context.js';
import { DEFAULT_CAPTAIN_LABELS, kindFromDb, PERMANENT_KINDS } from '../league/captains.js';
import { leagueNewEntryIds } from '../league/newEntries.js';
import { fetchAllPages, LEAGUE_MAX_PAGES } from '../league/pages.js';
import { derivedSocials, getLatestBattle, getSettings, toPublicConfig } from '../settings.js';
import { serialize } from '../validate.js';
import { HotCache, type HotPolicy, type HotResult } from './hotCache.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Freshness per hot key. Live data is recomputed at most every 10 s (FplService itself refetches FPL every
 * 30 s), and a stale key is served instantly while one refresh runs. `staleIfErrorMs` keeps the last good
 * table on screen while FPL is "being updated".
 */
export const HOT_POLICY = {
  bootstrap: { freshMs: 30 * SECOND, staleMs: 10 * MINUTE, staleIfErrorMs: 6 * 60 * MINUTE },
  live: { freshMs: 10 * SECOND, staleMs: MINUTE, staleIfErrorMs: 30 * MINUTE },
  standings: { freshMs: 30 * SECOND, staleMs: 2 * MINUTE, staleIfErrorMs: 30 * MINUTE },
  fixtures: { freshMs: 10 * SECOND, staleMs: MINUTE, staleIfErrorMs: 30 * MINUTE },
  config: { freshMs: 30 * SECOND, staleMs: MINUTE },
  news: { freshMs: 15 * SECOND, staleMs: 45 * SECOND },
  /** League avatars: every avatar change / ban / account deletion drops the key, so this only bounds drift. */
  avatars: { freshMs: MINUTE, staleMs: 4 * MINUTE },
} as const satisfies Record<string, HotPolicy>;

/** Hot key of GET /v1/league/avatars (routes/avatar.ts builds it). */
export const LEAGUE_AVATARS_HOT_KEY = 'avatars:league';

/** A league's entry → standings page/rank index is rebuilt after this (FplService's standings TTL). */
export const LEAGUE_POSITION_TTL_MS = FPL_CACHE_TTL.standings;

/** Where an entry sits in the league's standings (page = 50 per page, same paging as the live table). */
export interface EntryPosition {
  page: number;
  rank: number;
}

/**
 * Entry → position for one league, filled page by page as lookups need it: 150 users asking cost one scan of the
 * standings (shared, one page fetch at a time), not 150.
 */
interface PositionIndex {
  leagueId: FplLeagueId;
  builtAt: number;
  positions: Map<number, EntryPosition>;
  pagesScanned: number;
  done: boolean;
  next: Promise<void> | null;
}

/** Recompute now (deduped with any refresh in flight): the warmer and jobs that need current data. */
export const REFRESH_NOW: HotPolicy = { freshMs: 0, staleMs: 0 };

/** The in-memory settings copy is re-read at least this often (admin edits invalidate it at once). */
export const SETTINGS_TTL_MS = 15 * SECOND;
/** How often the pre-warmer looks for a live fixture. */
export const PREWARM_INTERVAL_MS = 30 * SECOND;
/** Picks lookups in flight at once for one standings page (≤ 50 rows; FplService caches each). */
export const STANDINGS_PICKS_CONCURRENCY = 5;
/** Max concurrent picks fetches for the captain battle's team-linked rows. */
const BATTLE_PICKS_CONCURRENCY = 5;

export interface HotDataDeps {
  prisma: PrismaClient;
  fpl: FplService;
  clock: Clock;
}

interface Captain {
  playerId: number;
  multiplier: number;
}

export function captainOf(picks: EntryPicks): Captain | null {
  const captain = picks.picks.find((p) => p.isCaptain);
  if (!captain) return null;
  return { playerId: captain.playerId, multiplier: captain.multiplier === 3 ? 3 : 2 };
}

/** Resolved rows by captain points (stable), unresolved rows last (stable). */
export function sortBattleRows<R extends Pick<CaptainBattleRow, 'captainPoints'> & { live: unknown }>(
  rows: readonly R[],
): R[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ra = a.row.live === null ? 1 : 0;
      const rb = b.row.live === null ? 1 : 0;
      return ra - rb || b.row.captainPoints - a.row.captainPoints || a.index - b.index;
    })
    .map((r) => r.row);
}

export function emptyPlayerLive(playerId: number): PlayerLive {
  return {
    playerId: FplPlayerIdSchema.parse(playerId),
    basePoints: 0,
    minutes: 0,
    provisionalBonus: 0,
    bonus: 0,
    bonusConfirmed: false,
    fixtureStatus: 'no_fixture',
  };
}

/**
 * Shared, precomputed hot data: one computation per TTL for everybody, whatever the number of users polling.
 * Routes send `body` (serialized + compressed once); jobs read `value`. Only user-specific parts (the viewer's
 * captain-battle row, My Team live) are built per request, from this shared data plus FplService's cached picks.
 */
export class HotData {
  readonly cache: HotCache;
  private log: FastifyBaseLogger | null = null;
  private settingsMemo: { at: number; value: Promise<AppSettings> } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private warming: Promise<string> | null = null;
  private positionIndex: PositionIndex | null = null;
  private newEntries: { leagueId: FplLeagueId; at: number; ids: Promise<ReadonlySet<number>> } | null = null;

  constructor(private readonly deps: HotDataDeps) {
    this.cache = new HotCache({
      now: () => deps.clock.now().getTime(),
      onError: (key, err) =>
        this.log?.warn({ err, key }, 'hot cache refresh failed (serving the last good copy)'),
    });
  }

  setLogger(log: FastifyBaseLogger): void {
    this.log = log;
  }

  // ---------- settings / config ----------

  /** AppSettings, re-read at most every SETTINGS_TTL_MS (getSettings is an upsert: a write per call). */
  settings(): Promise<AppSettings> {
    const now = this.deps.clock.now().getTime();
    if (this.settingsMemo === null || now - this.settingsMemo.at >= SETTINGS_TTL_MS) {
      const value = getSettings(this.deps.prisma);
      this.settingsMemo = { at: now, value };
      value.catch(() => {
        if (this.settingsMemo?.value === value) this.settingsMemo = null;
      });
    }
    return this.settingsMemo.value;
  }

  /** The configured league, or null. */
  async leagueId(): Promise<FplLeagueId | null> {
    const settings = await this.settings();
    return settings.leagueId === null ? null : FplLeagueIdSchema.parse(settings.leagueId);
  }

  /** After an admin edit of settings / captain battle / integrations: drop everything derived from them. */
  invalidateConfig(): void {
    this.settingsMemo = null;
    this.positionIndex = null;
    this.newEntries = null;
    this.cache.invalidate('config');
    this.cache.invalidate('battle');
    this.cache.invalidate('league:');
  }

  /** After a profile photo change, a ban / unban or an account deletion (GET /v1/league/avatars). */
  invalidateAvatars(): void {
    this.cache.invalidate(LEAGUE_AVATARS_HOT_KEY);
  }

  invalidateNews(): void {
    this.cache.invalidate('news:');
  }

  config(): Promise<HotResult<PublicConfig>> {
    return this.cache.get('config', HOT_POLICY.config, async () => {
      const [settings, battle, defaults] = await Promise.all([
        this.settings(),
        getLatestBattle(this.deps.prisma),
        derivedSocials(this.deps.prisma),
      ]);
      return { build: () => serialize(PublicConfigSchema, toPublicConfig(settings, battle, defaults)) };
    });
  }

  // ---------- FPL ----------

  bootstrap(policy: HotPolicy = HOT_POLICY.bootstrap): Promise<HotResult<Bootstrap>> {
    return this.cache.get('fpl:bootstrap', policy, async () => {
      const source = await this.deps.fpl.getBootstrap();
      return { source, build: () => serialize(BootstrapSchema, source, 'Bootstrap') };
    });
  }

  fixtures(
    event: Gameweek | undefined,
    policy: HotPolicy = HOT_POLICY.fixtures,
  ): Promise<HotResult<Fixture[]>> {
    return this.cache.get(`fpl:fixtures:${event ?? 'all'}`, policy, async () => {
      const source = await this.deps.fpl.getFixtures(event);
      return { source, build: () => serialize(z.array(FixtureSchema), source, 'Fixture[]') };
    });
  }

  fixtureDetail(fixtureId: FplFixtureId): Promise<HotResult<FixtureDetail>> {
    return this.cache.get(`fpl:fixture:${fixtureId}`, HOT_POLICY.fixtures, async () => {
      const source = await this.deps.fpl.getFixtureDetail(fixtureId);
      return { source, build: () => serialize(FixtureDetailSchema, source, 'FixtureDetail') };
    });
  }

  // ---------- league ----------

  liveLeague(
    leagueId: FplLeagueId,
    event: Gameweek,
    page: number,
    policy: HotPolicy = HOT_POLICY.live,
  ): Promise<HotResult<LiveLeague>> {
    return this.cache.get(`league:live:${leagueId}:${event}:${page}`, policy, async () => {
      const source = await this.deps.fpl.getLiveLeague(leagueId, event, page);
      return { source, build: () => serialize(LiveLeagueSchema, source, 'LiveLeague') };
    });
  }

  standings(leagueId: FplLeagueId, page: number): Promise<HotResult<LeagueStandings>> {
    return this.cache.get(`league:standings:${leagueId}:${page}`, HOT_POLICY.standings, async () => {
      const standings = await this.deps.fpl.getLeagueStandings(leagueId, page);
      const chips = await this.chipsFor(standings.rows.map((r) => r.entryId));
      return {
        build: () =>
          serialize(
            LeagueStandingsSchema,
            { ...standings, rows: standings.rows.map((r, i) => ({ ...r, activeChip: chips[i] ?? null })) },
            'LeagueStandings',
          ),
      };
    });
  }

  /**
   * The chip each entry played in the current (= last started) GW, from FplService's cached picks — only for
   * the rows on this page, a few at a time. Best-effort: a failed lookup is `null` for that row, never a failed
   * page; before the season's first deadline every row is `null`.
   */
  private async chipsFor(entryIds: readonly FplEntryId[]): Promise<(Chip | null)[]> {
    let event: Gameweek | null;
    try {
      event = (await this.deps.fpl.getBootstrap()).currentEvent;
    } catch {
      return entryIds.map(() => null);
    }
    if (event === null) return entryIds.map(() => null);
    const gw = event;
    return mapWithConcurrency(entryIds, STANDINGS_PICKS_CONCURRENCY, async (entryId) => {
      try {
        return (await this.deps.fpl.getEntryPicks(entryId, gw)).activeChip;
      } catch {
        return null;
      }
    });
  }

  /**
   * The standings page + official rank of `entryId` in `leagueId`, or null when it isn't in the league (or past
   * LEAGUE_MAX_PAGES). Pages are read in order through FplService's standings cache, stopping at the first page
   * that has the entry; every row seen is remembered, so later lookups (any user) are answered from memory until
   * the index is LEAGUE_POSITION_TTL_MS old. The live table uses the same pages (FplService builds live page N
   * from standings page N and only re-ranks within it), so `page` is valid for /v1/league/live too.
   */
  async leaguePosition(leagueId: FplLeagueId, entryId: FplEntryId): Promise<EntryPosition | null> {
    const now = this.deps.clock.now().getTime();
    let index = this.positionIndex;
    if (index === null || index.leagueId !== leagueId || now - index.builtAt >= LEAGUE_POSITION_TTL_MS) {
      index = { leagueId, builtAt: now, positions: new Map(), pagesScanned: 0, done: false, next: null };
      this.positionIndex = index;
    }
    for (;;) {
      const hit = index.positions.get(entryId);
      if (hit !== undefined) return hit;
      if (index.done) return null;
      index.next ??= this.scanNextPage(index);
      await index.next;
    }
  }

  /**
   * Whether `entryId` is one of the league's new entries (joined, not ranked yet). One read per league per
   * LEAGUE_POSITION_TTL_MS, shared by every caller (in flight included). FPL failing → false, not cached: the
   * worst case is a new joiner seeing the "Join our league" bar until the next read.
   */
  async isNewLeagueEntry(leagueId: FplLeagueId, entryId: FplEntryId): Promise<boolean> {
    const now = this.deps.clock.now().getTime();
    let memo = this.newEntries;
    if (memo === null || memo.leagueId !== leagueId || now - memo.at >= LEAGUE_POSITION_TTL_MS) {
      const ids = leagueNewEntryIds(this.deps.fpl, leagueId);
      memo = { leagueId, at: now, ids };
      this.newEntries = memo;
      const mine = memo;
      ids.catch((err: unknown) => {
        if (this.newEntries === mine) this.newEntries = null;
        this.log?.info({ err, leagueId }, 'league new entries unavailable');
      });
    }
    try {
      return (await memo.ids).has(entryId);
    } catch {
      return false;
    }
  }

  /** Reads the index's next standings page (one fetch shared by every waiting lookup). */
  private async scanNextPage(index: PositionIndex): Promise<void> {
    const page = index.pagesScanned + 1;
    try {
      const standings = await this.deps.fpl.getLeagueStandings(index.leagueId, page);
      for (const row of standings.rows) {
        // Standings can shift between page reads: the first sighting wins (as in fetchAllPages users).
        if (!index.positions.has(row.entryId)) {
          index.positions.set(row.entryId, { page: standings.page, rank: row.rank });
        }
      }
      index.pagesScanned = page;
      index.done = !standings.hasNext || page >= LEAGUE_MAX_PAGES;
    } finally {
      index.next = null;
    }
  }

  // ---------- captain battle ----------

  /**
   * The battle without any viewer row: the GW it is shown for, the team-linked rows' captains and every row's
   * live points. Computed once per TTL; a signed-in viewer's own row is added per request (see the route).
   */
  captainBattle(policy: HotPolicy = HOT_POLICY.live): Promise<HotResult<CaptainBattle>> {
    return this.cache.get('battle', policy, async () => {
      const value = await this.computeBattle();
      return { build: () => value };
    });
  }

  private async computeBattle(): Promise<CaptainBattle> {
    const now = this.deps.clock.now().toISOString();
    const battle = await getLatestBattle(this.deps.prisma);
    if (!battle) return serialize(CaptainBattleSchema, { event: null, rows: [], updatedAt: now });
    const savedEvent: Gameweek = GameweekSchema.parse(battle.event);
    const event = await this.battleEvent(savedEvent);

    const linked = [
      ...new Set(
        battle.entries.flatMap((e) =>
          e.source === 'ENTRY' && e.entryId !== null ? [FplEntryIdSchema.parse(e.entryId)] : [],
        ),
      ),
    ];
    const captains = new Map<number, Captain | null>();
    await mapWithConcurrency(linked, BATTLE_PICKS_CONCURRENCY, async (entryId) => {
      try {
        captains.set(entryId, captainOf(await this.deps.fpl.getEntryPicks(entryId, event)));
      } catch (err) {
        // 404 before the deadline (FPL hides picks) or any upstream error: captain unknown, row stays.
        this.log?.info({ err, entryId }, 'captain battle: picks unavailable');
        captains.set(entryId, null);
      }
    });

    const saved = battle.entries.map((e) => {
      const base = {
        key: e.id,
        label: e.label,
        kind: kindFromDb(e.kind),
        tag: e.tag,
      } as const;
      if (e.source === 'ENTRY' && e.entryId !== null) {
        const captain = captains.get(e.entryId) ?? null;
        return {
          ...base,
          source: 'entry' as const,
          entryId: e.entryId,
          playerId: captain?.playerId ?? null,
          multiplier: captain?.multiplier ?? 2,
        };
      }
      return {
        ...base,
        source: 'player' as const,
        entryId: null,
        // A hand-picked captain belongs to the GW it was saved for: after a rollover the row stays, empty
        // ("not picked yet for this GW"), until the admin picks again — never last week's player.
        playerId: savedEvent === event ? e.playerId : null,
        multiplier: 2,
      };
    });

    // The two permanent captains are always on the board: one the saved battle predates shows as "not picked yet".
    const present = new Set<string>(saved.map((r) => r.kind));
    const virtual = PERMANENT_KINDS.filter((k) => !present.has(k)).map((kind) => ({
      key: kind,
      label: DEFAULT_CAPTAIN_LABELS[kind],
      kind,
      tag: null,
      source: 'player' as const,
      entryId: null,
      playerId: null,
      multiplier: 2,
    }));
    const pending = [...virtual, ...saved];

    const ids = [
      ...new Set(pending.flatMap((r) => (r.playerId === null ? [] : [FplPlayerIdSchema.parse(r.playerId)]))),
    ];
    const live = ids.length > 0 ? await this.deps.fpl.getPlayersLive(ids, event) : [];
    const byId = new Map<number, PlayerLive>(live.map((p) => [p.playerId, p]));
    const rows = pending.map((row) => {
      const playerLive =
        row.playerId === null ? null : (byId.get(row.playerId) ?? emptyPlayerLive(row.playerId));
      return {
        ...row,
        captainPoints: playerLive ? playerLive.basePoints * row.multiplier : 0,
        live: playerLive,
      };
    });
    return serialize(
      CaptainBattleSchema,
      { event, rows: sortBattleRows(rows), updatedAt: now },
      'CaptainBattle',
    );
  }

  /**
   * The GW the battle is shown for: FPL's current GW (or the next before the season's first deadline), unless
   * the admin saved the battle for a later GW. FPL unavailable → the saved GW.
   */
  private async battleEvent(saved: Gameweek): Promise<Gameweek> {
    try {
      const bootstrap = await this.deps.fpl.getBootstrap();
      const current = bootstrap.currentEvent ?? bootstrap.nextEvent;
      return current === null || current < saved ? saved : current;
    } catch (err) {
      this.log?.info({ err }, 'captain battle: bootstrap unavailable, using the saved gameweek');
      return saved;
    }
  }

  // ---------- pre-warming ----------

  /** Every PREWARM_INTERVAL_MS while a fixture of the current GW is live: recompute the live hot keys. */
  start(intervalMs = PREWARM_INTERVAL_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.warm().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pre-warm pass (never overlapping itself). Outside live matches it costs two cached FPL reads; during
   * them it recomputes every live league page, the captain battle and the fixtures, so user requests always
   * find warm data. Returns what it did (for logs and tests).
   */
  warm(): Promise<string> {
    if (this.warming !== null) return this.warming;
    this.warming = (async () => {
      try {
        const bootstrap = (await this.bootstrap()).value;
        const event = bootstrap.currentEvent;
        if (event === null) return 'idle: no current gameweek';
        const fixtures = (await this.fixtures(event, REFRESH_NOW)).value;
        if (!fixtures.some((f) => f.status === 'live')) return `idle: GW${event} has no live fixture`;
        const leagueId = await this.leagueId();
        let pages = 0;
        if (leagueId !== null) {
          pages = (
            await fetchAllPages(
              async (page) => (await this.liveLeague(leagueId, event, page, REFRESH_NOW)).value,
            )
          ).length;
        }
        await this.captainBattle(REFRESH_NOW);
        return `warmed GW${event}: ${pages} live league page(s), captain battle, fixtures`;
      } catch (err) {
        this.log?.warn({ err }, 'pre-warm failed');
        return 'failed';
      } finally {
        this.warming = null;
      }
    })();
    return this.warming;
  }
}
