import { FplUnavailableError, type FplHealth, type FplUnavailableKind } from './service.js';

export interface FplBackoffOptions {
  now: () => number;
  /** First wait after a backoff-worthy failure; doubles per consecutive failure. Default 5 s. */
  baseMs?: number;
  /** Cap on the wait. Default 2 min. */
  maxMs?: number;
}

/** Failures that mean "FPL as a whole is unavailable to us right now" — worth backing off for. */
const BACKOFF_KINDS: ReadonlySet<FplUnavailableKind> = new Set(['updating', 'rate_limited', 'network']);
const BACKOFF_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * One circuit for the whole FPL host (its rate limit is per client IP and its 503 "The game is being
 * updated" window is global). After a 429 / 502 / 503 / 504 / network failure FPL is not called again
 * until an exponential backoff (base × 2^(n−1), capped; at least the server's Retry-After) has elapsed:
 * callers fail fast with `FplUnavailableError(kind 'backoff')` and the caches answer with their last good
 * value. Any successful response (2xx or 404) closes the circuit.
 */
export class FplBackoff {
  private readonly now: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private failures = 0;
  private retryAt = 0;
  private failingSince: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: { error: FplUnavailableError; at: number } | null = null;

  constructor(options: FplBackoffOptions) {
    this.now = options.now;
    this.baseMs = options.baseMs ?? 5_000;
    this.maxMs = options.maxMs ?? 2 * 60_000;
  }

  /** Throws instead of letting a request through while backing off. */
  check(path: string): void {
    if (this.now() < this.retryAt) {
      const last = this.lastError?.error;
      throw new FplUnavailableError(
        `FPL backoff until ${new Date(this.retryAt).toISOString()} (${path})`,
        last?.status ?? null,
        'backoff',
      );
    }
  }

  /** In FPL's update window (the last failure was "The game is being updated"). */
  get updating(): boolean {
    return this.failingSince !== null && this.lastError?.error.kind === 'updating';
  }

  onSuccess(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.failingSince = null;
    this.lastSuccessAt = this.now();
  }

  onFailure(error: FplUnavailableError): void {
    if (error.kind === 'backoff') return;
    const t = this.now();
    this.lastError = { error, at: t };
    const backoff =
      BACKOFF_KINDS.has(error.kind) || (error.status !== null && BACKOFF_STATUSES.has(error.status));
    if (!backoff) return;
    this.failingSince ??= t;
    this.failures++;
    const wait = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(this.failures - 1, 20));
    this.retryAt = t + Math.max(wait, error.retryAfterMs ?? 0);
  }

  health(): FplHealth {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const failing = this.failingSince !== null;
    const last = this.lastError;
    return {
      state: !failing ? 'ok' : this.updating ? 'updating' : 'degraded',
      stale: failing,
      lastSuccessAt: iso(this.lastSuccessAt),
      failingSince: iso(this.failingSince),
      retryAt: this.now() < this.retryAt ? iso(this.retryAt) : null,
      lastError: last
        ? {
            kind: last.error.kind,
            status: last.error.status,
            message: last.error.message,
            at: new Date(last.at).toISOString(),
          }
        : null,
    };
  }
}
