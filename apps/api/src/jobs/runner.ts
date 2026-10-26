import { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { MINUTE, type Job, type JobName } from './types.js';

export type JobRunStatus = 'ok' | 'failed' | 'locked' | 'not_due' | 'unknown';

const DEFAULT_LEASE_MS = 10 * MINUTE;
const EPOCH = new Date(0);
const StateSchema = z.record(z.string(), z.unknown());

/**
 * Runs registered jobs under a JobLease row: the lease is taken with one atomic
 * `UPDATE … WHERE lockedUntil < now RETURNING`, so two instances (or a cron tick racing the in-process
 * scheduler) never run the same job at the same time. A job failing never affects the others.
 */
export class JobRunner {
  private readonly jobs = new Map<JobName, Job>();

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
    const force = options.force ?? false;
    const { prisma } = this.ctx;
    const now = this.ctx.clock.now();
    const leaseUntil = new Date(now.getTime() + (job.leaseMs ?? DEFAULT_LEASE_MS));
    const dueBefore = new Date(now.getTime() - job.everyMs);

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
      if (!force) {
        const row = await prisma.jobLease.findUnique({ where: { name } });
        if (row !== null && row.lockedUntil.getTime() < now.getTime()) return 'not_due';
      }
      return 'locked';
    }

    const parsedState = StateSchema.safeParse(lease.state);
    const state = parsedState.success ? parsedState.data : {};
    const started = Date.now();
    try {
      const outcome = await job.run({ app: this.ctx, now, force, state, log: this.log });
      await prisma.jobLease.update({
        where: { name },
        data: {
          lockedUntil: EPOCH,
          lastOkAt: this.ctx.clock.now(),
          lastError: null,
          ...(outcome?.state !== undefined ? { state: outcome.state as Prisma.InputJsonObject } : {}),
        },
      });
      this.log.info({ job: name, ms: Date.now() - started, summary: outcome?.summary }, 'job ok');
      return 'ok';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.jobLease
        .update({ where: { name }, data: { lockedUntil: EPOCH, lastError: message.slice(0, 1000) } })
        .catch(() => undefined);
      this.log.error({ job: name, err }, 'job failed');
      return 'failed';
    }
  }

  /** Runs every due job one after another (bounded memory on small hosts). Returns the jobs that ran. */
  async runDue(): Promise<JobName[]> {
    const ran: JobName[] = [];
    for (const name of this.jobs.keys()) {
      const status = await this.run(name).catch((err: unknown) => {
        this.log.error({ job: name, err }, 'job lease failed');
        return 'failed' as const;
      });
      if (status === 'ok' || status === 'failed') ran.push(name);
    }
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
  }
}

/** In-process scheduler while the host is awake; the cron tick endpoint covers sleeping hosts. */
export class JobScheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly runner: JobRunner,
    private readonly intervalMs = 30_000,
  ) {}

  start(firstDelayMs = 5_000): void {
    if (this.timers.length > 0) return;
    const first = setTimeout(() => void this.tick(), firstDelayMs);
    const every = setInterval(() => void this.tick(), this.intervalMs);
    first.unref();
    every.unref();
    this.timers = [first, every];
  }

  /** Never overlaps itself; errors are logged by the runner. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runner.runDue();
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
