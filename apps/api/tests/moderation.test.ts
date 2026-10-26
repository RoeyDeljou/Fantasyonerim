import {
  AdminUserListSchema,
  ApiErrorSchema,
  CommunityPageSchema,
  HiddenNewsListSchema,
  NewsItemSchema,
  NewsPageSchema,
  ReportListSchema,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BANNED_MESSAGE } from '../src/community/guard.js';
import { createComment, createPost, makeImage, multipart } from './communityFixtures.js';
import { MemoryMediaStore } from './fakes.js';
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

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  ({ app, fpl, clock } = await buildTestApp(prisma, { media: new MemoryMediaStore() }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function call(method: Method, url: string, token: string | null, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: token === null ? {} : bearer(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const errorOf = (res: { json: () => unknown }) => ApiErrorSchema.parse(res.json()).error;

async function reports(token: string) {
  const res = await call('GET', '/v1/admin/reports?status=open', token);
  expect(res.statusCode).toBe(200);
  return ReportListSchema.parse(res.json()).items;
}

// ---------------------------------------------------------------------------------------------------------
describe('admin-only enforcement', () => {
  it('every new admin route: 401 anonymous, 403 for a fan (before validation)', async () => {
    const fan = await registerUser(app, fpl, 1001);
    const routes: [Method, string][] = [
      ['GET', '/v1/admin/reports'],
      ['POST', '/v1/admin/reports/post:abc/resolve'],
      ['GET', '/v1/admin/users'],
      ['POST', `/v1/admin/users/${fan.user.id}/ban`],
      ['DELETE', `/v1/admin/users/${fan.user.id}/ban`],
      ['GET', '/v1/admin/news/hidden'],
      ['POST', '/v1/admin/news/abc/restore'],
    ];
    for (const [method, url] of routes) {
      const anon = await call(method, url, null, method === 'POST' ? {} : undefined);
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
      const asFan = await call(method, url, fan.token, method === 'POST' ? {} : undefined);
      expect(asFan.statusCode, `${method} ${url}`).toBe(403);
      expect(errorOf(asFan).code).toBe('forbidden');
    }
    // A fan whose role was revoked mid-session is re-checked on every request.
    const admin = await adminToken(app, prisma);
    expect((await call('GET', '/v1/admin/users', admin)).statusCode).toBe(200);
    await prisma.user.updateMany({ where: { role: 'ADMIN' }, data: { role: 'USER' } });
    expect((await call('GET', '/v1/admin/users', admin)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('bans', () => {
  it('a banned user gets 403 on every community write but can still read; unban restores', async () => {
    const admin = await adminToken(app, prisma);
    const alice = await registerUser(app, fpl, 1101, 'Alice');
    const bob = await registerUser(app, fpl, 1102, 'Bob');
    const alicePost = await createPost(app, alice.token);
    const bobPost = await createPost(app, bob.token);
    const aliceComment = await createComment(app, bob.token, alicePost.id);
    const bobComment = await createComment(app, bob.token, bobPost.id);

    const ban = await call('POST', `/v1/admin/users/${bob.user.id}/ban`, admin, { reason: '  Spamming links ' });
    expect(ban.statusCode).toBe(204);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: bob.user.id } });
    expect(row.bannedAt?.toISOString()).toBe(clock.now().toISOString());
    expect(row.banReason).toBe('Spamming links');

    const jpeg = multipart({ bytes: await makeImage('jpeg', 10, 10) });
    const writes = [
      () => call('POST', '/v1/community/posts', bob.token, { text: 'let me in' }),
      () => call('DELETE', `/v1/community/posts/${bobPost.id}`, bob.token),
      () => call('PUT', `/v1/community/posts/${alicePost.id}/like`, bob.token),
      () => call('DELETE', `/v1/community/posts/${alicePost.id}/like`, bob.token),
      () => call('POST', `/v1/community/posts/${alicePost.id}/comments`, bob.token, { text: 'hey' }),
      () => call('DELETE', `/v1/community/comments/${bobComment.id}`, bob.token),
      () => call('POST', `/v1/community/posts/${alicePost.id}/report`, bob.token, { reason: 'spam' }),
      () => call('POST', `/v1/community/comments/${aliceComment.id}/report`, bob.token, { reason: 'spam' }),
      () =>
        app.inject({
          method: 'POST',
          url: '/v1/uploads',
          headers: { ...bearer(bob.token), ...jpeg.headers },
          payload: jpeg.payload,
        }),
    ];
    for (const write of writes) {
      const res = await write();
      expect(res.statusCode, res.body).toBe(403);
      expect(errorOf(res)).toEqual({ code: 'forbidden', message: BANNED_MESSAGE });
    }
    expect(await prisma.communityPost.count({ where: { authorId: bob.user.id, deletedAt: null } })).toBe(1);

    // Reads still work, as does the rest of the account.
    expect((await call('GET', '/v1/community/posts', bob.token)).statusCode).toBe(200);
    expect((await call('GET', `/v1/community/posts/${alicePost.id}`, bob.token)).statusCode).toBe(200);
    expect((await call('GET', `/v1/community/posts/${alicePost.id}/comments`, bob.token)).statusCode).toBe(200);
    expect((await call('GET', '/v1/me', bob.token)).statusCode).toBe(200);

    // Banning again keeps the original timestamp, updates the reason.
    clock.advance(60_000);
    await call('POST', `/v1/admin/users/${bob.user.id}/ban`, admin, { reason: 'Still spamming' });
    const again = await prisma.user.findUniqueOrThrow({ where: { id: bob.user.id } });
    expect(again.bannedAt?.toISOString()).toBe(row.bannedAt?.toISOString());
    expect(again.banReason).toBe('Still spamming');

    expect((await call('DELETE', `/v1/admin/users/${bob.user.id}/ban`, admin)).statusCode).toBe(204);
    expect((await call('DELETE', `/v1/admin/users/${bob.user.id}/ban`, admin)).statusCode).toBe(204);
    expect((await call('POST', '/v1/community/posts', bob.token, { text: 'back' })).statusCode).toBe(201);
    const cleared = await prisma.user.findUniqueOrThrow({ where: { id: bob.user.id } });
    expect(cleared).toMatchObject({ bannedAt: null, banReason: null });
  });

  it('admins cannot be banned; validation and unknown users', async () => {
    const admin = await adminToken(app, prisma);
    const fan = await registerUser(app, fpl, 1103);
    const me = await call('GET', '/v1/me', admin);
    const adminId = (me.json() as { id: string }).id;
    const res = await call('POST', `/v1/admin/users/${adminId}/ban`, admin, { reason: 'test' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toMatch(/Admins can't be banned/);

    expect((await call('POST', '/v1/admin/users/nobody/ban', admin, { reason: 'x' })).statusCode).toBe(404);
    expect((await call('DELETE', '/v1/admin/users/nobody/ban', admin)).statusCode).toBe(404);
    for (const payload of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(201) }, { reason: 'a\u0000' }]) {
      const bad = await call('POST', `/v1/admin/users/${fan.user.id}/ban`, admin, payload);
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fan.user.id } })).bannedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('admin users list', () => {
  it('searches by name, team name or exact Team ID and counts live posts', async () => {
    const admin = await adminToken(app, prisma);
    fpl.addEntry(1201, 'Haaland Hunters');
    const dana = await registerUser(app, fpl, 1201, 'Dana Levi');
    const yossi = await registerUser(app, fpl, 1202, 'Yossi');
    await createPost(app, dana.token);
    const gone = await createPost(app, dana.token);
    await createPost(app, dana.token);
    await call('DELETE', `/v1/community/posts/${gone.id}`, dana.token);
    await call('POST', `/v1/admin/users/${yossi.user.id}/ban`, admin, { reason: 'abuse' });

    const list = async (q?: string) => {
      const res = await call('GET', `/v1/admin/users${q === undefined ? '' : `?query=${encodeURIComponent(q)}`}`, admin);
      expect(res.statusCode).toBe(200);
      return AdminUserListSchema.parse(res.json()).items;
    };
    const all = await list();
    expect(all).toHaveLength(3); // + the admin
    const d = all.find((u) => u.id === dana.user.id);
    expect(d).toMatchObject({ name: 'Dana Levi', entryId: 1201, teamName: 'Haaland Hunters', role: 'user', postCount: 2, bannedAt: null, banReason: null });
    expect(all.find((u) => u.id === yossi.user.id)).toMatchObject({ banReason: 'abuse', postCount: 0 });
    expect(all.find((u) => u.role === 'admin')).toMatchObject({ entryId: null });

    expect((await list('dana')).map((u) => u.id)).toEqual([dana.user.id]);
    expect((await list('HUNTERS')).map((u) => u.id)).toEqual([dana.user.id]);
    expect((await list('1202')).map((u) => u.id)).toEqual([yossi.user.id]);
    expect(await list('120')).toEqual([]); // Team ID must be exact
    expect(await list('zzz')).toEqual([]);
    expect(await list('')).toHaveLength(3);
    expect((await call('GET', `/v1/admin/users?query=${'x'.repeat(101)}`, admin)).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('reports and moderation', () => {
  it('reports are idempotent per user/target; own content 400; missing 404; body validated', async () => {
    const alice = await registerUser(app, fpl, 1301);
    const bob = await registerUser(app, fpl, 1302);
    const p = await createPost(app, alice.token);
    const c = await createComment(app, alice.token, p.id);
    const url = `/v1/community/posts/${p.id}/report`;
    expect((await call('POST', url, bob.token, { reason: 'spam' })).statusCode).toBe(204);
    expect((await call('POST', url, bob.token, { reason: 'abuse', note: 'again' })).statusCode).toBe(204);
    await Promise.all([1, 2, 3].map(() => call('POST', url, bob.token, { reason: 'spam' })));
    expect(await prisma.report.count()).toBe(1);

    const own = await call('POST', url, alice.token, { reason: 'spam' });
    expect(own.statusCode).toBe(400);
    expect(errorOf(own).message).toMatch(/your own post/);
    const ownComment = await call('POST', `/v1/community/comments/${c.id}/report`, alice.token, { reason: 'spam' });
    expect(ownComment.statusCode).toBe(400);

    expect((await call('POST', '/v1/community/posts/nope/report', bob.token, { reason: 'spam' })).statusCode).toBe(404);
    expect((await call('POST', '/v1/community/comments/nope/report', bob.token, { reason: 'spam' })).statusCode).toBe(404);
    for (const payload of [{}, { reason: 'boring' }, { reason: 'other', note: 'x'.repeat(301) }, { reason: 'other', note: '\u0001' }]) {
      expect((await call('POST', url, bob.token, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await call('POST', url, null, { reason: 'spam' })).statusCode).toBe(401);
  });

  it('groups open reports per target with reasons, notes and counts; renders the target', async () => {
    const admin = await adminToken(app, prisma);
    const alice = await registerUser(app, fpl, 1401, 'Alice');
    const bob = await registerUser(app, fpl, 1402);
    const carol = await registerUser(app, fpl, 1403);
    const dave = await registerUser(app, fpl, 1404);
    const p = await createPost(app, alice.token, { text: 'Buy followers at spam.example' });
    const c = await createComment(app, alice.token, p.id, 'nasty comment');

    await call('POST', `/v1/community/posts/${p.id}/report`, bob.token, { reason: 'spam' });
    clock.advance(1000);
    await call('POST', `/v1/community/posts/${p.id}/report`, carol.token, { reason: 'abuse', note: ' scam link ' });
    await call('POST', `/v1/community/posts/${p.id}/report`, dave.token, { reason: 'abuse', note: '' });
    await call('POST', `/v1/community/comments/${c.id}/report`, bob.token, { reason: 'hate', note: 'slur' });

    const items = await reports(admin);
    expect(items).toHaveLength(2);
    const [postGroup, commentGroup] = items;
    expect(postGroup).toMatchObject({
      targetId: `post:${p.id}`,
      reportCount: 3,
      reasons: ['abuse', 'spam'],
      notes: ['scam link'],
      target: { kind: 'post', post: { id: p.id, text: 'Buy followers at spam.example', mine: false } },
    });
    expect(postGroup?.firstReportedAt).toBe(new Date(clock.now().getTime() - 1000).toISOString());
    expect(commentGroup).toMatchObject({
      targetId: `comment:${c.id}`,
      reportCount: 1,
      reasons: ['hate'],
      notes: ['slur'],
      target: { kind: 'comment', comment: { id: c.id, postId: p.id, text: 'nasty comment' } },
    });
    expect((await call('GET', '/v1/admin/reports?status=closed', admin)).statusCode).toBe(400);
    expect((await call('GET', '/v1/admin/reports', admin)).statusCode).toBe(200);
  });

  it('resolve remove soft-deletes the target and closes its reports; dismiss keeps it', async () => {
    const admin = await adminToken(app, prisma);
    const alice = await registerUser(app, fpl, 1501);
    const bob = await registerUser(app, fpl, 1502);
    const carol = await registerUser(app, fpl, 1503);
    const bad = await createPost(app, alice.token, { text: 'bad' });
    const fine = await createPost(app, alice.token, { text: 'fine' });
    const p3 = await createPost(app, carol.token, { text: 'has comments' });
    const c = await createComment(app, alice.token, p3.id, 'rude');
    await createComment(app, bob.token, p3.id, 'ok');

    for (const token of [bob.token, carol.token]) {
      await call('POST', `/v1/community/posts/${bad.id}/report`, token, { reason: 'spam' });
    }
    await call('POST', `/v1/community/posts/${fine.id}/report`, bob.token, { reason: 'other' });
    await call('POST', `/v1/community/comments/${c.id}/report`, bob.token, { reason: 'abuse' });
    expect(await reports(admin)).toHaveLength(3);

    const resolve = (targetId: string, action: unknown) =>
      call('POST', `/v1/admin/reports/${encodeURIComponent(targetId)}/resolve`, admin, { action });
    expect((await resolve(`post:${bad.id}`, 'delete')).statusCode).toBe(400);
    expect((await resolve(`banana:${bad.id}`, 'remove')).statusCode).toBe(400);
    expect((await resolve('post:', 'remove')).statusCode).toBe(400);

    expect((await resolve(`post:${bad.id}`, 'remove')).statusCode).toBe(204);
    expect((await call('GET', `/v1/community/posts/${bad.id}`, null)).statusCode).toBe(404);
    const badRow = await prisma.communityPost.findUniqueOrThrow({ where: { id: bad.id } });
    expect(badRow.deletedAt).not.toBeNull();
    const closed = await prisma.report.findMany({ where: { targetId: bad.id } });
    expect(closed.map((r) => [r.isOpen, r.resolution])).toEqual([
      [null, 'removed'],
      [null, 'removed'],
    ]);

    expect((await resolve(`post:${fine.id}`, 'dismiss')).statusCode).toBe(204);
    expect((await call('GET', `/v1/community/posts/${fine.id}`, null)).statusCode).toBe(200);
    expect((await prisma.report.findFirstOrThrow({ where: { targetId: fine.id } })).resolution).toBe('dismissed');
    // After a dismissal the same user can report again (one OPEN report per user/target).
    expect((await call('POST', `/v1/community/posts/${fine.id}/report`, bob.token, { reason: 'spam' })).statusCode).toBe(204);
    expect(await prisma.report.count({ where: { targetId: fine.id } })).toBe(2);
    expect((await resolve(`post:${fine.id}`, 'dismiss')).statusCode).toBe(204);

    // Removing a comment decrements its post's counter.
    expect((await resolve(`comment:${c.id}`, 'remove')).statusCode).toBe(204);
    expect((await prisma.communityPost.findUniqueOrThrow({ where: { id: p3.id } })).commentCount).toBe(1);
    expect((await resolve(`comment:${c.id}`, 'remove')).statusCode).toBe(404);
    expect(await reports(admin)).toEqual([]);
    expect(CommunityPageSchema.parse((await call('GET', '/v1/community/posts', null)).json()).items.map((p) => p.id)).toEqual([
      p3.id,
      fine.id,
    ]);
  });

  it("deleting reported content (author or with its post) closes its reports so the queue never shows ghosts", async () => {
    const admin = await adminToken(app, prisma);
    const alice = await registerUser(app, fpl, 1601);
    const bob = await registerUser(app, fpl, 1602);
    const p = await createPost(app, alice.token);
    const c = await createComment(app, alice.token, p.id);
    await call('POST', `/v1/community/posts/${p.id}/report`, bob.token, { reason: 'spam' });
    await call('POST', `/v1/community/comments/${c.id}/report`, bob.token, { reason: 'spam' });
    expect(await reports(admin)).toHaveLength(2);
    await call('DELETE', `/v1/community/posts/${p.id}`, alice.token);
    expect(await reports(admin)).toEqual([]);
    expect((await prisma.report.findMany()).every((r) => r.resolution === 'deleted' && r.isOpen === null)).toBe(true);
    expect((await call('POST', `/v1/community/comments/${c.id}/report`, bob.token, { reason: 'spam' })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('hidden news', () => {
  it('lists hidden items and restores them (idempotent); expired stories are not listed', async () => {
    const admin = await adminToken(app, prisma);
    const created = await call('POST', '/v1/admin/news', admin, { title: 'Live tonight', text: '20:00' });
    expect(created.statusCode).toBe(201);
    const item = NewsItemSchema.parse(created.json());
    expect((await call('DELETE', `/v1/admin/news/${item.id}`, admin)).statusCode).toBe(204);
    await prisma.newsItem.create({
      data: {
        dedupeKey: 'instagram_story:old',
        source: 'instagram_story',
        links: {},
        publishedAt: new Date(clock.now().getTime() - 2 * 86_400_000),
        expiresAt: new Date(clock.now().getTime() - 86_400_000),
        hiddenAt: clock.now(),
      },
    });

    const hidden = HiddenNewsListSchema.parse((await call('GET', '/v1/admin/news/hidden', admin)).json());
    expect(hidden.items.map((h) => h.item.id)).toEqual([item.id]);
    expect(hidden.items[0]?.hiddenAt).toBe(clock.now().toISOString());
    expect(NewsPageSchema.parse((await call('GET', '/v1/news', null)).json()).items).toEqual([]);

    expect((await call('POST', `/v1/admin/news/${item.id}/restore`, admin)).statusCode).toBe(204);
    expect((await call('POST', `/v1/admin/news/${item.id}/restore`, admin)).statusCode).toBe(204);
    expect(NewsPageSchema.parse((await call('GET', '/v1/news', null)).json()).items.map((i) => i.id)).toEqual([item.id]);
    expect(HiddenNewsListSchema.parse((await call('GET', '/v1/admin/news/hidden', admin)).json()).items).toEqual([]);
    expect((await call('POST', '/v1/admin/news/nope/restore', admin)).statusCode).toBe(404);
  });
});
