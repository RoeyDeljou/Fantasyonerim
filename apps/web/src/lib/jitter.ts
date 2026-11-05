/**
 * Spreading a crowd's requests. Everyone opens the app at kickoff and every client polls on the same clock, so
 * without this the API sees waves: all the 30-s live polls landing in the same second, all the resume refetches
 * firing the instant phones unlock after a goal.
 */

/** ±15 % around `ms`, drawn per poll (so clients drift apart instead of staying in lockstep). */
export const POLL_JITTER = 0.15;
export function jittered(ms: number): number {
  return Math.round(ms * (1 - POLL_JITTER + Math.random() * 2 * POLL_JITTER));
}

/** A resume's refetches start somewhere in 0–3 s instead of all at once (the refresh button stays immediate). */
export const RESUME_SPREAD_MS = 3_000;
export function resumeDelay(): number {
  return Math.round(Math.random() * RESUME_SPREAD_MS);
}
