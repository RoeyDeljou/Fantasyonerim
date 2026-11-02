/**
 * Micro-benchmark of the FPL layer's hot paths, over the deterministic demo dataset scaled to production
 * size: a ~1.8 MB bootstrap (780 elements with FPL's full field set), a matching GW live payload with
 * `explain`, and the demo league scaled to 150 entries (3 standings pages of 50).
 *
 * Run from the repo root:
 *   npm run bench -w @fant/fpl
 * (= node --expose-gc --max-semi-space-size=256 --import tsx packages/fpl/bench/fpl-bench.ts)
 *
 * Per scenario it reports CPU ms/op (process.cpuUsage, user+system, all threads) and allocated KB/op
 * (heapUsed delta with a forced GC before each op and a 256 MB young generation, so no scavenge runs
 * mid-op and the delta ≈ bytes allocated). "cold" = the underlying FPL payload was just (re)fetched;
 * "warm" = a request served while everything it needs is cached — the per-user cost during a live GW.
 *
 * Not part of the package build (outside src/), so it may use Node globals.
 */
import {
  FplEntryIdSchema,
  FplFixtureIdSchema,
  FplLeagueIdSchema,
  FplPlayerIdSchema,
  GameweekSchema,
} from '@fant/shared';
import { createFplService } from '../src/client.js';
import { buildDemoDataset, DEMO_DEFAULT_ANCHOR_MS, DEMO_LEAGUE_ID } from '../src/demo/index.js';
import type { FplService } from '../src/service.js';

declare const process: {
  cpuUsage(prev?: { user: number; system: number }): { user: number; system: number };
  memoryUsage(): { heapUsed: number };
  argv: string[];
};
declare const gc: (() => void) | undefined;

const ENTRIES = 150;
/** Per-entry cache sizing target: ~300 managers × 2 GWs. */
const MEMORY_ENTRIES = 300;
const ELEMENTS = 780;
const GW = 9;
const FIRST_ENTRY = 1_000_001;

// ---------- scaled dataset ----------

type Json = Record<string, unknown>;
const data = buildDemoDataset({ anchorMs: DEMO_DEFAULT_ANCHOR_MS });
const demoBootstrap = data.bootstrap as Json & { elements: Json[] };
const demoLive = data.live.get(GW) as unknown as { elements: (Json & { id: number })[] };
const demoEntryIds = [...data.entryIds];

/** The ~50 FPL element fields the demo doesn't carry (ICT, xG, ranks…), so the payload has real size. */
const PADDING: Json = {};
for (const k of ['influence', 'creativity', 'threat', 'ict_index', 'expected_goals', 'expected_assists']) {
  PADDING[k] = '123.4';
  PADDING[`${k}_rank`] = 321;
  PADDING[`${k}_rank_type`] = 45;
  PADDING[`${k}_per_90`] = 0.42;
}
for (const k of [
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'goals_conceded',
  'clearances_blocks_interceptions',
  'recoveries',
  'tackles',
  'defensive_contribution',
  'expected_goal_involvements',
  'expected_goals_conceded',
  'now_cost_rank',
  'now_cost_rank_type',
  'form_rank',
  'form_rank_type',
  'points_per_game_rank',
  'points_per_game_rank_type',
  'selected_rank',
  'selected_rank_type',
  'corners_and_indirect_freekicks_order',
  'direct_freekicks_order',
  'penalties_order',
]) {
  PADDING[k] = 7;
}
PADDING.corners_and_indirect_freekicks_text = '';
PADDING.direct_freekicks_text = '';
PADDING.penalties_text = '';

const elements: Json[] = [];
const liveElements: Json[] = [];
for (let i = 0; i < ELEMENTS; i++) {
  const src = demoBootstrap.elements[i % demoBootstrap.elements.length] as Json & { id: number };
  const id = i < demoBootstrap.elements.length ? src.id : 5000 + i;
  elements.push({ ...src, ...PADDING, id });
  const live = demoLive.elements.find((e) => e.id === src.id);
  if (live) liveElements.push({ ...live, id });
}
const bootstrap = { ...demoBootstrap, elements };
const live = { elements: liveElements };

const demoPage1 = data.standingsPages[0] as Json & { standings: { results: Json[] } };
const rowTemplate = demoPage1.standings.results[0] as Json;
const routes = new Map<string, unknown>([
  ['bootstrap-static/', bootstrap],
  ['fixtures/?event=9', data.fixtures.filter((f) => f.event === GW)],
  ['fixtures/', data.fixtures],
  [`event/${GW}/live/`, live],
]);
routes.set(
  'fixtures/?event=8',
  data.fixtures.filter((f) => f.event === 8),
);
routes.set('event/8/live/', data.live.get(8));
for (let i = 0; i < MEMORY_ENTRIES; i++) {
  const id = FIRST_ENTRY + i;
  const src = demoEntryIds[i % demoEntryIds.length] as number;
  routes.set(`entry/${id}/event/${GW}/picks/`, data.picks.get(`${src}:${GW}`));
  routes.set(`entry/${id}/event/8/picks/`, data.picks.get(`${src}:8`));
  routes.set(`entry/${id}/`, { ...(data.entries.get(src) as Json), id });
  routes.set(`entry/${id}/history/`, data.histories.get(src));
}
for (let page = 1; page <= ENTRIES / 50; page++) {
  const results = Array.from({ length: 50 }, (_, k) => {
    const n = (page - 1) * 50 + k;
    return {
      ...rowTemplate,
      id: n + 1,
      entry: FIRST_ENTRY + n,
      entry_name: `Team ${n + 1}`,
      player_name: `Manager ${n + 1}`,
      rank: n + 1,
      last_rank: n + 1,
      rank_sort: n + 1,
      total: 600 - n,
      event_total: 40,
    };
  });
  routes.set(`leagues-classic/${DEMO_LEAGUE_ID}/standings/?page_standings=${page}`, {
    ...demoPage1,
    standings: { has_next: page < ENTRIES / 50, page, results },
  });
}
const bodies = new Map<string, string>();
for (const [k, v] of routes) bodies.set(k, JSON.stringify(v));

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/api\//, '');
  const key = url.search ? `${path}${url.search}` : path;
  const body = bodies.get(key);
  return body === undefined
    ? new Response('{"detail":"Not found."}', { status: 404 })
    : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// ---------- harness ----------

interface Result {
  name: string;
  cpuMs: number;
  allocKb: number;
}

async function measure(
  name: string,
  iterations: number,
  setup: () => Promise<void> | void,
  op: () => Promise<unknown>,
): Promise<Result> {
  if (typeof gc !== 'function') throw new Error('run with node --expose-gc');
  for (let i = 0; i < Math.min(5, iterations); i++) {
    await setup();
    await op(); // warm up the JIT
  }
  let cpu = 0;
  let alloc = 0;
  for (let i = 0; i < iterations; i++) {
    await setup();
    gc();
    const heap0 = process.memoryUsage().heapUsed;
    const cpu0 = process.cpuUsage();
    await op();
    const d = process.cpuUsage(cpu0);
    alloc += process.memoryUsage().heapUsed - heap0;
    cpu += (d.user + d.system) / 1000;
  }
  return { name, cpuMs: cpu / iterations, allocKb: alloc / iterations / 1024 };
}

const gw = GameweekSchema.parse(GW);
const league = FplLeagueIdSchema.parse(DEMO_LEAGUE_ID);
const pages = Array.from({ length: ENTRIES / 50 }, (_, i) => i + 1);
const entryOf = (i: number) => FplEntryIdSchema.parse(FIRST_ENTRY + i);
const LIVE_FIXTURE = FplFixtureIdSchema.parse(
  (data.fixtures.find((f) => f.event === GW && f.started && !f.finished_provisional) as { id: number }).id,
);

/** A service whose clock we move; bootstrap/picks/entries never expire on their own during a bench. */
function makeService(): { service: FplService; tick: (ms: number) => void } {
  let t = DEMO_DEFAULT_ANCHOR_MS;
  const service = createFplService({
    fetch: fetchImpl,
    now: () => t,
    ttl: { bootstrap: 1e12, picksImmutable: 1e12, picksSummary: 1e12, entry: 1e12, history: 1e12 },
  });
  return { service, tick: (ms) => (t += ms) };
}

async function primeLeague(service: FplService): Promise<void> {
  for (const p of pages) await service.getLiveLeague(league, gw, p);
}

async function main(): Promise<void> {
  const iterations = Number(process.argv[2] ?? 40);
  const results: Result[] = [];

  results.push(
    await measure(
      'bootstrap: JSON.parse only (reference, not ours)',
      iterations,
      () => {},
      async () => JSON.parse(bodies.get('bootstrap-static/') as string),
    ),
  );
  {
    let s: FplService;
    results.push(
      await measure(
        'bootstrap: fetch + parse + normalize (cold)',
        iterations,
        () => {
          s = makeService().service;
        },
        () => s.getBootstrap(),
      ),
    );
  }
  {
    const { service, tick } = makeService();
    await primeLeague(service);
    const ids = [FplPlayerIdSchema.parse(1)];
    results.push(
      await measure(
        'live: refetch + parse + GW context (cold, 30 s TTL expired)',
        iterations,
        () => tick(31_000),
        () => service.getPlayersLive(ids, gw),
      ),
    );
  }
  {
    const { service, tick } = makeService();
    await primeLeague(service);
    results.push(
      await measure(
        'getLiveLeague ×3 pages = 150 entries (cold live, picks cached)',
        iterations,
        () => tick(31_000),
        async () => {
          for (const p of pages) await service.getLiveLeague(league, gw, p);
        },
      ),
    );
    results.push(
      await measure(
        'getLiveLeague ×3 pages = 150 entries (warm)',
        iterations,
        () => {},
        async () => {
          for (const p of pages) await service.getLiveLeague(league, gw, p);
        },
      ),
    );
    results.push(
      await measure(
        'getEntryLive ×1 (warm)',
        iterations * 10,
        () => {},
        () => service.getEntryLive(entryOf(3), gw),
      ),
    );
    results.push(
      await measure(
        'getEntryLive ×150 entries (warm)',
        iterations,
        () => {},
        async () => {
          for (let i = 0; i < ENTRIES; i++) await service.getEntryLive(entryOf(i), gw);
        },
      ),
    );
    results.push(
      await measure(
        'getFixtureDetail live fixture (warm)',
        iterations * 10,
        () => {},
        () => service.getFixtureDetail(LIVE_FIXTURE),
      ),
    );
    results.push(
      await measure(
        'getFixtureDetail live fixture (cold live)',
        iterations,
        () => tick(31_000),
        () => service.getFixtureDetail(LIVE_FIXTURE),
      ),
    );
    results.push(
      await measure(
        'getLeagueStandings ×3 pages (warm)',
        iterations * 10,
        () => {},
        async () => {
          for (const p of pages) await service.getLeagueStandings(league, p);
        },
      ),
    );
    results.push(
      await measure(
        'getLeagueStandings ×3 pages (cold, 2 min TTL expired)',
        iterations,
        () => tick(121_000),
        async () => {
          for (const p of pages) await service.getLeagueStandings(league, p);
        },
      ),
    );
    results.push(
      await measure(
        'getFixtures(GW) (warm)',
        iterations * 10,
        () => {},
        () => service.getFixtures(gw),
      ),
    );
  }

  // Retained heap of the per-entry caches at the sizing target (300 entries × 2 GWs).
  {
    const { service } = makeService();
    await service.getBootstrap();
    await service.getPlayersLive([], gw);
    await service.getPlayersLive([], GameweekSchema.parse(8));
    if (typeof gc === 'function') gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < MEMORY_ENTRIES; i++) {
      await service.getEntry(entryOf(i));
      for (const event of [GameweekSchema.parse(8), gw]) {
        await service.getEntryPicks(entryOf(i), event);
        await service.getEntryLive(entryOf(i), event);
      }
    }
    if (typeof gc === 'function') gc();
    const retained = process.memoryUsage().heapUsed - before;
    console.warn(
      `retained by per-entry caches, ${MEMORY_ENTRIES} entries × 2 GWs (entry + picks + history + EntryPicks/EntryLive memos): ${(retained / 1024 / 1024).toFixed(2)} MB`,
    );
  }

  const w = Math.max(...results.map((r) => r.name.length));
  console.warn(
    `bootstrap ${(bodies.get('bootstrap-static/') as string).length} B, live ${bodies.get(`event/${GW}/live/`)?.length} B, ${ENTRIES} entries`,
  );
  console.warn(`${'scenario'.padEnd(w)} | CPU ms/op | alloc KB/op`);
  for (const r of results)
    console.warn(
      `${r.name.padEnd(w)} | ${r.cpuMs.toFixed(3).padStart(9)} | ${r.allocKb.toFixed(0).padStart(11)}`,
    );
}

void main();
