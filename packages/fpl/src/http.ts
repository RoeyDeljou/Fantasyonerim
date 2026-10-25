import type { z } from 'zod';
import { FplNotFoundError, FplUnavailableError } from './service.js';

export const DEFAULT_BASE_URL = 'https://fantasy.premierleague.com/api';
export const DEFAULT_USER_AGENT = 'Fantasyonerim/0.1 (+https://fantasyonerim.app)';

export interface FplHttpOptions {
  fetch: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
}

export type FplGetJson = <S extends z.ZodType>(path: string, schema: S) => Promise<z.infer<S>>;

/**
 * Thin JSON GET over the injected `fetch`. Maps failures onto the two FPL error classes:
 *   404 → FplNotFoundError; 429 / 5xx / other non-2xx / network error / non-JSON body ("The game is
 *   being updated.") / schema mismatch → FplUnavailableError.
 */
export function createFplHttp(options: FplHttpOptions): FplGetJson {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const doFetch = options.fetch;

  return async <S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> => {
    const url = `${base}/${path.replace(/^\/+/, '')}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    } catch (err) {
      throw new FplUnavailableError(`FPL request failed: ${describe(err)} (${path})`, null);
    }
    if (res.status === 404) throw new FplNotFoundError(path);
    if (!res.ok) {
      const reason =
        res.status === 503 ? 'FPL is being updated' : res.status === 429 ? 'FPL rate limit' : 'FPL error';
      throw new FplUnavailableError(`${reason}: HTTP ${res.status} (${path})`, res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new FplUnavailableError(`FPL returned a non-JSON body (${path})`, res.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new FplUnavailableError(
        `FPL response did not match the expected shape (${path}): ${parsed.error.message.slice(0, 300)}`,
        res.status,
      );
    }
    return parsed.data;
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
