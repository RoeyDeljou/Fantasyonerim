import { z } from 'zod';

/**
 * Zod schemas for the raw fantasy.premierleague.com responses.
 *
 * Lenient on extra fields (z.object strips unknown keys — FPL adds fields every season) and strict on
 * the fields we actually read. These shapes never leave packages/fpl: `normalize.ts` maps them to the
 * `@fant/shared` DTOs.
 */

const int = z.number().int();
const isoDate = z.string().min(1);

// ---------- bootstrap-static/ ----------
export const RawEventSchema = z.object({
  id: int,
  name: z.string(),
  deadline_time: isoDate,
  finished: z.boolean(),
  data_checked: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  is_previous: z.boolean().optional(),
  average_entry_score: int.nullable().optional(),
  highest_score: int.nullable().optional(),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

export const RawTeamSchema = z.object({
  id: int,
  code: int,
  name: z.string(),
  short_name: z.string(),
});
export type RawTeam = z.infer<typeof RawTeamSchema>;

export const RawElementSchema = z.object({
  id: int,
  code: int.optional(),
  web_name: z.string(),
  first_name: z.string(),
  second_name: z.string(),
  team: int,
  /** 1 GKP, 2 DEF, 3 MID, 4 FWD (5 = assistant manager in 2024/25; filtered out). */
  element_type: int,
  now_cost: int,
  /** e.g. "223094.jpg" */
  photo: z.string(),
  status: z.string(),
  news: z.string().nullable().optional(),
  chance_of_playing_next_round: int.nullable().optional(),
  /** Decimal strings, e.g. "45.3" */
  selected_by_percent: z.string(),
  form: z.string(),
  total_points: int,
  event_points: int,
});
export type RawElement = z.infer<typeof RawElementSchema>;

export const RawBootstrapSchema = z.object({
  events: z.array(RawEventSchema),
  teams: z.array(RawTeamSchema),
  elements: z.array(RawElementSchema),
});
export type RawBootstrap = z.infer<typeof RawBootstrapSchema>;

// ---------- fixtures/ ----------
export const RawFixtureStatValueSchema = z.object({ value: int, element: int });
export const RawFixtureStatSchema = z.object({
  identifier: z.string(),
  a: z.array(RawFixtureStatValueSchema),
  h: z.array(RawFixtureStatValueSchema),
});

export const RawFixtureSchema = z.object({
  id: int,
  event: int.nullable(),
  kickoff_time: isoDate.nullable(),
  /** FPL sends `false` before kickoff and occasionally `null` for unscheduled fixtures. */
  started: z.boolean().nullable().optional(),
  finished: z.boolean(),
  finished_provisional: z.boolean(),
  minutes: int,
  team_h: int,
  team_a: int,
  team_h_score: int.nullable(),
  team_a_score: int.nullable(),
  stats: z.array(RawFixtureStatSchema).default([]),
});
export type RawFixture = z.infer<typeof RawFixtureSchema>;
export const RawFixturesSchema = z.array(RawFixtureSchema);

// ---------- entry/{id}/ ----------
export const RawEntrySchema = z.object({
  id: int,
  name: z.string(),
  player_first_name: z.string(),
  player_last_name: z.string(),
  player_region_name: z.string().nullable().optional(),
  summary_overall_points: int.nullable(),
  summary_overall_rank: int.nullable(),
  summary_event_points: int.nullable(),
  current_event: int.nullable(),
  last_deadline_bank: int.nullable().optional(),
  last_deadline_value: int.nullable().optional(),
});
export type RawEntry = z.infer<typeof RawEntrySchema>;

// ---------- entry/{id}/history/ ----------
export const RawEntryEventHistorySchema = z.object({
  event: int,
  /** GW points BEFORE the transfer-cost deduction. */
  points: int,
  /** Season total AFTER this GW, i.e. previous total + points − event_transfers_cost. */
  total_points: int,
  rank: int.nullable(),
  overall_rank: int.nullable(),
  bank: int,
  value: int,
  event_transfers: int,
  event_transfers_cost: int,
  points_on_bench: int,
});
export type RawEntryEventHistory = z.infer<typeof RawEntryEventHistorySchema>;

export const RawChipPlaySchema = z.object({ name: z.string(), event: int, time: z.string().optional() });

export const RawEntryHistorySchema = z.object({
  current: z.array(RawEntryEventHistorySchema),
  chips: z.array(RawChipPlaySchema).default([]),
});
export type RawEntryHistory = z.infer<typeof RawEntryHistorySchema>;

// ---------- entry/{id}/event/{gw}/picks/ ----------
export const RawPickSchema = z.object({
  element: int,
  /** 1..15 */
  position: int,
  multiplier: int,
  is_captain: z.boolean(),
  is_vice_captain: z.boolean(),
});
export type RawPick = z.infer<typeof RawPickSchema>;

export const RawPicksSchema = z.object({
  active_chip: z.string().nullable(),
  automatic_subs: z.array(z.object({ element_in: int, element_out: int, event: int })).default([]),
  entry_history: RawEntryEventHistorySchema,
  picks: z.array(RawPickSchema),
});
export type RawPicks = z.infer<typeof RawPicksSchema>;

// ---------- event/{gw}/live/ ----------
export const RawLiveStatsSchema = z.object({
  minutes: int,
  goals_scored: int,
  assists: int,
  clean_sheets: int,
  yellow_cards: int,
  red_cards: int,
  saves: int,
  bonus: int,
  bps: int,
  total_points: int,
});
export type RawLiveStats = z.infer<typeof RawLiveStatsSchema>;

export const RawLiveExplainSchema = z.object({
  fixture: int,
  stats: z.array(
    z.object({ identifier: z.string(), points: int, value: z.number(), points_modification: int.optional() }),
  ),
});

export const RawLiveElementSchema = z.object({
  id: int,
  stats: RawLiveStatsSchema,
  explain: z.array(RawLiveExplainSchema).default([]),
});
export type RawLiveElement = z.infer<typeof RawLiveElementSchema>;

export const RawLiveSchema = z.object({ elements: z.array(RawLiveElementSchema) });
export type RawLive = z.infer<typeof RawLiveSchema>;

// ---------- leagues-classic/{id}/standings/ ----------
export const RawStandingRowSchema = z.object({
  id: int.optional(),
  entry: int,
  entry_name: z.string(),
  player_name: z.string(),
  rank: int,
  last_rank: int,
  rank_sort: int.optional(),
  total: int,
  event_total: int,
});
export type RawStandingRow = z.infer<typeof RawStandingRowSchema>;

export const RawStandingsSchema = z.object({
  league: z.object({ id: int, name: z.string() }),
  standings: z.object({
    has_next: z.boolean(),
    page: int,
    results: z.array(RawStandingRowSchema),
  }),
});
export type RawStandings = z.infer<typeof RawStandingsSchema>;
