import { z } from 'zod';
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
  deadlineTime: z.string().datetime({ offset: true }),
  finished: z.boolean(),
  dataChecked: z.boolean(),
  isCurrent: z.boolean(),
  isNext: z.boolean(),
  averageScore: z.number().int().nullable(),
  highestScore: z.number().int().nullable(),
});
export type GameweekInfo = z.infer<typeof GameweekInfoSchema>;

export const PlTeamSchema = z.object({
  id: FplTeamIdSchema,
  name: z.string(),
  shortName: z.string(),
  /** FPL team `code`, used for badge/shirt image URLs. */
  code: z.number().int(),
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
  nowCost: z.number().int(),
  /** FPL photo code, e.g. "223094" — image at resources.premierleague.com/premierleague/photos/players/110x140/p{code}.png */
  photoCode: z.string(),
  status: PlayerStatusSchema,
  news: z.string(),
  chanceOfPlayingNextRound: z.number().int().nullable(),
  selectedByPercent: z.number(),
  totalPoints: z.number().int(),
  eventPoints: z.number().int(),
  form: z.number(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const BootstrapSchema = z.object({
  currentEvent: GameweekSchema.nullable(),
  nextEvent: GameweekSchema.nullable(),
  events: z.array(GameweekInfoSchema),
  teams: z.array(PlTeamSchema),
  players: z.array(PlayerSchema),
  fetchedAt: z.string().datetime({ offset: true }),
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

export const FixtureStatusSchema = z.enum(['not_started', 'live', 'finished_provisional', 'finished']);
export type FixtureStatus = z.infer<typeof FixtureStatusSchema>;

export const FixtureSchema = z.object({
  id: FplFixtureIdSchema,
  event: GameweekSchema.nullable(),
  kickoffTime: z.string().datetime({ offset: true }).nullable(),
  teamH: FplTeamIdSchema,
  teamA: FplTeamIdSchema,
  teamHScore: z.number().int().nullable(),
  teamAScore: z.number().int().nullable(),
  minutes: z.number().int(),
  status: FixtureStatusSchema,
});
export type Fixture = z.infer<typeof FixtureSchema>;
export const FixtureListSchema = z.array(FixtureSchema);

export const EntrySummarySchema = z.object({
  entryId: FplEntryIdSchema,
  teamName: z.string(),
  managerName: z.string(),
  overallPoints: z.number().int(),
  overallRank: z.number().int().nullable(),
  eventPoints: z.number().int(),
  currentEvent: GameweekSchema.nullable(),
  /** Tenths of a million. */
  bank: z.number().int().nullable(),
  value: z.number().int().nullable(),
  regionName: z.string().nullable(),
});
export type EntrySummary = z.infer<typeof EntrySummarySchema>;

export const ChipUsageSchema = z.object({ chip: ChipSchema, event: GameweekSchema });

export const PickSchema = z.object({
  playerId: FplPlayerIdSchema,
  /** 1..11 starting XI (in formation order), 12..15 bench (12 = bench GK). */
  slot: z.number().int().min(1).max(15),
  /** 0 bench, 1 normal, 2 captain, 3 triple captain. */
  multiplier: z.number().int().min(0).max(3),
  isCaptain: z.boolean(),
  isViceCaptain: z.boolean(),
});
export type Pick = z.infer<typeof PickSchema>;

export const EntryPicksSchema = z.object({
  entryId: FplEntryIdSchema,
  event: GameweekSchema,
  activeChip: ChipSchema.nullable(),
  chipsUsed: z.array(ChipUsageSchema),
  picks: z.array(PickSchema),
  /** Official points for the GW as reported by FPL (includes transfer cost deduction). */
  points: z.number().int(),
  pointsOnBench: z.number().int(),
  transfersMade: z.number().int(),
  transfersCost: z.number().int(),
  bank: z.number().int(),
  value: z.number().int(),
  overallRank: z.number().int().nullable(),
  rankInGameweek: z.number().int().nullable(),
});
export type EntryPicks = z.infer<typeof EntryPicksSchema>;

export const LivePickSchema = PickSchema.extend({
  /** Points this player earned this GW, before multiplier, including provisional bonus. */
  basePoints: z.number().int(),
  /** basePoints × effective multiplier (after auto-subs / vice-captain promotion). */
  points: z.number().int(),
  effectiveMultiplier: z.number().int().min(0).max(3),
  minutes: z.number().int(),
  provisionalBonus: z.number().int(),
  /** All bonus points this GW, final or not (provisional + confirmed). Show this in the bonus badge. */
  bonus: z.number().int(),
  bonusConfirmed: z.boolean(),
  /** Aggregate status of this player's fixture(s) this GW. 'no_fixture' = blank GW. */
  fixtureStatus: z.enum(['no_fixture', 'not_started', 'live', 'finished']),
  autoSubIn: z.boolean(),
  autoSubOut: z.boolean(),
  goals: z.number().int(),
  assists: z.number().int(),
  cleanSheet: z.boolean(),
  yellowCards: z.number().int(),
  redCards: z.number().int(),
  saves: z.number().int(),
  bps: z.number().int(),
});
export type LivePick = z.infer<typeof LivePickSchema>;

export const EntryLiveSchema = z.object({
  entryId: FplEntryIdSchema,
  event: GameweekSchema,
  activeChip: ChipSchema.nullable(),
  /** Live GW points for the XI (bench counted only on Bench Boost), minus transfer cost. */
  livePoints: z.number().int(),
  benchPoints: z.number().int(),
  transfersCost: z.number().int(),
  /** Season total before this GW + livePoints. */
  liveTotal: z.number().int().nullable(),
  picks: z.array(LivePickSchema),
  playersPlayed: z.number().int(),
  playersYetToPlay: z.number().int(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type EntryLive = z.infer<typeof EntryLiveSchema>;

export const LeagueStandingRowSchema = z.object({
  rank: z.number().int(),
  lastRank: z.number().int(),
  entryId: FplEntryIdSchema,
  entryName: z.string(),
  managerName: z.string(),
  total: z.number().int(),
  eventTotal: z.number().int(),
  /** Chip played in the current/last started GW (shown as an icon in the Table). null = none or unknown. */
  activeChip: ChipSchema.nullable().default(null),
});
export type LeagueStandingRow = z.infer<typeof LeagueStandingRowSchema>;

export const LeagueStandingsSchema = z.object({
  league: z.object({ id: FplLeagueIdSchema, name: z.string() }),
  page: z.number().int().min(1),
  hasNext: z.boolean(),
  rows: z.array(LeagueStandingRowSchema),
  updatedAt: z.string().datetime({ offset: true }),
});
export type LeagueStandings = z.infer<typeof LeagueStandingsSchema>;

export const LiveLeagueRowSchema = z.object({
  liveRank: z.number().int(),
  officialRank: z.number().int(),
  entryId: FplEntryIdSchema,
  entryName: z.string(),
  managerName: z.string(),
  livePoints: z.number().int(),
  liveTotal: z.number().int(),
  /** The captain the manager picked. */
  captainPlayerId: FplPlayerIdSchema.nullable(),
  /** Who actually gets the armband points: the vice when the captain didn't play, else the captain. */
  effectiveCaptainPlayerId: FplPlayerIdSchema.nullable(),
  activeChip: ChipSchema.nullable(),
  playersYetToPlay: z.number().int(),
});
export type LiveLeagueRow = z.infer<typeof LiveLeagueRowSchema>;

export const LiveLeagueSchema = z.object({
  league: z.object({ id: FplLeagueIdSchema, name: z.string() }),
  event: GameweekSchema,
  page: z.number().int().min(1),
  hasNext: z.boolean(),
  rows: z.array(LiveLeagueRowSchema),
  updatedAt: z.string().datetime({ offset: true }),
});
export type LiveLeague = z.infer<typeof LiveLeagueSchema>;

/** Live points of a single player in a GW (used by Captain Battle). */
export const PlayerLiveSchema = z.object({
  playerId: FplPlayerIdSchema,
  basePoints: z.number().int(),
  minutes: z.number().int(),
  provisionalBonus: z.number().int(),
  /** All bonus points this GW, final or not. */
  bonus: z.number().int(),
  /** True only when every fixture of the player this GW is `finished` (FPL's final state). */
  bonusConfirmed: z.boolean(),
  fixtureStatus: z.enum(['no_fixture', 'not_started', 'live', 'finished']),
});
export type PlayerLive = z.infer<typeof PlayerLiveSchema>;
