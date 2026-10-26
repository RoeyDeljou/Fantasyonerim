import {
  IntegrationAuthError,
  IntegrationConfigError,
  type ConnectableInstagramAccount,
} from '@fant/integrations';
import { IntegrationListSchema, IntegrationStatusSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IntegrationFactories } from '../src/integrations/factories.js';
import { createOAuthState } from '../src/integrations/oauthState.js';
import { chooseInstagramAccount } from '../src/routes/integrations.js';
import { devSecretsKey } from '../src/secrets.js';
import { episode, fakeIntegrations, result } from './fakes.js';
import type { FakeFplService } from './fakeFpl.js';
import type { TestClock } from './helpers.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
} from './helpers.js';

const prisma = createTestPrisma();
const META = { appId: 'meta-app', appSecret: 'meta-secret' };
const API = 'https://api.fant.test';
const WEB = 'https://app.fant.test';

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let fakes: ReturnType<typeof fakeIntegrations>;
let accounts: ConnectableInstagramAccount[];
let connectError: Error | null;
let connectCalls: unknown[];
let admin: string;

function account(username: string, n: number): ConnectableInstagramAccount {
  return {
    pageId: `page-${n}`,
    pageName: `Page ${n}`,
    igUserId: `ig-${n}`,
    username,
    profilePictureUrl: null,
    accessToken: `token-${n}-SECRET`,
    expiresAt: null,
    dataAccessExpiresAt: new Date('2027-01-20T00:00:00Z'),
  };
}

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  fakes = fakeIntegrations();
  accounts = [account('pod_fantasyonerim', 1), account('fantasyonerimfpl', 2)];
  connectError = null;
  connectCalls = [];
  const factories: Partial<IntegrationFactories> = {
    ...fakes.factories,
    completeInstagramConnect: async (input) => {
      connectCalls.push(input);
      if (connectError !== null) throw connectError;
      return accounts;
    },
  };
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    integrations: factories,
    config: { meta: META, apiPublicUrl: API, webAppUrl: WEB },
  }));
  admin = await adminToken(app, prisma);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const ADMIN_ROUTES = [
  { method: 'GET', url: '/v1/admin/integrations' },
  { method: 'PUT', url: '/v1/admin/integrations/podcast_rss', payload: { enabled: true, settings: {} } },
  { method: 'POST', url: '/v1/admin/integrations/podcast_rss/sync' },
  { method: 'GET', url: '/v1/admin/integrations/instagram/connect-url' },
  { method: 'DELETE', url: '/v1/admin/integrations/instagram' },
  { method: 'POST', url: '/v1/admin/news', payload: { title: null, text: 'hi' } },
  { method: 'DELETE', url: '/v1/admin/news/abc' },
  { method: 'POST', url: '/v1/admin/push', payload: { title: 't', body: 'b' } },
] as const;

const list = async () =>
  IntegrationListSchema.parse(
    (await app.inject({ method: 'GET', url: '/v1/admin/integrations', headers: bearer(admin) })).json(),
  ).integrations;

const put = (id: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: `/v1/admin/integrations/${id}`,
    headers: bearer(admin),
    payload: payload as object,
  });

describe('admin-only enforcement', () => {
  it('every new admin route answers 401 without a token and 403 for a fan', async () => {
    const fan = await registerUser(app, fpl, 77);
    for (const route of ADMIN_ROUTES) {
      const anon = await app.inject({ ...route });
      expect(anon.statusCode, `${route.method} ${route.url}`).toBe(401);
      const user = await app.inject({ ...route, headers: bearer(fan.token) });
      expect(user.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });
});

describe('integration settings', () => {
  it('lists one row per integration with the client defaults', async () => {
    const rows = await list();
    expect(rows.map((r) => [r.id, r.enabled, r.configured, r.paidFeature])).toEqual([
      ['podcast_rss', true, true, false],
      ['spotify', true, false, false],
      ['apple', true, true, false],
      ['instagram', false, false, false],
      ['x', false, false, true],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.settings]));
    expect(byId).toEqual({
      podcast_rss: { rssUrl: 'https://anchor.fm/s/105778688/podcast/rss' },
      spotify: { showId: '4sYY0tpz7M8gflimZAglHi' },
      apple: { podcastId: '1819558192' },
      instagram: { igUserId: null, username: null, pageId: null },
      x: { username: 'fantasyonerim', userId: null },
    });
  });

  it('accepts secrets write-only: never returned, encrypted at rest', async () => {
    const res = await put('spotify', {
      enabled: true,
      settings: { showId: 'https://open.spotify.com/show/4sYY0tpz7M8gflimZAglHi?si=abc' },
      secrets: { clientId: 'spotify-client-id-XYZ', clientSecret: 'spotify-client-secret-XYZ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('XYZ');
    const status = IntegrationStatusSchema.parse(res.json());
    expect(status).toMatchObject({
      configured: true,
      hasSecret: true,
      settings: { showId: '4sYY0tpz7M8gflimZAglHi' },
    });
    const listed = await app.inject({ method: 'GET', url: '/v1/admin/integrations', headers: bearer(admin) });
    expect(listed.body).not.toContain('XYZ');
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'spotify' } });
    expect(row.secretsEnc).toMatch(/^v1\./);
    expect(row.secretsEnc).not.toContain('XYZ');

    // Blank keeps, null clears.
    const kept = await put('spotify', { enabled: true, settings: {}, secrets: { clientId: '' } });
    expect(kept.json().configured).toBe(true);
    const cleared = await put('spotify', { enabled: true, settings: {}, secrets: { clientSecret: null } });
    expect(cleared.json()).toMatchObject({ configured: false, hasSecret: true });
  });

  it('rejects invalid settings with field-specific messages', async () => {
    const cases: [string, unknown, RegExp][] = [
      ['podcast_rss', { enabled: true, settings: { rssUrl: 'ftp://nope' } }, /^settings\.rssUrl: /],
      ['spotify', { enabled: true, settings: { showId: 'https://example.com/x' } }, /^settings\.showId: /],
      ['apple', { enabled: true, settings: { podcastId: 'abc' } }, /^settings\.podcastId: /],
      ['x', { enabled: true, settings: { username: 'not a handle!' } }, /^settings\.username: /],
      ['apple', { enabled: true, settings: { colour: 'red' } }, /^settings\.colour: not a setting of apple/],
      [
        'spotify',
        { enabled: true, settings: {}, secrets: { password: 'x' } },
        /^secrets\.password: not a secret/,
      ],
      ['instagram', { enabled: true, settings: {}, secrets: { accessToken: 'x' } }, /Connect Instagram/],
      ['podcast_rss', { enabled: 'yes', settings: {} }, /enabled/],
      ['podcast_rss', {}, /enabled/],
      ['nope', { enabled: true, settings: {} }, /id/],
    ];
    for (const [id, body, message] of cases) {
      const res = await put(id, body);
      expect(res.statusCode, `${id} ${JSON.stringify(body)}`).toBe(400);
      expect(res.json().error.message).toMatch(message);
    }
    expect(
      (await app.inject({ method: 'POST', url: '/v1/admin/integrations/nope/sync', headers: bearer(admin) }))
        .statusCode,
    ).toBe(400);
  });

  it('normalizes values and ignores read-only settings', async () => {
    const res = await put('apple', {
      enabled: false,
      settings: { podcastId: 'https://podcasts.apple.com/il/podcast/x/id1819558192' },
    });
    expect(res.json()).toMatchObject({ enabled: false, settings: { podcastId: '1819558192' } });
    const ig = await put('instagram', {
      enabled: true,
      settings: { igUserId: 'hack', username: null, pageId: null },
    });
    expect(ig.statusCode).toBe(200);
    expect(ig.json().settings).toEqual({ igUserId: null, username: null, pageId: null });
  });

  it('resolves the X user id once when the bearer token is set', async () => {
    const res = await put('x', {
      enabled: true,
      settings: { username: '@Fantasyonerim' },
      secrets: { bearerToken: 'bearer-SECRET' },
    });
    expect(res.json()).toMatchObject({
      configured: true,
      accountLabel: '@Fantasyonerim',
      settings: { username: 'Fantasyonerim', userId: '4242' },
    });
    expect(res.body).not.toContain('bearer-SECRET');

    const failing: Partial<IntegrationFactories> = {
      ...fakes.factories,
      resolveXUser: async () => {
        throw new IntegrationAuthError('X rejected the bearer token.');
      },
    };
    const { app: other } = await buildTestApp(prisma, { integrations: failing });
    const otherAdmin = await adminToken(other, prisma, 'admin2');
    const bad = await other.inject({
      method: 'PUT',
      url: '/v1/admin/integrations/x',
      headers: bearer(otherAdmin),
      payload: { enabled: true, settings: {}, secrets: { bearerToken: 'new-token' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(
      /^secrets\.bearerToken: X rejected the credentials — check the keys/,
    );
    await other.close();
  });

  it('"sync now" runs the source and returns its fresh status', async () => {
    fakes.podcast.next = result([episode(1, new Date(clock.now().getTime() - 3_600_000))], {
      accountLabel: 'פנטזיונרים',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/integrations/podcast_rss/sync',
      headers: bearer(admin),
    });
    expect(IntegrationStatusSchema.parse(res.json())).toMatchObject({
      id: 'podcast_rss',
      itemsImported: 1,
      accountLabel: 'פנטזיונרים',
      lastError: null,
      lastSuccessAt: clock.now().toISOString(),
    });
  });
});

describe('instagram OAuth', () => {
  async function connectUrl(): Promise<URL> {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/integrations/instagram/connect-url',
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);
    return new URL(res.json().url);
  }

  const callback = (query: string) =>
    app.inject({ method: 'GET', url: `/v1/integrations/instagram/callback?${query}` });

  it('connect-url is 503 when the Meta app is not configured', async () => {
    const { app: bare } = await buildTestApp(prisma);
    const token = await adminToken(bare, prisma, 'admin3');
    const res = await bare.inject({
      method: 'GET',
      url: '/v1/admin/integrations/instagram/connect-url',
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });

  it('connects, preferring @fantasyonerimfpl, storing the token encrypted', async () => {
    const url = await connectUrl();
    expect(url.searchParams.get('redirect_uri')).toBe(`${API}/v1/integrations/instagram/callback`);
    const state = url.searchParams.get('state') ?? '';
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/admin/?instagram=connected`);
    expect(connectCalls).toEqual([
      { ...META, redirectUri: `${API}/v1/integrations/instagram/callback`, code: 'abc' },
    ]);

    const ig = (await list()).find((r) => r.id === 'instagram');
    expect(ig).toMatchObject({
      enabled: true,
      configured: true,
      hasSecret: true,
      accountLabel: '@fantasyonerimfpl',
      settings: { igUserId: 'ig-2', username: 'fantasyonerimfpl', pageId: 'page-2' },
      lastError: null,
      dataAccessExpiresAt: '2027-01-20T00:00:00.000Z',
    });
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'instagram' } });
    expect(row.secretsEnc).not.toContain('SECRET');
    expect(JSON.stringify(await list())).not.toContain('SECRET');

    // Disconnect forgets token + account.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/admin/integrations/instagram',
          headers: bearer(admin),
        })
      ).statusCode,
    ).toBe(204);
    expect((await list()).find((r) => r.id === 'instagram')).toMatchObject({
      enabled: false,
      configured: false,
      hasSecret: false,
      accountLabel: null,
    });
  });

  it('warns when the connected account is not the expected one', async () => {
    accounts = [account('someone_else', 5)];
    const state = (await connectUrl()).searchParams.get('state') ?? '';
    const res = await callback(`code=abc&state=${encodeURIComponent(state)}`);
    expect(res.headers.location).toBe(`${WEB}/admin/?instagram=connected&warning=unexpected_account`);
    const ig = (await list()).find((r) => r.id === 'instagram');
    expect(ig?.lastError).toMatch(/^Connected @someone_else — expected @fantasyonerimfpl/);
    expect(chooseInstagramAccount([account('a', 1), account('FantasyonerimFPL', 2)]).account.igUserId).toBe(
      'ig-2',
    );
  });

  it('rejects a tampered, expired, missing or non-admin state', async () => {
    const state = (await connectUrl()).searchParams.get('state') ?? '';
    const [body, mac] = state.split('.') as [string, string];
    const forged = `${Buffer.from(JSON.stringify({ u: 'x', n: 'nnnnnnnnnn', e: 9e15 })).toString('base64url')}.${mac}`;
    for (const [query, reason] of [
      [`code=abc&state=${body}.${mac.slice(0, -2)}xx`, 'invalid_state'],
      [`code=abc&state=${forged}`, 'invalid_state'],
      ['code=abc', 'invalid_state'],
    ] as const) {
      const res = await callback(query);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${WEB}/admin/?instagram=error&reason=${reason}`);
    }
    const fan = await registerUser(app, fpl, 88);
    const fanState = createOAuthState(devSecretsKey(), fan.user.id, clock.now().getTime());
    expect((await callback(`code=abc&state=${fanState}`)).headers.location).toMatch(/reason=invalid_state$/);

    clock.advance(11 * 60_000);
    expect((await callback(`code=abc&state=${encodeURIComponent(state)}`)).headers.location).toBe(
      `${WEB}/admin/?instagram=error&reason=expired_state`,
    );
    expect(connectCalls).toHaveLength(0);
  });

  it('reports a denied dialog or a failed exchange back to the admin page', async () => {
    const state = encodeURIComponent((await connectUrl()).searchParams.get('state') ?? '');
    expect(
      (await callback(`error=access_denied&error_reason=user_denied&state=${state}`)).headers.location,
    ).toBe(`${WEB}/admin/?instagram=error&reason=user_denied`);
    connectError = new IntegrationConfigError(
      'No Instagram professional account is linked to a Facebook Page',
    );
    expect((await callback(`code=abc&state=${state}`)).headers.location).toBe(
      `${WEB}/admin/?instagram=error&reason=no_instagram_account`,
    );
    expect((await list()).find((r) => r.id === 'instagram')?.lastError).toMatch(
      /No Instagram professional account/,
    );
  });
});
