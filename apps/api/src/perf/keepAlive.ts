import type { AppContext } from '../context.js';

/** /health runs `SELECT 1` at most this often. */
export const DB_PING_INTERVAL_MS = 60 * 1000;
/** During quiet hours, due jobs run at most this often (scheduler and cron tick alike). */
export const QUIET_JOBS_EVERY_MS = 30 * 60 * 1000;
export const KEEPALIVE_TIME_ZONE = 'Asia/Jerusalem';

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: KEEPALIVE_TIME_ZONE,
  hour: 'numeric',
  hourCycle: 'h23',
});

/** Israel-time hour of `date` ∈ [start, end) (the window may wrap midnight). null = never quiet. */
export function isQuietHour(date: Date, quietHours: readonly [number, number] | null | undefined): boolean {
  if (!quietHours) return false;
  const [start, end] = quietHours;
  if (start === end) return false;
  const hour = Number(hourFormat.format(date));
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** "02-07" → [2, 7]; "" / "off" → null. */
export function parseQuietHours(raw: string): readonly [number, number] | null {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'off' || value === 'none') return null;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!m) throw new Error('must be "HH-HH" (Israel time, e.g. "02-07") or "off"');
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 24) throw new Error('hours must be 0–24');
  return [start, end % 24];
}

/**
 * Neon suspends its compute after ~5 idle minutes and the next query then waits ~1 s for a cold start. The
 * external keep-alive pings /health every 5 minutes; this makes that ping touch the database too (one cheap
 * `SELECT 1`, at most once a minute, never awaited by the health response), except during quiet hours.
 */
export function createDbKeepAlive(ctx: Pick<AppContext, 'prisma' | 'clock' | 'config'>) {
  let lastPingAt = -Infinity;
  let inflight = false;
  return {
    /** Returns whether a ping was started. */
    touch(): boolean {
      const now = ctx.clock.now();
      if (inflight || now.getTime() - lastPingAt < DB_PING_INTERVAL_MS) return false;
      if (isQuietHour(now, ctx.config.keepAlive?.quietHours)) return false;
      lastPingAt = now.getTime();
      inflight = true;
      void ctx.prisma.$queryRaw`SELECT 1`
        .catch(() => undefined)
        .finally(() => {
          inflight = false;
        });
      return true;
    },
  };
}
