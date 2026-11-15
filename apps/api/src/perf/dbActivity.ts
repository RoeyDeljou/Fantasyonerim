import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

/** Neon suspends its compute after ~5 minutes without a query: every query keeps it awake this long. */
export const DB_AWAKE_AFTER_MS = 5 * 60 * 1000;
/**
 * Jobs treat the database as "awake" (optional work joins in) only right after a query: a query at +1 min extends
 * the compute's awake time by 1 min, one at +4 min by 4 — so the window is short (two scheduler ticks).
 */
export const DB_AWAKE_MARGIN_MS = 60 * 1000;
export const DB_ACTIVITY_LOG_EVERY_MS = 60 * 60 * 1000;

export interface DbActivitySnapshot {
  queries: number;
  /** Estimated compute-awake minutes (union of [query, query + 5 min) windows). */
  awakeMinutes: number;
  since: string;
  lastQueryAt: string | null;
}

/**
 * In-memory DB activity tracker: counts every statement the app sends and estimates how long Neon stayed awake
 * because of them. Jobs ask `isAwake()` to batch their optional work into periods the database is running anyway.
 * One summary line per hour (pino info); the counters are process-local and reset on restart.
 */
export class DbActivity {
  private queries = 0;
  private awakeMs = 0;
  private awakeUntil = -Infinity;
  private lastAt = -Infinity;
  private readonly startedAt: number;
  private hour: { at: number; queries: number; awakeMs: number };

  constructor(private readonly now: () => number) {
    this.startedAt = now();
    this.hour = { at: this.startedAt, queries: 0, awakeMs: 0 };
  }

  record(): void {
    const t = this.now();
    const end = t + DB_AWAKE_AFTER_MS;
    const added = Math.max(0, end - Math.max(t, this.awakeUntil));
    this.awakeMs += added;
    this.hour.awakeMs += added;
    this.awakeUntil = Math.max(this.awakeUntil, end);
    this.lastAt = t;
    this.queries += 1;
    this.hour.queries += 1;
  }

  /** The database ran a query recently enough that one more costs (almost) no extra compute time. */
  isAwake(at = this.now()): boolean {
    return at - this.lastAt < DB_AWAKE_MARGIN_MS;
  }

  get lastQueryAt(): number | null {
    return Number.isFinite(this.lastAt) ? this.lastAt : null;
  }

  snapshot(): DbActivitySnapshot {
    return {
      queries: this.queries,
      awakeMinutes: Math.round(this.awakeMs / 60_000),
      since: new Date(this.startedAt).toISOString(),
      lastQueryAt: Number.isFinite(this.lastAt) ? new Date(this.lastAt).toISOString() : null,
    };
  }

  /** Logs (and resets) the hourly counters once an hour has passed. Called from the job scheduler's tick. */
  maybeLogHourly(log: FastifyBaseLogger): boolean {
    const t = this.now();
    if (t - this.hour.at < DB_ACTIVITY_LOG_EVERY_MS) return false;
    log.info(
      {
        db: {
          queries: this.hour.queries,
          awakeMinutes: Math.round(this.hour.awakeMs / 60_000),
          minutes: Math.round((t - this.hour.at) / 60_000),
          total: this.snapshot(),
        },
      },
      'db activity (last hour)',
    );
    this.hour = { at: t, queries: 0, awakeMs: 0 };
    return true;
  }
}

/**
 * The app's PrismaClient with every operation (model calls, raw SQL, transactions' statements) counted. The
 * extended client is a drop-in PrismaClient at runtime; the cast keeps the rest of the code on the plain type.
 */
export function trackPrisma(prisma: PrismaClient, activity: DbActivity): PrismaClient {
  return prisma.$extends({
    query: {
      $allOperations({ args, query }) {
        activity.record();
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
}
