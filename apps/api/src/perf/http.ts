import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Encoding, HotBody } from './hotCache.js';

/**
 * Cache-Control per kind of data. Render passes responses through, so most of these only steer browsers / the
 * PWA's HTTP cache: within max-age the poll never leaves the phone, after it the browser revalidates with
 * If-None-Match and usually gets a bodiless 304. Config and bootstrap also carry `s-maxage`: the web app reads them
 * through the Vercel CDN (`/cdn/v1/config/`, `/cdn/v1/fpl/bootstrap/` rewrites in vercel.json), so an app-open spike
 * is answered by the CDN instead of the 0.1-CPU API. They must never vary by user (asserted in tests).
 */
export const CACHE_CONTROL = {
  /** Moves while a match is on: live league, live fixtures, a live match sheet, a manager's live points. */
  live: 'public, max-age=10, stale-while-revalidate=20',
  /** Bootstrap: FplService refreshes it every 5 minutes. */
  bootstrap: 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
  /** Standings / an entry / picks: minutes. */
  fpl: 'public, max-age=30, stale-while-revalidate=60',
  /** Public config (league, socials): admin edits show within a minute. */
  config: 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
  /** News feed pages / stories (an admin hide shows within ~15 s). */
  news: 'public, max-age=15, stale-while-revalidate=45',
  /**
   * Gameweek Roundup without a signed-in viewer: a stored roundup never changes, and "pending" → "building" →
   * "ready" may lag by a minute. Browser cache only (varies by Authorization: signed-in viewers get `private`).
   */
  roundup: 'public, max-age=60, stale-while-revalidate=120',
  /** Community-captain vote for guests: the voter count moves, the shared part is recomputed every ~15 s. */
  vote: 'public, max-age=15, stale-while-revalidate=30',
  /** Per-viewer responses: the browser may keep them, never a shared cache; always revalidated (ETag). */
  private: 'private, no-cache',
} as const;

/** Picks the response encoding from Accept-Encoding: br, then gzip, else identity (q=0 honoured). */
export function negotiateEncoding(header: string | string[] | undefined): Encoding {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  if (raw === '') return 'identity';
  const accepted = new Set<string>();
  for (const part of raw.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (name && !(q !== undefined && Number(q.slice(2)) === 0)) accepted.add(name.trim());
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip') || accepted.has('*')) return 'gzip';
  return 'identity';
}

/** True when If-None-Match lists `etag` (weak comparison, `*` matches). */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const bare = etag.replace(/^W\//, '');
  return raw.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === bare;
  });
}

/**
 * Sends a precomputed body: 304 when the client already has it, else the cached JSON in the best encoding the
 * client accepts (compressed once per body, never per request).
 */
export async function sendHot(
  request: FastifyRequest,
  reply: FastifyReply,
  body: HotBody,
  cacheControl: string,
  /** Extra request headers the response varies by (e.g. `authorization`). */
  vary: readonly string[] = [],
): Promise<FastifyReply> {
  reply
    .header('etag', body.etag)
    .header('cache-control', cacheControl)
    .header('vary', ['accept-encoding', ...vary].join(', '));
  if (etagMatches(request.headers['if-none-match'], body.etag)) return reply.code(304).send();
  const encoding = body.compressible ? negotiateEncoding(request.headers['accept-encoding']) : 'identity';
  const payload = await body.encoded(encoding);
  reply.header('content-type', 'application/json; charset=utf-8');
  if (encoding !== 'identity') reply.header('content-encoding', encoding);
  return reply.send(payload);
}

/**
 * Conditional GET for every other JSON response: a weak ETag over the serialized body, and 304 when it matches
 * If-None-Match. Saves the transfer (and the compression) of unchanged per-user data such as My Team live.
 * Registered before @fastify/compress, so it hashes the JSON, not a compressed stream.
 */
export function registerConditionalGet(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' || reply.statusCode !== 200) return payload;
    if (reply.getHeader('etag') !== undefined) return payload;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    const type = String(reply.getHeader('content-type') ?? '');
    if (!type.startsWith('application/json')) return payload;
    const etag = `W/"${createHash('sha1').update(payload).digest('base64url')}"`;
    reply.header('etag', etag);
    if (reply.getHeader('cache-control') === undefined) reply.header('cache-control', CACHE_CONTROL.private);
    if (etagMatches(request.headers['if-none-match'], etag)) {
      reply.code(304);
      reply.removeHeader('content-type');
      reply.removeHeader('content-length');
      return '';
    }
    return payload;
  });
}
