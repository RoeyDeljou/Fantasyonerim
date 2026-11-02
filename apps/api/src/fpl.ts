import { createDemoFplService, createFplService, type FplService } from '@fant/fpl';
import type { Env } from './env.js';

/**
 * The only place that picks an FplService implementation. FPL_MODE=live → real HTTP client (with TTL
 * cache), FPL_MODE=demo → deterministic demo dataset, no network (sandboxes and previews). `onWarn` receives
 * non-fatal FPL data oddities (e.g. an unmapped fixture stat).
 */
export function createFplFromEnv(env: Env, onWarn?: (message: string) => void): FplService {
  const warn = onWarn === undefined ? {} : { onWarn };
  if (env.FPL_MODE === 'demo') return createDemoFplService(warn);
  return createFplService({
    fetch: globalThis.fetch.bind(globalThis),
    ...warn,
    ...(env.FPL_USER_AGENT ? { userAgent: env.FPL_USER_AGENT } : {}),
  });
}
