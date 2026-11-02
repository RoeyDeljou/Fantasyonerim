import { FplUnavailableError } from './service.js';

interface Stored<T> {
  value: T;
  storedAt: number;
}

/** How long a value may be served, per read. */
export interface CachePolicy {
  /** Fresh for this long: served without touching FPL. Past it, a read waits for a refetch. */
  ttlMs: number;
  /**
   * Refresh-ahead (stale-while-revalidate inside the TTL): a hit at least this old is still served
   * immediately, and ONE background refetch is started (shared with any concurrent reader). With steady
   * traffic nobody ever waits for FPL. Defaults to `ttlMs` (off).
   */
  refreshAfterMs?: number;
  /**
   * When a refetch fails with FplUnavailableError (429, 5xx, network, bad body) a stored value up to this
   * old is served instead of failing. Defaults to the cache's `staleIfUnavailableMs`.
   */
  staleIfErrorMs?: number;
}

export interface TtlCacheOptions {
  now: () => number;
  /** Hard cap on stored keys; the least recently used key is evicted first. */
  maxEntries?: number;
  /** Default `CachePolicy.staleIfErrorMs`. */
  staleIfUnavailableMs?: number;
  /**
   * During FPL's update window ("The game is being updated", which can last hours) FPL data is frozen, so
   * the last good value of ANY resource is served up to this old. Default 12 h.
   */
  outageMaxStaleMs?: number;
  /** True while FPL is in its update window (e.g. `FplBackoff.updating`). */
  isOutage?: () => boolean;
}

/**
 * TTL + LRU cache with in-flight de-duplication, refresh-ahead and stale-on-error. Freshness is decided at
 * read time (`maxAgeMs` / policy per call), so different callers can accept different staleness for the
 * same key — e.g. picks are read with a short TTL by `getEntryPicks` (entry_history changes during a GW)
 * and a long TTL by the live engine (the picks themselves are immutable after the deadline).
 *
 * Values are stored by reference and never cloned: callers must treat them as immutable.
 */
export class TtlCache {
  private readonly store = new Map<string, Stored<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly staleIfUnavailableMs: number;
  private readonly outageMaxStaleMs: number;
  private readonly isOutage: () => boolean;

  constructor(options: TtlCacheOptions) {
    this.now = options.now;
    this.maxEntries = options.maxEntries ?? 5000;
    this.staleIfUnavailableMs = options.staleIfUnavailableMs ?? 60 * 60 * 1000;
    this.outageMaxStaleMs = options.outageMaxStaleMs ?? 12 * 60 * 60 * 1000;
    this.isOutage = options.isOutage ?? (() => false);
  }

  get<T>(key: string, maxAge: number | CachePolicy, load: () => Promise<T>): Promise<T> {
    const policy = typeof maxAge === 'number' ? { ttlMs: maxAge } : maxAge;
    const stored = this.store.get(key) as Stored<T> | undefined;
    if (stored && this.hit(key, stored, policy, load)) return Promise.resolve(stored.value);
    return this.load(key, policy, load, stored);
  }

  /**
   * Synchronous fast path of `get`: the stored value when it is fresh under `policy` (starting the same
   * refresh-ahead as `get`), else undefined — then call `get`. Saves a promise per hit in hot loops.
   */
  peek<T>(key: string, policy: CachePolicy, load: () => Promise<T>): T | undefined {
    const stored = this.store.get(key) as Stored<T> | undefined;
    return stored && this.hit(key, stored, policy, load) ? stored.value : undefined;
  }

  private hit<T>(key: string, stored: Stored<T>, policy: CachePolicy, load: () => Promise<T>): boolean {
    const age = this.now() - stored.storedAt;
    if (age >= policy.ttlMs) return false;
    // LRU: a hit makes the key most recently used.
    this.store.delete(key);
    this.store.set(key, stored);
    if (age >= (policy.refreshAfterMs ?? policy.ttlMs) && !this.inflight.has(key)) {
      this.load(key, policy, load, stored).catch(() => undefined);
    }
    return true;
  }

  /** Age in ms of the stored value, or null. */
  ageOf(key: string): number | null {
    const stored = this.store.get(key);
    return stored ? this.now() - stored.storedAt : null;
  }

  /** Number of stored keys. */
  get size(): number {
    return this.store.size;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }

  private load<T>(
    key: string,
    policy: CachePolicy,
    load: () => Promise<T>,
    stored: Stored<T> | undefined,
  ): Promise<T> {
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = (async (): Promise<T> => {
      try {
        const value = await load();
        this.set(key, value);
        return value;
      } catch (err) {
        if (err instanceof FplUnavailableError && stored) {
          const outage = err.kind === 'updating' || this.isOutage();
          const errorWindow = policy.staleIfErrorMs ?? this.staleIfUnavailableMs;
          const allowed = outage ? Math.max(errorWindow, this.outageMaxStaleMs) : errorWindow;
          // The newest value may have landed meanwhile (another key path); prefer what is stored now.
          const latest = (this.store.get(key) as Stored<T> | undefined) ?? stored;
          if (this.now() - latest.storedAt < allowed) return latest.value;
        }
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  private set(key: string, value: unknown): void {
    this.store.delete(key);
    this.store.set(key, { value, storedAt: this.now() });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }
}

/** A Map capped at `max` keys, evicting the least recently used (get/set both count as a use). */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Runs `fn` over `items` with at most `limit` concurrent calls, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
