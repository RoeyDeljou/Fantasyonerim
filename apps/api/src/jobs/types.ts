import type { IntegrationId } from '@fant/shared';
import type { AppSettings } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context.js';
import type { LoadedIntegration } from '../integrations/store.js';

export type JobName =
  | 'podcast'
  | 'instagram_posts'
  | 'instagram_stories'
  | 'x'
  | 'youtube'
  | 'deadline_reminders'
  | 'gameweek_summary'
  | 'gameweek_roundup'
  | 'community_captain'
  | 'live_alerts'
  | 'cleanup'
  | 'image_variants';

export interface JobRunContext {
  app: AppContext;
  now: Date;
  /** Run requested explicitly (admin "sync now"): skip internal throttles. */
  force: boolean;
  /** Job-private JSON state persisted on the lease row (null on the first run). */
  state: Record<string, unknown>;
  log: FastifyBaseLogger;
  /** Job-private memory that survives between runs of this process (never persisted; empty after a restart). */
  memo: Record<string, unknown>;
  /** What the job's `plan` handed over (e.g. the upstream result it already fetched); undefined when forced. */
  carry?: unknown;
}

/** An integration check the runner remembers in memory (admin status shows it; persisted opportunistically). */
export interface IntegrationCheck {
  ok: boolean;
  error: string | null;
}

/**
 * Context of a job's `plan`: everything comes from memory (job state, memo, cached settings/integrations, FPL's
 * own caches) so a plan that finds nothing to do never queries the database.
 */
export interface JobPlanContext {
  app: AppContext;
  now: Date;
  /** The job's persisted state as of its last run (in memory). Read-only: plans keep scratch data in `memo`. */
  state: Readonly<Record<string, unknown>>;
  memo: Record<string, unknown>;
  log: FastifyBaseLogger;
  /** The database ran a query in the last few minutes: optional DB work now costs (almost) nothing extra. */
  dbAwake: boolean;
  /** Cached integration row (loaded from the DB only when not cached yet). */
  integration(id: IntegrationId): Promise<LoadedIntegration>;
  /** Cached AppSettings (loaded from the DB only when not cached yet). */
  settings(): Promise<AppSettings>;
  /** Records a DB-free integration check (shown as the integration's last run in the admin console). */
  checked(id: IntegrationId, outcome: IntegrationCheck): void;
}

/** `run: false` = nothing to do: the runner touches no database. `run: true` = take the lease and run. */
export type JobPlan = { run: false; summary: string } | { run: true; reason: string; carry?: unknown };

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
  /**
   * Optional DB-free pre-check run when the job is due (never when forced): decides from memory and upstream
   * sources whether there is database work. Without it every due run takes the lease.
   */
  plan?(ctx: JobPlanContext): Promise<JobPlan>;
  /**
   * DB-bound housekeeping: while the database is asleep the job waits this long between runs (instead of
   * `everyMs`), so it rides along with bursts of other database activity.
   */
  idleEveryMs?: number;
  run(ctx: JobRunContext): Promise<JobOutcome | void>;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
