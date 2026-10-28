import {
  ApiErrorSchema,
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
  PublicConfigSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeBootstrap, makePicks, upstreamDown, type FakeFplService } from './fakeFpl.js';
import { buildTestApp, createTestPrisma, migrateTestDb, resetDb } from './helpers.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl } = await buildTestApp(prisma));
  fpl.addEntry(42, 'Proxy FC');
  fpl.picks.set('42:9', makePicks(42, 9, 1));
  fpl.picks.set('42:3', makePicks(42, 3, 2));
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('FPL proxy routes', () => {
  it('GET /v1/fpl/bootstrap', async () => {
    const res = await get('/v1/fpl/bootstrap');
    expect(res.statusCode).toBe(200);
    expect(BootstrapSchema.parse(res.json()).players).toHaveLength(4);
  });

  it('GET /v1/fpl/fixtures defaults to the current GW and accepts ?event=', async () => {
    expect(z.array(FixtureSchema).parse((await get('/v1/fpl/fixtures')).json())[0]?.event).toBe(9);
    expect(z.array(FixtureSchema).parse((await get('/v1/fpl/fixtures?event=12')).json())[0]?.event).toBe(12);
    expect(z.array(FixtureSchema).parse((await get('/v1/fpl/fixtures?event=')).json())[0]?.event).toBe(9);
    expect((await get('/v1/fpl/fixtures?event=39')).statusCode).toBe(400);
  });

  it('GET /v1/fpl/entries/:entryId (+ 404 unknown, 400 invalid)', async () => {
    const res = await get('/v1/fpl/entries/42');
    expect(EntrySummarySchema.parse(res.json()).teamName).toBe('Proxy FC');
    const missing = await get('/v1/fpl/entries/43');
    expect(missing.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(missing.json()).error.code).toBe('not_found');
    expect((await get('/v1/fpl/entries/abc')).statusCode).toBe(400);
    expect((await get('/v1/fpl/entries/0')).statusCode).toBe(400);
  });

  it('GET /v1/fpl/entries/:entryId/picks defaults to current GW', async () => {
    expect(EntryPicksSchema.parse((await get('/v1/fpl/entries/42/picks')).json()).event).toBe(9);
    expect(EntryPicksSchema.parse((await get('/v1/fpl/entries/42/picks?event=3')).json()).event).toBe(3);
    expect((await get('/v1/fpl/entries/42/picks?event=nope')).statusCode).toBe(400);
  });

  it('GET /v1/fpl/entries/:entryId/live uses next GW before the season starts', async () => {
    fpl.bootstrap = makeBootstrap(null, 1);
    expect(EntryLiveSchema.parse((await get('/v1/fpl/entries/42/live')).json()).event).toBe(1);
  });

  it('404s when there is no current or next GW', async () => {
    fpl.bootstrap = makeBootstrap(null, null);
    expect((await get('/v1/fpl/entries/42/live')).statusCode).toBe(404);
  });

  it.each([
    '/v1/fpl/bootstrap',
    '/v1/fpl/fixtures',
    '/v1/fpl/entries/42',
    '/v1/fpl/entries/42/picks?event=9',
  ])('%s → 503 upstream_unavailable when FPL is down', async (url) => {
    fpl.failAll = upstreamDown();
    const res = await get(url);
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('upstream_unavailable');
  });

  it('register → 503 when FPL is down (no account created)', async () => {
    fpl.failAll = upstreamDown();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Roey', entryId: 42 },
    });
    expect(res.statusCode).toBe(503);
    expect(await prisma.user.count()).toBe(0);
  });
});

describe('public misc', () => {
  it('GET /health', async () => {
    const res = await get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /v1/config with defaults', async () => {
    const config = PublicConfigSchema.parse((await get('/v1/config')).json());
    expect(config).toEqual({
      league: null,
      captainBattleEvent: null,
      // Derived from the integrations' defaults (tests/socials.test.ts covers the rules).
      socials: {
        spotifyUrl: 'https://open.spotify.com/show/4sYY0tpz7M8gflimZAglHi',
        appleUrl: 'https://podcasts.apple.com/podcast/id1819558192',
        instagramUrl: 'https://www.instagram.com/fantasyonerimfpl/',
        xUrl: null,
        whatsappUrl: null,
      },
    });
  });

  it('unknown routes → ApiError 404', async () => {
    const res = await get('/v1/nope');
    expect(res.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('not_found');
  });

  it('CORS allows configured origins only', async () => {
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const evil = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
