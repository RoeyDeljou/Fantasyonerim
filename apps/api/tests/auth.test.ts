import { ApiErrorSchema, AuthResponseSchema, MeSchema, RecoveryCodeResponseSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/auth/bootstrapAdmin.js';
import { hashToken } from '../src/auth/tokens.js';
import type { FakeFplService } from './fakeFpl.js';
import type { TestClock } from './helpers.js';
import {
  DAY_MS,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
} from './helpers.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl, clock } = await buildTestApp(prisma));
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const errorCode = (body: unknown) => ApiErrorSchema.parse(body).error.code;

describe('POST /v1/auth/register', () => {
  it('creates the account and returns a token + Me', async () => {
    fpl.addEntry(123456, 'Salah Days');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: '  Roey ', entryId: '123456', locale: 'en' },
    });
    expect(res.statusCode).toBe(201);
    const body = AuthResponseSchema.parse(res.json());
    expect(body.user).toMatchObject({
      name: 'Roey',
      entryId: 123456,
      teamName: 'Salah Days',
      role: 'user',
      locale: 'en',
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { entryId: 123456 } });
    expect(user.recoveryCodeHash).toMatch(/^\$argon2id\$/);
    // Token is stored hashed only.
    const session = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.tokenHash).toBe(hashToken(body.token));
    expect(session.tokenHash).not.toBe(body.token);
    expect(session.expiresAt.getTime() - clock.now().getTime()).toBe(365 * DAY_MS);
  });

  it('defaults locale to Hebrew', async () => {
    const auth = await registerUser(app, fpl, 7);
    expect(auth.user.locale).toBe('he');
  });

  it('404s with a friendly message for an unknown Team ID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Roey', entryId: 999 },
    });
    expect(res.statusCode).toBe(404);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('999');
    expect(await prisma.user.count()).toBe(0);
  });

  it('409s when the team is already registered and points to the recovery code', async () => {
    await registerUser(app, fpl, 42);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Other', entryId: 42 },
    });
    expect(res.statusCode).toBe(409);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('conflict');
    expect(body.error.message.toLowerCase()).toContain('recovery code');
  });

  it.each([
    ['missing body', undefined],
    ['short name', { name: 'R', entryId: 1 }],
    ['angle brackets', { name: '<script>', entryId: 1 }],
    ['non-numeric team', { name: 'Roey', entryId: 'abc' }],
    ['negative team', { name: 'Roey', entryId: -5 }],
    ['bad locale', { name: 'Roey', entryId: 1, locale: 'fr' }],
  ])('400s on invalid body (%s)', async (_label, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.json())).toBe('bad_request');
    expect(fpl.calls.filter((c) => c.startsWith('getEntry'))).toHaveLength(0);
  });

  it('400s on malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.json())).toBe('bad_request');
  });
});

describe('sessions', () => {
  it('token works on /v1/me; no/garbage token is 401', async () => {
    const auth = await registerUser(app, fpl, 5, 'Dor');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    expect(me.statusCode).toBe(200);
    expect(MeSchema.parse(me.json())).toMatchObject({ name: 'Dor', entryId: 5 });

    const anon = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(anon.statusCode).toBe(401);
    expect(errorCode(anon.json())).toBe('unauthorized');
    const garbage = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('x'.repeat(43)) });
    expect(garbage.statusCode).toBe(401);
  });

  it('logout invalidates the token (empty JSON body accepted)', async () => {
    const auth = await registerUser(app, fpl, 5);
    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { ...bearer(auth.token), 'content-type': 'application/json' },
    });
    expect(out.statusCode).toBe(204);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    expect(me.statusCode).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('logout without a token is 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/logout' });
    expect(res.statusCode).toBe(401);
  });

  it('expires after a year without use', async () => {
    const auth = await registerUser(app, fpl, 5);
    clock.advance(365 * DAY_MS + 1);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    expect(me.statusCode).toBe(401);
    expect(errorCode(me.json())).toBe('unauthorized');
  });

  it('slides the expiry forward on use (writes at most hourly)', async () => {
    const auth = await registerUser(app, fpl, 5);
    const before = await prisma.session.findFirstOrThrow();

    clock.advance(30 * 60 * 1000); // 30 min: within throttle window → no write
    await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    const unchanged = await prisma.session.findFirstOrThrow();
    expect(unchanged.expiresAt).toEqual(before.expiresAt);

    clock.advance(300 * DAY_MS);
    const mid = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    expect(mid.statusCode).toBe(200);
    const slid = await prisma.session.findFirstOrThrow();
    expect(slid.expiresAt.getTime()).toBe(clock.now().getTime() + 365 * DAY_MS);

    clock.advance(300 * DAY_MS); // 600 days after register, but only 300 since last use
    const later = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    expect(later.statusCode).toBe(200);
  });
});

describe('profile', () => {
  it('PATCH /v1/me updates name and locale', async () => {
    const auth = await registerUser(app, fpl, 5);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(auth.token),
      payload: { name: 'New Name', locale: 'en' },
    });
    expect(res.statusCode).toBe(200);
    expect(MeSchema.parse(res.json())).toMatchObject({ name: 'New Name', locale: 'en' });

    const bad = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(auth.token),
      payload: { locale: 'de' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /v1/me/recovery-code returns an XXXX-XXXX code stored encrypted', async () => {
    const auth = await registerUser(app, fpl, 5);
    const res = await app.inject({ method: 'GET', url: '/v1/me/recovery-code', headers: bearer(auth.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { recoveryCode } = RecoveryCodeResponseSchema.parse(res.json());
    expect(recoveryCode).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    const user = await prisma.user.findUniqueOrThrow({ where: { entryId: 5 } });
    expect(user.recoveryCodeEnc).not.toContain(recoveryCode);
    expect(JSON.stringify(user)).not.toContain(recoveryCode);

    const anon = await app.inject({ method: 'GET', url: '/v1/me/recovery-code' });
    expect(anon.statusCode).toBe(401);
  });
});

describe('POST /v1/auth/recover', () => {
  async function codeFor(token: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/v1/me/recovery-code', headers: bearer(token) });
    return RecoveryCodeResponseSchema.parse(res.json()).recoveryCode;
  }

  it('issues a new session with the right code (case-insensitive)', async () => {
    const first = await registerUser(app, fpl, 77, 'Moshe');
    const code = await codeFor(first.token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/recover',
      payload: { entryId: 77, recoveryCode: code.toLowerCase() },
    });
    expect(res.statusCode).toBe(200);
    const body = AuthResponseSchema.parse(res.json());
    expect(body.token).not.toBe(first.token);
    expect(body.user.name).toBe('Moshe');
    // Both devices stay signed in.
    for (const token of [first.token, body.token]) {
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
      expect(me.statusCode).toBe(200);
    }
  });

  it('401s with a wrong code or unknown team', async () => {
    await registerUser(app, fpl, 77);
    for (const payload of [
      { entryId: 77, recoveryCode: 'AAAA-AAAA' },
      { entryId: 78, recoveryCode: 'AAAA-AAAA' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/recover', payload });
      expect(res.statusCode).toBe(401);
      expect(errorCode(res.json())).toBe('unauthorized');
    }
  });

  it('400s on a malformed code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/recover',
      payload: { entryId: 77, recoveryCode: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('admin login + bootstrap', () => {
  it('bootstrap creates the admin once (idempotent) and login works', async () => {
    expect(await bootstrapAdmin(prisma, 'boss', 'super-secret-pw')).toBe('created');
    expect(await bootstrapAdmin(prisma, 'boss', 'another-password')).toBe('exists');
    expect(await bootstrapAdmin(prisma, undefined, undefined)).toBe('skipped');
    expect(await prisma.adminCredential.count()).toBe(1);
    const user = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    expect(user).toMatchObject({ name: 'boss', entryId: null });
    const cred = await prisma.adminCredential.findUniqueOrThrow({ where: { username: 'boss' } });
    expect(cred.passwordHash).toMatch(/^\$argon2id\$/);

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin-login',
      payload: { username: 'boss', password: 'super-secret-pw' },
    });
    expect(ok.statusCode).toBe(200);
    const body = AuthResponseSchema.parse(ok.json());
    expect(body.user).toMatchObject({ role: 'admin', entryId: null, teamName: null });

    // The second bootstrap must not have reset the password.
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/auth/admin-login',
      payload: { username: 'boss', password: 'another-password' },
    });
    expect(stale.statusCode).toBe(401);
  });

  it('wrong password and unknown username get the same generic 401', async () => {
    await bootstrapAdmin(prisma, 'boss', 'super-secret-pw');
    const messages: string[] = [];
    for (const payload of [
      { username: 'boss', password: 'wrong-password' },
      { username: 'nobody', password: 'super-secret-pw' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/admin-login', payload });
      expect(res.statusCode).toBe(401);
      messages.push(ApiErrorSchema.parse(res.json()).error.message);
    }
    expect(messages[0]).toBe(messages[1]);
  });
});

describe('rate limits', () => {
  it('auth routes are strictly limited per IP → 429 rate_limited', async () => {
    const limited = await buildTestApp(prisma, { rateLimit: { authMax: 2 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/v1/auth/recover',
          payload: { entryId: 1, recoveryCode: 'AAAA-AAAA' },
        });
        codes.push(res.statusCode);
        if (res.statusCode === 429) expect(errorCode(res.json())).toBe('rate_limited');
      }
      expect(codes).toEqual([401, 401, 429]);
      // Other routes are unaffected by the strict limit.
      const health = await limited.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await limited.app.close();
    }
  });
});
