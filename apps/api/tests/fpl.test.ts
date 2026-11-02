import {
  ApiErrorSchema,
  BootstrapSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureDetailSchema,
  FixtureSchema,
  PublicConfigSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDemoFplService } from '@fant/fpl';
import { buildApp } from '../src/app.js';
import { devSecretsKey } from '../src/secrets.js';
import { makeBootstrap, makeFixtureDetail, makePicks, upstreamDown, type FakeFplService } from './fakeFpl.js';
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
    '/v1/fpl/fixtures/100',
  ])('%s → 503 upstream_unavailable when FPL is down', async (url) => {
    fpl.failAll = upstreamDown();
    const res = await get(url);
    expect(res.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(res.json()).error.code).toBe('upstream_unavailable');
  });

  it('GET /v1/fpl/fixtures/:fixtureId → FixtureDetail, cache by fixture state, 404 unknown, 400 invalid', async () => {
    fpl.fixtureDetails.set(100, makeFixtureDetail(100));
    const res = await get('/v1/fpl/fixtures/100');
    expect(res.statusCode).toBe(200);
    const detail = FixtureDetailSchema.parse(res.json());
    expect(detail.fixture).toMatchObject({ id: 100, status: 'live' });
    expect(detail.players[0]).toMatchObject({ playerId: 1, points: 8 });
    expect(res.headers['cache-control']).toBe('public, max-age=15, stale-while-revalidate=15');

    const finished = makeFixtureDetail(101);
    fpl.fixtureDetails.set(101, { ...finished, fixture: { ...finished.fixture, status: 'finished' } });
    expect((await get('/v1/fpl/fixtures/101')).headers['cache-control']).toBe(
      'public, max-age=600, stale-while-revalidate=600',
    );
    const provisional = makeFixtureDetail(102);
    fpl.fixtureDetails.set(102, {
      ...provisional,
      fixture: { ...provisional.fixture, status: 'finished_provisional' },
    });
    expect((await get('/v1/fpl/fixtures/102')).headers['cache-control']).toBe(
      'public, max-age=15, stale-while-revalidate=15',
    );

    const missing = await get('/v1/fpl/fixtures/999');
    expect(missing.statusCode).toBe(404);
    expect(ApiErrorSchema.parse(missing.json()).error.code).toBe('not_found');
    expect(missing.headers['cache-control']).toBeUndefined();
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const r = await get(`/v1/fpl/fixtures/${bad}`);
      expect(r.statusCode, bad).toBe(400);
      expect(ApiErrorSchema.parse(r.json()).error.code).toBe('bad_request');
    }
  });

  it("GET /v1/fpl/fixtures/:fixtureId on the demo dataset: fixture 87 is live (62')", async () => {
    const demo = await buildApp({
      prisma,
      fpl: createDemoFplService(),
      config: { corsOrigins: ['http://localhost:3000'], secretsKey: devSecretsKey() },
    });
    try {
      const res = await demo.inject({ method: 'GET', url: '/v1/fpl/fixtures/87' });
      expect(res.statusCode).toBe(200);
      const detail = FixtureDetailSchema.parse(res.json());
      expect(detail.fixture).toMatchObject({ id: 87, event: 9, status: 'live', minutes: 62 });
      expect(detail.players.length).toBeGreaterThan(0);
      expect(detail.players.every((p) => p.minutes > 0)).toBe(true);
      expect(res.headers['cache-control']).toBe('public, max-age=15, stale-while-revalidate=15');

      const upcoming = await demo.inject({ method: 'GET', url: '/v1/fpl/fixtures/88' });
      const notStarted = FixtureDetailSchema.parse(upcoming.json());
      expect(notStarted.fixture.status).toBe('not_started');
      expect(notStarted.stats).toEqual([]);
      expect(notStarted.players).toEqual([]);
      expect(upcoming.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=30');

      const finished = await demo.inject({ method: 'GET', url: '/v1/fpl/fixtures/81' });
      expect(FixtureDetailSchema.parse(finished.json()).stats.length).toBeGreaterThan(0);
    } finally {
      await demo.close();
    }
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
