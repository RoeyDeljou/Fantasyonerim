/**
 * Same-origin-able FPL player photos for the admin "share captains" poster (drawn on a canvas, so the image must be
 * CORS-clean). Fixed upstream URL, digits only: this is not a generic proxy.
 */

export const PLAYER_PHOTO_URL = (code: string) =>
  `https://resources.premierleague.com/premierleague25/photos/players/110x140/${code}.png`;

export const PHOTO_TIMEOUT_MS = 5_000;
export const PHOTO_MAX_BYTES = 1024 * 1024;
export const PHOTO_CACHE_ENTRIES = 300;

export interface PlayerPhoto {
  bytes: Buffer;
  contentType: string;
}

export type PhotoResult =
  { kind: 'ok'; photo: PlayerPhoto } | { kind: 'not_found' } | { kind: 'failed'; reason: string };

export interface PlayerPhotoFetcher {
  get(code: string): Promise<PhotoResult>;
}

export function createPlayerPhotoFetcher(
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number; maxEntries?: number } = {},
): PlayerPhotoFetcher {
  const timeoutMs = options.timeoutMs ?? PHOTO_TIMEOUT_MS;
  const maxEntries = options.maxEntries ?? PHOTO_CACHE_ENTRIES;
  // Map iteration order = insertion order: re-inserting on hit makes the first key the least recently used.
  const cache = new Map<string, PlayerPhoto>();

  async function download(code: string): Promise<PhotoResult> {
    let res: Response;
    try {
      res = await fetchImpl(PLAYER_PHOTO_URL(code), { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return { kind: 'failed', reason: err instanceof Error ? err.name : 'fetch failed' };
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'not_found' };
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (res.status !== 200 || !contentType.startsWith('image/')) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'failed', reason: `HTTP ${res.status} ${contentType || 'no content-type'}` };
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (res.body === null || (Number.isFinite(declared) && declared > PHOTO_MAX_BYTES)) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'failed', reason: 'empty or too large' };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PHOTO_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { kind: 'failed', reason: 'too large' };
        }
        chunks.push(value);
      }
    } catch (err) {
      return { kind: 'failed', reason: err instanceof Error ? err.name : 'read failed' };
    }
    if (total === 0) return { kind: 'failed', reason: 'empty' };
    return { kind: 'ok', photo: { bytes: Buffer.concat(chunks, total), contentType } };
  }

  return {
    async get(code) {
      const hit = cache.get(code);
      if (hit !== undefined) {
        cache.delete(code);
        cache.set(code, hit);
        return { kind: 'ok', photo: hit };
      }
      const result = await download(code);
      if (result.kind === 'ok') {
        cache.set(code, result.photo);
        while (cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return result;
    },
  };
}
