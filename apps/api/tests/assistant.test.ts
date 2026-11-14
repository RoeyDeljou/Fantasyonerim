import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminSettingsSchema,
  ApiErrorSchema,
  DEFAULT_ASSISTANT_CONFIG,
  PublicConfigSchema,
  type AssistantConfig,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let admin: string;

const NO_SOCIALS = { spotifyUrl: null, appleUrl: null, instagramUrl: null, xUrl: null, whatsappUrl: null };
const LIVE: AssistantConfig = {
  visibility: 'everyone',
  scriptUrl: 'https://cdn.fpl-lad.com/alfie/embed.js',
  partnerId: 'fantasyonerim',
  fallbackUrl: 'https://www.fpl-lad.com/alfie',
};

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl } = await buildTestApp(prisma));
  admin = await adminToken(app, prisma);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const putSettings = (body: Record<string, unknown>, token = admin) =>
  app.inject({
    method: 'PUT',
    url: '/v1/admin/settings',
    headers: bearer(token),
    payload: { leagueId: null, deadlineReminderMinutes: [1440, 120], socials: NO_SOCIALS, ...body },
  });
const adminSettings = async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(admin) });
  expect(res.statusCode).toBe(200);
  return AdminSettingsSchema.parse(res.json());
};
const configRaw = async (token?: string) =>
  app.inject({
    method: 'GET',
    url: '/v1/config',
    ...(token === undefined ? {} : { headers: bearer(token) }),
  });
const config = async () => PublicConfigSchema.parse((await configRaw()).json());

describe('"Ask Alfie" assistant config', () => {
  it('unset → defaults in admin settings and public config (nothing stored)', async () => {
    expect((await adminSettings()).assistant).toEqual(DEFAULT_ASSISTANT_CONFIG);
    expect((await config()).assistant).toEqual(DEFAULT_ASSISTANT_CONFIG);
    expect((await prisma.appSettings.findFirstOrThrow()).assistant).toBeNull();
  });

  it('a stored value that no longer matches the contract falls back to the defaults', async () => {
    await adminSettings(); // creates the row
    await prisma.appSettings.updateMany({
      data: { assistant: { visibility: 'everyone', scriptUrl: 'https://evil.com/x.js', partnerId: null } },
    });
    expect((await adminSettings()).assistant).toEqual(DEFAULT_ASSISTANT_CONFIG);
    expect((await config()).assistant).toEqual(DEFAULT_ASSISTANT_CONFIG);
  });

  it('PUT round-trips, and the public config reflects it at once (hot cache invalidated)', async () => {
    expect((await config()).assistant).toEqual(DEFAULT_ASSISTANT_CONFIG); // warm the hot cache
    const res = await putSettings({ assistant: { ...LIVE, partnerId: '  fantasyonerim  ' } });
    expect(res.statusCode).toBe(200);
    expect(AdminSettingsSchema.parse(res.json()).assistant).toEqual(LIVE); // trimmed
    expect((await adminSettings()).assistant).toEqual(LIVE);
    expect((await config()).assistant).toEqual(LIVE);
  });

  it('PUT without assistant keeps the stored value', async () => {
    expect((await putSettings({ assistant: LIVE })).statusCode).toBe(200);
    const res = await putSettings({ deadlineReminderMinutes: [60] });
    expect(res.statusCode).toBe(200);
    expect(AdminSettingsSchema.parse(res.json()).assistant).toEqual(LIVE);
    expect((await adminSettings()).assistant).toEqual(LIVE);
    expect((await config()).assistant).toEqual(LIVE);
  });

  it('PUT can switch it off and clear the script', async () => {
    expect((await putSettings({ assistant: LIVE })).statusCode).toBe(200);
    const off = { ...LIVE, visibility: 'off', scriptUrl: null, partnerId: null } as const;
    expect((await putSettings({ assistant: off })).statusCode).toBe(200);
    expect((await config()).assistant).toEqual(off);
  });

  it.each([
    ['https://evil.com/x.js', 'must be on an allowed FPL Lad domain'],
    ['https://fpl-lad.com.evil.com/x.js', 'must be on an allowed FPL Lad domain'],
    ['https://evilfpl-lad.com/x.js', 'must be on an allowed FPL Lad domain'],
    ['http://fpl-lad.com/x.js', 'https'],
    ['not a url', ''],
  ])('scriptUrl %s → 400, nothing stored', async (scriptUrl, message) => {
    expect((await putSettings({ assistant: LIVE })).statusCode).toBe(200);
    const res = await putSettings({ assistant: { ...LIVE, scriptUrl } });
    expect(res.statusCode).toBe(400);
    const err = ApiErrorSchema.parse(res.json()).error;
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain('assistant.scriptUrl');
    expect(err.message).toContain(message);
    expect((await adminSettings()).assistant).toEqual(LIVE);
  });

  it.each([
    [{ ...LIVE, visibility: 'fans' }, 'assistant.visibility'],
    [{ ...LIVE, fallbackUrl: 'http://www.fpl-lad.com/' }, 'assistant.fallbackUrl'],
    [{ ...LIVE, partnerId: '   ' }, 'assistant.partnerId'],
    [{ ...LIVE, partnerId: 'x'.repeat(81) }, 'assistant.partnerId'],
    [{ visibility: 'everyone' }, 'assistant'],
    [null, 'assistant'],
  ])('invalid assistant %j → 400', async (assistant, path) => {
    const res = await putSettings({ assistant });
    expect(res.statusCode).toBe(400);
    expect(ApiErrorSchema.parse(res.json()).error.message).toContain(path);
  });

  it('non-admins cannot read or write it', async () => {
    const fan = await registerUser(app, fpl, 5);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/admin/settings', headers: bearer(fan.token) })).statusCode,
    ).toBe(403);
    expect((await putSettings({ assistant: LIVE }, fan.token)).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/v1/admin/settings', payload: {} })).statusCode).toBe(
      401,
    );
    expect((await config()).assistant).toEqual(DEFAULT_ASSISTANT_CONFIG);
  });

  it('/v1/config is identical for a guest, a fan and an admin (not varied by user)', async () => {
    expect((await putSettings({ assistant: { ...LIVE, visibility: 'admins' } })).statusCode).toBe(200);
    const fan = await registerUser(app, fpl, 7);
    const guest = await configRaw();
    const asFan = await configRaw(fan.token);
    const asAdmin = await configRaw(admin);
    for (const res of [guest, asFan, asAdmin]) expect(res.statusCode).toBe(200);
    expect(asFan.body).toBe(guest.body);
    expect(asAdmin.body).toBe(guest.body);
    expect(asFan.headers['etag']).toBe(guest.headers['etag']);
    expect(asFan.headers['cache-control']).toBe(guest.headers['cache-control']);
    expect(PublicConfigSchema.parse(guest.json()).assistant).toEqual({ ...LIVE, visibility: 'admins' });
  });

  it('migration: additive, nullable JSONB column', () => {
    const dir = resolve(API_DIR, 'prisma/migrations');
    const name = readdirSync(dir).find((d) => d.endsWith('_assistant_config'));
    expect(name).toBeDefined();
    const sql = readFileSync(resolve(dir, name!, 'migration.sql'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trim().startsWith('--'));
    expect(sql).toEqual(['ALTER TABLE "AppSettings" ADD COLUMN     "assistant" JSONB;']);
  });
});
