import { ApiErrorSchema, AuthResponseSchema, MeSchema } from '@fant/shared';
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
const errorMessage = (body: unknown) => ApiErrorSchema.parse(body).error.message;

const EMAIL_TAKEN = 'This email is already used by another account.';
const TEAM_TAKEN = 'This Team ID is already registered. Sign in with your email and Team ID.';
const LOGIN_FAILED = 'Email or Team ID is incorrect';

const getEntryCalls = () => fpl.calls.filter((c) => c.startsWith('getEntry')).length;

describe('POST /v1/auth/register', () => {
  it('creates the account and returns a token + Me', async () => {
    fpl.addEntry(123456, 'Salah Days');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: '  Roey ', entryId: '123456', email: '  Roey.K@Example.TEST ', locale: 'en' },
    });
    expect(res.statusCode).toBe(201);
    const body = AuthResponseSchema.parse(res.json());
    expect(body.user).toMatchObject({
      name: 'Roey',
      entryId: 123456,
      teamName: 'Salah Days',
      email: 'roey.k@example.test',
      role: 'user',
      locale: 'en',
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { entryId: 123456 } });
    // Stored normalized (trimmed + lower-case); no recovery code any more.
    expect(user.email).toBe('roey.k@example.test');
    expect(user.recoveryCodeHash).toBeNull();
    expect(user.recoveryCodeEnc).toBeNull();
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
      payload: { name: 'Roey', entryId: 999, email: 'roey@example.test' },
    });
    expect(res.statusCode).toBe(404);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('999');
    expect(await prisma.user.count()).toBe(0);
  });

  it('409s when the team is already registered and points to email sign-in', async () => {
    await registerUser(app, fpl, 42);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Other', entryId: 42, email: 'other@example.test' },
    });
    expect(res.statusCode).toBe(409);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toBe(TEAM_TAKEN);
  });

  it('409s when the email is on another account (any case), before calling FPL', async () => {
    await registerUser(app, fpl, 42, 'Dana', 'dana@example.test');
    fpl.addEntry(43);
    const before = getEntryCalls();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Other', entryId: 43, email: ' DANA@example.TEST' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res.json())).toBe('conflict');
    expect(errorMessage(res.json())).toBe(EMAIL_TAKEN);
    expect(getEntryCalls()).toBe(before);
    expect(await prisma.user.count()).toBe(1);
  });

  it('a concurrent race for the same email → exactly one account, the other gets the email 409', async () => {
    fpl.addEntry(51);
    fpl.addEntry(52);
    const [a, b] = await Promise.all(
      [51, 52].map((entryId) =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: { name: `Fan ${entryId}`, entryId, email: 'same@example.test' },
        }),
      ),
    );
    const results = [a, b].map((r) => r?.statusCode).sort();
    expect(results).toEqual([201, 409]);
    const loser = [a, b].find((r) => r?.statusCode === 409);
    expect(errorMessage(loser?.json())).toBe(EMAIL_TAKEN);
    expect(await prisma.user.count({ where: { email: 'same@example.test' } })).toBe(1);
  });

  it.each([
    ['missing body', undefined],
    ['missing email', { name: 'Roey', entryId: 1 }],
    ['invalid email', { name: 'Roey', entryId: 1, email: 'not-an-email' }],
    ['email with spaces', { name: 'Roey', entryId: 1, email: 'ro ey@example.test' }],
    ['null email', { name: 'Roey', entryId: 1, email: null }],
    ['too-long email', { name: 'Roey', entryId: 1, email: `${'a'.repeat(250)}@example.test` }],
    ['short name', { name: 'R', entryId: 1, email: 'r@example.test' }],
    ['angle brackets', { name: '<script>', entryId: 1, email: 'r@example.test' }],
    ['non-numeric team', { name: 'Roey', entryId: 'abc', email: 'r@example.test' }],
    ['negative team', { name: 'Roey', entryId: -5, email: 'r@example.test' }],
    ['bad locale', { name: 'Roey', entryId: 1, email: 'r@example.test', locale: 'fr' }],
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

  it('PATCH /v1/me adds an email (normalized), shows it on /v1/me at once (cache invalidated)', async () => {
    // An account from before email was required.
    const auth = await registerUser(app, fpl, 5);
    await prisma.user.update({ where: { id: auth.user.id }, data: { email: null } });
    // This read caches the session with email = null; the PATCH must evict it.
    const me0 = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    expect(MeSchema.parse(me0.json()).email).toBeNull();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(auth.token),
      payload: { email: ' New.Mail@Example.test ' },
    });
    expect(res.statusCode).toBe(200);
    expect(MeSchema.parse(res.json()).email).toBe('new.mail@example.test');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(auth.token) });
    expect(MeSchema.parse(me.json()).email).toBe('new.mail@example.test');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } })).email).toBe(
      'new.mail@example.test',
    );
    // Re-sending your own email is fine.
    const same = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(auth.token),
      payload: { email: 'NEW.MAIL@example.test' },
    });
    expect(same.statusCode).toBe(200);
  });

  it('PATCH /v1/me with an email used by another account → 409, nothing changes', async () => {
    await registerUser(app, fpl, 5, 'Dana', 'dana@example.test');
    const other = await registerUser(app, fpl, 6);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(other.token),
      payload: { email: 'Dana@Example.test', name: 'Renamed' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorMessage(res.json())).toBe(EMAIL_TAKEN);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: other.user.id } });
    expect(row).toMatchObject({ email: 'fan6@example.test', name: 'Fan 6' });
  });

  it('PATCH /v1/me email race between two accounts → one 200, one 409', async () => {
    const a = await registerUser(app, fpl, 5);
    const b = await registerUser(app, fpl, 6);
    const results = await Promise.all(
      [a, b].map((u) =>
        app.inject({
          method: 'PATCH',
          url: '/v1/me',
          headers: bearer(u.token),
          payload: { email: 'race@example.test' },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409);
    expect(errorMessage(loser?.json())).toBe(EMAIL_TAKEN);
    expect(await prisma.user.count({ where: { email: 'race@example.test' } })).toBe(1);
  });

  it('PATCH /v1/me: a banned user may still set their email', async () => {
    const auth = await registerUser(app, fpl, 5);
    await prisma.user.update({
      where: { id: auth.user.id },
      data: { bannedAt: clock.now(), banReason: 'x' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(auth.token),
      payload: { email: 'still.me@example.test' },
    });
    expect(res.statusCode).toBe(200);
    expect(MeSchema.parse(res.json())).toMatchObject({ email: 'still.me@example.test', canPost: false });
  });

  it.each([
    ['invalid email', { email: 'nope' }],
    ['null email', { email: null }],
    ['numeric email', { email: 5 }],
  ])('PATCH /v1/me 400s on %s', async (_label, payload) => {
    const auth = await registerUser(app, fpl, 5);
    const res = await app.inject({ method: 'PATCH', url: '/v1/me', headers: bearer(auth.token), payload });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.json())).toBe('bad_request');
  });
});

describe('recovery codes are gone', () => {
  it('the old recovery routes no longer exist (404)', async () => {
    const auth = await registerUser(app, fpl, 5);
    const admin = await adminLogin();
    const recover = await app.inject({
      method: 'POST',
      url: '/v1/auth/recover',
      payload: { entryId: 5, recoveryCode: 'AAAA-AAAA' },
    });
    expect(recover.statusCode).toBe(404);
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/me/recovery-code',
      headers: bearer(auth.token),
    });
    expect(mine.statusCode).toBe(404);
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${auth.user.id}/recovery-code`,
      headers: bearer(admin),
    });
    expect(issued.statusCode).toBe(404);
  });
});

async function adminLogin(): Promise<string> {
  await bootstrapAdmin(prisma, 'boss', 'super-secret-pw');
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/admin-login',
    payload: { username: 'boss', password: 'super-secret-pw' },
  });
  return AuthResponseSchema.parse(res.json()).token;
}

describe('POST /v1/auth/email-login', () => {
  const login = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/auth/email-login', payload: payload as Record<string, unknown> });

  it('issues a new session with the right email + Team ID (email case/space-insensitive)', async () => {
    const first = await registerUser(app, fpl, 77, 'Moshe', 'moshe@example.test');
    const res = await login({ email: '  MOSHE@Example.Test ', entryId: '77' });
    expect(res.statusCode).toBe(200);
    const body = AuthResponseSchema.parse(res.json());
    expect(body.token).not.toBe(first.token);
    expect(body.user).toMatchObject({ name: 'Moshe', entryId: 77, email: 'moshe@example.test' });
    // Both devices stay signed in.
    for (const token of [first.token, body.token]) {
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
      expect(me.statusCode).toBe(200);
    }
    expect(await prisma.session.count({ where: { userId: first.user.id } })).toBe(2);
  });

  it('works again after signing out', async () => {
    const first = await registerUser(app, fpl, 77);
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(first.token) });
    const res = await login({ email: 'fan77@example.test', entryId: 77 });
    expect(res.statusCode).toBe(200);
  });

  it("every miss is the same 401 (wrong team, unknown email, someone else's team, no email on file)", async () => {
    await registerUser(app, fpl, 77, 'Moshe', 'moshe@example.test');
    await registerUser(app, fpl, 78, 'Dana', 'dana@example.test');
    const legacy = await registerUser(app, fpl, 79);
    await prisma.user.update({ where: { id: legacy.user.id }, data: { email: null } });
    const misses = [
      { email: 'moshe@example.test', entryId: 76 }, // wrong Team ID
      { email: 'nobody@example.test', entryId: 77 }, // unknown email
      { email: 'moshe@example.test', entryId: 78 }, // another account's Team ID
      { email: 'nobody@example.test', entryId: 999 }, // both unknown
      { email: 'fan79@example.test', entryId: 79 }, // account has no email yet
    ];
    for (const payload of misses) {
      const res = await login(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(401);
      expect(ApiErrorSchema.parse(res.json()).error).toEqual({
        code: 'unauthorized',
        message: LOGIN_FAILED,
      });
    }
    expect(await prisma.session.count()).toBe(3); // only the three registrations
  });

  it('a banned user can sign in (read-only)', async () => {
    const auth = await registerUser(app, fpl, 77);
    await prisma.user.update({
      where: { id: auth.user.id },
      data: { bannedAt: clock.now(), banReason: 'x' },
    });
    const res = await login({ email: 'fan77@example.test', entryId: 77 });
    expect(res.statusCode).toBe(200);
    expect(AuthResponseSchema.parse(res.json()).user.canPost).toBe(false);
  });

  it('an admin-only account (no Team ID) cannot use it', async () => {
    await bootstrapAdmin(prisma, 'boss', 'super-secret-pw');
    await prisma.user.updateMany({ where: { role: 'ADMIN' }, data: { email: 'boss@example.test' } });
    for (const entryId of [1, 77]) {
      const res = await login({ email: 'boss@example.test', entryId });
      expect(res.statusCode).toBe(401);
      expect(errorMessage(res.json())).toBe(LOGIN_FAILED);
    }
  });

  it.each([
    ['missing body', undefined],
    ['missing email', { entryId: 77 }],
    ['missing team', { email: 'a@example.test' }],
    ['invalid email', { email: 'a@b', entryId: 77 }],
    ['non-numeric team', { email: 'a@example.test', entryId: 'abc' }],
    ['zero team', { email: 'a@example.test', entryId: 0 }],
  ])('400s on invalid body (%s)', async (_label, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/email-login',
      ...(payload === undefined ? {} : { payload }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.json())).toBe('bad_request');
  });
});

describe('admin login + bootstrap', () => {
  it('bootstrap creates the admin once (idempotent) and login works', async () => {
    expect(await bootstrapAdmin(prisma, 'boss', 'super-secret-pw')).toBe('created');
    expect(await bootstrapAdmin(prisma, 'boss', 'another-password')).toBe('exists');
    // A different bootstrap username never creates a second admin once one exists (no resurrection).
    expect(await bootstrapAdmin(prisma, 'other-boss', 'another-password')).toBe('exists');
    expect(await prisma.adminCredential.count()).toBe(1);
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
          url: '/v1/auth/email-login',
          payload: { email: 'nobody@example.test', entryId: 1 },
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
