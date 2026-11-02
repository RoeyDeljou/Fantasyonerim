import type { FplService } from '@fant/fpl';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth/bootstrapAdmin.js';
import { parseOrigins, type Env } from './env.js';
import { createFplFromEnv } from './fpl.js';
import { ensureIntegrationRows, seedIntegrationSecrets } from './integrations/store.js';
import { JobScheduler } from './jobs/runner.js';
import { mediaUrlConfigFromEnv } from './media/publicUrl.js';
import { LocalDiskMediaStore, S3MediaStore, type MediaStore } from './media/store.js';
import { startRuntimeMonitor } from './perf/runtime.js';
import { WebPushProvider } from './push/provider.js';
import { devSecretsKey, parseSecretsKey } from './secrets.js';

export interface StartServerOptions {
  env: Env;
  /** Overrides the FplService picked from FPL_MODE (the load test injects a scaled demo league). */
  fpl?: (onWarn: (message: string) => void) => FplService;
  /** fetch for integrations + media downloads (the load test serves recorded feeds offline). */
  fetch?: typeof fetch;
}

export interface RunningServer {
  app: FastifyInstance;
  prisma: PrismaClient;
  shutdown(signal: string): Promise<void>;
}

/**
 * Boots the production server: Prisma, FplService, media store, push, first-boot seeding, HTTP listener, the
 * in-process job scheduler and the live pre-warmer. `src/server.ts` is the entry point; the load test
 * (`scripts/loadtest/`) calls this with a different FplService.
 */
export async function startServer({
  env,
  fpl: fplOverride,
  fetch: fetchOverride,
}: StartServerOptions): Promise<RunningServer> {
  const logger =
    env.NODE_ENV === 'development'
      ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
      : { level: env.LOG_LEVEL, redact: ['req.headers.authorization'] };
  // buildApp adds the safe `req` serializer (src/logging.ts): no query strings, no invite tokens in logged URLs.

  const prisma = new PrismaClient({ datasourceUrl: withPoolDefaults(env.DATABASE_URL, env.DB_POOL_SIZE) });
  // Non-fatal FPL data oddities go to the app logger (bound once the app exists).
  const fplWarn = (message: string): void => app.log.warn({ fpl: message }, 'FPL data warning');
  const fpl = fplOverride ? fplOverride(fplWarn) : createFplFromEnv(env, fplWarn);

  const apiPublicUrl = env.API_PUBLIC_URL ?? `http://localhost:${env.PORT}`;

  function createMediaStore(): MediaStore {
    if (
      env.MEDIA_STORE === 's3' &&
      env.S3_ENDPOINT &&
      env.S3_BUCKET &&
      env.S3_ACCESS_KEY_ID &&
      env.S3_SECRET_ACCESS_KEY &&
      env.S3_PUBLIC_BASE_URL
    ) {
      return new S3MediaStore({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        publicBaseUrl: env.S3_PUBLIC_BASE_URL,
      });
    }
    return new LocalDiskMediaStore(env.MEDIA_DIR, apiPublicUrl);
  }

  const vapid =
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
      ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT }
      : null;

  const pushLog = (statusCode: number | null, message: string): void =>
    app.log.warn({ statusCode, message }, 'web push send failed');

  const app: FastifyInstance = await buildApp({
    prisma,
    fpl,
    logger,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
    media: createMediaStore(),
    push:
      vapid === null
        ? null
        : new WebPushProvider(vapid, (statusCode, message) => pushLog(statusCode, message)),
    config: {
      corsOrigins: parseOrigins(env.CORS_ORIGINS),
      secretsKey: env.SECRETS_KEY ? parseSecretsKey(env.SECRETS_KEY) : devSecretsKey(),
      trustProxy: env.TRUST_PROXY,
      cronSecret: env.CRON_SECRET ?? null,
      vapidPublicKey: vapid?.publicKey ?? null,
      meta:
        env.META_APP_ID && env.META_APP_SECRET
          ? { appId: env.META_APP_ID, appSecret: env.META_APP_SECRET }
          : null,
      apiPublicUrl,
      webAppUrl: env.WEB_APP_URL ?? null,
      ...mediaUrlConfigFromEnv(env),
      keepAlive: { quietHours: env.DB_QUIET_HOURS },
    },
  });

  if (!vapid) app.log.warn('VAPID_* not set — push notifications are disabled');
  // Client defaults (podcast RSS + Apple enabled) exist from the first boot, so the feed fills by itself.
  await ensureIntegrationRows(prisma);
  // Deploy-time credentials (never committed) configure a fresh database without manual re-entry.
  const secretsKey = env.SECRETS_KEY ? parseSecretsKey(env.SECRETS_KEY) : devSecretsKey();
  const seeded = await seedIntegrationSecrets(prisma, secretsKey, {
    ...(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET
      ? { spotify: { clientId: env.SPOTIFY_CLIENT_ID, clientSecret: env.SPOTIFY_CLIENT_SECRET } }
      : {}),
  });
  if (seeded.length > 0) app.log.info({ seeded }, 'integration credentials seeded from env');

  if (!env.SECRETS_KEY) app.log.warn('SECRETS_KEY not set — using an insecure development key');

  const admin = await bootstrapAdmin(prisma, env.ADMIN_BOOTSTRAP_USERNAME, env.ADMIN_BOOTSTRAP_PASSWORD);
  if (admin === 'created')
    app.log.info({ username: env.ADMIN_BOOTSTRAP_USERNAME }, 'bootstrap admin created');

  const scheduler = new JobScheduler(app.jobs);
  const monitor = startRuntimeMonitor(app.log, () => ({ hot: app.hot.cache.size }));

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    scheduler.stop();
    app.hot.stop();
    monitor.stop();
    await app.close();
    await prisma.$disconnect();
  };

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ fplMode: env.FPL_MODE, jobs: env.JOBS_ENABLED, mediaStore: env.MEDIA_STORE }, 'api ready');

  if (env.JOBS_ENABLED) scheduler.start();
  // Keeps the live league / captain battle / fixtures warm while a fixture is in play (no-op otherwise).
  if (env.PREWARM_ENABLED) app.hot.start();
  return { app, prisma, shutdown };
}

/**
 * Prisma's default pool is `num_cpus * 2 + 1` connections, and on a shared host num_cpus is the machine's, not
 * the container's 0.1 CPU. The Neon pooler multiplexes connections anyway, so a small explicit pool is right:
 * enough to overlap a job with request queries. An explicit `connection_limit` in DATABASE_URL wins.
 */
export function withPoolDefaults(databaseUrl: string, poolSize: number): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', String(poolSize));
  return url.toString();
}
