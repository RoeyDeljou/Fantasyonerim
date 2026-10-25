import { z } from 'zod';

/**
 * Branded domain ids. Never pass a bare string/number across a package or network boundary —
 * parse it with the matching schema first.
 */
export const UserIdSchema = z.string().min(1).brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

/** An FPL "entry" = one manager's team. Shown to users as "Team ID". */
export const FplEntryIdSchema = z.coerce.number().int().positive().max(99_999_999).brand<'FplEntryId'>();
export type FplEntryId = z.infer<typeof FplEntryIdSchema>;

export const FplLeagueIdSchema = z.coerce.number().int().positive().brand<'FplLeagueId'>();
export type FplLeagueId = z.infer<typeof FplLeagueIdSchema>;

/** An FPL "element" = one real-world player. */
export const FplPlayerIdSchema = z.coerce.number().int().positive().brand<'FplPlayerId'>();
export type FplPlayerId = z.infer<typeof FplPlayerIdSchema>;

/** An FPL "event" = one gameweek (1..38). */
export const GameweekSchema = z.coerce.number().int().min(1).max(38).brand<'Gameweek'>();
export type Gameweek = z.infer<typeof GameweekSchema>;

export const FplTeamIdSchema = z.coerce.number().int().positive().brand<'FplTeamId'>();
export type FplTeamId = z.infer<typeof FplTeamIdSchema>;

export const FplFixtureIdSchema = z.coerce.number().int().positive().brand<'FplFixtureId'>();
export type FplFixtureId = z.infer<typeof FplFixtureIdSchema>;

export const NewsItemIdSchema = z.string().min(1).brand<'NewsItemId'>();
export type NewsItemId = z.infer<typeof NewsItemIdSchema>;

export const PostIdSchema = z.string().min(1).brand<'PostId'>();
export type PostId = z.infer<typeof PostIdSchema>;

export const CommentIdSchema = z.string().min(1).brand<'CommentId'>();
export type CommentId = z.infer<typeof CommentIdSchema>;
