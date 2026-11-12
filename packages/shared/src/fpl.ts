import * as z from 'zod/mini';
import {
  FplEntryIdSchema,
  FplFixtureIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  FplTeamIdSchema,
  GameweekSchema,
} from './ids.js';

/**
 * Normalized FPL DTOs. These are OUR shapes (camelCase, trimmed), produced by packages/fpl from the raw
 * fantasy.premierleague.com responses, served by apps/api, rendered by apps/web.
 */

export const PositionSchema = z.enum(['GKP', 'DEF', 'MID', 'FWD']);
export type Position = z.infer<typeof PositionSchema>;

export const ChipSchema = z.enum(['wildcard', 'freehit', 'bboost', '3xc']);
export type Chip = z.infer<typeof ChipSchema>;

export const GameweekInfoSchema = z.object({
  id: GameweekSchema,
  name: z.string(),
  deadlineTime: z.string().check(z.iso.datetime({ offset: true })),
  finished: z.boolean(),
  dataChecked: z.boolean(),
  isCurrent: z.boolean(),
  isNext: z.boolean(),
  averageScore: z.nullable(z.number().check(z.int())),
  highestScore: z.nullable(z.number().check(z.int())),
});
export type GameweekInfo = z.infer<typeof GameweekInfoSchema>;

export const PlTeamSchema = z.object({
  id: FplTeamIdSchema,
  name: z.string(),
  shortName: z.string(),
  /** FPL team `code`, used for badge/shirt image URLs. */
  code: z.number().check(z.int()),
});
export type PlTeam = z.infer<typeof PlTeamSchema>;

export const PlayerStatusSchema = z.enum(['a', 'd', 'i', 'n', 's', 'u']);

export const PlayerSchema = z.object({
  id: FplPlayerIdSchema,
  webName: z.string(),
  firstName: z.string(),
  secondName: z.string(),
  teamId: FplTeamIdSchema,
  position: PositionSchema,
  /** Price in tenths of a million (FPL convention): 105 = £10.5m. */
  nowCost: z.number().check(z.int()),
  /** FPL photo code, e.g. "223094" — image at resources.premierleague.com/premierleague25/photos/players/110x140/{code}.png */
  photoCode: z.string(),
  status: PlayerStatusSchema,
  news: z.string(),
  chanceOfPlayingNextRound: z.nullable(z.number().check(z.int())),
  selectedByPercent: z.number(),
  totalPoints: z.number().check(z.int()),
  eventPoints: z.number().check(z.int()),
  form: z.number(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const BootstrapSchema = z.object({
  currentEvent: z.nullable(GameweekSchema),
  nextEvent: z.nullable(GameweekSchema),
  events: z.array(GameweekInfoSchema),
  teams: z.array(PlTeamSchema),
  players: z.array(PlayerSchema),
  fetchedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

export const FixtureStatusSchema = z.enum(['not_started', 'live', 'finished_provisional', 'finished']);
export type FixtureStatus = z.infer<typeof FixtureStatusSchema>;

export const FixtureSchema = z.object({
  id: FplFixtureIdSchema,
  event: z.nullable(GameweekSchema),
  kickoffTime: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  teamH: FplTeamIdSchema,
  teamA: FplTeamIdSchema,
  teamHScore: z.nullable(z.number().check(z.int())),
  teamAScore: z.nullable(z.number().check(z.int())),
  minutes: z.number().check(z.int()),
  status: FixtureStatusSchema,
});
export type Fixture = z.infer<typeof FixtureSchema>;
export const FixtureListSchema = z.array(FixtureSchema);

/** FPL's per-fixture stat identifiers (fixtures endpoint `stats`), in the order the match sheet shows them. */
export const FixtureStatIdSchema = z.enum([
  'goals_scored',
  'assists',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'bonus',
  'bps',
  'defensive_contribution',
]);
export type FixtureStatId = z.infer<typeof FixtureStatIdSchema>;

export const FixtureStatValueSchema = z.object({
  playerId: FplPlayerIdSchema,
  value: z.number().check(z.int()),
});

/** One stat block of the match sheet, e.g. goals: home [{Salah, 2}] · away [{Isak, 1}]. Sorted by value desc. */
export const FixtureStatBlockSchema = z.object({
  id: FixtureStatIdSchema,
  home: z.array(FixtureStatValueSchema),
  away: z.array(FixtureStatValueSchema),
});
export type FixtureStatBlock = z.infer<typeof FixtureStatBlockSchema>;

/** A player's FPL return from this fixture only (from the GW live `explain` for this fixture). */
export const FixturePlayerPointsSchema = z.object({
  playerId: FplPlayerIdSchema,
  teamId: FplTeamIdSchema,
  minutes: z.number().check(z.int(), z.nonnegative()),
  /** FPL points earned in this fixture (provisional bonus not included until FPL adds it). */
  points: z.number().check(z.int()),
});
export type FixturePlayerPoints = z.infer<typeof FixturePlayerPointsSchema>;

/** GET /v1/fpl/fixtures/:fixtureId — the FPL match sheet ("Match Details" + "Player Stats"). */
export const FixtureDetailSchema = z.object({
  fixture: FixtureSchema,
  /** Only blocks with at least one entry; empty before kick-off. */
  stats: z.array(FixtureStatBlockSchema),
  /** Players who appeared (minutes > 0), points desc. Empty before kick-off. */
  players: z.array(FixturePlayerPointsSchema),
  updatedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type FixtureDetail = z.infer<typeof FixtureDetailSchema>;

export const EntrySummarySchema = z.object({
  entryId: FplEntryIdSchema,
  teamName: z.string(),
  managerName: z.string(),
  overallPoints: z.number().check(z.int()),
  overallRank: z.nullable(z.number().check(z.int())),
  eventPoints: z.number().check(z.int()),
  currentEvent: z.nullable(GameweekSchema),
  /** Tenths of a million. */
  bank: z.nullable(z.number().check(z.int())),
  value: z.nullable(z.number().check(z.int())),
  regionName: z.nullable(z.string()),
});
export type EntrySummary = z.infer<typeof EntrySummarySchema>;

export const ChipUsageSchema = z.object({ chip: ChipSchema, event: GameweekSchema });

export const PickSchema = z.object({
  playerId: FplPlayerIdSchema,
  /** 1..11 starting XI (in formation order), 12..15 bench (12 = bench GK). */
  slot: z.number().check(z.int(), z.gte(1), z.lte(15)),
  /** 0 bench, 1 normal, 2 captain, 3 triple captain. */
  multiplier: z.number().check(z.int(), z.gte(0), z.lte(3)),
  isCaptain: z.boolean(),
  isViceCaptain: z.boolean(),
});
export type Pick = z.infer<typeof PickSchema>;

export const EntryPicksSchema = z.object({
  entryId: FplEntryIdSchema,
  event: GameweekSchema,
  activeChip: z.nullable(ChipSchema),
  chipsUsed: z.array(ChipUsageSchema),
  picks: z.array(PickSchema),
  /** Official points for the GW as reported by FPL (includes transfer cost deduction). */
  points: z.number().check(z.int()),
  pointsOnBench: z.number().check(z.int()),
  transfersMade: z.number().check(z.int()),
  transfersCost: z.number().check(z.int()),
  bank: z.number().check(z.int()),
  value: z.number().check(z.int()),
  overallRank: z.nullable(z.number().check(z.int())),
  rankInGameweek: z.nullable(z.number().check(z.int())),
});
export type EntryPicks = z.infer<typeof EntryPicksSchema>;

export const LivePickSchema = z.extend(PickSchema, {
  /** Points this player earned this GW, before multiplier, including provisional bonus. */
  basePoints: z.number().check(z.int()),
  /** basePoints × effective multiplier (after auto-subs / vice-captain promotion). */
  points: z.number().check(z.int()),
  effectiveMultiplier: z.number().check(z.int(), z.gte(0), z.lte(3)),
  minutes: z.number().check(z.int()),
  provisionalBonus: z.number().check(z.int()),
  /** All bonus points this GW, final or not (provisional + confirmed). Show this in the bonus badge. */
  bonus: z.number().check(z.int()),
  bonusConfirmed: z.boolean(),
  /** Aggregate status of this player's fixture(s) this GW. 'no_fixture' = blank GW. */
  fixtureStatus: z.enum(['no_fixture', 'not_started', 'live', 'finished']),
  autoSubIn: z.boolean(),
  autoSubOut: z.boolean(),
  goals: z.number().check(z.int()),
  assists: z.number().check(z.int()),
  cleanSheet: z.boolean(),
  yellowCards: z.number().check(z.int()),
  redCards: z.number().check(z.int()),
  saves: z.number().check(z.int()),
  bps: z.number().check(z.int()),
});
export type LivePick = z.infer<typeof LivePickSchema>;

export const EntryLiveSchema = z.object({
  entryId: FplEntryIdSchema,
  event: GameweekSchema,
  activeChip: z.nullable(ChipSchema),
  /** Live GW points for the XI (bench counted only on Bench Boost), minus transfer cost. */
  livePoints: z.number().check(z.int()),
  benchPoints: z.number().check(z.int()),
  transfersCost: z.number().check(z.int()),
  /** Season total before this GW + livePoints. */
  liveTotal: z.nullable(z.number().check(z.int())),
  picks: z.array(LivePickSchema),
  playersPlayed: z.number().check(z.int()),
  playersYetToPlay: z.number().check(z.int()),
  updatedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type EntryLive = z.infer<typeof EntryLiveSchema>;

export const LeagueStandingRowSchema = z.object({
  rank: z.number().check(z.int()),
  lastRank: z.number().check(z.int()),
  entryId: FplEntryIdSchema,
  entryName: z.string(),
  managerName: z.string(),
  total: z.number().check(z.int()),
  eventTotal: z.number().check(z.int()),
  /** Chip played in the current/last started GW (shown as an icon in the Table). null = none or unknown. */
  activeChip: z._default(z.nullable(ChipSchema), null),
});
export type LeagueStandingRow = z.infer<typeof LeagueStandingRowSchema>;

export const LeagueStandingsSchema = z.object({
  league: z.object({ id: FplLeagueIdSchema, name: z.string() }),
  page: z.number().check(z.int(), z.gte(1)),
  hasNext: z.boolean(),
  rows: z.array(LeagueStandingRowSchema),
  updatedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type LeagueStandings = z.infer<typeof LeagueStandingsSchema>;

/**
 * GET /v1/league/position (signed in) — where the viewer's own team sits in the podcast league, so the Table and
 * Live tables can jump straight to it. `page` is the standings page (50 per page) that contains the entry, also
 * valid for /v1/league/live (same paging); null when the viewer's team isn't in the league.
 */
export const LeaguePositionSchema = z.object({
  entryId: z.nullable(FplEntryIdSchema),
  page: z.nullable(z.number().check(z.int(), z.gte(1))),
  /** Official league rank (null when not in the league). */
  rank: z.nullable(z.number().check(z.int(), z.gte(1))),
  /**
   * The viewer's team is in the league: in the standings, or a "new entry" FPL hasn't ranked yet (new joiners only
   * get a page/rank after the next GW update). Drives the "Join our league" bar. Defaults to false.
   */
  member: z._default(z.boolean(), false),
});
export type LeaguePosition = z.infer<typeof LeaguePositionSchema>;

export const LiveLeagueRowSchema = z.object({
  liveRank: z.number().check(z.int()),
  officialRank: z.number().check(z.int()),
  entryId: FplEntryIdSchema,
  entryName: z.string(),
  managerName: z.string(),
  livePoints: z.number().check(z.int()),
  liveTotal: z.number().check(z.int()),
  /** The captain the manager picked. */
  captainPlayerId: z.nullable(FplPlayerIdSchema),
  /** Who actually gets the armband points: the vice when the captain didn't play, else the captain. */
  effectiveCaptainPlayerId: z.nullable(FplPlayerIdSchema),
  activeChip: z.nullable(ChipSchema),
  playersYetToPlay: z.number().check(z.int()),
});
export type LiveLeagueRow = z.infer<typeof LiveLeagueRowSchema>;

export const LiveLeagueSchema = z.object({
  league: z.object({ id: FplLeagueIdSchema, name: z.string() }),
  event: GameweekSchema,
  page: z.number().check(z.int(), z.gte(1)),
  hasNext: z.boolean(),
  rows: z.array(LiveLeagueRowSchema),
  updatedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type LiveLeague = z.infer<typeof LiveLeagueSchema>;

/** Live points of a single player in a GW (used by Captain Battle). */
export const PlayerLiveSchema = z.object({
  playerId: FplPlayerIdSchema,
  basePoints: z.number().check(z.int()),
  minutes: z.number().check(z.int()),
  provisionalBonus: z.number().check(z.int()),
  /** All bonus points this GW, final or not. */
  bonus: z.number().check(z.int()),
  /** True only when every fixture of the player this GW is `finished` (FPL's final state). */
  bonusConfirmed: z.boolean(),
  fixtureStatus: z.enum(['no_fixture', 'not_started', 'live', 'finished']),
});
export type PlayerLive = z.infer<typeof PlayerLiveSchema>;
