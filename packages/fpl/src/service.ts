import type {
  Bootstrap,
  EntryLive,
  EntryPicks,
  EntrySummary,
  Fixture,
  FixtureDetail,
  FplEntryId,
  FplFixtureId,
  FplLeagueId,
  FplPlayerId,
  Gameweek,
  LeagueStandings,
  LiveLeague,
  PlayerLive,
} from '@fant/shared';
import type { EntryHistory, EntryTransfer, EventPoints, LeagueInfo } from './dto.js';

/**
 * The single seam between the app and fantasy.premierleague.com.
 *
 * Implemented by `createFplService` (live HTTP + TTL cache) and by test fakes. apps/api depends on
 * this interface only — never on raw FPL response shapes.
 */
/**
 * Per-read options. `fresh: true` = always ask FPL: never answer from the cache and never fall back to stale
 * data — failures throw (`FplUnavailableError`, `FplNotFoundError`), the shared backoff still applies, and a
 * success refreshes the cache. Use it for anything that is stored permanently (the Gameweek Roundup).
 */
export interface FplReadOptions {
  fresh?: boolean;
}

export interface FplService {
  getBootstrap(options?: FplReadOptions): Promise<Bootstrap>;
  /** All fixtures of a GW (or the whole season when `event` is omitted), with live scores. */
  getFixtures(event?: Gameweek): Promise<Fixture[]>;
  /** Throws FplNotFoundError when the Team ID doesn't exist. */
  getEntry(entryId: FplEntryId): Promise<EntrySummary>;
  /** `fresh` also re-reads the history used for `chipsUsed`. */
  getEntryPicks(entryId: FplEntryId, event: Gameweek, options?: FplReadOptions): Promise<EntryPicks>;
  /** Live GW points with auto-subs, vice-captain promotion and provisional bonus applied. */
  getEntryLive(entryId: FplEntryId, event: Gameweek): Promise<EntryLive>;
  getLeagueStandings(leagueId: FplLeagueId, page: number, options?: FplReadOptions): Promise<LeagueStandings>;
  /** Live table for one standings page (50 managers): each manager's live GW points, re-ranked. */
  getLiveLeague(leagueId: FplLeagueId, event: Gameweek, page: number): Promise<LiveLeague>;
  /**
   * Managers who joined the league since FPL's last standings update and aren't ranked yet (`new_entries`,
   * every page, capped at 20). Use with the standings rows for a "member of the league" check. Optional so
   * existing fakes still compile; createFplService always implements it.
   */
  getLeagueNewEntries?(leagueId: FplLeagueId): Promise<FplEntryId[]>;
  getPlayersLive(playerIds: readonly FplPlayerId[], event: Gameweek): Promise<PlayerLive[]>;
  /**
   * A manager's season, GW by GW (points net of hits, transfers, bench points, ranks) plus chips played.
   * Throws FplNotFoundError for an unknown Team ID. Optional so existing fakes still compile;
   * createFplService always implements it (as do getEntryTransfers, getEventPoints and getLeagueInfo).
   */
  getEntryHistory?(entryId: FplEntryId, options?: FplReadOptions): Promise<EntryHistory>;
  /** Every transfer of the season, oldest first (Wildcard / Free Hit ones included). */
  getEntryTransfers?(entryId: FplEntryId, options?: FplReadOptions): Promise<EntryTransfer[]>;
  /**
   * Every player's FPL points and minutes for a GW from ONE `event/{gw}/live/` call (shared with the live
   * engine's cache). FPL's own totals: final once the GW is data-checked. Missing player → 0 points.
   */
  getEventPoints?(event: Gameweek, options?: FplReadOptions): Promise<EventPoints>;
  /** League name and `startEvent` (from standings page 1, same cache). Throws FplNotFoundError if unknown. */
  getLeagueInfo?(leagueId: FplLeagueId, options?: FplReadOptions): Promise<LeagueInfo>;
  /**
   * The FPL match sheet ("Match Details" stat blocks + per-player FPL points from this fixture only).
   * Empty stats/players before kick-off. Throws FplNotFoundError for an unknown fixture id.
   */
  getFixtureDetail(fixtureId: FplFixtureId): Promise<FixtureDetail>;
  /**
   * Upstream health: whether FPL is currently failing (429 / 503 "The game is being updated" / network)
   * and the service is answering from its last good data. Optional so test fakes needn't implement it.
   * The DTOs' `updatedAt` / `fetchedAt` carry the age of the data actually served.
   */
  getHealth?(): FplHealth;
}

/** Why FPL could not be used. `updating` = FPL's GW-update window (HTTP 503 / "The game is being updated."). */
export type FplUnavailableKind =
  'updating' | 'rate_limited' | 'server_error' | 'network' | 'bad_response' | 'backoff';

export interface FplHealth {
  /** `ok`: last FPL call succeeded. `updating`: FPL's update window. `degraded`: rate limit / errors. */
  state: 'ok' | 'degraded' | 'updating';
  /** True while FPL is failing: responses come from the last good data (see their `updatedAt`). */
  stale: boolean;
  /** Last successful FPL response (ISO), or null before the first one. */
  lastSuccessAt: string | null;
  /** Since when FPL has been failing (ISO), or null when healthy. */
  failingSince: string | null;
  /** While backing off, FPL is not called before this instant (ISO); null when not backing off. */
  retryAt: string | null;
  lastError: { kind: FplUnavailableKind; status: number | null; message: string; at: string } | null;
}

export class FplNotFoundError extends Error {
  constructor(what: string) {
    super(`FPL resource not found: ${what}`);
    this.name = 'FplNotFoundError';
  }
}

/** FPL is down, rate-limiting us, or "The game is being updated" (HTTP 503 between GWs). */
export class FplUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Defaults from `status`: 503 → updating, 429 → rate_limited, null → network, other → server_error. */
    readonly kind: FplUnavailableKind = defaultKind(status),
    /** Server-requested wait (HTTP Retry-After), ms. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'FplUnavailableError';
  }
}

function defaultKind(status: number | null): FplUnavailableKind {
  if (status === null) return 'network';
  if (status === 503) return 'updating';
  if (status === 429) return 'rate_limited';
  return 'server_error';
}

export interface FplServiceOptions {
  /** Injected so the package stays platform-agnostic and tests can replay recorded responses. */
  fetch: typeof fetch;
  /** Defaults to https://fantasy.premierleague.com/api */
  baseUrl?: string;
  userAgent?: string;
  /** Injected clock (ms since epoch) for cache TTLs and `updatedAt`. Defaults to Date.now. */
  now?: () => number;
  /**
   * Non-fatal data oddities, e.g. a fixture stat identifier FPL introduced that we don't map yet. Each
   * distinct message is reported once per service instance.
   */
  onWarn?: (message: string) => void;
}
