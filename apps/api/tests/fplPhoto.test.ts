import type { FastifyInstance } from 'fastify';
import type { FakeFplService } from './fakeFpl.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHOTO_MAX_BYTES } from '../src/fplPhoto.js';
import { bearer, buildTestApp, createTestPrisma, migrateTestDb, registerUser, resetDb } from './helpers.js';

const UPSTREAM = 'https://resources.premierleague.com/premierleague25/photos/players/110x140/';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  fetchMock = vi.fn<typeof fetch>();
  ({ app, fpl } = await buildTestApp(prisma, { fetch: fetchMock }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const png = () =>
  new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });

describe('GET /v1/fpl/photo/:code', () => {
  it('proxies the photo bytes with public, immutable, CORS-open headers', async () => {
    fetchMock.mockResolvedValue(png());
    for (const code of ['223094', '223094.png']) {
      const res = await app.inject({ method: 'GET', url: `/v1/fpl/photo/${code}` });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PNG)).toBe(true);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=604800, s-maxage=604800, immutable');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(String(res.headers.vary ?? '')).not.toMatch(/authorization/i);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${UPSTREAM}223094.png`);
  });

  it('is the same for a signed-in user (never per-user / private)', async () => {
    fetchMock.mockResolvedValue(png());
    const { token } = await registerUser(app, fpl, 1001);
    const res = await app.inject({ method: 'GET', url: '/v1/fpl/photo/1', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=604800, s-maxage=604800, immutable');
    expect(String(res.headers.vary ?? '')).not.toMatch(/authorization/i);
  });

  it('serves a repeat request from the in-memory cache (one upstream fetch)', async () => {
    fetchMock.mockImplementation(async () => png());
    const a = await app.inject({ method: 'GET', url: '/v1/fpl/photo/42' });
    const b = await app.inject({ method: 'GET', url: '/v1/fpl/photo/42.png' });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.rawPayload.equals(PNG)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['abc', '12a', '12345678901', '1.jpg', '..%2F1', '1.png.png', '%20123'])(
    'rejects code %s with 400 and never fetches',
    async (code) => {
      const res = await app.inject({ method: 'GET', url: `/v1/fpl/photo/${code}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'bad_request' } });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('upstream 404 → 404 with a short public cache', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    const res = await app.inject({ method: 'GET', url: '/v1/fpl/photo/999' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(res.headers['cache-control']).toBe('public, max-age=3600, s-maxage=3600');
  });

  it.each([
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['upstream 500', () => Promise.resolve(new Response('boom', { status: 500 }))],
    [
      'non-image content-type',
      () =>
        Promise.resolve(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    ],
    [
      'body over 1 MB',
      () =>
        Promise.resolve(
          new Response(new Uint8Array(PHOTO_MAX_BYTES + 1), { headers: { 'content-type': 'image/png' } }),
        ),
    ],
  ] as const)('%s → 502 no-store, and is not cached', async (_name, impl) => {
    fetchMock.mockImplementation(impl);
    const res = await app.inject({ method: 'GET', url: '/v1/fpl/photo/7' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
    expect(res.headers['cache-control']).toBe('no-store');

    fetchMock.mockResolvedValue(png());
    const retry = await app.inject({ method: 'GET', url: '/v1/fpl/photo/7' });
    expect(retry.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes an abort signal (timeout) to the upstream fetch', async () => {
    fetchMock.mockResolvedValue(png());
    await app.inject({ method: 'GET', url: '/v1/fpl/photo/5' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
