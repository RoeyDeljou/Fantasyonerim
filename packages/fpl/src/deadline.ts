import type { Bootstrap, GameweekInfo, Gameweek } from '@fant/shared';

export interface NextDeadline {
  event: Gameweek;
  deadlineTime: string;
  /** Milliseconds from `nowMs` until the deadline (> 0). */
  msUntil: number;
}

/** The first GW whose deadline is strictly after `nowMs`, or null when the season's deadlines are over. */
export function nextDeadline(events: readonly GameweekInfo[], nowMs: number): NextDeadline | null {
  let best: NextDeadline | null = null;
  for (const e of events) {
    const ms = Date.parse(e.deadlineTime);
    if (Number.isNaN(ms) || ms <= nowMs) continue;
    if (!best || ms - nowMs < best.msUntil)
      best = { event: e.id, deadlineTime: e.deadlineTime, msUntil: ms - nowMs };
  }
  return best;
}

/** The GW in progress (FPL `is_current`), else the next one (pre-season), else the last GW. */
export function currentOrNextEvent(
  bootstrap: Pick<Bootstrap, 'currentEvent' | 'nextEvent' | 'events'>,
): Gameweek | null {
  if (bootstrap.currentEvent !== null) return bootstrap.currentEvent;
  if (bootstrap.nextEvent !== null) return bootstrap.nextEvent;
  const last = bootstrap.events.at(-1);
  return last ? last.id : null;
}

/** The latest GW whose deadline has passed at `nowMs` (picks are immutable from then on), or null. */
export function lastStartedEvent(events: readonly GameweekInfo[], nowMs: number): Gameweek | null {
  let best: GameweekInfo | null = null;
  for (const e of events) {
    const ms = Date.parse(e.deadlineTime);
    if (!Number.isNaN(ms) && ms <= nowMs && (!best || ms > Date.parse(best.deadlineTime))) best = e;
  }
  return best ? best.id : null;
}
