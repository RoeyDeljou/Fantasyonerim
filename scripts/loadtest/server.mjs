// The API process under test, forked by run.mjs. It is the production server (apps/api/dist/boot.js: Prisma,
// jobs scheduler, push, rate limits…) with two swaps: the FplService serves the scaled demo league and the
// content jobs read recorded feeds (no network). It reports its own runtime metrics over IPC: RSS, heap, CPU
// time and event-loop delay (perf_hooks.monitorEventLoopDelay), so the numbers come from inside the process.
/* global setInterval, clearInterval -- Node.js globals (eslint's .mjs config lists only a few) */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { startServer } from '../../apps/api/dist/boot.js';
import { loadEnv } from '../../apps/api/dist/env.js';
import { createContentFetch } from './lib/content.mjs';
import { createScaledFplService } from './lib/fpl.mjs';

const managers = Number(process.env.LT_MANAGERS ?? '150');
let upstream = 0;

const { app, shutdown } = await startServer({
  env: loadEnv(),
  fpl: (onWarn) =>
    createScaledFplService({
      managers,
      onWarn,
      onRequest: () => {
        upstream += 1;
      },
    }).fpl,
  fetch: createContentFetch(),
});

const phase = monitorEventLoopDelay({ resolution: 5 });
const second = monitorEventLoopDelay({ resolution: 5 });
phase.enable();
second.enable();

const ms = (ns) => Math.round((ns / 1e6) * 10) / 10;
const lag = (h) => ({
  p50: ms(h.percentile(50)),
  p99: ms(h.percentile(99)),
  max: ms(h.max),
  mean: ms(h.mean),
});

function sample() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    t: Date.now(),
    rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
    heapMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
    externalMb: Math.round(((mem.external + mem.arrayBuffers) / 1048576) * 10) / 10,
    cpuMs: (cpu.user + cpu.system) / 1000,
    upstream,
  };
}

const timer = setInterval(() => {
  process.send?.({ type: 'sample', ...sample(), lag: lag(second) });
  second.reset();
}, 1000);
timer.unref();

process.on('message', (msg) => {
  if (msg?.type === 'reset') {
    phase.reset();
    process.send?.({ type: 'reset-ok', ...sample() });
  } else if (msg?.type === 'report') {
    process.send?.({ type: 'report', ...sample(), lag: lag(phase), lagCount: phase.count });
  } else if (msg?.type === 'gc' && typeof globalThis.gc === 'function') {
    globalThis.gc();
    process.send?.({ type: 'gc-ok', ...sample() });
  } else if (msg?.type === 'stop') {
    clearInterval(timer);
    void shutdown('loadtest').finally(() => process.exit(0));
  }
});

app.log.info({ managers }, 'loadtest server ready');
process.send?.({ type: 'ready', ...sample() });
