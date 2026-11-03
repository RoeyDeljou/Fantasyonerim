import * as z from 'zod/mini';

/**
 * Branded domain ids. Never pass a bare string/number across a package or network boundary —
 * parse it with the matching schema first.
 */
export const UserIdSchema = z.string().check(z.minLength(1)).brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

/** An FPL "entry" = one manager's team. Shown to users as "Team ID". */
export const FplEntryIdSchema = z.coerce
  .number()
  .check(z.int(), z.positive(), z.lte(99_999_999))
  .brand<'FplEntryId'>();
export type FplEntryId = z.infer<typeof FplEntryIdSchema>;

export const FplLeagueIdSchema = z.coerce.number().check(z.int(), z.positive()).brand<'FplLeagueId'>();
export type FplLeagueId = z.infer<typeof FplLeagueIdSchema>;

/** An FPL "element" = one real-world player. */
export const FplPlayerIdSchema = z.coerce.number().check(z.int(), z.positive()).brand<'FplPlayerId'>();
export type FplPlayerId = z.infer<typeof FplPlayerIdSchema>;

/** An FPL "event" = one gameweek (1..38). */
export const GameweekSchema = z.coerce.number().check(z.int(), z.gte(1), z.lte(38)).brand<'Gameweek'>();
export type Gameweek = z.infer<typeof GameweekSchema>;

export const FplTeamIdSchema = z.coerce.number().check(z.int(), z.positive()).brand<'FplTeamId'>();
export type FplTeamId = z.infer<typeof FplTeamIdSchema>;

export const FplFixtureIdSchema = z.coerce.number().check(z.int(), z.positive()).brand<'FplFixtureId'>();
export type FplFixtureId = z.infer<typeof FplFixtureIdSchema>;

export const NewsItemIdSchema = z.string().check(z.minLength(1)).brand<'NewsItemId'>();
export type NewsItemId = z.infer<typeof NewsItemIdSchema>;

export const PostIdSchema = z.string().check(z.minLength(1)).brand<'PostId'>();
export type PostId = z.infer<typeof PostIdSchema>;

export const CommentIdSchema = z.string().check(z.minLength(1)).brand<'CommentId'>();
export type CommentId = z.infer<typeof CommentIdSchema>;
