import type { PrismaClient } from '@prisma/client';
import type { FplService } from '@fant/fpl';
import type { IntegrationContext } from '@fant/integrations';
import type { IntegrationFactories } from './integrations/factories.js';
import type { MediaUrlMapper } from './media/publicUrl.js';
import type { MediaStore } from './media/store.js';
import type { PushProvider } from './push/provider.js';
import type { PushBatchRecorder } from './push/stats.js';

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
  /** Requests per window for other writes (push subscriptions/devices, likes, reports; per user when signed in). */
  writeMax: number;
  timeWindowMs: number;
  /** Community posts per user per hour. */
  postsPerHour: number;
  /** Community comments per user per hour. */
  commentsPerHour: number;
  /** Image uploads per user per hour. */
  uploadsPerHour: number;
  /** Admin live broadcasts per admin per hour. */
  broadcastsPerHour: number;
  /** Admin invite links created per admin per hour. */
  invitesPerHour: number;
  /** POST /v1/push/test per user per 10 minutes. */
  pushTestsPer10Min: number;
}

export interface MetaAppConfig {
  appId: string;
  appSecret: string;
}

export interface AppConfig {
  /** Allowed CORS origins; ["*"] allows any (refused in production by env validation). */
  corsOrigins: string[];
  /** 32-byte AES-256-GCM key (SECRETS_KEY). */
  secretsKey: Buffer;
  trustProxy?: boolean;
  rateLimit?: Partial<RateLimitConfig>;
  /** Guards POST /internal/jobs/tick; unset → 503. */
  cronSecret?: string | null;
  /** VAPID public key served to browsers; unset → push disabled (503 on the key route). */
  vapidPublicKey?: string | null;
  /** Meta app for the Instagram OAuth connect flow; unset → 503 on connect-url. */
  meta?: MetaAppConfig | null;
  /** Public base URL of this API (OAuth redirect URI). */
  apiPublicUrl?: string | null;
  /** Public base URL of the web app (OAuth callback redirects here). */
  webAppUrl?: string | null;
  /** Base of the URLs the MediaStore returns (S3_PUBLIC_BASE_URL), as stored in the DB. */
  mediaOriginBaseUrl?: string | null;
  /**
   * Base clients load media from (MEDIA_PUBLIC_BASE_URL, the web app's cached `/media` rewrite). Stored URLs under
   * `mediaOriginBaseUrl` are served under this base instead. Unset → stored URLs are served as-is.
   */
  mediaPublicBaseUrl?: string | null;
}

/** Everything a route or job needs. Built once in buildApp and passed to each module. */
export interface AppContext {
  prisma: PrismaClient;
  fpl: FplService;
  clock: Clock;
  config: AppConfig;
  /** @fant/integrations entry points (fakes in tests). */
  integrations: IntegrationFactories;
  /** `{ fetch, now }` handed to every integration call. */
  integrationCtx: IntegrationContext;
  /** fetch used to download media for re-hosting. */
  fetch: typeof fetch;
  /** null when VAPID isn't configured: notifications are skipped. */
  push: PushProvider | null;
  /** Recent notification batches (in memory) + one log line per batch. */
  pushStats: PushBatchRecorder;
  media: MediaStore;
  /** Stored media URL → client URL (see media/publicUrl.ts). Every serializer of a media URL uses it. */
  mediaUrl: MediaUrlMapper;
}
