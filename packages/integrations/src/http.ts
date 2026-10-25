import type { z } from 'zod';
import type { IntegrationContext } from './types.js';
import { IntegrationUnavailableError } from './types.js';

export const USER_AGENT = 'Fantasyonerim/0.1 (+https://fantasyonerim.app)';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * `fetch` through the injected context with a timeout. Network failures / timeouts become
 * IntegrationUnavailableError so callers only ever see the typed integration errors.
 */
export async function send(
  ctx: IntegrationContext,
  platform: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT);
  try {
    return await ctx.fetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new IntegrationUnavailableError(`${platform} request failed: ${describeError(err)}`, null);
  }
}

/** Reads a body as JSON; `undefined` when it is not JSON (never throws). */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Validates a whole response envelope; a mismatch means the platform changed → unavailable. */
export function parseEnvelope<S extends z.ZodType>(
  platform: string,
  schema: S,
  body: unknown,
  status: number,
): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new IntegrationUnavailableError(
      `${platform} response did not match the expected shape: ${parsed.error.message.slice(0, 300)}`,
      status,
    );
  }
  return parsed.data;
}

/** Seconds from a `Retry-After` header (delta-seconds or HTTP date). */
export function retryAfterSec(res: Response, nowMs: number): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'TimeoutError' ? 'timed out' : err.message;
  }
  return String(err);
}

/** Returns the URL if it is an absolute http(s) URL (as `NewsLinks` / `z.string().url()` require). */
export function httpUrlOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
