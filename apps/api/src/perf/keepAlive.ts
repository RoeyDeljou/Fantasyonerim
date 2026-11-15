/**
 * Quiet hours (night, Israel time): due jobs run at most every QUIET_JOBS_EVERY_MS.
 *
 * There is deliberately NO database keep-alive any more (the old /health `SELECT 1` kept Neon awake ~19 h a day and
 * burned the free plan's compute hours). Neon suspends ~5 minutes after the last query; the first query after that
 * waits ~0.5–1 s for the cold start. That is the accepted trade-off: the hot caches and the CDN serve almost every
 * public read without the database, so only a signed-in user's first uncached request pays it.
 * See docs/PERFORMANCE.md "Keeping Neon asleep".
 */
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
