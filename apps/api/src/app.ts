import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { ApiError, ApiErrorCode } from '@fant/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { createAuth } from './auth/session.js';
import { systemClock, type AppConfig, type AppContext, type Clock, type RateLimitConfig } from './context.js';
import { ApiHttpError } from './errors.js';
import { isFplNotFound, isFplUnavailable } from './fplErrors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { captainBattleRoutes } from './routes/captainBattle.js';
import { configRoutes } from './routes/config.js';
import { fplRoutes } from './routes/fpl.js';
import { leagueRoutes } from './routes/league.js';
import { meRoutes } from './routes/me.js';
import { formatZodIssues } from './validate.js';
import { realIntegrations, type IntegrationFactories } from './integrations/factories.js';
import { JOBS } from './jobs/index.js';
import { JobRunner } from './jobs/runner.js';
import type { Job } from './jobs/types.js';
import { LocalDiskMediaStore, type MediaStore } from './media/store.js';
import type { PushProvider } from './push/provider.js';
import { adminNewsRoutes } from './routes/adminNews.js';
import { integrationRoutes } from './routes/integrations.js';
import { internalRoutes } from './routes/internal.js';
import { newsRoutes } from './routes/news.js';
import { pushRoutes } from './routes/push.js';
import type { FplService } from '@fant/fpl';
import type { PrismaClient } from '@prisma/client';

declare module 'fastify' {
  interface FastifyInstance {
    /** Background job runner (scheduler, cron tick, admin "sync now"; tests call it directly). */
    jobs: JobRunner;
  }
}

export interface AppDeps {
  prisma: PrismaClient;
  fpl: FplService;
  config: AppConfig;
  clock?: Clock;
  logger?: FastifyServerOptions['logger'];
  /** Platform layer; defaults to the real @fant/integrations functions. Tests override pieces. */
  integrations?: Partial<IntegrationFactories>;
  /** fetch for integrations + media downloads (default: global fetch). */
  fetch?: typeof fetch;
  /** null/undefined = push disabled (no VAPID keys). */
  push?: PushProvider | null;
  /** Default: LocalDiskMediaStore in ./.media. */
  media?: MediaStore;
  /** Job registry override (tests). */
  jobs?: readonly Job[];
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = { globalMax: 600, authMax: 10, writeMax: 30, timeWindowMs: 60_000 };

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

function body(code: ApiErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

function statusOf(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const status = (err as { statusCode: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const clock = deps.clock ?? systemClock;
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const ctx: AppContext = {
    prisma: deps.prisma,
    fpl: deps.fpl,
    clock,
    config: deps.config,
    integrations: { ...realIntegrations, ...deps.integrations },
    integrationCtx: { fetch: fetchImpl, now: () => clock.now().getTime() },
    fetch: fetchImpl,
    push: deps.push ?? null,
    media: deps.media ?? new LocalDiskMediaStore('./.media', deps.config.apiPublicUrl ?? 'http://localhost:4000'),
  };
  const limits: RateLimitConfig = { ...DEFAULT_RATE_LIMIT, ...deps.config.rateLimit };

  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.config.trustProxy ?? false,
    bodyLimit: 256 * 1024,
  });

  // Accept an empty JSON body (e.g. POST /v1/auth/logout from a fetch wrapper that always sets the header).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, raw, done) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text) as unknown);
    } catch {
      done(new ApiHttpError(400, 'bad_request', 'Request body is not valid JSON'), undefined);
    }
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiHttpError) {
      return reply.code(err.statusCode).send(body(err.code, err.message));
    }
    if (err instanceof ZodError) {
      return reply.code(400).send(body('bad_request', formatZodIssues(err.issues)));
    }
    if (isFplNotFound(err)) {
      return reply.code(404).send(body('not_found', 'That FPL resource does not exist'));
    }
    if (isFplUnavailable(err)) {
      request.log.warn({ err }, 'FPL upstream unavailable');
      return reply
        .code(503)
        .send(
          body('upstream_unavailable', 'Fantasy Premier League is not responding right now. Try again soon.'),
        );
    }
    const status = statusOf(err);
    if (status !== null && status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : 'Bad request';
      return reply.code(status).send(body(STATUS_CODES[status] ?? 'bad_request', message));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send(body('internal', 'Something went wrong on our side'));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(body('not_found', `Route ${request.method} ${request.url.split('?')[0]} not found`));
  });

  const origins = deps.config.corsOrigins;
  await app.register(cors, {
    origin: origins.includes('*') ? true : origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86_400,
  });

  await app.register(rateLimit, {
    global: true,
    max: limits.globalMax,
    timeWindow: limits.timeWindowMs,
    errorResponseBuilder: (_request, context) =>
      new ApiHttpError(429, 'rate_limited', `Too many requests — try again in ${context.after}`),
  });

  const auth = createAuth(ctx);
  const strictLimit = { max: limits.authMax, timeWindow: limits.timeWindowMs };
  const writeLimit = { max: limits.writeMax, timeWindow: limits.timeWindowMs };
  const jobs = new JobRunner(ctx, deps.jobs ?? JOBS, app.log);
  app.decorate('jobs', jobs);

  configRoutes(app, ctx);
  authRoutes(app, ctx, auth, strictLimit);
  meRoutes(app, ctx, auth);
  fplRoutes(app, ctx);
  leagueRoutes(app, ctx);
  captainBattleRoutes(app, ctx, auth);
  adminRoutes(app, ctx, auth);
  newsRoutes(app, ctx);
  pushRoutes(app, ctx, auth, writeLimit);
  integrationRoutes(app, ctx, auth, jobs);
  adminNewsRoutes(app, ctx, auth);
  internalRoutes(app, ctx, jobs);

  return app;
}
