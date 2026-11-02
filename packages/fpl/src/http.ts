import type { z } from 'zod';
import type { FplBackoff } from './backoff.js';
import { FplNotFoundError, FplUnavailableError } from './service.js';

export const DEFAULT_BASE_URL = 'https://fantasy.premierleague.com/api';
export const DEFAULT_USER_AGENT = 'Fantasyonerim/0.1 (+https://fantasyonerim.app)';

export interface FplHttpOptions {
  fetch: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
  /** Shared circuit: requests fail fast while it is open, and every outcome is reported to it. */
  backoff?: FplBackoff;
}

export type FplGetJson = <S extends z.ZodType>(path: string, schema: S) => Promise<z.infer<S>>;

/**
 * Thin JSON GET over the injected `fetch`. Maps failures onto the two FPL error classes:
 *   404 → FplNotFoundError; 429 / 5xx / other non-2xx / network error / non-JSON body ("The game is
 *   being updated.") / schema mismatch → FplUnavailableError. The body is Zod-parsed exactly once per fetch.
 */
export function createFplHttp(options: FplHttpOptions): FplGetJson {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const doFetch = options.fetch;

  const backoff = options.backoff;

  const request = async <S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> => {
    backoff?.check(path);
    const url = `${base}/${path.replace(/^\/+/, '')}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
    } catch (err) {
      throw new FplUnavailableError(`FPL request failed: ${describe(err)} (${path})`, null, 'network');
    }
    if (res.status === 404) throw new FplNotFoundError(path);
    if (!res.ok) {
      const reason =
        res.status === 503 ? 'FPL is being updated' : res.status === 429 ? 'FPL rate limit' : 'FPL error';
      throw new FplUnavailableError(
        `${reason}: HTTP ${res.status} (${path})`,
        res.status,
        undefined,
        retryAfterMs(res.headers.get('retry-after')),
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new FplUnavailableError(`FPL response body failed: ${describe(err)} (${path})`, null, 'network');
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // FPL answers its update window with a plain-text "The game is being updated." (sometimes 200).
      const updating = /being updated/i.test(text.slice(0, 500));
      throw new FplUnavailableError(
        updating ? `FPL is being updated (${path})` : `FPL returned a non-JSON body (${path})`,
        res.status,
        updating ? 'updating' : 'bad_response',
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new FplUnavailableError(
        `FPL response did not match the expected shape (${path}): ${parsed.error.message.slice(0, 300)}`,
        res.status,
        'bad_response',
      );
    }
    return parsed.data;
  };

  if (!backoff) return request;
  return async <S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> => {
    try {
      const value = await request(path, schema);
      backoff.onSuccess();
      return value;
    } catch (err) {
      if (err instanceof FplNotFoundError) backoff.onSuccess();
      else if (err instanceof FplUnavailableError) backoff.onFailure(err);
      throw err;
    }
  };
}

/** HTTP Retry-After in delta-seconds → ms, capped at 10 min (the HTTP-date form is ignored). */
function retryAfterMs(header: string | null): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 10 * 60_000) : null;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
