import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Bodies smaller than this are sent uncompressed (headers would eat the saving). */
export const COMPRESS_THRESHOLD_BYTES = 1024;
/**
 * Brotli quality for cached bodies. Each body is compressed once per change (not per request), off the event loop
 * (libuv threadpool), so a mid quality is affordable; 5 is ~gzip-6 CPU with a smaller result.
 */
export const BROTLI_QUALITY = 5;
export const GZIP_LEVEL = 6;

export type Encoding = 'br' | 'gzip' | 'identity';

/** A serialized, validated response: one JSON body + its ETag, compressed lazily once per encoding. */
export class HotBody {
  readonly etag: string;
  private readonly variants = new Map<Exclude<Encoding, 'identity'>, Promise<Buffer>>();

  constructor(readonly json: Buffer) {
    // Weak: the same JSON is sent with different Content-Encodings.
    this.etag = `W/"${createHash('sha1').update(json).digest('base64url')}"`;
  }

  static of(value: unknown): HotBody {
    return new HotBody(Buffer.from(JSON.stringify(value), 'utf8'));
  }

  get compressible(): boolean {
    return this.json.length >= COMPRESS_THRESHOLD_BYTES;
  }

  /** The body for `encoding` (identity = the JSON itself). Compression runs in the threadpool, once. */
  encoded(encoding: Encoding): Promise<Buffer> {
    if (encoding === 'identity' || !this.compressible) return Promise.resolve(this.json);
    let pending = this.variants.get(encoding);
    if (pending === undefined) {
      pending =
        encoding === 'br'
          ? brotliAsync(this.json, {
              params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
                [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: this.json.length,
              },
            })
          : gzipAsync(this.json, { level: GZIP_LEVEL });
      this.variants.set(encoding, pending);
    }
    return pending;
  }

  /** Bytes held (JSON + finished compressed variants are roughly bounded by 2× the JSON). */
  get weight(): number {
    return this.json.length * 2;
  }
}

export interface HotPolicy {
  /** Served as-is while younger than this. */
  freshMs: number;
  /**
   * After `freshMs`, the stored body is still served (instantly) for this long while ONE background refresh runs —
   * no user request ever waits for a recomputation once a key is warm. Older than fresh + stale → the request waits.
   */
  staleMs: number;
  /** A failed refresh keeps serving the last good body for this long (FPL "game is being updated"). */
  staleIfErrorMs?: number;
}

interface Entry<T> {
  source: unknown;
  value: T;
  body: HotBody;
  storedAt: number;
}

export interface HotLoad<T> {
  /**
   * The upstream object the value is built from (e.g. FplService's cached Bootstrap). When a refresh returns the
   * identical object (===), the stored body is kept as is: no re-validation, re-serialization or re-compression.
   */
  source?: unknown;
  /** Builds the validated response value from the source (serialize(Schema, …)). Called only when it changed. */
  build: () => T | Promise<T>;
}

export interface HotCacheOptions {
  now: () => number;
  /** LRU bound on keys. */
  maxEntries?: number;
  /** LRU bound on bytes held (JSON + compressed copies). */
  maxBytes?: number;
  onError?: (key: string, err: unknown) => void;
}

/** The value + serialized body for a key, and whether this read was answered from a stored body. */
export interface HotResult<T> {
  value: T;
  body: HotBody;
  hit: boolean;
}

/**
 * Shared, precomputed hot responses. Everybody polling the same data (live league pages, fixtures, captain
 * battle, config, news page 1) shares one computation per TTL: concurrent misses wait on a single in-flight
 * load, a stale key is served immediately while one background refresh runs, and the JSON is serialized,
 * hashed (ETag) and compressed once per change instead of once per request.
 */
export class HotCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<Entry<unknown>>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly onError: (key: string, err: unknown) => void;
  private bytes = 0;

  constructor(options: HotCacheOptions) {
    this.now = options.now;
    this.maxEntries = options.maxEntries ?? 1000;
    this.maxBytes = options.maxBytes ?? 48 * 1024 * 1024;
    this.onError = options.onError ?? (() => undefined);
  }

  async get<T>(key: string, policy: HotPolicy, load: () => Promise<HotLoad<T>>): Promise<HotResult<T>> {
    const stored = this.entries.get(key) as Entry<T> | undefined;
    const age = stored === undefined ? Infinity : this.now() - stored.storedAt;
    if (stored !== undefined && age < policy.freshMs) {
      this.touch(key, stored);
      return { value: stored.value, body: stored.body, hit: true };
    }
    if (stored !== undefined && age < policy.freshMs + policy.staleMs) {
      this.touch(key, stored);
      this.refresh(key, load, stored).catch((err: unknown) => this.onError(key, err));
      return { value: stored.value, body: stored.body, hit: true };
    }
    try {
      const entry = (await this.refresh(key, load, stored)) as Entry<T>;
      return { value: entry.value, body: entry.body, hit: false };
    } catch (err) {
      const fallback = this.entries.get(key) as Entry<T> | undefined;
      if (fallback !== undefined && this.now() - fallback.storedAt < (policy.staleIfErrorMs ?? 0)) {
        this.onError(key, err);
        return { value: fallback.value, body: fallback.body, hit: true };
      }
      throw err;
    }
  }

  /** Age of a key in ms, or null. */
  ageOf(key: string): number | null {
    const e = this.entries.get(key);
    return e === undefined ? null : this.now() - e.storedAt;
  }

  /** Drops every key starting with `prefix` (admin edits, ingested news). */
  invalidate(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.drop(key);
    }
  }

  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  private refresh<T>(key: string, load: () => Promise<HotLoad<T>>, previous: Entry<T> | undefined) {
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending as Promise<Entry<T>>;
    const promise = (async (): Promise<Entry<T>> => {
      try {
        const loaded = await load();
        const current = (this.entries.get(key) as Entry<T> | undefined) ?? previous;
        if (current !== undefined && loaded.source !== undefined && loaded.source === current.source) {
          const kept: Entry<T> = { ...current, storedAt: this.now() };
          this.store(key, kept);
          return kept;
        }
        const value = await loaded.build();
        let body = HotBody.of(value);
        // Same bytes as before (a live table that didn't move): keep the old body and its compressed copies.
        if (current !== undefined && current.body.etag === body.etag) body = current.body;
        const entry: Entry<T> = { source: loaded.source, value, body, storedAt: this.now() };
        this.store(key, entry);
        return entry;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise as Promise<Entry<unknown>>);
    return promise;
  }

  private touch(key: string, entry: Entry<unknown>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private store(key: string, entry: Entry<unknown>): void {
    this.drop(key);
    this.entries.set(key, entry);
    this.bytes += entry.body.weight;
    while (this.entries.size > this.maxEntries || (this.bytes > this.maxBytes && this.entries.size > 1)) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
  }

  private drop(key: string): void {
    const e = this.entries.get(key);
    if (e === undefined) return;
    this.entries.delete(key);
    this.bytes -= e.body.weight;
  }
}
