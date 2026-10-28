import { AdminSettingsSchema, PublicConfigSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureIntegrationRows } from '../src/integrations/store.js';
import { adminToken, bearer, buildTestApp, createTestPrisma, migrateTestDb, resetDb } from './helpers.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let admin: string;

const SPOTIFY = 'https://open.spotify.com/show/4sYY0tpz7M8gflimZAglHi';
const APPLE = 'https://podcasts.apple.com/podcast/id1819558192';
const INSTAGRAM = 'https://www.instagram.com/fantasyonerimfpl/';

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app } = await buildTestApp(prisma));
  admin = await adminToken(app, prisma);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function publicSocials() {
  const res = await app.inject({ method: 'GET', url: '/v1/config' });
  expect(res.statusCode).toBe(200);
  return PublicConfigSchema.parse(res.json()).socials;
}

async function adminSocials() {
  const res = await app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(admin) });
  expect(res.statusCode).toBe(200);
  return AdminSettingsSchema.parse(res.json()).socials;
}

const DEFAULTS = {
  spotifyUrl: SPOTIFY,
  appleUrl: APPLE,
  instagramUrl: INSTAGRAM,
  xUrl: null,
  whatsappUrl: null,
};

describe('social links: defaults derived from the integrations', () => {
  it('an empty DB is prefilled (3 of 5) in the public config and the admin form', async () => {
    expect(await publicSocials()).toEqual(DEFAULTS);
    expect(await adminSocials()).toEqual(DEFAULTS);
    await ensureIntegrationRows(prisma); // same with the default rows present
    expect(await publicSocials()).toEqual(DEFAULTS);
  });

  it('a stored value overrides the default; clearing it brings the default back', async () => {
    const save = (socials: Record<string, string | null>) =>
      app.inject({
        method: 'PUT',
        url: '/v1/admin/settings',
        headers: bearer(admin),
        payload: {
          leagueId: null,
          deadlineReminderMinutes: [1440],
          socials: { ...DEFAULTS, ...socials },
        },
      });
    const custom = {
      spotifyUrl: 'https://open.spotify.com/show/0000000000000000000000',
      xUrl: 'https://x.com/Fantasyonerim',
    };
    const res = await save(custom);
    expect(res.statusCode, res.body).toBe(200);
    expect(AdminSettingsSchema.parse(res.json()).socials).toEqual({ ...DEFAULTS, ...custom });
    expect(await publicSocials()).toEqual({ ...DEFAULTS, ...custom });

    expect((await save({ spotifyUrl: null, xUrl: null })).statusCode).toBe(200);
    expect(await adminSocials()).toEqual(DEFAULTS);
  });

  it('a disabled integration gives no default', async () => {
    await ensureIntegrationRows(prisma);
    await prisma.integrationConfig.update({ where: { id: 'spotify' }, data: { enabled: false } });
    await prisma.integrationConfig.update({ where: { id: 'apple' }, data: { enabled: false } });
    expect(await publicSocials()).toEqual({ ...DEFAULTS, spotifyUrl: null, appleUrl: null });
  });

  it('uses the connected Instagram username and the stored show/podcast ids', async () => {
    await ensureIntegrationRows(prisma);
    await prisma.integrationConfig.update({
      where: { id: 'instagram' },
      data: { enabled: true, settings: { igUserId: '1784', username: 'other.account_1', pageId: '9' } },
    });
    await prisma.integrationConfig.update({
      where: { id: 'apple' },
      data: { settings: { podcastId: '42' } },
    });
    expect(await adminSocials()).toEqual({
      ...DEFAULTS,
      appleUrl: 'https://podcasts.apple.com/podcast/id42',
      instagramUrl: 'https://www.instagram.com/other.account_1/',
    });
  });
});
