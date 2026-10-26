import { FplNotFoundError, FplUnavailableError, type FplService } from '@fant/fpl';
import {
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  PlayerLiveSchema,
  type Bootstrap,
  type EntryPicks,
  type EntrySummary,
  type FplEntryId,
  type FplLeagueId,
  type FplPlayerId,
  type Gameweek,
  type PlayerLive,
} from '@fant/shared';

const ISO = '2026-10-25T12:00:00.000Z';

export function makeBootstrap(currentEvent: number | null = 9, nextEvent: number | null = 10): Bootstrap {
  const player = (id: number, webName: string) => ({
    id,
    webName,
    firstName: webName,
    secondName: webName,
    teamId: 1,
    position: 'MID',
    nowCost: 100,
    photoCode: String(1000 + id),
    status: 'a',
    news: '',
    chanceOfPlayingNextRound: null,
    selectedByPercent: 10,
    totalPoints: 50,
    eventPoints: 5,
    form: 5,
  });
  return BootstrapSchema.parse({
    currentEvent,
    nextEvent,
    events: [],
    teams: [{ id: 1, name: 'Arsenal', shortName: 'ARS', code: 3 }],
    players: [player(1, 'Salah'), player(2, 'Haaland'), player(3, 'Palmer'), player(4, 'Saka')],
    fetchedAt: ISO,
  });
}

export function makeEntry(entryId: number, teamName = `Team ${entryId}`): EntrySummary {
  return EntrySummarySchema.parse({
    entryId,
    teamName,
    managerName: `Manager ${entryId}`,
    overallPoints: 500,
    overallRank: 1234,
    eventPoints: 60,
    currentEvent: 9,
    bank: 5,
    value: 1003,
    regionName: 'Israel',
  });
}

export function makePicks(
  entryId: number,
  event: number,
  captainId: number,
  captainMultiplier = 2,
): EntryPicks {
  const others = [1, 2, 3, 4].filter((id) => id !== captainId);
  return EntryPicksSchema.parse({
    entryId,
    event,
    activeChip: captainMultiplier === 3 ? '3xc' : null,
    chipsUsed: [],
    picks: [
      { playerId: captainId, slot: 1, multiplier: captainMultiplier, isCaptain: true, isViceCaptain: false },
      ...others.map((playerId, i) => ({
        playerId,
        slot: i + 2,
        multiplier: 1,
        isCaptain: false,
        isViceCaptain: i === 0,
      })),
    ],
    points: 60,
    pointsOnBench: 3,
    transfersMade: 1,
    transfersCost: 0,
    bank: 5,
    value: 1003,
    overallRank: 1234,
    rankInGameweek: 100,
  });
}

export function makePlayerLive(playerId: number, basePoints: number): PlayerLive {
  return PlayerLiveSchema.parse({
    playerId,
    basePoints,
    minutes: 90,
    provisionalBonus: 0,
    fixtureStatus: 'live',
  });
}

export interface FakeLeague {
  id: number;
  name: string;
}

/** In-memory FplService for API tests. Mutate the public fields to shape each scenario. */
export class FakeFplService implements FplService {
  bootstrap: Bootstrap = makeBootstrap();
  entries = new Map<number, EntrySummary>();
  picks = new Map<string, EntryPicks>();
  playerPoints = new Map<number, number>();
  /** Minutes per player (default 90). 0 = didn't play → vice-captain gets the armband in live league. */
  playerMinutes = new Map<number, number>();
  leagues = new Map<number, FakeLeague>();
  /** When set, every call throws this error. */
  failAll: Error | null = null;
  /** When set, getEntryPicks throws this error. */
  failPicks: Error | null = null;
  calls: string[] = [];

  addEntry(entryId: number, teamName?: string): this {
    this.entries.set(entryId, makeEntry(entryId, teamName));
    return this;
  }

  private check(call: string): void {
    this.calls.push(call);
    if (this.failAll) throw this.failAll;
  }

  async getBootstrap(): Promise<Bootstrap> {
    this.check('getBootstrap');
    return this.bootstrap;
  }

  async getFixtures(event?: Gameweek) {
    this.check(`getFixtures:${event ?? 'all'}`);
    return [
      FixtureSchema.parse({
        id: 100,
        event: event ?? 1,
        kickoffTime: ISO,
        teamH: 1,
        teamA: 1,
        teamHScore: 1,
        teamAScore: 0,
        minutes: 60,
        status: 'live',
      }),
    ];
  }

  async getEntry(entryId: FplEntryId): Promise<EntrySummary> {
    this.check(`getEntry:${entryId}`);
    const entry = this.entries.get(entryId);
    if (!entry) throw new FplNotFoundError(`entry ${entryId}`);
    return entry;
  }

  async getEntryPicks(entryId: FplEntryId, event: Gameweek): Promise<EntryPicks> {
    this.check(`getEntryPicks:${entryId}:${event}`);
    if (this.failPicks) throw this.failPicks;
    const picks = this.picks.get(`${entryId}:${event}`);
    if (!picks) throw new FplNotFoundError(`picks ${entryId}/${event}`);
    return picks;
  }

  async getEntryLive(entryId: FplEntryId, event: Gameweek) {
    this.check(`getEntryLive:${entryId}:${event}`);
    if (!this.entries.has(entryId)) throw new FplNotFoundError(`entry ${entryId}`);
    return EntryLiveSchema.parse({
      entryId,
      event,
      activeChip: null,
      livePoints: 42,
      benchPoints: 3,
      transfersCost: 0,
      liveTotal: 542,
      picks: [],
      playersPlayed: 6,
      playersYetToPlay: 5,
      updatedAt: ISO,
    });
  }

  async getLeagueStandings(leagueId: FplLeagueId, page: number) {
    this.check(`getLeagueStandings:${leagueId}:${page}`);
    const league = this.leagues.get(leagueId);
    if (!league) throw new FplNotFoundError(`league ${leagueId}`);
    return LeagueStandingsSchema.parse({
      league,
      page,
      hasNext: page < 2,
      rows: [
        {
          rank: 1,
          lastRank: 2,
          entryId: 11,
          entryName: 'Top Team',
          managerName: 'Dor',
          total: 600,
          eventTotal: 70,
        },
      ],
      updatedAt: ISO,
    });
  }

  async getLiveLeague(leagueId: FplLeagueId, event: Gameweek, page: number) {
    this.check(`getLiveLeague:${leagueId}:${event}:${page}`);
    const league = this.leagues.get(leagueId);
    if (!league) throw new FplNotFoundError(`league ${leagueId}`);
    return LiveLeagueSchema.parse({
      league,
      event,
      page,
      hasNext: false,
      rows: [
        {
          liveRank: 1,
          officialRank: 2,
          entryId: 11,
          entryName: 'Top Team',
          managerName: 'Dor',
          livePoints: 71,
          liveTotal: 671,
          captainPlayerId: 1,
          // Vice (2) takes the armband when the captain (1) didn't play.
          effectiveCaptainPlayerId: (this.playerMinutes.get(1) ?? 90) > 0 ? 1 : 2,
          activeChip: null,
          playersYetToPlay: 2,
        },
      ],
      updatedAt: ISO,
    });
  }

  async getPlayersLive(playerIds: readonly FplPlayerId[], event: Gameweek): Promise<PlayerLive[]> {
    this.check(`getPlayersLive:${[...playerIds].sort().join(',')}:${event}`);
    return playerIds.map((id) =>
      PlayerLiveSchema.parse({
        ...makePlayerLive(id, this.playerPoints.get(id) ?? 0),
        minutes: this.playerMinutes.get(id) ?? 90,
      }),
    );
  }
}

export const upstreamDown = () => new FplUnavailableError('FPL returned 503', 503);
