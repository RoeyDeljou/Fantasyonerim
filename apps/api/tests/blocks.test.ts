import { BlockListSchema, CommentPageSchema, CommunityPageSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createComment, createPost } from './communityFixtures.js';
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
  type TestClock,
} from './helpers.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  push = new FakePushProvider();
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    push,
    media: new MemoryMediaStore(),
    config: { vapidPublicKey: 'BKEY' },
  }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const auth = (token: string | null) => (token === null ? {} : { headers: bearer(token) });
const block = (token: string | null, userId: string) =>
  app.inject({ method: 'PUT', url: `/v1/community/blocks/${userId}`, ...auth(token) });
const unblock = (token: string | null, userId: string) =>
  app.inject({ method: 'DELETE', url: `/v1/community/blocks/${userId}`, ...auth(token) });

async function feed(token: string | null, query = '') {
  const res = await app.inject({ method: 'GET', url: `/v1/community/posts${query}`, ...auth(token) });
  expect(res.statusCode).toBe(200);
  return CommunityPageSchema.parse(res.json()).items.map((p) => p.id);
}

async function thread(token: string | null, postId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/community/posts/${postId}/comments`,
    ...auth(token),
  });
  return {
    status: res.statusCode,
    ids: res.statusCode === 200 ? CommentPageSchema.parse(res.json()).items.map((c) => c.id) : [],
  };
}

const single = async (token: string | null, postId: string) =>
  (await app.inject({ method: 'GET', url: `/v1/community/posts/${postId}`, ...auth(token) })).statusCode;

describe('user blocking', () => {
  it('validation: 401 signed out, 400 self/admin, 404 unknown user', async () => {
    const a = await registerUser(app, fpl, 11);
    const b = await registerUser(app, fpl, 12);
    await adminToken(app, prisma);
    const adminId = (await prisma.adminCredential.findFirstOrThrow()).userId;

    expect((await block(null, b.user.id)).statusCode).toBe(401);
    expect((await unblock(null, b.user.id)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/community/blocks' })).statusCode).toBe(401);

    const self = await block(a.token, a.user.id);
    expect(self.statusCode).toBe(400);
    expect(self.json().error.message).toMatch(/yourself/);
    expect((await unblock(a.token, a.user.id)).statusCode).toBe(400);
    const adm = await block(a.token, adminId);
    expect(adm.statusCode).toBe(400);
    expect(adm.json().error.message).toMatch(/Admins/);
    expect((await block(a.token, 'no-such-user')).statusCode).toBe(404);
    expect((await unblock(a.token, 'no-such-user')).statusCode).toBe(404);
    expect(await prisma.userBlock.count()).toBe(0);
  });

  it('is idempotent and lists blocks newest first', async () => {
    const a = await registerUser(app, fpl, 21);
    const b = await registerUser(app, fpl, 22, 'Bee');
    const c = await registerUser(app, fpl, 23, 'Cee');
    expect((await block(a.token, b.user.id)).statusCode).toBe(204);
    expect((await block(a.token, b.user.id)).statusCode).toBe(204);
    clock.advance(60_000);
    expect((await block(a.token, c.user.id)).statusCode).toBe(204);

    const res = await app.inject({ method: 'GET', url: '/v1/community/blocks', headers: bearer(a.token) });
    expect(res.statusCode).toBe(200);
    const list = BlockListSchema.parse(res.json());
    expect(list.items.map((i) => [i.id, i.name, i.teamName])).toEqual([
      [c.user.id, 'Cee', 'Team 23'],
      [b.user.id, 'Bee', 'Team 22'],
    ]);
    expect(list.items[0]?.blockedAt).toBe(clock.now().toISOString());

    expect((await unblock(a.token, b.user.id)).statusCode).toBe(204);
    expect((await unblock(a.token, b.user.id)).statusCode).toBe(204);
    const after = BlockListSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/community/blocks', headers: bearer(a.token) })).json(),
    );
    expect(after.items.map((i) => i.id)).toEqual([c.user.id]);
    // Private and one-way: c's list is empty.
    const cList = await app.inject({ method: 'GET', url: '/v1/community/blocks', headers: bearer(c.token) });
    expect(BlockListSchema.parse(cList.json()).items).toEqual([]);
  });

  it('hides the blocked user’s posts and comments from the blocker in every read path', async () => {
    const a = await registerUser(app, fpl, 31); // blocker
    const b = await registerUser(app, fpl, 32); // blocked
    const c = await registerUser(app, fpl, 33); // bystander
    const cPost = await createPost(app, c.token, { text: 'C post' });
    clock.advance(1000);
    const bPost = await createPost(app, b.token, { text: 'B post' });
    const bComment = await createComment(app, b.token, cPost.id, 'B on C');
    const cComment = await createComment(app, c.token, cPost.id, 'C on C');
    const bOnB = await createComment(app, c.token, bPost.id, 'C on B');

    expect((await block(a.token, b.user.id)).statusCode).toBe(204);

    // Feed, author filter, single post, threads.
    expect(await feed(a.token)).toEqual([cPost.id]);
    expect(await feed(a.token, `?authorId=${b.user.id}`)).toEqual([]);
    expect(await feed(a.token, `?authorId=${c.user.id}`)).toEqual([cPost.id]);
    expect(await single(a.token, bPost.id)).toBe(404);
    expect(await single(a.token, cPost.id)).toBe(200);
    expect(await thread(a.token, cPost.id)).toEqual({ status: 200, ids: [cComment.id] });
    expect((await thread(a.token, bPost.id)).status).toBe(404);

    // Everyone else still sees everything; counters stay global.
    for (const viewer of [c.token, b.token, null]) {
      expect(await feed(viewer)).toEqual([bPost.id, cPost.id]);
      expect(await feed(viewer, `?authorId=${b.user.id}`)).toEqual([bPost.id]);
      expect(await single(viewer, bPost.id)).toBe(200);
      expect(await thread(viewer, cPost.id)).toEqual({ status: 200, ids: [bComment.id, cComment.id] });
      expect(await thread(viewer, bPost.id)).toEqual({ status: 200, ids: [bOnB.id] });
    }
    const seenByA = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${cPost.id}`,
      headers: bearer(a.token),
    });
    expect(seenByA.json().commentCount).toBe(2);

    // Unblocking restores everything.
    expect((await unblock(a.token, b.user.id)).statusCode).toBe(204);
    expect(await feed(a.token)).toEqual([bPost.id, cPost.id]);
    expect(await single(a.token, bPost.id)).toBe(200);
    expect(await thread(a.token, cPost.id)).toEqual({ status: 200, ids: [bComment.id, cComment.id] });
  });

  it('no comment notification from a blocked user; others still notify', async () => {
    const a = await registerUser(app, fpl, 41);
    const b = await registerUser(app, fpl, 42, 'Blocked Bob');
    const c = await registerUser(app, fpl, 43, 'Carol');
    await subscribe(app, a.token, 'https://push.test/a');
    const aPost = await createPost(app, a.token, { text: 'mine' });
    expect((await block(a.token, b.user.id)).statusCode).toBe(204);

    await createComment(app, b.token, aPost.id, 'from blocked');
    expect(push.sent).toHaveLength(0);
    await createComment(app, c.token, aPost.id, 'from carol');
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload.title).toContain('Carol');
  });

  it('banned users can block and unblock', async () => {
    const a = await registerUser(app, fpl, 51);
    const b = await registerUser(app, fpl, 52);
    await prisma.user.update({ where: { id: a.user.id }, data: { bannedAt: new Date(), banReason: 'x' } });
    expect((await block(a.token, b.user.id)).statusCode).toBe(204);
    expect((await unblock(a.token, b.user.id)).statusCode).toBe(204);
  });

  it('blocks disappear with either account', async () => {
    const a = await registerUser(app, fpl, 61);
    const b = await registerUser(app, fpl, 62);
    expect((await block(a.token, b.user.id)).statusCode).toBe(204);
    await prisma.user.delete({ where: { id: b.user.id } });
    expect(await prisma.userBlock.count()).toBe(0);
  });
});
