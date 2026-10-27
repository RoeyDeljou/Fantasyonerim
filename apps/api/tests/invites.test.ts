import {
  AdminInviteCreatedSchema,
  AdminInviteListSchema,
  AdminInvitePreviewSchema,
  AuthResponseSchema,
  MeSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LAST_ADMIN_MESSAGE } from '../src/account/deleteAccount.js';
import { ADMIN_INVITE_TTL_MS, INVALID_INVITE_MESSAGE } from '../src/auth/invites.js';
import { hashToken } from '../src/auth/tokens.js';
import type { FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  type TestClock,
} from './helpers.js';

const prisma = createTestPrisma();
const WEB = 'https://app.fantasyonerim.test';
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let admin: string;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl, clock } = await buildTestApp(prisma, { config: { webAppUrl: `${WEB}/` } }));
  admin = await adminToken(app, prisma);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function createInvite(label = 'Dor', token = admin) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/invites',
    headers: bearer(token),
    payload: { label },
  });
  expect(res.statusCode, res.body).toBe(201);
  const created = AdminInviteCreatedSchema.parse(res.json());
  const inviteToken = new URLSearchParams(new URL(created.url).hash.slice(1)).get('invite') ?? '';
  return { ...created, token: inviteToken };
}

async function list() {
  const res = await app.inject({ method: 'GET', url: '/v1/admin/invites', headers: bearer(admin) });
  expect(res.statusCode).toBe(200);
  return AdminInviteListSchema.parse(res.json()).items;
}

const preview = (token: string) =>
  app.inject({ method: 'POST', url: '/v1/admin-invites/preview', payload: { token } });

function register(entryId: number, inviteToken?: string, name = `Host ${entryId}`) {
  if (!fpl.entries.has(entryId)) fpl.addEntry(entryId);
  return app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { name, entryId, ...(inviteToken === undefined ? {} : { inviteToken }) },
  });
}

const redeem = (token: string, inviteToken: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/me/admin-invite',
    headers: bearer(token),
    payload: { token: inviteToken },
  });

const revoke = (id: string, token = admin) =>
  app.inject({ method: 'DELETE', url: `/v1/admin/invites/${id}`, headers: bearer(token) });

describe('admin invites — admin routes', () => {
  it('401 signed out, 403 for fans, 400 on bad bodies', async () => {
    const fan = await registerUser(app, fpl, 10);
    for (const route of [
      { method: 'POST' as const, url: '/v1/admin/invites', payload: { label: 'Dor' } },
      { method: 'GET' as const, url: '/v1/admin/invites' },
      { method: 'DELETE' as const, url: '/v1/admin/invites/whatever' },
    ]) {
      expect((await app.inject(route)).statusCode).toBe(401);
      expect((await app.inject({ ...route, headers: bearer(fan.token) })).statusCode).toBe(403);
    }
    for (const payload of [{}, { label: '  ' }, { label: 'x'.repeat(41) }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/invites',
        headers: bearer(admin),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(await prisma.adminInvite.count()).toBe(0);
  });

  it('creates a one-time link (token shown once, stored hashed), lists newest first, revokes pending only', async () => {
    const dor = await createInvite('Dor');
    expect(dor.url).toMatch(new RegExp(`^${WEB}/onboarding/#invite=[A-Za-z0-9_-]{43}$`));
    expect(dor.invite).toMatchObject({
      label: 'Dor',
      createdBy: 'admin',
      status: 'pending',
      usedAt: null,
      usedByName: null,
      revokedAt: null,
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + ADMIN_INVITE_TTL_MS).toISOString(),
    });
    const row = await prisma.adminInvite.findUniqueOrThrow({ where: { id: dor.invite.id } });
    expect(row.tokenHash).toBe(hashToken(dor.token));
    expect(JSON.stringify(row)).not.toContain(dor.token);

    clock.advance(1000);
    const itay = await createInvite('Itay');
    const items = await list();
    expect(items.map((i) => i.id)).toEqual([itay.invite.id, dor.invite.id]);
    expect(JSON.stringify(items)).not.toContain(dor.token);

    expect((await revoke(itay.invite.id)).statusCode).toBe(204);
    expect((await revoke(itay.invite.id)).statusCode).toBe(409);
    expect((await revoke('no-such-invite')).statusCode).toBe(404);
    expect((await list()).find((i) => i.id === itay.invite.id)?.status).toBe('revoked');

    expect((await register(20, dor.token)).statusCode).toBe(201);
    const used = await revoke(dor.invite.id);
    expect(used.statusCode).toBe(409);
    expect((await list()).find((i) => i.id === dor.invite.id)).toMatchObject({
      status: 'used',
      usedByName: 'Host 20',
    });
  });

  it('expired invites show as expired and cannot be revoked', async () => {
    const inv = await createInvite();
    clock.advance(ADMIN_INVITE_TTL_MS + 1);
    expect((await list())[0]?.status).toBe('expired');
    expect((await revoke(inv.invite.id)).statusCode).toBe(409);
  });

  it('rate-limits invite creation per admin', async () => {
    await app.close();
    await resetDb(prisma);
    ({ app, fpl, clock } = await buildTestApp(prisma, { rateLimit: { invitesPerHour: 2 } }));
    admin = await adminToken(app, prisma);
    const one = await createInvite('a');
    expect(one.url).toMatch(/^http:\/\/localhost:3000\/onboarding\/#invite=/); // dev default
    await createInvite('b');
    const third = await app.inject({
      method: 'POST',
      url: '/v1/admin/invites',
      headers: bearer(admin),
      payload: { label: 'c' },
    });
    expect(third.statusCode).toBe(429);
  });
});

describe('POST /v1/admin-invites/preview (public)', () => {
  it('pending → label + expiry; unknown/used/expired/revoked → the same generic 404', async () => {
    const ok = await createInvite('Dor');
    const res = await preview(ok.token);
    expect(res.statusCode).toBe(200);
    expect(AdminInvitePreviewSchema.parse(res.json())).toEqual({
      label: 'Dor',
      expiresAt: ok.invite.expiresAt,
    });

    const used = await createInvite('used');
    expect((await register(30, used.token)).statusCode).toBe(201);
    const revoked = await createInvite('revoked');
    expect((await revoke(revoked.invite.id)).statusCode).toBe(204);
    const expired = await createInvite('expired');
    await prisma.adminInvite.update({
      where: { id: expired.invite.id },
      data: { expiresAt: new Date(clock.now().getTime() - 1) },
    });

    const bodies = new Set<string>();
    for (const token of [
      'x'.repeat(43),
      'short',
      '',
      'x'.repeat(5000),
      used.token,
      revoked.token,
      expired.token,
    ]) {
      const r = await preview(token);
      expect(r.statusCode, token).toBe(404);
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
  });

  it('400 when there is no token string at all; the old GET path no longer exists', async () => {
    for (const payload of [undefined, {}, { token: 42 }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin-invites/preview',
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const ok = await createInvite();
    const old = await app.inject({ method: 'GET', url: `/v1/admin-invites/${ok.token}` });
    expect(old.statusCode).toBe(404);
    expect(old.json().error.message).not.toContain(ok.token);
  });
});

describe('request logging never contains invite tokens or query strings', () => {
  it('redacts /v1/admin-invites/* and strips query strings from logged URLs', async () => {
    const lines: string[] = [];
    const stream = { write: (line: string) => void lines.push(line) };
    const { app: logged } = await buildTestApp(prisma, { logger: { level: 'info', stream } });
    const secret = 'RAWINVITETOKEN0123456789abcdefghijklmnopq';
    await logged.inject({ method: 'GET', url: `/v1/admin-invites/${secret}` });
    await logged.inject({ method: 'GET', url: `/v1/admin-invites/${secret}?again=${secret}` });
    await logged.inject({ method: 'POST', url: '/v1/admin-invites/preview', payload: { token: secret } });
    await logged.inject({ method: 'GET', url: `/v1/news?invite=${secret}` });
    await logged.close();

    const output = lines.join('');
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(secret);
    const urls = lines
      .map((l) => JSON.parse(l) as { req?: { url?: string } })
      .flatMap((l) => (l.req?.url === undefined ? [] : [l.req.url]));
    expect(urls).toEqual([
      '/v1/admin-invites/[redacted]',
      '/v1/admin-invites/[redacted]',
      '/v1/admin-invites/[redacted]',
      '/v1/news',
    ]);
  });
});

describe('POST /v1/auth/register with an invite', () => {
  it('creates the account as an admin with a recovery code and marks the invite used', async () => {
    const inv = await createInvite('Dor');
    const res = await register(11597, inv.token, 'Dor Dabush');
    expect(res.statusCode).toBe(201);
    const auth = AuthResponseSchema.parse(res.json());
    expect(auth.user.role).toBe('admin');
    expect(auth.user.entryId).toBe(11597);
    const code = await app.inject({
      method: 'GET',
      url: '/v1/me/recovery-code',
      headers: bearer(auth.token),
    });
    expect(code.json().recoveryCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const row = await prisma.adminInvite.findUniqueOrThrow({ where: { id: inv.invite.id } });
    expect(row).toMatchObject({ usedById: auth.user.id, usedByName: 'Dor Dabush' });
    expect(row.usedAt).not.toBeNull();
    // No username/password; admin routes work via the app session (role, not credential).
    expect(await prisma.adminCredential.count({ where: { userId: auth.user.id } })).toBe(0);
    const settings = await app.inject({
      method: 'GET',
      url: '/v1/admin/settings',
      headers: bearer(auth.token),
    });
    expect(settings.statusCode).toBe(200);
    const newInvite = await createInvite('Itay', auth.token);
    expect(newInvite.invite.createdBy).toBe('Dor Dabush');
  });

  it('second use of the same link → 400 and nothing created', async () => {
    const inv = await createInvite();
    expect((await register(40, inv.token)).statusCode).toBe(201);
    const users = await prisma.user.count();
    const again = await register(41, inv.token);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toBe(INVALID_INVITE_MESSAGE);
    expect(await prisma.user.count()).toBe(users);
    expect(await prisma.user.count({ where: { entryId: 41 } })).toBe(0);
  });

  it('concurrent double redemption → exactly one admin, the other request creates nothing', async () => {
    const inv = await createInvite();
    const [a, b] = await Promise.all([register(50, inv.token), register(51, inv.token)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 400]);
    expect(await prisma.user.count({ where: { entryId: { in: [50, 51] } } })).toBe(1);
    expect(await prisma.user.count({ where: { role: 'ADMIN', entryId: { in: [50, 51] } } })).toBe(1);
  });

  it('expired (clock), revoked or unknown → 400, no fallback fan account', async () => {
    const exp = await createInvite('exp');
    const rev = await createInvite('rev');
    expect((await revoke(rev.invite.id)).statusCode).toBe(204);
    clock.advance(ADMIN_INVITE_TTL_MS);
    for (const [entryId, token] of [
      [60, exp.token],
      [61, rev.token],
      [62, 'y'.repeat(43)],
    ] as const) {
      const res = await register(entryId, token);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe(INVALID_INVITE_MESSAGE);
    }
    expect(await prisma.user.count({ where: { entryId: { in: [60, 61, 62] } } })).toBe(0);
  });

  it('register without an invite is unchanged (fan), and the duplicate-team 409 still wins', async () => {
    const fan = await register(70);
    expect(fan.statusCode).toBe(201);
    expect(AuthResponseSchema.parse(fan.json()).user.role).toBe('user');
    const inv = await createInvite();
    const dup = await register(70, inv.token);
    expect(dup.statusCode).toBe(409);
    expect((await prisma.adminInvite.findUniqueOrThrow({ where: { id: inv.invite.id } })).usedAt).toBeNull();
  });
});

describe('POST /v1/me/admin-invite (existing account)', () => {
  it('upgrades a fan to admin; then 409 already admin; reused link 400', async () => {
    const fan = await registerUser(app, fpl, 80, 'Itay Tebeka');
    const inv = await createInvite('Itay');
    const res = await redeem(fan.token, inv.token);
    expect(res.statusCode).toBe(200);
    expect(MeSchema.parse(res.json()).role).toBe('admin');
    expect((await prisma.adminInvite.findUniqueOrThrow({ where: { id: inv.invite.id } })).usedByName).toBe(
      'Itay Tebeka',
    );
    const again = await redeem(fan.token, (await createInvite('x')).token);
    expect(again.statusCode).toBe(409);

    const other = await registerUser(app, fpl, 81);
    const reused = await redeem(other.token, inv.token);
    expect(reused.statusCode).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.user.id } })).role).toBe('USER');
  });

  it('401 signed out, 400 invalid body/token, 403 banned (invite stays pending)', async () => {
    const inv = await createInvite();
    const noAuth = await app.inject({
      method: 'POST',
      url: '/v1/me/admin-invite',
      payload: { token: inv.token },
    });
    expect(noAuth.statusCode).toBe(401);
    const fan = await registerUser(app, fpl, 90);
    expect((await redeem(fan.token, 'short')).statusCode).toBe(400);
    expect((await redeem(fan.token, 'z'.repeat(43))).statusCode).toBe(400);
    await prisma.user.update({ where: { id: fan.user.id }, data: { bannedAt: clock.now(), banReason: 'x' } });
    expect((await redeem(fan.token, inv.token)).statusCode).toBe(403);
    expect((await prisma.adminInvite.findUniqueOrThrow({ where: { id: inv.invite.id } })).usedAt).toBeNull();
  });
});

describe('credential-less admins', () => {
  async function inviteAdmin(entryId: number) {
    const inv = await createInvite();
    const res = await register(entryId, inv.token);
    expect(res.statusCode).toBe(201);
    return AuthResponseSchema.parse(res.json());
  }

  it('GET /v1/admin/admins lists every admin; invite-made admins have username null', async () => {
    clock.advance(1000);
    const host = await inviteAdmin(130);
    await registerUser(app, fpl, 131); // a fan is not listed
    const res = await app.inject({ method: 'GET', url: '/v1/admin/admins', headers: bearer(host.token) });
    expect(res.statusCode).toBe(200);
    const adminId = (await prisma.adminCredential.findUniqueOrThrow({ where: { username: 'admin' } })).userId;
    expect(res.json()).toEqual([
      { userId: adminId, username: 'admin', name: 'admin' },
      { userId: host.user.id, username: null, name: 'Host 130' },
    ]);
  });

  it('password change → clear 400 instead of a crash', async () => {
    const host = await inviteAdmin(100);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/me/password',
      headers: bearer(host.token),
      payload: { currentPassword: 'whatever pass', newPassword: 'a brand new password' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('This admin signs in with their app account and has no password');
  });

  it('last-admin rule counts role-ADMIN users, whatever their sign-in method', async () => {
    const host = await inviteAdmin(110);
    const del = (token: string) =>
      app.inject({
        method: 'DELETE',
        url: '/v1/me',
        headers: bearer(token),
        payload: { confirm: 'DELETE' },
      });
    // Two admins (password + invite): the password admin may leave…
    expect((await del(admin)).statusCode).toBe(204);
    // …now the invite admin is the only one, with no credential anywhere.
    expect(await prisma.adminCredential.count()).toBe(0);
    const last = await del(host.token);
    expect(last.statusCode).toBe(409);
    expect(last.json().error.message).toBe(LAST_ADMIN_MESSAGE);
    // The invite admin keeps full admin access.
    const settings = await app.inject({
      method: 'GET',
      url: '/v1/admin/settings',
      headers: bearer(host.token),
    });
    expect(settings.statusCode).toBe(200);
  });

  it('deleting the creator keeps the invite history (createdBy name)', async () => {
    const host = await inviteAdmin(120);
    const inv = await createInvite('later', host.token);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/me',
          headers: bearer(host.token),
          payload: { confirm: 'DELETE' },
        })
      ).statusCode,
    ).toBe(204);
    const row = await prisma.adminInvite.findUniqueOrThrow({ where: { id: inv.invite.id } });
    expect(row.createdById).toBeNull();
    expect((await list()).find((i) => i.id === inv.invite.id)?.createdBy).toBe('Host 120');
  });
});
