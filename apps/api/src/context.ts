import type { PrismaClient } from '@prisma/client';
import type { FplService } from '@fant/fpl';

/** Injected clock so tests control session expiry and timestamps. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface RateLimitConfig {
  /** Requests per window per IP for every route. */
  globalMax: number;
  /** Requests per window per IP for register / recover / admin-login. */
  authMax: number;
  timeWindowMs: number;
}

export interface AppConfig {
  /** Allowed CORS origins; ["*"] allows any (refused in production by env validation). */
  corsOrigins: string[];
  /** 32-byte AES-256-GCM key (SECRETS_KEY). */
  secretsKey: Buffer;
  trustProxy?: boolean;
  rateLimit?: Partial<RateLimitConfig>;
}

/** Everything a route needs. Built once in buildApp and passed to each route module. */
export interface AppContext {
  prisma: PrismaClient;
  fpl: FplService;
  clock: Clock;
  config: AppConfig;
}
