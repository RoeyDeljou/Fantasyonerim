import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';

export const RUNTIME_LOG_INTERVAL_MS = 5 * 60 * 1000;
/** Above this event-loop p99 the periodic line is logged as a warning. */
export const EVENT_LOOP_P99_WARN_MS = 100;

const mb = (bytes: number) => Math.round(bytes / 1048576);
const ms = (ns: number) => Math.round(ns / 1e5) / 10;

/**
 * One log line every 5 minutes with RSS, heap, CPU and event-loop delay (p50/p99/max), so a slow phone on a
 * live Saturday can be matched to the server's state in Render's logs. Costs nothing measurable.
 */
export function startRuntimeMonitor(
  log: FastifyBaseLogger,
  extra: () => Record<string, unknown> = () => ({}),
  intervalMs = RUNTIME_LOG_INTERVAL_MS,
): { stop(): void } {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let cpu = process.cpuUsage();
  let at = Date.now();
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const used = process.cpuUsage(cpu);
    const now = Date.now();
    const line = {
      rssMb: mb(mem.rss),
      heapMb: mb(mem.heapUsed),
      cpuPct: Math.round(((used.user + used.system) / 1000 / (now - at)) * 1000) / 10,
      eventLoopMs: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) },
      ...extra(),
    };
    if (line.eventLoopMs.p99 > EVENT_LOOP_P99_WARN_MS)
      log.warn({ runtime: line }, 'runtime: event loop slow');
    else log.info({ runtime: line }, 'runtime');
    delay.reset();
    cpu = process.cpuUsage();
    at = now;
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      delay.disable();
    },
  };
}
