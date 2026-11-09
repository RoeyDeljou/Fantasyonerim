import * as z from 'zod/mini';
import { ChipSchema } from './fpl.js';
import { FplEntryIdSchema, FplLeagueIdSchema, FplPlayerIdSchema, GameweekSchema } from './ids.js';

/**
 * Gameweek Roundup ("סיכום מחזור") — the podcast league's official results for one finished GW.
 *
 * Built once by the API when FPL marks the GW official (`dataChecked`), stored, and served to everyone; past GWs
 * are back-filled the same way. Every section is nullable: a GW without that data (e.g. no transfers made, no
 * captain battle configured) shows that section empty. Player names/photos come from the client's bootstrap by id.
 */

const int = () => z.number().check(z.int());

/** A league team, as shown across the roundup. */
export const RoundupTeamSchema = z.object({
  entryId: FplEntryIdSchema,
  entryName: z.string(),
  managerName: z.string(),
});
export type RoundupTeam = z.infer<typeof RoundupTeamSchema>;

/** A player and the points he scored for that team this GW (multiplier applied where it says so). */
export const RoundupPlayerPointsSchema = z.object({
  playerId: FplPlayerIdSchema,
  points: int(),
});
export type RoundupPlayerPoints = z.infer<typeof RoundupPlayerPointsSchema>;

export const RoundupTransferSchema = z.object({
  playerOut: FplPlayerIdSchema,
  playerIn: FplPlayerIdSchema,
});
export type RoundupTransfer = z.infer<typeof RoundupTransferSchema>;

/** One row of the league table after the GW. */
export const RoundupRowSchema = z.extend(RoundupTeamSchema, {
  rank: int(),
  /** Rank before this GW (null for a team with no previous GW in the league). */
  lastRank: z.nullable(int()),
  /** GW points after transfer hits (FPL's official GW score). */
  eventPoints: int(),
  total: int(),
  captainPlayerId: z.nullable(FplPlayerIdSchema),
  chip: z.nullable(ChipSchema),
  /** This GW's transfers (empty on Wildcard/Free Hit is still the real list). */
  transfers: z.array(RoundupTransferSchema),
  /** Points deducted for extra transfers this GW (0, 4, 8, …). */
  transferCost: int(),
});
export type RoundupRow = z.infer<typeof RoundupRowSchema>;

export const RoundupKingSchema = z.extend(RoundupTeamSchema, {
  points: int(),
  captainPlayerId: z.nullable(FplPlayerIdSchema),
  chip: z.nullable(ChipSchema),
  /** The team's best scorers this GW (up to 4, captain multiplier applied), highest first. */
  topPlayers: z.array(RoundupPlayerPointsSchema),
  /** Bench Boost: what the bench added. Null when no Bench Boost. */
  benchBoostPoints: z.nullable(int()),
});
export type RoundupKing = z.infer<typeof RoundupKingSchema>;

/** Biggest climb / drop in the league table this GW. */
export const RoundupMoverSchema = z.extend(RoundupTeamSchema, {
  /** Places moved (always positive; the section says up or down). */
  places: int(),
  eventPoints: int(),
});
export type RoundupMover = z.infer<typeof RoundupMoverSchema>;

/** Most points left on the bench (no Bench Boost). */
export const RoundupBenchSchema = z.extend(RoundupTeamSchema, {
  points: int(),
  players: z.array(RoundupPlayerPointsSchema),
});
export type RoundupBench = z.infer<typeof RoundupBenchSchema>;

/** Best / worst single transfer of the GW: points of the player in minus the player out (hits not counted). */
export const RoundupTransferPickSchema = z.extend(RoundupTeamSchema, {
  playerOut: RoundupPlayerPointsSchema,
  playerIn: RoundupPlayerPointsSchema,
  /** playerIn.points − playerOut.points */
  gain: int(),
  /** The team's transfer hit this GW (shown as "minus 4"). */
  transferCost: int(),
});
export type RoundupTransferPick = z.infer<typeof RoundupTransferPickSchema>;

/** Captain battle for that GW, final points. Same row kinds as the live Captain Battle. */
export const RoundupCaptainSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['community', 'fpl_lad', 'custom', 'mine']),
  /** Admin-chosen badge text; null = the client's default for the kind. Rows stored before tags existed read as null. */
  tag: z._default(z.nullable(z.string()), null),
  playerId: z.nullable(FplPlayerIdSchema),
  multiplier: z.number().check(z.int(), z.gte(1), z.lte(3)),
  /** Base points × multiplier (0 when playerId is null). */
  captainPoints: int(),
});
export type RoundupCaptain = z.infer<typeof RoundupCaptainSchema>;

export const RoundupStatusSchema = z.enum([
  /** The GW is official and its roundup is ready. */
  'ready',
  /** The GW hasn't started or isn't official yet: "Come back at the end of the game week!" */
  'pending',
  /** The GW is official but the roundup is still being built (first minutes after FPL confirms it). */
  'building',
  /** No league is configured, or this GW's data couldn't be built. */
  'unavailable',
]);
export type RoundupStatus = z.infer<typeof RoundupStatusSchema>;

/**
 * GET /v1/league/roundup?event=<gw> (public; the `mine` captain row is added for a signed-in fan).
 * Without `event` → the latest official GW. Cacheable for everyone except the `captains[kind=mine]` row.
 */
export const GameweekRoundupSchema = z.object({
  event: GameweekSchema,
  status: RoundupStatusSchema,
  /** GWs the picker can open: 1 … the current GW (the unfinished ones show "pending"). */
  events: z.array(GameweekSchema),
  league: z.nullable(z.object({ id: FplLeagueIdSchema, name: z.string() })),
  /** Teams in the league table for this GW. */
  participants: z.nullable(int()),
  /** League average GW points (one decimal) and FPL's world average. */
  averages: z.nullable(z.object({ league: z.nullable(z.number()), world: z.nullable(int()) })),
  king: z.nullable(RoundupKingSchema),
  table: z.array(RoundupRowSchema),
  biggestClimb: z.nullable(RoundupMoverSchema),
  biggestDrop: z.nullable(RoundupMoverSchema),
  benchPoints: z.nullable(RoundupBenchSchema),
  bestTransfer: z.nullable(RoundupTransferPickSchema),
  worstTransfer: z.nullable(RoundupTransferPickSchema),
  /** Sorted by captainPoints desc. Empty when no captain battle was configured for the GW and no `mine` row. */
  captains: z.array(RoundupCaptainSchema),
  /** When the roundup was built (null unless ready). */
  builtAt: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
});
export type GameweekRoundup = z.infer<typeof GameweekRoundupSchema>;

// ---------- season captain battle ----------

/** The podcast hosts: their own teams are highlighted on the season leaderboard. */
export const SeasonHostSchema = z.enum(['dor', 'itay']);
export type SeasonHost = z.infer<typeof SeasonHostSchema>;

/**
 * One row of the season Captain Battle leaderboard ("קרב קפטנים עונתי"): total captain points over every official GW
 * so far (captain base points × the armband multiplier), NOT the number of GW wins. League members rank next to the
 * two permanent special captains (the community's and FPL Lad's).
 */
export const SeasonCaptainRowSchema = z.object({
  /** 'manager' = a league team's own captain picks; the others are the permanent special captains. */
  kind: z.enum(['manager', 'community', 'fpl_lad']),
  /** entryId (as text) for managers; 'community' / 'fpl_lad' for the special captains. */
  key: z.string(),
  entryId: z.nullable(FplEntryIdSchema),
  /** Team name for managers; the configured label for special captains. */
  name: z.string(),
  /** Manager name for managers; null for special captains. */
  subtitle: z.nullable(z.string()),
  /** Admin-chosen badge text of a special captain; null otherwise (the client uses its default). */
  tag: z.nullable(z.string()),
  /** Dor's / Itay's own team (a 'manager' row) — highlighted by the client; null for everyone else. */
  host: z._default(z.nullable(SeasonHostSchema), null),
  /** Competition ranking: equal points share a rank (1, 2, 2, 4). */
  rank: int(),
  points: int(),
  /** GWs that count towards the total (the GWs the captain / the team's captain is known for). */
  gameweeks: int(),
});
export type SeasonCaptainRow = z.infer<typeof SeasonCaptainRowSchema>;

export const SeasonCaptainsStatusSchema = z.enum([
  'ready',
  /** No official GW roundup is stored yet (season start, or the back-fill is still running). */
  'building',
  /** No league is configured. */
  'unavailable',
]);

/** GET /v1/league/season-captains — public; the viewer's own row is found by `entryId` on the client. */
export const SeasonCaptainsSchema = z.object({
  status: SeasonCaptainsStatusSchema,
  league: z.nullable(z.object({ id: FplLeagueIdSchema, name: z.string() })),
  /** The last official GW included in the totals. */
  throughEvent: z.nullable(GameweekSchema),
  rows: z.array(SeasonCaptainRowSchema),
  updatedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type SeasonCaptains = z.infer<typeof SeasonCaptainsSchema>;
