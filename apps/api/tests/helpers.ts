import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthResponseSchema, type AuthResponse } from '@fant/shared';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig, Clock, RateLimitConfig } from '../src/context.js';
import type { IntegrationFactories } from '../src/integrations/factories.js';
import type { MediaStore } from '../src/media/store.js';
import type { PushProvider } from '../src/push/provider.js';
import { createAdmin } from '../src/routes/admin.js';
import { devSecretsKey } from '../src/secrets.js';
import { FakeFplService } from './fakeFpl.js';

// Integration tests hash with argon2 and hit a real Postgres; give them headroom on a busy machine.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 60_000 });

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://fant:fant@localhost:5432/fantasyonerim_test';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Applies pending migrations to the test DB (idempotent, cheap when up to date). */
export function migrateTestDb(): void {
  execFileSync(
    process.execPath,
    [resolve(API_DIR, '../../node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: 'pipe',
    },
  );
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ datasourceUrl: TEST_DATABASE_URL });
}

/** Empties every application table between tests. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export class TestClock implements Clock {
  private ms: number;
  constructor(start = Date.parse('2026-10-25T12:00:00.000Z')) {
    this.ms = start;
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface TestAppOptions {
  fpl?: FakeFplService;
  clock?: TestClock;
  rateLimit?: Partial<RateLimitConfig>;
  corsOrigins?: string[];
  integrations?: Partial<IntegrationFactories>;
  push?: PushProvider | null;
  media?: MediaStore;
  fetch?: typeof fetch;
  config?: Partial<AppConfig>;
}

export async function buildTestApp(prisma: PrismaClient, options: TestAppOptions = {}) {
  const fpl = options.fpl ?? new FakeFplService();
  const clock = options.clock ?? new TestClock();
  const app = await buildApp({
    prisma,
    fpl,
    clock,
    ...(options.integrations ? { integrations: options.integrations } : {}),
    ...(options.push !== undefined ? { push: options.push } : {}),
    ...(options.media ? { media: options.media } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    config: {
      corsOrigins: options.corsOrigins ?? ['http://localhost:3000'],
      secretsKey: devSecretsKey(),
      rateLimit: { globalMax: 10_000, authMax: 10_000, writeMax: 10_000, ...options.rateLimit },
      ...options.config,
    },
  });
  await app.ready();
  return { app, fpl, clock };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function registerUser(
  app: FastifyInstance,
  fpl: FakeFplService,
  entryId: number,
  name = `Fan ${entryId}`,
): Promise<AuthResponse> {
  if (!fpl.entries.has(entryId)) fpl.addEntry(entryId);
  const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { name, entryId } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return AuthResponseSchema.parse(res.json());
}

export async function adminToken(
  app: FastifyInstance,
  prisma: PrismaClient,
  username = 'admin',
  password = 'correct horse battery',
): Promise<string> {
  await createAdmin(prisma, { username, password, name: username });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/admin-login',
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`admin login failed: ${res.statusCode} ${res.body}`);
  return AuthResponseSchema.parse(res.json()).token;
}
