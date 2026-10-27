import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LAST_ADMIN_MESSAGE } from '../src/account/deleteAccount.js';
import { cleanupJob } from '../src/jobs/fpl.js';
import { createComment, createPost, makeImage, upload } from './communityFixtures.js';
import { FakePushProvider, MemoryMediaStore, subscribe } from './fakes.js';
import type { FakeFplService } from './fakeFpl.js';
import {
  adminToken,
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  type TestAppOptions,
} from './helpers.js';

const prisma = createTestPrisma();

/** Media store whose deletes can be made to fail (storage briefly down). */
class FlakyMediaStore extends MemoryMediaStore {
  failDeletes = false;
  override async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error('storage unavailable');
    await super.delete(key);
  }
}

let app: FastifyInstance;
let fpl: FakeFplService;
let push: FakePushProvider;
let media: FlakyMediaStore;

async function boot(options: TestAppOptions = {}) {
  push = new FakePushProvider();
  media = new FlakyMediaStore();
  ({ app, fpl } = await buildTestApp(prisma, {
    push,
    media,
    config: { vapidPublicKey: 'BKEY' },
    ...options,
  }));
}

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  await boot();
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const del = (token: string | null, payload?: object) =>
  app.inject({
    method: 'DELETE',
    url: '/v1/me',
    ...(token === null ? {} : { headers: bearer(token) }),
    ...(payload === undefined ? {} : { payload }),
  });
const CONFIRM = { confirm: 'DELETE' };

async function inject(method: 'PUT' | 'POST', url: string, token: string, payload?: object) {
  const res = await app.inject({
    method,
    url,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload }),
  });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res;
}

/** Every row anywhere that still points at the user (directly or through their content). */
async function rowsReferencing(userId: string, postIds: string[], commentIds: string[]) {
  return {
    user: await prisma.user.count({ where: { id: userId } }),
    sessions: await prisma.session.count({ where: { userId } }),
    pushSubscriptions: await prisma.pushSubscription.count({ where: { userId } }),
    nativeDevices: await prisma.nativePushDevice.count({ where: { userId } }),
    prefs: await prisma.notificationPrefs.count({ where: { userId } }),
    notificationLog: await prisma.notificationLog.count({ where: { userId } }),
    posts: await prisma.communityPost.count({
      where: { OR: [{ authorId: userId }, { id: { in: postIds } }] },
    }),
    comments: await prisma.comment.count({
      where: { OR: [{ authorId: userId }, { id: { in: commentIds } }, { postId: { in: postIds } }] },
    }),
    likes: await prisma.postLike.count({ where: { OR: [{ userId }, { postId: { in: postIds } }] } }),
    reportsFiled: await prisma.report.count({ where: { reporterId: userId } }),
    reportsAbout: await prisma.report.count({
      where: {
        OR: [
          { targetKind: 'post', targetId: { in: postIds } },
          { targetKind: 'comment', targetId: { in: commentIds } },
        ],
      },
    }),
    uploads: await prisma.upload.count({ where: { ownerId: userId } }),
    blocks: await prisma.userBlock.count({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] } }),
    adminCredential: await prisma.adminCredential.count({ where: { userId } }),
  };
}

describe('DELETE /v1/me', () => {
  it('validates: 401 signed out, 400 without the exact confirmation', async () => {
    const fan = await registerUser(app, fpl, 101);
    expect((await del(null, CONFIRM)).statusCode).toBe(401);
    expect((await del('bogus-token', CONFIRM)).statusCode).toBe(401);
    for (const payload of [undefined, {}, { confirm: 'delete' }, { confirm: true }, { confirm: 'DELETE ' }]) {
      const res = await del(fan.token, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect(await prisma.user.count({ where: { id: fan.user.id } })).toBe(1);
  });

  it('deletes everything tied to the user, keeps other counters right, removes the stored photos', async () => {
    const a = await registerUser(app, fpl, 201, 'Leaving Fan');
    const b = await registerUser(app, fpl, 202, 'Staying Fan');
    await subscribe(app, a.token, 'https://push.test/a');
    await subscribe(app, b.token, 'https://push.test/b');
    await inject('POST', '/v1/push/devices', a.token, { platform: 'fcm', token: 'fcm-token-0123456789' });
    await inject('PUT', '/v1/me/notification-prefs', a.token, {
      news: true,
      fpl: false,
      live: true,
      community: true,
    });

    // A's content: a post with a photo, an unused upload, a comment + like on B's post, a like on their own post.
    const photo = await upload(app, a.token, await makeImage('png', 40, 30));
    const spare = await upload(app, a.token, await makeImage('png', 20, 20));
    const aPost = await createPost(app, a.token, { text: 'my post', uploadId: photo.uploadId });
    const bPost = await createPost(app, b.token, { text: 'B post' });
    const aComment = await createComment(app, a.token, bPost.id, 'A on B');
    await createComment(app, b.token, bPost.id, 'B on B');
    const bOnA = await createComment(app, b.token, aPost.id, 'B on A'); // notifies A → NotificationLog row
    await inject('PUT', `/v1/community/posts/${bPost.id}/like`, a.token);
    await inject('PUT', `/v1/community/posts/${bPost.id}/like`, b.token);
    await inject('PUT', `/v1/community/posts/${aPost.id}/like`, a.token);
    await inject('PUT', `/v1/community/posts/${aPost.id}/like`, b.token);
    // Reports both ways.
    await inject('POST', `/v1/community/posts/${aPost.id}/report`, b.token, { reason: 'spam' });
    await inject('POST', `/v1/community/comments/${aComment.id}/report`, b.token, { reason: 'abuse' });
    await inject('POST', `/v1/community/posts/${bPost.id}/report`, a.token, { reason: 'other' });
    // Blocks both ways.
    await inject('PUT', `/v1/community/blocks/${b.user.id}`, a.token);
    await inject('PUT', `/v1/community/blocks/${a.user.id}`, b.token);

    const before = await prisma.communityPost.findUniqueOrThrow({ where: { id: bPost.id } });
    expect([before.commentCount, before.likeCount]).toEqual([2, 2]);
    expect(await prisma.notificationLog.count({ where: { userId: a.user.id } })).toBeGreaterThan(0);
    const aKeys = [...media.objects.keys()].filter((k) => k.startsWith(`uploads/${a.user.id}/`));
    expect(aKeys).toHaveLength(2);

    const res = await del(a.token, CONFIRM);
    expect(res.statusCode).toBe(204);

    // The token stops working immediately.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(a.token) })).statusCode).toBe(
      401,
    );
    expect(await rowsReferencing(a.user.id, [aPost.id], [aComment.id, bOnA.id])).toEqual({
      user: 0,
      sessions: 0,
      pushSubscriptions: 0,
      nativeDevices: 0,
      prefs: 0,
      notificationLog: 0,
      posts: 0,
      comments: 0,
      likes: 0,
      reportsFiled: 0,
      reportsAbout: 0,
      uploads: 0,
      blocks: 0,
      adminCredential: 0,
    });
    // No stored files left behind, nothing pending.
    expect([...media.objects.keys()].filter((k) => k.includes(a.user.id))).toEqual([]);
    expect(media.deleted.sort()).toEqual(aKeys.sort());
    expect(await prisma.pendingMediaDelete.count()).toBe(0);
    expect(spare.uploadId).toBeTruthy();

    // B's post: only B's own comment + like remain, and the counters match.
    const after = await prisma.communityPost.findUniqueOrThrow({ where: { id: bPost.id } });
    expect([after.commentCount, after.likeCount]).toEqual([1, 1]);
    expect(await prisma.comment.count({ where: { postId: bPost.id, deletedAt: null } })).toBe(1);
    expect(await prisma.postLike.count({ where: { postId: bPost.id } })).toBe(1);
    // B is untouched and still signed in.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(b.token) })).statusCode).toBe(
      200,
    );
    expect(await prisma.pushSubscription.count({ where: { userId: b.user.id } })).toBe(1);
    // The feed no longer has A's post.
    const feed = await app.inject({ method: 'GET', url: '/v1/community/posts', headers: bearer(b.token) });
    expect(feed.json().items.map((p: { id: string }) => p.id)).toEqual([bPost.id]);
    // The Team ID is free to register again.
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { name: 'Back again', entryId: 201 },
    });
    expect(again.statusCode).toBe(201);
  });

  it('a soft-deleted comment does not over-decrement the counter', async () => {
    const a = await registerUser(app, fpl, 301);
    const b = await registerUser(app, fpl, 302);
    const bPost = await createPost(app, b.token);
    const gone = await createComment(app, a.token, bPost.id, 'removed later');
    await createComment(app, a.token, bPost.id, 'stays');
    await createComment(app, b.token, bPost.id, 'B');
    const rm = await app.inject({
      method: 'DELETE',
      url: `/v1/community/comments/${gone.id}`,
      headers: bearer(a.token),
    });
    expect(rm.statusCode).toBe(204);
    expect((await prisma.communityPost.findUniqueOrThrow({ where: { id: bPost.id } })).commentCount).toBe(2);
    expect((await del(a.token, CONFIRM)).statusCode).toBe(204);
    expect((await prisma.communityPost.findUniqueOrThrow({ where: { id: bPost.id } })).commentCount).toBe(1);
  });

  it('storage down: rows go, file keys are kept as pending and the hourly cleanup deletes them', async () => {
    const a = await registerUser(app, fpl, 401);
    const photo = await upload(app, a.token, await makeImage('png', 16, 16));
    await createPost(app, a.token, { text: 'pic', uploadId: photo.uploadId });
    media.failDeletes = true;
    expect((await del(a.token, CONFIRM)).statusCode).toBe(204);
    expect(await prisma.user.count({ where: { id: a.user.id } })).toBe(0);
    const pending = await prisma.pendingMediaDelete.findMany();
    expect(pending.map((p) => p.key)).toEqual([`uploads/${a.user.id}/${photo.uploadId}.webp`]);

    media.failDeletes = false;
    expect(await app.jobs.run(cleanupJob.name, { force: true })).toBe('ok');
    expect(await prisma.pendingMediaDelete.count()).toBe(0);
    expect([...media.objects.keys()].filter((k) => k.includes(a.user.id))).toEqual([]);
  });

  it('a banned user can still delete their account', async () => {
    const a = await registerUser(app, fpl, 501);
    await prisma.user.update({ where: { id: a.user.id }, data: { bannedAt: new Date(), banReason: 'spam' } });
    expect((await del(a.token, CONFIRM)).statusCode).toBe(204);
    expect(await prisma.user.count({ where: { id: a.user.id } })).toBe(0);
  });

  it('the last admin gets 409; with another admin it works and broadcast history keeps the name', async () => {
    const admin = await adminToken(app, prisma);
    const res = await del(admin, CONFIRM);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code: 'conflict', message: LAST_ADMIN_MESSAGE });
    expect(await prisma.adminCredential.count()).toBe(1);

    const sent = await app.inject({
      method: 'POST',
      url: '/v1/admin/broadcast',
      headers: bearer(admin),
      payload: { text: 'גול!', targets: ['news'] },
    });
    expect(sent.statusCode).toBe(201);
    const other = await adminToken(app, prisma, 'dor', 'dors password 123');
    const adminId = (await prisma.adminCredential.findUniqueOrThrow({ where: { username: 'admin' } })).userId;
    expect((await del(admin, CONFIRM)).statusCode).toBe(204);
    expect(await rowsReferencing(adminId, [], [])).toMatchObject({
      user: 0,
      adminCredential: 0,
      sessions: 0,
    });

    const history = await app.inject({ method: 'GET', url: '/v1/admin/broadcasts', headers: bearer(other) });
    expect(history.json().items[0].sentBy).toBe('admin');
    // Now dor is the last admin.
    expect((await del(other, CONFIRM)).statusCode).toBe(409);
  });

  it('is rate-limited like other writes', async () => {
    await app.close();
    await resetDb(prisma);
    await boot({ rateLimit: { writeMax: 2 } });
    const a = await registerUser(app, fpl, 601);
    expect((await del(a.token, {})).statusCode).toBe(400);
    expect((await del(a.token, {})).statusCode).toBe(400);
    expect((await del(a.token, CONFIRM)).statusCode).toBe(429);
    expect(await prisma.user.count({ where: { id: a.user.id } })).toBe(1);
  });
});
