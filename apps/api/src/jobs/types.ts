import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';

export type JobName =
  | 'podcast'
  | 'instagram_posts'
  | 'instagram_stories'
  | 'x'
  | 'youtube'
  | 'deadline_reminders'
  | 'gameweek_summary'
  | 'cleanup';

export interface JobRunContext {
  app: AppContext;
  now: Date;
  /** Run requested explicitly (admin "sync now"): skip internal throttles. */
  force: boolean;
  /** Job-private JSON state persisted on the lease row (null on the first run). */
  state: Record<string, unknown>;
  log: FastifyBaseLogger;
}

export interface JobOutcome {
  /** Short human summary for logs, e.g. "3 new, 1 updated". */
  summary?: string;
  /** Replaces the persisted state when given. */
  state?: Record<string, unknown>;
}

export interface Job {
  name: JobName;
  everyMs: number;
  /** How long the lease is held at most (a crashed run frees it after this). Default 10 min. */
  leaseMs?: number;
  run(ctx: JobRunContext): Promise<JobOutcome | void>;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
