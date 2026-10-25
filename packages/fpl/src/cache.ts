import { FplUnavailableError } from './service.js';

interface Stored<T> {
  value: T;
  storedAt: number;
}

export interface TtlCacheOptions {
  now: () => number;
  /** Hard cap on stored keys; the oldest insertion is evicted first. */
  maxEntries?: number;
  /**
   * When the loader fails with FplUnavailableError (503 "game is being updated", 429, network) and a
   * value younger than this is stored, the stale value is served instead of failing.
   */
  staleIfUnavailableMs?: number;
}

/**
 * TTL cache with in-flight de-duplication. Freshness is decided at read time (`maxAgeMs` per call), so
 * different callers can accept different staleness for the same key — e.g. picks are read with a short
 * TTL by `getEntryPicks` (entry_history changes during a GW) and a long TTL by the live engine (the
 * picks themselves are immutable after the deadline).
 */
export class TtlCache {
  private readonly store = new Map<string, Stored<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly staleIfUnavailableMs: number;

  constructor(options: TtlCacheOptions) {
    this.now = options.now;
    this.maxEntries = options.maxEntries ?? 5000;
    this.staleIfUnavailableMs = options.staleIfUnavailableMs ?? 60 * 60 * 1000;
  }

  async get<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
    const stored = this.store.get(key) as Stored<T> | undefined;
    if (stored && this.now() - stored.storedAt < maxAgeMs) return stored.value;

    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = (async (): Promise<T> => {
      try {
        const value = await load();
        this.set(key, value);
        return value;
      } catch (err) {
        if (
          err instanceof FplUnavailableError &&
          stored &&
          this.now() - stored.storedAt < this.staleIfUnavailableMs
        ) {
          return stored.value;
        }
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Age in ms of the stored value, or null. */
  ageOf(key: string): number | null {
    const stored = this.store.get(key);
    return stored ? this.now() - stored.storedAt : null;
  }

  clear(): void {
    this.store.clear();
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
