import type {
  Bootstrap,
  EntryLive,
  EntryPicks,
  EntrySummary,
  Fixture,
  FplEntryId,
  FplLeagueId,
  FplPlayerId,
  Gameweek,
  LeagueStandings,
  LiveLeague,
  PlayerLive,
} from '@fant/shared';

/**
 * The single seam between the app and fantasy.premierleague.com.
 *
 * Implemented by `createFplService` (live HTTP + TTL cache) and by test fakes. apps/api depends on
 * this interface only — never on raw FPL response shapes.
 */
export interface FplService {
  getBootstrap(): Promise<Bootstrap>;
  /** All fixtures of a GW (or the whole season when `event` is omitted), with live scores. */
  getFixtures(event?: Gameweek): Promise<Fixture[]>;
  /** Throws FplNotFoundError when the Team ID doesn't exist. */
  getEntry(entryId: FplEntryId): Promise<EntrySummary>;
  getEntryPicks(entryId: FplEntryId, event: Gameweek): Promise<EntryPicks>;
  /** Live GW points with auto-subs, vice-captain promotion and provisional bonus applied. */
  getEntryLive(entryId: FplEntryId, event: Gameweek): Promise<EntryLive>;
  getLeagueStandings(leagueId: FplLeagueId, page: number): Promise<LeagueStandings>;
  /** Live table for one standings page (50 managers): each manager's live GW points, re-ranked. */
  getLiveLeague(leagueId: FplLeagueId, event: Gameweek, page: number): Promise<LiveLeague>;
  getPlayersLive(playerIds: readonly FplPlayerId[], event: Gameweek): Promise<PlayerLive[]>;
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
  ) {
    super(message);
    this.name = 'FplUnavailableError';
  }
}

export interface FplServiceOptions {
  /** Injected so the package stays platform-agnostic and tests can replay recorded responses. */
  fetch: typeof fetch;
  /** Defaults to https://fantasy.premierleague.com/api */
  baseUrl?: string;
  userAgent?: string;
  /** Injected clock (ms since epoch) for cache TTLs and `updatedAt`. Defaults to Date.now. */
  now?: () => number;
}
