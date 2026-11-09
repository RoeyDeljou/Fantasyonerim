import {
  EntryHistorySchema,
  EntryTransferSchema,
  FplNotFoundError,
  FplUnavailableError,
  LeagueInfoSchema,
  type EntryHistory,
  type EntryTransfer,
  type EventPoints,
  type FplService,
  type LeagueInfo,
  type PlayerEventPoints,
} from '@fant/fpl';
import {
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureDetailSchema,
  FixtureSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  PlayerLiveSchema,
  type Bootstrap,
  type EntryLive,
  type EntryPicks,
  type EntrySummary,
  type Fixture,
  type FixtureDetail,
  FplEntryIdSchema,
  type FplEntryId,
  type FplFixtureId,
  type FplLeagueId,
  type FplPlayerId,
  type Gameweek,
  type PlayerLive,
  FplPlayerIdSchema,
  type GameweekInfo,
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

/**
 * Bootstrap GW list 1…38: GWs ≤ `officialUpTo` are finished + data-checked, `finishedUpTo` (default the same)
 * finished; `current` is FPL's current GW.
 */
export function makeEvents(
  current: number | null,
  officialUpTo: number,
  finishedUpTo = officialUpTo,
): GameweekInfo[] {
  return Array.from({ length: 38 }, (_, i) => {
    const id = i + 1;
    return {
      id,
      name: `Gameweek ${id}`,
      deadlineTime: new Date(Date.parse('2026-08-15T10:00:00.000Z') + i * 7 * 86_400_000).toISOString(),
      finished: id <= finishedUpTo,
      dataChecked: id <= officialUpTo,
      isCurrent: id === current,
      isNext: current !== null && id === current + 1,
      averageScore: id <= finishedUpTo ? 50 + id : null,
      highestScore: id <= finishedUpTo ? 100 + id : null,
    } as GameweekInfo;
  });
}

export interface HistoryRow {
  event: number;
  points: number;
  transfersMade?: number;
  transfersCost?: number;
  pointsOnBench?: number;
}

/** An entry's season from per-GW rows (`points` net of the hit; totals accumulated). */
export function makeHistory(
  entryId: number,
  rows: readonly HistoryRow[],
  chips: { chip: string; event: number }[] = [],
): EntryHistory {
  let total = 0;
  return EntryHistorySchema.parse({
    entryId,
    events: rows.map((r) => {
      total += r.points;
      return {
        event: r.event,
        points: r.points,
        grossPoints: r.points + (r.transfersCost ?? 0),
        totalPoints: total,
        transfersMade: r.transfersMade ?? 0,
        transfersCost: r.transfersCost ?? 0,
        pointsOnBench: r.pointsOnBench ?? 0,
        overallRank: 1000,
        rankInGameweek: 1000,
        bank: 5,
        value: 1000,
      };
    }),
    chips,
  });
}

export function makeTransfer(event: number, playerOut: number, playerIn: number): EntryTransfer {
  return EntryTransferSchema.parse({
    event,
    playerIn,
    playerOut,
    playerInCost: 50,
    playerOutCost: 50,
    time: '2026-10-01T10:00:00Z',
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
    bonus: 0,
    bonusConfirmed: false,
    fixtureStatus: 'live',
  });
}

export function makeFixture(id: number, event: number, status: Fixture['status'] = 'live'): Fixture {
  return FixtureSchema.parse({
    id,
    event,
    kickoffTime: ISO,
    teamH: 1,
    teamA: 1,
    teamHScore: status === 'not_started' ? null : 1,
    teamAScore: status === 'not_started' ? null : 0,
    minutes: status === 'not_started' ? 0 : 60,
    status,
  });
}

export function makeFixtureDetail(id: number, event = 9): FixtureDetail {
  return FixtureDetailSchema.parse({
    fixture: makeFixture(id, event, 'live'),
    stats: [{ id: 'goals_scored', home: [{ playerId: 1, value: 1 }], away: [] }],
    players: [{ playerId: 1, teamId: 1, minutes: 60, points: 8 }],
    updatedAt: ISO,
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
  /** Per-entry getEntryPicks failures (entryId → error). */
  failPicksFor = new Map<number, Error>();
  /** Standings rows override (default: one row, entry 11). */
  standingsRows: unknown[] | null = null;
  /** Standings pages (hasNext = page < standingsPageCount). */
  standingsPageCount = 2;
  /** Per-page standings rows (overrides standingsRows; a missing page has no rows). */
  standingsByPage: Map<number, unknown[]> | null = null;
  /** Per-page live league rows (hasNext = page < size); null = the default one-row table. */
  liveLeagueByPage: Map<number, unknown[]> | null = null;
  /** getEntryLive override by `${entryId}:${event}`. */
  entryLive = new Map<string, EntryLive>();
  /** getFixtures override (default: one live fixture 100 in the requested GW). */
  fixtures: Fixture[] | null = null;
  /** getFixtureDetail data by fixture id (unknown id → FplNotFoundError). */
  fixtureDetails = new Map<number, FixtureDetail>();
  calls: string[] = [];
  /** getEntryHistory by entry id (missing → FplNotFoundError). */
  histories = new Map<number, EntryHistory>();
  /** getEntryTransfers by entry id (missing → no transfers). */
  transfers = new Map<number, EntryTransfer[]>();
  /** getEventPoints by GW (player id → points); a GW not here uses `playerPoints`. */
  eventPoints = new Map<number, Map<number, number>>();
  /** getLeagueInfo startEvent by league id (default 1). */
  leagueStartEvents = new Map<number, number>();
  /** Per-entry getEntryHistory failures (entryId → error). */
  failHistoryFor = new Map<number, Error>();
  /** getEventPoints failure. */
  failEventPoints: Error | null = null;
  /** getLeagueNewEntries by league id (joined, not ranked yet); a league in `leagues` defaults to none. */
  newEntries = new Map<number, number[]>();

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

  async getFixtures(event?: Gameweek): Promise<Fixture[]> {
    this.check(`getFixtures:${event ?? 'all'}`);
    if (this.fixtures !== null) return this.fixtures.filter((f) => event === undefined || f.event === event);
    return [makeFixture(100, event ?? 1, 'live')];
  }

  async getFixtureDetail(fixtureId: FplFixtureId): Promise<FixtureDetail> {
    this.check(`getFixtureDetail:${fixtureId}`);
    const detail = this.fixtureDetails.get(fixtureId);
    if (!detail) throw new FplNotFoundError(`fixture ${fixtureId}`);
    return detail;
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
    const failure = this.failPicksFor.get(entryId);
    if (failure) throw failure;
    const picks = this.picks.get(`${entryId}:${event}`);
    if (!picks) throw new FplNotFoundError(`picks ${entryId}/${event}`);
    return picks;
  }

  async getEntryLive(entryId: FplEntryId, event: Gameweek) {
    this.check(`getEntryLive:${entryId}:${event}`);
    const override = this.entryLive.get(`${entryId}:${event}`);
    if (override) return override;
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
      hasNext: page < this.standingsPageCount,
      rows: this.standingsByPage?.get(page) ??
        this.standingsRows ?? [
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
    if (this.liveLeagueByPage !== null) {
      return LiveLeagueSchema.parse({
        league,
        event,
        page,
        hasNext: page < this.liveLeagueByPage.size,
        rows: this.liveLeagueByPage.get(page) ?? [],
        updatedAt: ISO,
      });
    }
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

  async getLeagueNewEntries(leagueId: FplLeagueId): Promise<FplEntryId[]> {
    this.check(`getLeagueNewEntries:${leagueId}`);
    if (!this.leagues.has(leagueId)) throw new FplNotFoundError(`league ${leagueId}`);
    return (this.newEntries.get(leagueId) ?? []).map((id) => FplEntryIdSchema.parse(id));
  }

  async getEntryHistory(entryId: FplEntryId): Promise<EntryHistory> {
    this.check(`getEntryHistory:${entryId}`);
    const failure = this.failHistoryFor.get(entryId);
    if (failure) throw failure;
    const history = this.histories.get(entryId);
    if (!history) throw new FplNotFoundError(`history ${entryId}`);
    return history;
  }

  async getEntryTransfers(entryId: FplEntryId): Promise<EntryTransfer[]> {
    this.check(`getEntryTransfers:${entryId}`);
    return this.transfers.get(entryId) ?? [];
  }

  async getEventPoints(event: Gameweek): Promise<EventPoints> {
    this.check(`getEventPoints:${event}`);
    if (this.failEventPoints) throw this.failEventPoints;
    const points = this.eventPoints.get(event) ?? this.playerPoints;
    return new Map<ReturnType<typeof FplPlayerIdSchema.parse>, PlayerEventPoints>(
      [...points].map(([id, p]) => [FplPlayerIdSchema.parse(id), { points: p, minutes: 90 }]),
    );
  }

  async getLeagueInfo(leagueId: FplLeagueId): Promise<LeagueInfo> {
    this.check(`getLeagueInfo:${leagueId}`);
    const league = this.leagues.get(leagueId);
    if (!league) throw new FplNotFoundError(`league ${leagueId}`);
    return LeagueInfoSchema.parse({ ...league, startEvent: this.leagueStartEvents.get(leagueId) ?? 1 });
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

export interface LiveCaptain {
  playerId: number;
  goals?: number;
  assists?: number;
  /** 2 captain, 3 triple captain. */
  multiplier?: number;
  basePoints?: number;
}

/**
 * A live team whose effective captain (effectiveMultiplier ≥ 2) is `captain`; `benchedCaptain` adds the picked
 * captain with effectiveMultiplier 0 (didn't play → the vice above took the armband).
 */
export function makeEntryLive(
  entryId: number,
  event: number,
  captain: LiveCaptain,
  benchedCaptain: number | null = null,
): EntryLive {
  const pick = (playerId: number, slot: number, effectiveMultiplier: number, extra: object = {}) => ({
    playerId,
    slot,
    multiplier: effectiveMultiplier,
    isCaptain: false,
    isViceCaptain: false,
    basePoints: 2,
    points: 2 * effectiveMultiplier,
    effectiveMultiplier,
    minutes: 90,
    provisionalBonus: 0,
    bonus: 0,
    bonusConfirmed: false,
    fixtureStatus: 'live',
    autoSubIn: false,
    autoSubOut: false,
    goals: 0,
    assists: 0,
    cleanSheet: false,
    yellowCards: 0,
    redCards: 0,
    saves: 0,
    bps: 10,
    ...extra,
  });
  const mult = captain.multiplier ?? 2;
  const base = captain.basePoints ?? 2 + 5 * (captain.goals ?? 0) + 3 * (captain.assists ?? 0);
  const picks = [
    pick(captain.playerId, 1, mult, {
      isCaptain: benchedCaptain === null,
      isViceCaptain: benchedCaptain !== null,
      goals: captain.goals ?? 0,
      assists: captain.assists ?? 0,
      basePoints: base,
      points: base * mult,
    }),
    ...(benchedCaptain === null
      ? []
      : [
          pick(benchedCaptain, 2, 0, {
            isCaptain: true,
            multiplier: 2,
            minutes: 0,
            basePoints: 0,
            points: 0,
          }),
        ]),
  ];
  return EntryLiveSchema.parse({
    entryId,
    event,
    activeChip: mult === 3 ? '3xc' : null,
    livePoints: 50,
    benchPoints: 0,
    transfersCost: 0,
    liveTotal: 550,
    picks,
    playersPlayed: 6,
    playersYetToPlay: 5,
    updatedAt: ISO,
  });
}
