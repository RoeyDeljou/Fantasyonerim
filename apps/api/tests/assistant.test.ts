import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdminSettingsSchema,
  ApiErrorSchema,
  ASSISTANT_DEFAULT_TESTER_ENTRY_IDS,
  DEFAULT_ASSISTANT_CONFIG,
  FplEntryIdSchema,
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
  testerEntryIds: [FplEntryIdSchema.parse(28060)],
};
const entryIds = (...ids: number[]) => ids.map((id) => FplEntryIdSchema.parse(id));

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

  it('the default testers are [28060] when nothing is stored', async () => {
    expect(ASSISTANT_DEFAULT_TESTER_ENTRY_IDS).toEqual([28060]);
    expect((await adminSettings()).assistant?.testerEntryIds).toEqual([28060]);
    expect((await config()).assistant?.testerEntryIds).toEqual([28060]);
  });

  it('a stored config saved before testerEntryIds existed reads back with the default testers', async () => {
    await adminSettings(); // creates the row
    const { testerEntryIds: _omitted, ...legacy } = LIVE;
    await prisma.appSettings.updateMany({ data: { assistant: { ...legacy, visibility: 'admins' } } });
    const expected = { ...legacy, visibility: 'admins', testerEntryIds: entryIds(28060) };
    expect((await adminSettings()).assistant).toEqual(expected);
    expect((await config()).assistant).toEqual(expected);
  });

  it('PUT with testerEntryIds [] keeps [] (not replaced by the default)', async () => {
    const none = { ...LIVE, visibility: 'admins', testerEntryIds: [] };
    const res = await putSettings({ assistant: none });
    expect(res.statusCode).toBe(200);
    expect(AdminSettingsSchema.parse(res.json()).assistant?.testerEntryIds).toEqual([]);
    expect((await adminSettings()).assistant?.testerEntryIds).toEqual([]);
    expect((await config()).assistant?.testerEntryIds).toEqual([]);
    expect((await prisma.appSettings.findFirstOrThrow()).assistant).toMatchObject({ testerEntryIds: [] });
    // A later PUT without `assistant` keeps the stored [].
    expect((await putSettings({ deadlineReminderMinutes: [60] })).statusCode).toBe(200);
    expect((await config()).assistant?.testerEntryIds).toEqual([]);
  });

  it('PUT with testerEntryIds [28060, 123] round-trips to admin settings and /v1/config', async () => {
    const two: AssistantConfig = { ...LIVE, visibility: 'admins', testerEntryIds: entryIds(28060, 123) };
    const res = await putSettings({ assistant: two });
    expect(res.statusCode).toBe(200);
    expect(AdminSettingsSchema.parse(res.json()).assistant).toEqual(two);
    expect((await adminSettings()).assistant).toEqual(two);
    expect((await config()).assistant).toEqual(two);
  });

  it('PUT with testerEntryIds omitted stores the default testers', async () => {
    const { testerEntryIds: _omitted, ...legacy } = LIVE;
    expect((await putSettings({ assistant: legacy })).statusCode).toBe(200);
    expect((await config()).assistant?.testerEntryIds).toEqual([28060]);
  });

  it.each([
    ['51 ids', Array.from({ length: 51 }, (_, i) => i + 1)],
    ['a zero id', [0]],
    ['a negative id', [-5]],
    ['a fractional id', [1.5]],
    ['a non-numeric id', ['abc']],
    ['an id above the FPL range', [100_000_000]],
    ['null', null],
    ['not an array', 28060],
  ])('testerEntryIds with %s → 400, nothing stored', async (_label, testerEntryIds) => {
    expect((await putSettings({ assistant: LIVE })).statusCode).toBe(200);
    const res = await putSettings({ assistant: { ...LIVE, testerEntryIds } });
    expect(res.statusCode).toBe(400);
    const err = ApiErrorSchema.parse(res.json()).error;
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain('assistant.testerEntryIds');
    expect((await adminSettings()).assistant).toEqual(LIVE);
  });

  it('50 tester ids is the maximum accepted', async () => {
    const fifty = { ...LIVE, testerEntryIds: entryIds(...Array.from({ length: 50 }, (_, i) => i + 1)) };
    const res = await putSettings({ assistant: fifty });
    expect(res.statusCode).toBe(200);
    expect((await config()).assistant?.testerEntryIds).toHaveLength(50);
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
