import * as z from 'zod/mini';
import { FplPlayerIdSchema, GameweekSchema } from './ids.js';

/**
 * "My Community Captain" — fans vote for the community captain of the NEXT gameweek.
 *
 * Window for GW N: opens when GW N-1 is finished (FPL's `finished`; always open for GW 1) and closes at GW N's
 * deadline. Until then a fan can change the pick freely (one vote per fan per GW); at the deadline the vote locks,
 * the most-voted player becomes the community captain of the captain battle for GW N, a tie goes to the admins to
 * break, and an admin can always pick by hand. The tally stays hidden from fans until the vote is locked.
 */

const int = () => z.number().check(z.int());

export const CommunityCaptainStatusSchema = z.enum([
  /** GW N-1 isn't finished yet: voting opens when it ends. */
  'not_open',
  'open',
  /** Past the GW N deadline: no more changes. */
  'locked',
]);
export type CommunityCaptainStatus = z.infer<typeof CommunityCaptainStatusSchema>;

export const CommunityCaptainResultStatusSchema = z.enum([
  /** Locked, but the server hasn't tallied yet (the job runs every couple of minutes). */
  'pending',
  /** A player was assigned as the community captain (by the vote, or by an admin). */
  'decided',
  /** Two or more players share the top count: the admins were notified to break the tie. */
  'tied',
  /** Nobody voted: an admin picks by hand. */
  'no_votes',
]);
export type CommunityCaptainResultStatus = z.infer<typeof CommunityCaptainResultStatusSchema>;

export const CommunityCaptainTallyRowSchema = z.object({
  playerId: FplPlayerIdSchema,
  votes: int(),
});
export type CommunityCaptainTallyRow = z.infer<typeof CommunityCaptainTallyRowSchema>;

export const CommunityCaptainResultSchema = z.object({
  status: CommunityCaptainResultStatusSchema,
  /** How the winner was chosen: the fans' votes (also after an admin broke a tie among the top) or an admin's own pick. */
  source: z.nullable(z.enum(['votes', 'admin'])),
  winnerPlayerId: z.nullable(FplPlayerIdSchema),
  /** The players sharing the top count while the status is `tied` (empty otherwise). */
  tiedPlayerIds: z.array(FplPlayerIdSchema),
  totalVotes: int(),
  /** The most-voted players (up to 5), highest first. */
  top: z.array(CommunityCaptainTallyRowSchema),
});
export type CommunityCaptainResult = z.infer<typeof CommunityCaptainResultSchema>;

/** GET /v1/community-captain — the vote for the next GW. `myPick` needs a bearer token; `result` only once locked. */
export const CommunityCaptainStateSchema = z.object({
  /** The GW being voted for (the next GW whose deadline is still ahead); null when there is none (season over). */
  event: z.nullable(GameweekSchema),
  status: CommunityCaptainStatusSchema,
  /** The GW whose end opens voting (event − 1); null for GW 1. */
  opensAfterEvent: z.nullable(GameweekSchema),
  deadline: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  /** How many fans have voted so far (the tally itself stays hidden until the vote locks). */
  voters: int(),
  /** The signed-in viewer's current pick; null = none yet or signed out. */
  myPick: z.nullable(FplPlayerIdSchema),
  /** Only when `status` is `locked`. */
  result: z.nullable(CommunityCaptainResultSchema),
  updatedAt: z.string().check(z.iso.datetime({ offset: true })),
});
export type CommunityCaptainState = z.infer<typeof CommunityCaptainStateSchema>;

/** PUT /v1/community-captain — set or change the viewer's pick (until the deadline). Returns the new state. */
export const CommunityCaptainVoteBodySchema = z.object({
  event: GameweekSchema,
  playerId: FplPlayerIdSchema,
});
export type CommunityCaptainVoteBody = z.infer<typeof CommunityCaptainVoteBodySchema>;

/** GET /v1/admin/community-captain?event= — the full picture for the admin card (tally is visible to admins). */
export const AdminCommunityCaptainSchema = z.object({
  event: z.nullable(GameweekSchema),
  status: CommunityCaptainStatusSchema,
  deadline: z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
  totalVotes: int(),
  /** The most-voted players (up to 20), highest first, live while the vote is open. */
  tally: z.array(CommunityCaptainTallyRowSchema),
  result: z.nullable(CommunityCaptainResultSchema),
  /** The community player currently set in the captain battle for this GW (null = none picked yet). */
  battlePlayerId: z.nullable(FplPlayerIdSchema),
});
export type AdminCommunityCaptain = z.infer<typeof AdminCommunityCaptainSchema>;

/** POST /v1/admin/community-captain/resolve — break a tie, or pick by hand: sets the battle's community captain for the GW. */
export const AdminCommunityCaptainResolveBodySchema = z.object({
  event: GameweekSchema,
  playerId: FplPlayerIdSchema,
});
export type AdminCommunityCaptainResolveBody = z.infer<typeof AdminCommunityCaptainResolveBodySchema>;
