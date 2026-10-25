import { createDemoFplService, createFplService, type FplService } from '@fant/fpl';
import type { Env } from './env.js';

/**
 * The only place that picks an FplService implementation. FPL_MODE=live → real HTTP client (with TTL
 * cache), FPL_MODE=demo → deterministic demo dataset, no network (sandboxes and previews).
 */
export function createFplFromEnv(env: Env): FplService {
  if (env.FPL_MODE === 'demo') return createDemoFplService();
  return createFplService({
    fetch: globalThis.fetch.bind(globalThis),
    ...(env.FPL_USER_AGENT ? { userAgent: env.FPL_USER_AGENT } : {}),
  });
}
