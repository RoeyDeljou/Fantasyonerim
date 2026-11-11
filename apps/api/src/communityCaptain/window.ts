import type { CommunityCaptainStatus, GameweekInfo } from '@fant/shared';

/** After a GW's deadline, an admin can still resolve (tie-break / pick by hand) for this long. */
export const RESOLVE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
/** The job only tallies GWs whose deadline passed within this long (this feature starts now: no back-fill). */
export const TALLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The job waits this long after the deadline so a vote accepted just before it has surely been committed. */
export const TALLY_GRACE_MS = 10_000;

export interface VoteWindow {
  event: GameweekInfo['id'];
  status: CommunityCaptainStatus;
  /** event - 1, null for GW 1. */
  opensAfterEvent: GameweekInfo['id'] | null;
  deadline: string;
  deadlineMs: number;
}

/**
 * The vote window of one GW: `locked` from its deadline on; else `open` when GW N-1 is finished (always for GW 1),
 * else `not_open`. Null when the GW is not in the bootstrap.
 */
export function windowOf(events: readonly GameweekInfo[], event: number, nowMs: number): VoteWindow | null {
  const gw = events.find((e) => e.id === event);
  if (gw === undefined) return null;
  const deadlineMs = Date.parse(gw.deadlineTime);
  if (Number.isNaN(deadlineMs)) return null;
  const previous = events.find((e) => e.id === event - 1);
  const status: CommunityCaptainStatus =
    deadlineMs <= nowMs ? 'locked' : event === 1 || previous?.finished === true ? 'open' : 'not_open';
  return {
    event: gw.id,
    status,
    opensAfterEvent: previous?.id ?? null,
    deadline: gw.deadlineTime,
    deadlineMs,
  };
}

/** The GW being voted for: the first (lowest) GW whose deadline is still in the future. Null = season over. */
export function targetWindow(events: readonly GameweekInfo[], nowMs: number): VoteWindow | null {
  const next = [...events].sort((a, b) => a.id - b.id).find((e) => Date.parse(e.deadlineTime) > nowMs);
  return next === undefined ? null : windowOf(events, next.id, nowMs);
}

/**
 * The GW the fan screen shows: the GW in progress (deadline passed, not finished yet) as `locked`, so fans see the
 * lock and the result until it ends; otherwise the next GW to vote for (`targetWindow`). Per GW N the sequence is
 * open (N-1 finished … deadline N) → locked (deadline N … N finished) → the view moves on to N+1.
 */
export function displayWindow(events: readonly GameweekInfo[], nowMs: number): VoteWindow | null {
  const inProgress = [...events]
    .sort((a, b) => b.id - a.id)
    .find((e) => Date.parse(e.deadlineTime) <= nowMs && !e.finished);
  return inProgress === undefined ? targetWindow(events, nowMs) : windowOf(events, inProgress.id, nowMs);
}
