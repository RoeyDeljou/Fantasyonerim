import { createFplService, type CreateFplServiceExtras } from '../client.js';
import { createReplayFetch, type ReplayFetchOptions, type ReplayResolver } from '../replay.js';
import type { FplService, FplServiceOptions } from '../service.js';
import { buildDemoDataset, type BuildDemoOptions, type DemoDataset } from './generate.js';

export {
  buildDemoDataset,
  DEMO_CURRENT_EVENT,
  DEMO_DEFAULT_ANCHOR_MS,
  DEMO_ENTRIES,
  DEMO_ENTRY_COUNT,
  DEMO_FIRST_ENTRY_ID,
  DEMO_LEAGUE_ID,
  DEMO_LEAGUE_NAME,
  type BuildDemoOptions,
  type DemoDataset,
} from './generate.js';

/** Serves a demo dataset under the real FPL API paths (404 for anything it doesn't know). */
export function demoRoutes(data: DemoDataset): ReplayResolver {
  return (path, query) => {
    if (path === 'bootstrap-static/') return data.bootstrap;
    if (path === 'fixtures/') {
      const event = query.get('event');
      return event === null ? data.fixtures : data.fixtures.filter((f) => String(f.event) === event);
    }
    let m = /^event\/(\d+)\/live\/$/.exec(path);
    if (m) return data.live.get(Number(m[1]));
    m = /^entry\/(\d+)\/$/.exec(path);
    if (m) return data.entries.get(Number(m[1]));
    m = /^entry\/(\d+)\/history\/$/.exec(path);
    if (m) return data.histories.get(Number(m[1]));
    m = /^entry\/(\d+)\/event\/(\d+)\/picks\/$/.exec(path);
    if (m) return data.picks.get(`${m[1]}:${m[2]}`);
    m = /^leagues-classic\/(\d+)\/standings\/$/.exec(path);
    if (m && Number(m[1]) === data.leagueId) {
      const page = Math.max(1, Number(query.get('page_standings') ?? '1') || 1);
      const found = data.standingsPages[page - 1];
      if (found) return found;
      const first = data.standingsPages[0] as Record<string, unknown>;
      return { ...first, standings: { has_next: false, page, results: [] } };
    }
    return undefined;
  };
}

export interface DemoFplServiceOptions
  extends Partial<Omit<FplServiceOptions, 'fetch'>>, CreateFplServiceExtras, BuildDemoOptions {
  replay?: ReplayFetchOptions;
}

/**
 * `createFplService` wired to a replay fetch over the deterministic demo dataset (no network). Used by
 * apps/api when `FPL_MODE=demo`. The dataset is anchored at `anchorMs` (default: `now()` at creation)
 * so the in-progress GW9 always looks "live" relative to the clock.
 */
export function createDemoFplService(options: DemoFplServiceOptions = {}): FplService {
  const now = options.now ?? (() => Date.now());
  const data = buildDemoDataset({
    anchorMs: options.anchorMs ?? now(),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });
  return createFplService({
    fetch: createReplayFetch(demoRoutes(data), options.replay),
    now,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
  });
}
