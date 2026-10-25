import { PrismaClient } from '@prisma/client';
import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth/bootstrapAdmin.js';
import { loadEnv, parseOrigins } from './env.js';
import { createFplFromEnv } from './fpl.js';
import { devSecretsKey, parseSecretsKey } from './secrets.js';

const env = loadEnv();

const logger =
  env.NODE_ENV === 'development'
    ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
    : { level: env.LOG_LEVEL, redact: ['req.headers.authorization'] };

const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
const fpl = createFplFromEnv(env);

const app = await buildApp({
  prisma,
  fpl,
  logger,
  config: {
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    secretsKey: env.SECRETS_KEY ? parseSecretsKey(env.SECRETS_KEY) : devSecretsKey(),
    trustProxy: env.TRUST_PROXY,
  },
});

if (!env.SECRETS_KEY) app.log.warn('SECRETS_KEY not set — using an insecure development key');

const admin = await bootstrapAdmin(prisma, env.ADMIN_BOOTSTRAP_USERNAME, env.ADMIN_BOOTSTRAP_PASSWORD);
if (admin === 'created') app.log.info({ username: env.ADMIN_BOOTSTRAP_USERNAME }, 'bootstrap admin created');

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info({ fplMode: env.FPL_MODE }, 'api ready');
