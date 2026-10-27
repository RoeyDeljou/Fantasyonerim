import { PrismaClient } from '@prisma/client';
import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth/bootstrapAdmin.js';
import { loadEnv, parseOrigins } from './env.js';
import { createFplFromEnv } from './fpl.js';
import { ensureIntegrationRows, seedIntegrationSecrets } from './integrations/store.js';
import { JobScheduler } from './jobs/runner.js';
import { LocalDiskMediaStore, S3MediaStore, type MediaStore } from './media/store.js';
import { WebPushProvider } from './push/provider.js';
import { devSecretsKey, parseSecretsKey } from './secrets.js';

const env = loadEnv();

const logger =
  env.NODE_ENV === 'development'
    ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
    : { level: env.LOG_LEVEL, redact: ['req.headers.authorization'] };

const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
const fpl = createFplFromEnv(env);

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

const app = await buildApp({
  prisma,
  fpl,
  logger,
  media: createMediaStore(),
  push:
    vapid === null ? null : new WebPushProvider(vapid, (statusCode, message) => pushLog(statusCode, message)),
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
  },
});

function pushLog(statusCode: number | null, message: string): void {
  app.log.warn({ statusCode, message }, 'web push send failed');
}

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
if (admin === 'created') app.log.info({ username: env.ADMIN_BOOTSTRAP_USERNAME }, 'bootstrap admin created');

const scheduler = new JobScheduler(app.jobs);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  scheduler.stop();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
// A socket that resets after its request already settled (seen with push services behind proxies) emits an
// error nobody can await. Such transport errors must not take the whole server down; anything else is a
// real bug, so log it and exit (the host restarts the process).
const TRANSIENT_SOCKET_ERRORS = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH']);
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code && TRANSIENT_SOCKET_ERRORS.has(err.code)) {
    app.log.warn({ code: err.code }, 'ignored stray socket error');
    return;
  }
  app.log.fatal({ err }, 'uncaught exception — exiting');
  process.exit(1);
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ fplMode: env.FPL_MODE, jobs: env.JOBS_ENABLED, mediaStore: env.MEDIA_STORE }, 'api ready');

if (env.JOBS_ENABLED) scheduler.start();
