import {
  BootstrapSchema,
  ChipSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
  LeagueStandingsSchema,
  PlayerLiveSchema,
  PlayerStatusSchema,
  type Bootstrap,
  type Chip,
  type EntryLive,
  type EntryPicks,
  type EntrySummary,
  type Fixture,
  type FixtureStatus,
  type LeagueStandings,
  type PlayerLive,
  type Position,
} from '@fant/shared';
import type {
  EngineFixture,
  EngineLiveStats,
  EnginePick,
  EnginePlayer,
  LivePointsResult,
  PlayerLiveInfo,
} from './live-engine.js';
import type {
  RawBootstrap,
  RawElement,
  RawEntry,
  RawEntryHistory,
  RawFixture,
  RawLive,
  RawPicks,
  RawStandings,
} from './raw.js';

/** Raw → `@fant/shared` DTOs. Every output is passed through the shared schema's `.parse`. */

const POSITION_BY_ELEMENT_TYPE: Readonly<Record<number, Position>> = {
  1: 'GKP',
  2: 'DEF',
  3: 'MID',
  4: 'FWD',
};

export function positionOf(elementType: number): Position | null {
  return POSITION_BY_ELEMENT_TYPE[elementType] ?? null;
}

export function toChip(name: string | null | undefined): Chip | null {
  const parsed = ChipSchema.safeParse(name);
  return parsed.success ? parsed.data : null;
}

export function fixtureStatusOf(
  f: Pick<RawFixture, 'started' | 'finished' | 'finished_provisional'>,
): FixtureStatus {
  if (f.finished) return 'finished';
  if (f.finished_provisional) return 'finished_provisional';
  if (f.started) return 'live';
  return 'not_started';
}

function toIso(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

function toNumber(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(status: string): 'a' | 'd' | 'i' | 'n' | 's' | 'u' {
  const parsed = PlayerStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : 'a';
}

function isPlayableElement(e: RawElement): boolean {
  return positionOf(e.element_type) !== null;
}

export function mapBootstrap(raw: RawBootstrap, fetchedAtMs: number): Bootstrap {
  const current = raw.events.find((e) => e.is_current);
  const next = raw.events.find((e) => e.is_next);
  return BootstrapSchema.parse({
    currentEvent: current?.id ?? null,
    nextEvent: next?.id ?? null,
    events: raw.events.map((e) => {
      const started = e.finished || e.is_current;
      return {
        id: e.id,
        name: e.name,
        deadlineTime: toIso(e.deadline_time),
        finished: e.finished,
        dataChecked: e.data_checked,
        isCurrent: e.is_current,
        isNext: e.is_next,
        averageScore: started ? (e.average_entry_score ?? null) : null,
        highestScore: started ? (e.highest_score ?? null) : null,
      };
    }),
    teams: raw.teams.map((t) => ({ id: t.id, name: t.name, shortName: t.short_name, code: t.code })),
    players: raw.elements.filter(isPlayableElement).map((e) => ({
      id: e.id,
      webName: e.web_name,
      firstName: e.first_name,
      secondName: e.second_name,
      teamId: e.team,
      position: positionOf(e.element_type),
      nowCost: e.now_cost,
      photoCode: e.photo.replace(/\.(jpg|png)$/i, ''),
      status: mapStatus(e.status),
      news: e.news ?? '',
      chanceOfPlayingNextRound: e.chance_of_playing_next_round ?? null,
      selectedByPercent: toNumber(e.selected_by_percent),
      totalPoints: e.total_points,
      eventPoints: e.event_points,
      form: toNumber(e.form),
    })),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  });
}

export function mapFixtures(raw: readonly RawFixture[]): Fixture[] {
  return raw.map((f) =>
    FixtureSchema.parse({
      id: f.id,
      event: f.event,
      kickoffTime: f.kickoff_time === null ? null : toIso(f.kickoff_time),
      teamH: f.team_h,
      teamA: f.team_a,
      teamHScore: f.team_h_score,
      teamAScore: f.team_a_score,
      minutes: f.minutes,
      status: fixtureStatusOf(f),
    }),
  );
}

export function mapEntry(raw: RawEntry): EntrySummary {
  return EntrySummarySchema.parse({
    entryId: raw.id,
    teamName: raw.name,
    managerName: `${raw.player_first_name} ${raw.player_last_name}`.trim(),
    overallPoints: raw.summary_overall_points ?? 0,
    overallRank: raw.summary_overall_rank ?? null,
    eventPoints: raw.summary_event_points ?? 0,
    currentEvent: raw.current_event,
    bank: raw.last_deadline_bank ?? null,
    value: raw.last_deadline_value ?? null,
    regionName: raw.player_region_name ?? null,
  });
}

export function chipsUsedOf(history: RawEntryHistory): { chip: Chip; event: number }[] {
  const out: { chip: Chip; event: number }[] = [];
  for (const c of history.chips) {
    const chip = toChip(c.name);
    if (chip) out.push({ chip, event: c.event });
  }
  return out.sort((a, b) => a.event - b.event);
}

export function mapPicks(
  entryId: number,
  event: number,
  raw: RawPicks,
  history: RawEntryHistory,
): EntryPicks {
  const eh = raw.entry_history;
  return EntryPicksSchema.parse({
    entryId,
    event,
    activeChip: toChip(raw.active_chip),
    chipsUsed: chipsUsedOf(history),
    picks: [...raw.picks]
      .sort((a, b) => a.position - b.position)
      .map((p) => ({
        playerId: p.element,
        slot: p.position,
        multiplier: p.multiplier,
        isCaptain: p.is_captain,
        isViceCaptain: p.is_vice_captain,
      })),
    // FPL's entry_history.points is gross; the DTO documents points net of the transfer cost.
    points: eh.points - eh.event_transfers_cost,
    pointsOnBench: eh.points_on_bench,
    transfersMade: eh.event_transfers,
    transfersCost: eh.event_transfers_cost,
    bank: eh.bank,
    value: eh.value,
    overallRank: eh.overall_rank,
    rankInGameweek: eh.rank,
  });
}

export function mapStandings(raw: RawStandings, page: number, nowMs: number): LeagueStandings {
  return LeagueStandingsSchema.parse({
    league: { id: raw.league.id, name: raw.league.name },
    page,
    hasNext: raw.standings.has_next,
    rows: raw.standings.results.map((r) => ({
      rank: r.rank,
      lastRank: r.last_rank,
      entryId: r.entry,
      entryName: r.entry_name,
      managerName: r.player_name,
      total: r.total,
      eventTotal: r.event_total,
    })),
    updatedAt: new Date(nowMs).toISOString(),
  });
}

// ---------- raw → engine ----------

export function enginePlayersOf(bootstrap: Bootstrap): Map<number, EnginePlayer> {
  return new Map(
    bootstrap.players.map((p) => [p.id as number, { id: p.id, teamId: p.teamId, position: p.position }]),
  );
}

export function engineFixturesOf(raw: readonly RawFixture[]): EngineFixture[] {
  return raw.map((f) => {
    const stat = (id: string) => f.stats.find((s) => s.identifier === id);
    const bps = stat('bps');
    const bonus = stat('bonus');
    return {
      id: f.id,
      teamH: f.team_h,
      teamA: f.team_a,
      status: fixtureStatusOf(f),
      bonus: bonus ? [...bonus.h, ...bonus.a].map((s) => ({ element: s.element, value: s.value })) : [],
      bps: bps ? [...bps.h, ...bps.a].map((s) => ({ element: s.element, value: s.value })) : [],
    };
  });
}

export function engineLiveOf(raw: RawLive): Map<number, EngineLiveStats> {
  return new Map(
    raw.elements.map((e) => [
      e.id,
      {
        minutes: e.stats.minutes,
        totalPoints: e.stats.total_points,
        bonus: e.stats.bonus,
        goals: e.stats.goals_scored,
        assists: e.stats.assists,
        cleanSheets: e.stats.clean_sheets,
        yellowCards: e.stats.yellow_cards,
        redCards: e.stats.red_cards,
        saves: e.stats.saves,
        bps: e.stats.bps,
      },
    ]),
  );
}

export function enginePicksOf(raw: RawPicks): EnginePick[] {
  return raw.picks.map((p) => ({
    playerId: p.element,
    slot: p.position,
    multiplier: p.multiplier,
    isCaptain: p.is_captain,
    isViceCaptain: p.is_vice_captain,
  }));
}

/**
 * Season total BEFORE this GW, from the picks response's entry_history. FPL keeps
 *   total_points = previousTotal + points − event_transfers_cost
 * and updates `points` / `total_points` together while the GW is in progress, so this difference is
 * stable during the GW (even from a cached picks response) and never double-counts the in-progress GW.
 */
export function totalBeforeEvent(raw: RawPicks): number {
  const eh = raw.entry_history;
  return eh.total_points - eh.points + eh.event_transfers_cost;
}

export function mapEntryLive(
  entryId: number,
  event: number,
  activeChip: Chip | null,
  result: LivePointsResult,
  totalBefore: number | null,
  nowMs: number,
): EntryLive {
  return EntryLiveSchema.parse({
    entryId,
    event,
    activeChip,
    livePoints: result.livePoints,
    benchPoints: result.benchPoints,
    transfersCost: result.transfersCost,
    liveTotal: totalBefore === null ? null : totalBefore + result.livePoints,
    picks: result.picks.map((p) => ({
      playerId: p.playerId,
      slot: p.slot,
      multiplier: p.multiplier,
      isCaptain: p.isCaptain,
      isViceCaptain: p.isViceCaptain,
      basePoints: p.basePoints,
      points: p.points,
      effectiveMultiplier: p.effectiveMultiplier,
      minutes: p.minutes,
      provisionalBonus: p.provisionalBonus,
      bonus: p.bonus,
      bonusConfirmed: p.bonusConfirmed,
      fixtureStatus: p.fixtureStatus,
      autoSubIn: p.autoSubIn,
      autoSubOut: p.autoSubOut,
      goals: p.goals,
      assists: p.assists,
      cleanSheet: p.cleanSheet,
      yellowCards: p.yellowCards,
      redCards: p.redCards,
      saves: p.saves,
      bps: p.bps,
    })),
    playersPlayed: result.playersPlayed,
    playersYetToPlay: result.playersYetToPlay,
    updatedAt: new Date(nowMs).toISOString(),
  });
}

export function mapPlayerLive(info: PlayerLiveInfo): PlayerLive {
  return PlayerLiveSchema.parse({
    playerId: info.playerId,
    basePoints: info.basePoints,
    minutes: info.minutes,
    provisionalBonus: info.provisionalBonus,
    bonus: info.bonus,
    bonusConfirmed: info.bonusConfirmed,
    fixtureStatus: info.fixtureStatus,
  });
}
