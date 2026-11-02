import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { COMPRESS_THRESHOLD_BYTES, HotBody, HotCache } from './hotCache.js';
import { etagMatches, negotiateEncoding } from './http.js';
import { isQuietHour, parseQuietHours } from './keepAlive.js';

function setup() {
  let now = 1_000_000;
  const errors: string[] = [];
  const cache = new HotCache({ now: () => now, onError: (key) => errors.push(key) });
  return { cache, errors, advance: (ms: number) => (now += ms) };
}

const POLICY = { freshMs: 10_000, staleMs: 60_000, staleIfErrorMs: 600_000 };

describe('HotCache', () => {
  it('computes once for concurrent misses and serves the stored body while fresh', async () => {
    const { cache } = setup();
    let loads = 0;
    const load = async () => {
      loads += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { build: () => ({ n: loads }) };
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.get('k', POLICY, load)));
    expect(loads).toBe(1);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect((await cache.get('k', POLICY, load)).hit).toBe(true);
    expect(loads).toBe(1);
  });

  it('stale-while-revalidate: a stale key answers at once and refreshes in the background, once', async () => {
    const { cache, advance } = setup();
    let version = 1;
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { build: () => ({ version }) };
    };
    await cache.get('k', POLICY, load);
    version = 2;
    advance(POLICY.freshMs + 1);
    const stale = await Promise.all([cache.get('k', POLICY, load), cache.get('k', POLICY, load)]);
    expect(stale.map((r) => r.value)).toEqual([{ version: 1 }, { version: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(loads).toBe(2);
    expect((await cache.get('k', POLICY, load)).value).toEqual({ version: 2 });
    // Past fresh + stale: the request waits for the new value.
    version = 3;
    advance(POLICY.freshMs + POLICY.staleMs + 1);
    expect((await cache.get('k', POLICY, load)).value).toEqual({ version: 3 });
  });

  it('keeps the body (no rebuild) when the source object is unchanged, and the old body when bytes match', async () => {
    const { cache, advance } = setup();
    const source = { a: 1 };
    let builds = 0;
    const first = await cache.get('k', POLICY, async () => ({
      source,
      build: () => (builds++, { ...source }),
    }));
    advance(POLICY.freshMs + POLICY.staleMs + 1);
    const second = await cache.get('k', POLICY, async () => ({
      source,
      build: () => (builds++, { ...source }),
    }));
    expect(builds).toBe(1);
    expect(second.body).toBe(first.body);
    advance(POLICY.freshMs + POLICY.staleMs + 1);
    const third = await cache.get('k', POLICY, async () => ({ source: { a: 1 }, build: () => ({ a: 1 }) }));
    expect(third.body).toBe(first.body); // same ETag → same body object (its compressed copies are reused)
  });

  it('serves the last good body while a refresh fails (within staleIfErrorMs), then throws', async () => {
    const { cache, advance, errors } = setup();
    await cache.get('k', POLICY, async () => ({ build: () => ({ ok: true }) }));
    advance(POLICY.freshMs + POLICY.staleMs + 1);
    const failing = async (): Promise<never> => {
      throw new Error('FPL is being updated');
    };
    expect((await cache.get('k', POLICY, failing)).value).toEqual({ ok: true });
    expect(errors).toEqual(['k']);
    advance(POLICY.staleIfErrorMs);
    await expect(cache.get('k', POLICY, failing)).rejects.toThrow('FPL is being updated');
  });

  it('is bounded (LRU by entries) and invalidates by prefix', async () => {
    let now = 0;
    const cache = new HotCache({ now: () => now, maxEntries: 3 });
    for (const k of ['a', 'b', 'c', 'd']) await cache.get(k, POLICY, async () => ({ build: () => ({ k }) }));
    expect(cache.size.entries).toBe(3);
    expect(cache.ageOf('a')).toBeNull();
    await cache.get('news:1', POLICY, async () => ({ build: () => 1 }));
    await cache.get('news:2', POLICY, async () => ({ build: () => 2 }));
    cache.invalidate('news:');
    expect(cache.ageOf('news:1')).toBeNull();
    expect(cache.ageOf('news:2')).toBeNull();
    now += 1;
    expect(cache.size.entries).toBe(1);
  });

  it('is bounded by bytes', async () => {
    const cache = new HotCache({ now: () => 0, maxBytes: 10_000 });
    for (let i = 0; i < 10; i += 1) {
      await cache.get(`k${i}`, POLICY, async () => ({ build: () => 'x'.repeat(2_000) }));
    }
    expect(cache.size.bytes).toBeLessThanOrEqual(10_000);
    expect(cache.ageOf('k9')).not.toBeNull();
  });
});

describe('HotBody', () => {
  it('compresses once per encoding, only above the threshold; ETag is the JSON hash', async () => {
    const big = HotBody.of({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `row ${i}` })) });
    expect(big.compressible).toBe(true);
    const br = await big.encoded('br');
    expect(br).toBe(await big.encoded('br'));
    expect(JSON.parse(brotliDecompressSync(br).toString())).toEqual(JSON.parse(big.json.toString()));
    expect(JSON.parse(gunzipSync(await big.encoded('gzip')).toString()).rows).toHaveLength(200);
    expect(br.length).toBeLessThan(big.json.length / 3);
    expect(big.etag).toBe(HotBody.of(JSON.parse(big.json.toString())).etag);

    const small = HotBody.of({ ok: true });
    expect(small.json.length).toBeLessThan(COMPRESS_THRESHOLD_BYTES);
    expect(await small.encoded('br')).toBe(small.json);
  });
});

describe('http helpers', () => {
  it('negotiates br > gzip > identity and honours q=0', () => {
    expect(negotiateEncoding('gzip, deflate, br')).toBe('br');
    expect(negotiateEncoding('gzip')).toBe('gzip');
    expect(negotiateEncoding('br;q=0, gzip;q=0.8')).toBe('gzip');
    expect(negotiateEncoding(undefined)).toBe('identity');
    expect(negotiateEncoding('identity')).toBe('identity');
  });

  it('matches If-None-Match weakly, in lists and with *', () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"x", W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('*', 'W/"abc"')).toBe(true);
    expect(etagMatches('W/"abd"', 'W/"abc"')).toBe(false);
    expect(etagMatches(undefined, 'W/"abc"')).toBe(false);
  });
});

describe('quiet hours (Israel time)', () => {
  it('parses HH-HH / off and handles windows that wrap midnight', () => {
    expect(parseQuietHours('02-07')).toEqual([2, 7]);
    expect(parseQuietHours('off')).toBeNull();
    expect(() => parseQuietHours('2am')).toThrow();
    // 2026-11-02 is winter time in Israel (UTC+2).
    const at = (utcHour: number) => new Date(Date.UTC(2026, 10, 2, utcHour, 30));
    expect(isQuietHour(at(0), [2, 7])).toBe(true); // 02:30 in Israel
    expect(isQuietHour(at(4), [2, 7])).toBe(true); // 06:30
    expect(isQuietHour(at(5), [2, 7])).toBe(false); // 07:30
    expect(isQuietHour(at(23), [2, 7])).toBe(false); // 01:30
    expect(isQuietHour(at(23), [22, 6])).toBe(true); // wraps midnight
    expect(isQuietHour(at(0), null)).toBe(false);
  });
});
