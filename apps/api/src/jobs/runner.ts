import type { IntegrationId } from '@fant/shared';
import { Prisma, type AppSettings } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  describe,
  ensureIntegrationRows,
  loadIntegration,
  type LoadedIntegration,
} from '../integrations/store.js';
import { isQuietHour, QUIET_JOBS_EVERY_MS } from '../perf/keepAlive.js';
import { getSettings } from '../settings.js';
import {
  HOUR,
  MINUTE,
  type IntegrationCheck,
  type Job,
  type JobName,
  type JobPlan,
  type JobPlanContext,
} from './types.js';

export type JobRunStatus = 'ok' | 'failed' | 'locked' | 'not_due' | 'unknown';

const DEFAULT_LEASE_MS = 10 * MINUTE;
/** Jobs that write News items (ingest, YouTube linking, story expiry). */
const NEWS_JOBS: ReadonlySet<JobName> = new Set<JobName>([
  'podcast',
  'youtube',
  'instagram_posts',
  'instagram_stories',
  'x',
  'cleanup',
  // Adds `variants` to News media.
  'image_variants',
]);
const EPOCH = new Date(0);
const StateSchema = z.record(z.string(), z.unknown());

/** While the database is awake anyway, a job due within this long runs now (its DB work joins the burst). */
export const EARLY_WHILE_AWAKE_MS = MINUTE;
/** In-memory "last checked" times of DB-free runs are written back at most this often, only while the DB is awake. */
export const HEARTBEAT_EVERY_MS = HOUR;
/** Cached integration rows / settings are re-read after this long, but only while the database is awake... */
export const CACHE_REFRESH_AWAKE_MS = 10 * MINUTE;
/** ...or unconditionally after this long (another instance may have changed them). */
export const CACHE_MAX_AGE_MS = 12 * HOUR;
/** A scheduler tick failure (e.g. database unreachable) is logged at most this often per distinct message. */
export const TICK_ERROR_LOG_EVERY_MS = 10 * MINUTE;

interface JobMemory {
  /** Last run or DB-free check (ms). null = never / reset: due now. */
  lastRunAt: number | null;
  /** lastRunAt as stored on the lease row (as far as this process knows). */
  persistedRunAt: number | null;
  /** The persisted job state as of the last run. */
  state: Record<string, unknown>;
  /** The lease row's lastError as of the last run. */
  lastError: string | null;
  memo: Record<string, unknown>;
}

interface IntegrationCheckMemory extends IntegrationCheck {
  at: number;
  persistedAt: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

function parseState(raw: unknown): Record<string, unknown> {
  const parsed = StateSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Runs registered jobs under a JobLease row: the lease is taken with one atomic
 * `UPDATE … WHERE lockedUntil < now RETURNING`, so two instances (or a cron tick racing the in-process
 * scheduler) never run the same job at the same time. A job failing never affects the others.
 *
 * Keeping Neon asleep (docs/PERFORMANCE.md): every job's lastRunAt and state live in memory after the first load,
 * so a tick where nothing is due sends no query at all. A due job with a `plan` first decides DB-free (cached
 * FPL data, upstream ETags / fingerprints, cached settings and integration rows) whether there is anything to
 * write; only then is the lease taken. While the database is awake anyway, jobs due within a minute run early
 * and housekeeping jobs (`idleEveryMs`) catch up, so database activity comes in short bursts with long gaps.
 */
export class JobRunner {
  private readonly jobs = new Map<JobName, Job>();
  private readonly memory = new Map<JobName, JobMemory>();
  private loading: Promise<void> | null = null;
  private lastQuietRunAt = -Infinity;
  private lastHeartbeatAt = -Infinity;
  private integrationCache: { at: number; rows: Map<IntegrationId, LoadedIntegration> } | null = null;
  private integrationsStale = false;
  private settingsCache: { at: number; value: AppSettings } | null = null;
  private readonly checks = new Map<IntegrationId, IntegrationCheckMemory>();

  constructor(
    private readonly ctx: AppContext,
    jobs: readonly Job[],
    private readonly log: FastifyBaseLogger,
  ) {
    for (const job of jobs) this.jobs.set(job.name, job);
  }

  get names(): JobName[] {
    return [...this.jobs.keys()];
  }

  /** Runs one job if its lease is free (and, unless forced, it is due). */
  async run(name: JobName, options: { force?: boolean } = {}): Promise<JobRunStatus> {
    const job = this.jobs.get(name);
    if (job === undefined) return 'unknown';
    await this.load();
    const now = this.ctx.clock.now();
    const force = options.force ?? false;
    if (!force && !this.isDue(job, this.mem(name), now.getTime())) return 'not_due';
    const status = await this.execute(job, now, force);
    await this.afterBurst(now.getTime());
    return status;
  }

  /** Runs every due job one after another (bounded memory on small hosts). Returns the jobs that ran. */
  async runDue(): Promise<JobName[]> {
    const now = this.ctx.clock.now();
    this.ctx.db.maybeLogHourly(this.log);
    // Quiet hours (night, Israel time): jobs run at most every 30 min.
    if (isQuietHour(now, this.ctx.config.keepAlive?.quietHours)) {
      if (now.getTime() - this.lastQuietRunAt < QUIET_JOBS_EVERY_MS) return [];
      this.lastQuietRunAt = now.getTime();
    }
    // One read of every lease on boot; afterwards lastRunAt / state come from memory (an idle tick: no query).
    await this.load();
    const ran: JobName[] = [];
    for (const [name, job] of this.jobs) {
      if (!this.isDue(job, this.mem(name), now.getTime())) continue;
      const status = await this.execute(job, now, false).catch((err: unknown) => {
        this.log.error({ job: name, err }, 'job lease failed');
        return 'failed' as const;
      });
      if (status === 'ok' || status === 'failed') ran.push(name);
    }
    await this.afterBurst(now.getTime());
    return ran;
  }

  /**
   * Makes a job due on the next tick. `forgetState` also drops its private state (e.g. "first sync
   * done"), used when Instagram is (re)connected so the new account backfills silently.
   */
  async reset(name: JobName, options: { forgetState?: boolean } = {}): Promise<void> {
    await this.ctx.prisma.jobLease.updateMany({
      where: { name },
      data: { lastRunAt: null, ...(options.forgetState === true ? { state: Prisma.DbNull } : {}) },
    });
    const m = this.memory.get(name);
    if (m !== undefined) {
      m.lastRunAt = null;
      m.persistedRunAt = null;
      if (options.forgetState === true) {
        m.state = {};
        m.memo = {};
      }
    }
    this.invalidateCaches();
  }

  /** After an admin write (settings, integrations): cached copies are re-read on next use. */
  invalidateCaches(): void {
    this.integrationCache = null;
    this.settingsCache = null;
  }

  /** The latest DB-free check of an integration in this process (the admin console shows it as "last run"). */
  integrationCheck(id: IntegrationId): { at: Date; ok: boolean } | null {
    const check = this.checks.get(id);
    return check === undefined ? null : { at: new Date(check.at), ok: check.ok };
  }

  // ---------- internals ----------

  private mem(name: JobName): JobMemory {
    let m = this.memory.get(name);
    if (m === undefined) {
      m = { lastRunAt: null, persistedRunAt: null, state: {}, lastError: null, memo: {} };
      this.memory.set(name, m);
    }
    return m;
  }

  /** Loads every lease row once per process (and again after a failed load). */
  private async load(): Promise<void> {
    if (this.loading === null) {
      this.loading = (async () => {
        const rows = await this.ctx.prisma.jobLease.findMany({
          select: { name: true, lastRunAt: true, state: true, lastError: true },
        });
        const byName = new Map(rows.map((r) => [r.name, r]));
        for (const name of this.jobs.keys()) {
          const row = byName.get(name);
          const m = this.mem(name);
          const at = row?.lastRunAt?.getTime() ?? null;
          m.lastRunAt = at;
          m.persistedRunAt = at;
          m.state = parseState(row?.state);
          m.lastError = row?.lastError ?? null;
        }
      })();
      this.loading.catch(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  private awake(now: number): boolean {
    return this.ctx.db.isAwake(now);
  }

  private intervalOf(job: Job, now: number): number {
    const awake = this.awake(now);
    const every = job.idleEveryMs !== undefined && !awake ? job.idleEveryMs : job.everyMs;
    // A short-period job's own queries keep the DB "awake", so running it early would compound (a 2-min job
    // would run every minute): only jobs with an interval well above the early window ride along with bursts.
    const early = awake && every > 2 * EARLY_WHILE_AWAKE_MS ? EARLY_WHILE_AWAKE_MS : 0;
    return Math.max(0, every - early);
  }

  private isDue(job: Job, m: JobMemory, now: number): boolean {
    return m.lastRunAt === null || now - m.lastRunAt >= this.intervalOf(job, now);
  }

  private async execute(job: Job, now: Date, force: boolean): Promise<JobRunStatus> {
    const m = this.mem(job.name);
    let carry: unknown;
    if (!force && job.plan !== undefined) {
      let plan: JobPlan | null = null;
      try {
        plan = await job.plan(this.planContext(m, now));
      } catch (err) {
        if (errorText(err) === m.lastError) {
          // Same failure as last time (e.g. FPL down for an hour): already recorded, don't wake the DB for it.
          m.lastRunAt = now.getTime();
          this.log.warn({ job: job.name, err }, 'job check failed (unchanged, not recorded again)');
          return 'failed';
        }
        // A new failure: run for real so it is recorded on the lease row (the run will most likely hit it too).
      }
      // A previous failure is still on the lease row: one real run clears it.
      if (plan !== null && !plan.run && m.lastError === null) {
        m.lastRunAt = now.getTime();
        this.log.debug({ job: job.name, summary: plan.summary }, 'job idle (no database work)');
        return 'ok';
      }
      if (plan?.run === true) carry = plan.carry;
    }
    return this.leaseAndRun(job, m, now, force, carry);
  }

  private async leaseAndRun(
    job: Job,
    m: JobMemory,
    now: Date,
    force: boolean,
    carry: unknown,
  ): Promise<JobRunStatus> {
    const { name } = job;
    const { prisma } = this.ctx;
    const nowMs = now.getTime();
    const leaseUntil = new Date(nowMs + (job.leaseMs ?? DEFAULT_LEASE_MS));
    const dueBefore = new Date(nowMs - this.intervalOf(job, nowMs));

    await prisma.$executeRaw`
      INSERT INTO "JobLease" ("name", "lockedUntil") VALUES (${name}, ${EPOCH})
      ON CONFLICT ("name") DO NOTHING`;
    const taken = await prisma.$queryRaw<{ state: unknown }[]>(Prisma.sql`
      UPDATE "JobLease" SET "lockedUntil" = ${leaseUntil}, "lastRunAt" = ${now}
      WHERE "name" = ${name} AND "lockedUntil" < ${now}
        AND (${force} OR "lastRunAt" IS NULL OR "lastRunAt" <= ${dueBefore})
      RETURNING "state"`);
    const lease = taken[0];
    if (lease === undefined) {
      // Another instance (or a racing tick) ran it: adopt its lastRunAt / state.
      const row = await prisma.jobLease.findUnique({ where: { name } });
      if (row !== null) {
        const at = row.lastRunAt?.getTime() ?? null;
        if (at !== null && (m.lastRunAt === null || at > m.lastRunAt)) m.lastRunAt = at;
        m.persistedRunAt = at;
        m.state = parseState(row.state);
        m.lastError = row.lastError;
        if (!force && row.lockedUntil.getTime() < nowMs) return 'not_due';
      }
      return 'locked';
    }

    m.lastRunAt = nowMs;
    m.persistedRunAt = nowMs;
    this.integrationsStale = true;
    const state = parseState(lease.state);
    const started = Date.now();
    try {
      const outcome = await job.run({
        app: this.ctx,
        now,
        force,
        state,
        log: this.log,
        memo: m.memo,
        ...(carry === undefined ? {} : { carry }),
      });
      await prisma.jobLease.update({
        where: { name },
        data: {
          lockedUntil: EPOCH,
          lastOkAt: this.ctx.clock.now(),
          lastError: null,
          ...(outcome?.state !== undefined ? { state: outcome.state as Prisma.InputJsonObject } : {}),
        },
      });
      m.state = outcome?.state ?? state;
      m.lastError = null;
      // Content jobs change the News feed: the shared hot pages are rebuilt on the next request.
      if (NEWS_JOBS.has(name)) this.ctx.hot.invalidateNews();
      this.log.info({ job: name, ms: Date.now() - started, summary: outcome?.summary }, 'job ok');
      return 'ok';
    } catch (err) {
      if (NEWS_JOBS.has(name)) this.ctx.hot.invalidateNews(); // a partial import is still new news
      const message = errorText(err);
      m.lastError = message;
      await prisma.jobLease
        .update({ where: { name }, data: { lockedUntil: EPOCH, lastError: message } })
        .catch(() => undefined);
      this.log.error({ job: name, err }, 'job failed');
      return 'failed';
    }
  }

  private planContext(m: JobMemory, now: Date): JobPlanContext {
    const nowMs = now.getTime();
    return {
      app: this.ctx,
      now,
      state: m.state,
      memo: m.memo,
      log: this.log,
      dbAwake: this.awake(nowMs),
      integration: (id) => this.integration(id, nowMs),
      settings: () => this.settings(nowMs),
      checked: (id, outcome) => {
        const previous = this.checks.get(id);
        this.checks.set(id, { ...outcome, at: nowMs, persistedAt: previous?.persistedAt ?? -Infinity });
      },
    };
  }

  private cacheExpired(at: number, now: number): boolean {
    const age = now - at;
    return age >= CACHE_MAX_AGE_MS || (age >= CACHE_REFRESH_AWAKE_MS && this.awake(now));
  }

  private integrationsLoading: Promise<Map<IntegrationId, LoadedIntegration>> | null = null;

  /** One load at a time (a plan asks for several integrations in parallel). */
  private loadIntegrations(now: number): Promise<Map<IntegrationId, LoadedIntegration>> {
    this.integrationsLoading ??= this.readIntegrations(now).finally(() => {
      this.integrationsLoading = null;
    });
    return this.integrationsLoading;
  }

  private async readIntegrations(now: number): Promise<Map<IntegrationId, LoadedIntegration>> {
    await ensureIntegrationRows(this.ctx.prisma);
    const rows = await this.ctx.prisma.integrationConfig.findMany();
    const map = new Map(rows.map((row) => [row.id, describe(row, this.ctx.config.secretsKey)]));
    this.integrationCache = { at: now, rows: map };
    this.integrationsStale = false;
    return map;
  }

  private async integration(id: IntegrationId, now: number): Promise<LoadedIntegration> {
    const cache = this.integrationCache;
    const rows =
      cache === null || this.cacheExpired(cache.at, now) ? await this.loadIntegrations(now) : cache.rows;
    return rows.get(id) ?? loadIntegration(this.ctx.prisma, this.ctx.config.secretsKey, id);
  }

  private async settings(now: number): Promise<AppSettings> {
    const cache = this.settingsCache;
    if (cache !== null && !this.cacheExpired(cache.at, now)) return cache.value;
    const value = await getSettings(this.ctx.prisma);
    this.settingsCache = { at: now, value };
    return value;
  }

  /**
   * End of a tick, while the database is awake anyway: refresh the integration rows the runs just wrote (so the
   * next DB-free checks see the new cursor / status), and at most hourly write back the in-memory "last checked"
   * times (lease rows + integration rows) so a restart and the admin console stay roughly current.
   */
  private async afterBurst(now: number): Promise<void> {
    if (!this.awake(now)) return;
    try {
      if (this.integrationsStale && this.integrationCache !== null) await this.loadIntegrations(now);
      if (now - this.lastHeartbeatAt < HEARTBEAT_EVERY_MS) return;
      this.lastHeartbeatAt = now;
      const { prisma } = this.ctx;
      for (const [name, m] of this.memory) {
        const at = m.lastRunAt;
        if (at === null || (m.persistedRunAt !== null && at <= m.persistedRunAt)) continue;
        await prisma.jobLease.updateMany({
          where: { name, OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(at) } }] },
          data: { lastRunAt: new Date(at) },
        });
        m.persistedRunAt = at;
      }
      for (const [id, check] of this.checks) {
        if (check.at <= check.persistedAt) continue;
        const at = new Date(check.at);
        await prisma.integrationConfig.updateMany({
          where: { id, OR: [{ lastRunAt: null }, { lastRunAt: { lt: at } }] },
          data: { lastRunAt: at, ...(check.ok ? { lastSuccessAt: at } : {}) },
        });
        check.persistedAt = check.at;
      }
    } catch (err) {
      this.log.warn({ err }, 'job heartbeat failed (retried later)');
    }
  }
}

/** In-process scheduler while the host is awake; the cron tick endpoint covers sleeping hosts. */
export class JobScheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  /** Last time each distinct tick error message was logged (ms), so a database outage doesn't flood the logs. */
  private readonly loggedErrors = new Map<string, number>();

  constructor(
    private readonly runner: Pick<JobRunner, 'runDue'>,
    private readonly log: Pick<FastifyBaseLogger, 'error'>,
    private readonly intervalMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  start(firstDelayMs = 5_000): void {
    if (this.timers.length > 0) return;
    const first = setTimeout(() => void this.tick(), firstDelayMs);
    const every = setInterval(() => void this.tick(), this.intervalMs);
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  /** Never overlaps itself; job failures are logged by the runner, anything else here. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runner.runDue();
    } catch (err) {
      // e.g. the lease rows couldn't be loaded (database briefly unreachable): retried on the next tick.
      this.logTickError(err);
    } finally {
      this.running = false;
    }
  }

  private logTickError(err: unknown): void {
    const key = errorText(err);
    const now = this.now();
    const last = this.loggedErrors.get(key);
    if (last !== undefined && now - last < TICK_ERROR_LOG_EVERY_MS) return;
    for (const [k, at] of this.loggedErrors) {
      if (now - at >= TICK_ERROR_LOG_EVERY_MS) this.loggedErrors.delete(k);
    }
    this.loggedErrors.set(key, now);
    this.log.error({ err }, 'job scheduler tick failed (retried on the next tick)');
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
