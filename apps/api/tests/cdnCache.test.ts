import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicConfigSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_CONTROL } from '../src/perf/http.js';
import type { FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
} from './helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const API_ORIGIN = 'https://fantasyonerim-api.onrender.com';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl } = await buildTestApp(prisma));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const sMaxAge = (cc: string) => Number(/s-maxage=(\d+)/.exec(cc)?.[1] ?? NaN);

describe('CDN-cacheable public JSON (config, bootstrap)', () => {
  it('both carry s-maxage + stale-while-revalidate (config 30 s, bootstrap 60 s), public, with an ETag', async () => {
    const config = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(config.headers['cache-control']).toBe(
      'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    );
    const bootstrap = await app.inject({ method: 'GET', url: '/v1/fpl/bootstrap' });
    expect(bootstrap.headers['cache-control']).toBe(
      'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
    );
    for (const res of [config, bootstrap]) {
      expect(res.headers.etag).toBeDefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(String(res.headers.vary ?? '')).not.toMatch(/authorization|cookie/i);
    }
  });

  it('never vary by user: guest, fan and admin get the same bytes; config has only public fields', async () => {
    fpl.leagues.set(314, { id: 314, name: 'Fantasyonerim League' });
    const admin = await adminToken(app, prisma);
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings',
      headers: bearer(admin),
      payload: {
        leagueId: 314,
        leagueCode: 'AB12CD',
        deadlineReminderMinutes: [1440, 120],
        socials: { spotifyUrl: null, appleUrl: null, instagramUrl: null, xUrl: null, whatsappUrl: null },
      },
    });
    const fan = await registerUser(app, fpl, 901);
    for (const url of ['/v1/config', '/v1/fpl/bootstrap']) {
      const views = await Promise.all(
        [undefined, fan.token, admin].map((token) =>
          app.inject({ method: 'GET', url, headers: token === undefined ? {} : bearer(token) }),
        ),
      );
      expect(new Set(views.map((v) => v.body)).size, url).toBe(1);
      expect(new Set(views.map((v) => v.headers.etag)).size, url).toBe(1);
      expect(new Set(views.map((v) => v.headers['cache-control'])).size, url).toBe(1);
    }
    const config = (await app.inject({ method: 'GET', url: '/v1/config' })).json() as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(['captainBattleEvent', 'league', 'leagueJoin', 'socials']);
    expect(Object.keys(PublicConfigSchema.shape).sort()).toEqual(Object.keys(config).sort());
  });
});

interface VercelConfig {
  trailingSlash?: boolean;
  rewrites: { source: string; destination: string }[];
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

describe('vercel.json: /cdn rewrites to the API, cached like /media', () => {
  const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as VercelConfig;
  const routes = [
    { path: '/v1/config', cc: CACHE_CONTROL.config },
    { path: '/v1/fpl/bootstrap', cc: CACHE_CONTROL.bootstrap },
  ];

  it.each(routes)('$path: rewritten with and without the trailing slash', ({ path }) => {
    for (const source of [`/cdn${path}`, `/cdn${path}/`]) {
      expect(vercel.rewrites).toContainEqual({ source, destination: `${API_ORIGIN}${path}` });
    }
  });

  it('vercel.json uses only exact /cdn header sources (Vercel rejects an optional "/?" and then skips every deploy)', () => {
    for (const h of vercel.headers.filter((x) => x.source.startsWith('/cdn'))) {
      expect(h.source, h.source).not.toMatch(/[?*+()]/);
    }
  });

  it.each(routes)('$path: rewrite caching on, CDN TTL = the API s-maxage', ({ path, cc }) => {
    for (const source of [`/cdn${path}`, `/cdn${path}/`]) {
      const rule = vercel.headers.find((h) => h.source === source);
      expect(rule, source).toBeDefined();
      const header = (key: string) =>
        rule!.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
      expect(header('x-vercel-enable-rewrite-caching')).toBe('1');
      const cdn = header('CDN-Cache-Control') ?? '';
      expect(Number(/max-age=(\d+)/.exec(cdn)?.[1])).toBe(sMaxAge(cc));
      expect(cdn).toMatch(/stale-while-revalidate=\d+/);
    }
    // Same mechanism as the media rewrite.
    expect(
      vercel.headers.some(
        (h) =>
          h.source.startsWith('/media/') &&
          h.headers.some((x) => x.key === 'x-vercel-enable-rewrite-caching'),
      ),
    ).toBe(true);
  });
});
