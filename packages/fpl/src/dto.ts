import {
  ChipSchema,
  FplEntryIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
  type FplPlayerId,
} from '@fant/shared';
import { z } from 'zod';

/**
 * Normalized FPL data that only the server needs (inputs of the Gameweek Roundup builder), so it lives
 * here rather than in the REST contract. camelCase, branded ids, no raw FPL field names. Every value
 * returned by FplService is passed through these schemas.
 */

const int = z.number().int();

/** One GW of a manager's season (`entry/{id}/history/` → `current[]`). Same naming as `EntryPicks`. */
export const EntryHistoryEventSchema = z.object({
  event: GameweekSchema,
  /** The GW's points AFTER the transfer-cost deduction (FPL's raw `points` is before it). */
  points: int,
  /** The GW's points before the transfer-cost deduction (what FPL's standings `event_total` shows). */
  grossPoints: int,
  /** Season total after this GW (FPL's overall total, i.e. counted from GW1 / the entry's first GW). */
  totalPoints: int,
  /** Transfers counted by FPL this GW: Wildcard / Free Hit transfers are NOT counted (always 0 then). */
  transfersMade: int,
  /** Points deducted for extra transfers (0, 4, 8, …). */
  transfersCost: int,
  /** Points of the 4 bench players. 0 on a Bench Boost GW (they counted). */
  pointsOnBench: int,
  overallRank: int.nullable(),
  rankInGameweek: int.nullable(),
  /** Tenths of a million. */
  bank: int,
  value: int,
});
export type EntryHistoryEvent = z.infer<typeof EntryHistoryEventSchema>;

export const EntryHistorySchema = z.object({
  entryId: FplEntryIdSchema,
  /** Sorted by event. Starts at the entry's first GW (a team created in GW8 has no rows for GW1–7). */
  events: z.array(EntryHistoryEventSchema),
  /** Chips played, sorted by event. */
  chips: z.array(z.object({ chip: ChipSchema, event: GameweekSchema })),
});
export type EntryHistory = z.infer<typeof EntryHistorySchema>;

/** One transfer (`entry/{id}/transfers/`), oldest first. Includes Wildcard / Free Hit transfers. */
export const EntryTransferSchema = z.object({
  event: GameweekSchema,
  playerIn: FplPlayerIdSchema,
  playerOut: FplPlayerIdSchema,
  /** Price paid / received, tenths of a million (null if FPL omits it). */
  playerInCost: int.nullable(),
  playerOutCost: int.nullable(),
  /** ISO 8601 (UTC). */
  time: z.string(),
});
export type EntryTransfer = z.infer<typeof EntryTransferSchema>;

/** A classic league's identity and the first GW its totals count from. */
export const LeagueInfoSchema = z.object({
  id: FplLeagueIdSchema,
  name: z.string(),
  /** FPL `start_event`: league total = Σ (GW points − transfer cost) over GWs ≥ startEvent. */
  startEvent: GameweekSchema,
});
export type LeagueInfo = z.infer<typeof LeagueInfoSchema>;

/** A player's FPL points in one GW (all fixtures summed: a DGW counts both). */
export interface PlayerEventPoints {
  /** FPL `total_points` for the GW (confirmed bonus only; final once the GW is data-checked). */
  points: number;
  minutes: number;
}

/** Every player who has a row in `event/{gw}/live/`. Players without a row scored 0. */
export type EventPoints = ReadonlyMap<FplPlayerId, PlayerEventPoints>;
