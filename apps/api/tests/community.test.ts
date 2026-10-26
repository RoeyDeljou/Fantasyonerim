import {
  ApiErrorSchema,
  CommentPageSchema,
  CommunityPageSchema,
  CommunityPostSchema,
  LikeResultSchema,
  type AuthResponse,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupJob } from '../src/jobs/fpl.js';
import { createComment, createPost, makeFullPicks, makeImage, multipart, upload } from './communityFixtures.js';
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
const HOUR = 3_600_000;

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;
let media: MemoryMediaStore;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  push = new FakePushProvider();
  media = new MemoryMediaStore();
  ({ app, fpl, clock } = await buildTestApp(prisma, { push, media }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

function errorOf(res: { json: () => unknown }) {
  return ApiErrorSchema.parse(res.json()).error;
}

async function post(token: string | null, url: string, payload?: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: token === null ? {} : bearer(token),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function get(url: string, token: string | null = null) {
  return app.inject({ method: 'GET', url, headers: token === null ? {} : bearer(token) });
}

async function uploadRaw(token: string, bytes: Uint8Array, part: { filename?: string; contentType?: string; field?: string } = {}) {
  const body = multipart({ ...part, bytes });
  return app.inject({
    method: 'POST',
    url: '/v1/uploads',
    headers: { ...bearer(token), ...body.headers },
    payload: body.payload,
  });
}

// ---------------------------------------------------------------------------------------------------------
describe('POST /v1/uploads', () => {
  it('re-encodes to webp, auto-rotates by EXIF orientation and strips all metadata (EXIF / GPS)', async () => {
    const fan = await registerUser(app, fpl, 101);
    const original = await makeImage('jpeg', 300, 100, { orientation: 6, exif: true });
    const before = await sharp(original).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);

    const res = await upload(app, fan.token, original);
    // Orientation 6 = rotate 90°: the 300×100 sensor image is a 100×300 portrait.
    expect(res.image).toMatchObject({ width: 100, height: 300 });
    const key = `uploads/${fan.user.id}/${res.uploadId}.webp`;
    expect(res.image.url).toBe(`https://media.test/${key}`);
    const stored = media.objects.get(key);
    expect(stored?.contentType).toBe('image/webp');

    const after = await sharp(Buffer.from(stored?.bytes ?? new Uint8Array())).metadata();
    expect(after.format).toBe('webp');
    expect(after.width).toBe(100);
    expect(after.height).toBe(300);
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(Buffer.from(stored?.bytes ?? new Uint8Array()).includes('Secret Model')).toBe(false);

    const row = await prisma.upload.findUniqueOrThrow({ where: { id: res.uploadId } });
    expect(row).toMatchObject({ ownerId: fan.user.id, storageKey: key, width: 100, height: 300, usedAt: null });
  });

  it('fits large images inside 2048 px (never upscales small ones); accepts png and webp', async () => {
    const fan = await registerUser(app, fpl, 102);
    const big = await upload(app, fan.token, await makeImage('png', 4000, 1000), { filename: 'x.png', contentType: 'image/png' });
    expect(big.image).toMatchObject({ width: 2048, height: 512 });
    const small = await upload(app, fan.token, await makeImage('webp', 640, 480), { filename: 'x.webp', contentType: 'image/webp' });
    expect(small.image).toMatchObject({ width: 640, height: 480 });
    // The declared type is ignored: a PNG sent as image/jpeg is fine (bytes decide).
    const mislabeled = await upload(app, fan.token, await makeImage('png', 50, 60), { filename: 'a.jpg' });
    expect(mislabeled.image).toMatchObject({ width: 50, height: 60 });
  });

  it('415 for a non-image renamed .jpg, an unknown format, or a corrupt image', async () => {
    const fan = await registerUser(app, fpl, 103);
    const text = Buffer.from('<html><script>alert(1)</script></html> definitely not a photo');
    const res = await uploadRaw(fan.token, text, { filename: 'evil.jpg', contentType: 'image/jpeg' });
    expect(res.statusCode).toBe(415);
    expect(errorOf(res).message).toMatch(/Unsupported image type/);

    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    expect((await uploadRaw(fan.token, gif, { filename: 'a.gif', contentType: 'image/gif' })).statusCode).toBe(415);

    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    const bad = await uploadRaw(fan.token, corrupt);
    expect(bad.statusCode).toBe(415);
    expect(errorOf(bad).message).toMatch(/couldn't be read/);
    expect(await prisma.upload.count()).toBe(0);
    expect(media.objects.size).toBe(0);
  });

  it('413 for files over 10 MB', async () => {
    const fan = await registerUser(app, fpl, 104);
    const jpeg = await makeImage('jpeg', 10, 10);
    const huge = Buffer.concat([jpeg, Buffer.alloc(10 * 1024 * 1024 + 1 - jpeg.length)]);
    const res = await uploadRaw(fan.token, huge);
    expect(res.statusCode).toBe(413);
    expect(errorOf(res).message).toMatch(/10 MB/);
    expect(await prisma.upload.count()).toBe(0);
  });

  it('401 anonymous, 400 without a multipart "file" field or with an empty file', async () => {
    const fan = await registerUser(app, fpl, 105);
    const body = multipart({ bytes: await makeImage('jpeg', 10, 10) });
    const anon = await app.inject({ method: 'POST', url: '/v1/uploads', headers: body.headers, payload: body.payload });
    expect(anon.statusCode).toBe(401);
    expect((await post(fan.token, '/v1/uploads', { file: 'x' })).statusCode).toBe(400);
    const wrongField = await uploadRaw(fan.token, await makeImage('jpeg', 10, 10), { field: 'image' });
    expect(wrongField.statusCode).toBe(400);
    expect((await uploadRaw(fan.token, new Uint8Array())).statusCode).toBe(400);
  });

  it('a post may only use your own, unused upload; the cleanup job deletes stale unused uploads', async () => {
    const alice = await registerUser(app, fpl, 106, 'Alice');
    const bob = await registerUser(app, fpl, 107, 'Bob');
    const img = await upload(app, alice.token, await makeImage('jpeg', 200, 100));

    const stolen = await post(bob.token, '/v1/community/posts', { uploadId: img.uploadId });
    expect(stolen.statusCode).toBe(400);
    expect(errorOf(stolen).message).toMatch(/uploadId/);
    expect((await post(alice.token, '/v1/community/posts', { uploadId: 'nope' })).statusCode).toBe(400);

    const created = await createPost(app, alice.token, { text: 'My new kit', uploadId: img.uploadId });
    expect(created.image).toEqual(img.image);
    const reuse = await post(alice.token, '/v1/community/posts', { text: 'again', uploadId: img.uploadId });
    expect(reuse.statusCode).toBe(400);
    expect(await prisma.communityPost.count()).toBe(1);

    const stale = await upload(app, alice.token, await makeImage('jpeg', 20, 20));
    clock.advance(23 * HOUR);
    const fresh = await upload(app, alice.token, await makeImage('jpeg', 20, 20));
    clock.advance(2 * HOUR);
    const run = await app.jobs.run(cleanupJob.name, { force: true });
    expect(run).toBe('ok');
    const remaining = (await prisma.upload.findMany()).map((u) => u.id).sort();
    expect(remaining).toEqual([img.uploadId, fresh.uploadId].sort());
    expect(media.deleted).toEqual([`uploads/${alice.user.id}/${stale.uploadId}.webp`]);
    // Still idempotent: a second run deletes nothing more.
    await app.jobs.run(cleanupJob.name, { force: true });
    expect(media.deleted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('posts', () => {
  it('creates a text post (trimmed, newlines kept) and validates text', async () => {
    const fan = await registerUser(app, fpl, 201, 'Dana');
    const p = await createPost(app, fan.token, { text: '  Line one\r\nLine two\tend  ' });
    expect(p).toMatchObject({
      text: 'Line one\nLine two\tend',
      image: null,
      team: null,
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
      mine: true,
      author: { id: fan.user.id, name: 'Dana', entryId: 201, teamName: 'Team 201', role: 'user' },
    });

    for (const payload of [{}, { text: '   ' }, { text: 'x'.repeat(1001) }, { text: 'bell\u0007' }, { text: 'nul\u0000' }, { text: 5 }]) {
      const res = await post(fan.token, '/v1/community/posts', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errorOf(res).code).toBe('bad_request');
    }
    expect((await post(fan.token, '/v1/community/posts', { text: 'x'.repeat(1000) })).statusCode).toBe(201);
    expect((await post(null, '/v1/community/posts', { text: 'hi' })).statusCode).toBe(401);
    const badJson = await app.inject({
      method: 'POST',
      url: '/v1/community/posts',
      headers: { ...bearer(fan.token), 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(badJson.statusCode).toBe(400);
  });

  it('freezes a team snapshot of a started GW; later FPL changes do not alter it', async () => {
    const fan = await registerUser(app, fpl, 202);
    fpl.picks.set('202:9', makeFullPicks(202, 9, 71));
    fpl.picks.set('202:8', makeFullPicks(202, 8, 50));
    const p = await createPost(app, fan.token, { text: 'Rate my GW9', shareTeamEvent: 9 });
    expect(p.team).toMatchObject({
      entryId: 202,
      event: 9,
      teamName: 'Team 202',
      managerName: 'Manager 202',
      points: 71,
      overallRank: 4321,
      activeChip: null,
    });
    expect(p.team?.picks).toHaveLength(15);
    expect(p.team?.picks[0]).toMatchObject({ playerId: 1, isCaptain: true, multiplier: 2 });

    // Past GW, no text: allowed (team alone is enough).
    const past = await createPost(app, fan.token, { shareTeamEvent: 8 });
    expect(past.team?.points).toBe(50);

    // FPL data changes afterwards (transfers, renamed team) — the post keeps its snapshot.
    fpl.picks.set('202:9', makeFullPicks(202, 9, 99, 100));
    fpl.addEntry(202, 'Renamed FC');
    const again = CommunityPostSchema.parse((await get(`/v1/community/posts/${p.id}`)).json());
    expect(again.team).toEqual(p.team);
  });

  it('400 for a future GW, an account without a team, or a GW the team has no picks for', async () => {
    const fan = await registerUser(app, fpl, 203);
    fpl.picks.set('203:10', makeFullPicks(203, 10));
    const future = await post(fan.token, '/v1/community/posts', { text: 'next week', shareTeamEvent: 10 });
    expect(future.statusCode).toBe(400);
    expect(errorOf(future).message).toMatch(/hasn't started/);

    const missing = await post(fan.token, '/v1/community/posts', { shareTeamEvent: 9 });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing).message).toMatch(/no picks/);

    fpl.bootstrap = { ...fpl.bootstrap, currentEvent: null };
    expect((await post(fan.token, '/v1/community/posts', { shareTeamEvent: 1 })).statusCode).toBe(400);

    const admin = await adminToken(app, prisma);
    const noTeam = await post(admin, '/v1/community/posts', { text: 'mine', shareTeamEvent: 9 });
    expect(noTeam.statusCode).toBe(400);
    expect(errorOf(noTeam).message).toMatch(/no FPL team/);
    expect((await post(fan.token, '/v1/community/posts', { shareTeamEvent: 39 })).statusCode).toBe(400);
    expect(await prisma.communityPost.count()).toBe(0);
  });

  it('paginates newest-first with a keyset cursor and filters by author', async () => {
    const a = await registerUser(app, fpl, 204);
    const b = await registerUser(app, fpl, 205);
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      // Several posts share a timestamp: the id tie-breaker must keep pages stable.
      if (i % 3 === 0) clock.advance(1000);
      ids.push((await createPost(app, i % 2 === 0 ? a.token : b.token, { text: `post ${i}` })).id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/community/posts?limit=10${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = CommunityPageSchema.parse((await get(url)).json());
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    const page1 = CommunityPageSchema.parse((await get('/v1/community/posts?limit=25')).json());
    expect(page1.items.map((p) => p.text)[0]).toBe('post 24');
    expect(page1.nextCursor).toBeNull();
    expect(seen).toEqual(page1.items.map((p) => p.id));

    const mine = CommunityPageSchema.parse((await get(`/v1/community/posts?authorId=${b.user.id}`)).json());
    expect(mine.items).toHaveLength(12);
    expect(mine.items.every((p) => p.author.id === b.user.id)).toBe(true);

    expect((await get('/v1/community/posts?cursor=garbage')).statusCode).toBe(400);
    expect((await get('/v1/community/posts?limit=51')).statusCode).toBe(400);
    expect((await get('/v1/community/posts?limit=0')).statusCode).toBe(400);
    expect((await get('/v1/community/posts?limit=')).statusCode).toBe(200);
  });

  it('likedByMe / mine are per viewer (anonymous → false); delete own or admin, others 403', async () => {
    const alice = await registerUser(app, fpl, 206);
    const bob = await registerUser(app, fpl, 207);
    const p = await createPost(app, alice.token);
    await app.inject({ method: 'PUT', url: `/v1/community/posts/${p.id}/like`, headers: bearer(bob.token) });

    const asBob = CommunityPostSchema.parse((await get(`/v1/community/posts/${p.id}`, bob.token)).json());
    expect(asBob).toMatchObject({ likedByMe: true, mine: false, likeCount: 1 });
    const asAlice = CommunityPageSchema.parse((await get('/v1/community/posts', alice.token)).json());
    expect(asAlice.items[0]).toMatchObject({ likedByMe: false, mine: true });
    const anon = CommunityPostSchema.parse((await get(`/v1/community/posts/${p.id}`, 'bad-token')).json());
    expect(anon).toMatchObject({ likedByMe: false, mine: false });

    const del = (token: string, id = p.id) =>
      app.inject({ method: 'DELETE', url: `/v1/community/posts/${id}`, headers: bearer(token) });
    const forbidden = await del(bob.token);
    expect(forbidden.statusCode).toBe(403);
    expect((await del(alice.token)).statusCode).toBe(204);
    expect((await del(alice.token)).statusCode).toBe(404);
    expect((await get(`/v1/community/posts/${p.id}`)).statusCode).toBe(404);
    expect(CommunityPageSchema.parse((await get('/v1/community/posts')).json()).items).toHaveLength(0);
    const row = await prisma.communityPost.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.deletedBy).toBe(alice.user.id);

    const admin = await adminToken(app, prisma);
    const other = await createPost(app, bob.token);
    expect((await del(admin, other.id)).statusCode).toBe(204);
    expect((await get('/v1/community/posts/nope')).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/community/posts/${other.id}` })).statusCode).toBe(401);
  });

  it('admin posts carry role "admin"', async () => {
    const admin = await adminToken(app, prisma);
    const p = await createPost(app, admin, { text: 'Welcome to the community!' });
    expect(p.author).toMatchObject({ role: 'admin', entryId: null, teamName: null });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('likes, comments and counters', () => {
  it('keeps likeCount / commentCount correct across like/unlike/comment/delete (idempotent)', async () => {
    const alice = await registerUser(app, fpl, 301);
    const bob = await registerUser(app, fpl, 302);
    const carol = await registerUser(app, fpl, 303);
    const p = await createPost(app, alice.token);
    const like = async (token: string, method: 'PUT' | 'DELETE') => {
      const res = await app.inject({ method, url: `/v1/community/posts/${p.id}/like`, headers: bearer(token) });
      expect(res.statusCode).toBe(200);
      return LikeResultSchema.parse(res.json());
    };
    expect(await like(bob.token, 'PUT')).toEqual({ likeCount: 1, likedByMe: true });
    expect(await like(bob.token, 'PUT')).toEqual({ likeCount: 1, likedByMe: true });
    expect(await like(carol.token, 'PUT')).toEqual({ likeCount: 2, likedByMe: true });
    expect(await like(alice.token, 'PUT')).toEqual({ likeCount: 3, likedByMe: true });
    expect(await like(bob.token, 'DELETE')).toEqual({ likeCount: 2, likedByMe: false });
    expect(await like(bob.token, 'DELETE')).toEqual({ likeCount: 2, likedByMe: false });
    // Concurrent duplicate likes still count once.
    await Promise.all([like(bob.token, 'PUT'), like(bob.token, 'PUT'), like(bob.token, 'PUT')]);
    expect(await prisma.postLike.count({ where: { postId: p.id } })).toBe(3);

    const c1 = await createComment(app, bob.token, p.id, 'first');
    await createComment(app, carol.token, p.id, 'second');
    await Promise.all([createComment(app, bob.token, p.id, 'x'), createComment(app, carol.token, p.id, 'y')]);
    let row = await prisma.communityPost.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ likeCount: 3, commentCount: 4 });

    const delComment = (token: string, id: string) =>
      app.inject({ method: 'DELETE', url: `/v1/community/comments/${id}`, headers: bearer(token) });
    expect((await delComment(carol.token, c1.id)).statusCode).toBe(403);
    expect((await delComment(bob.token, c1.id)).statusCode).toBe(204);
    expect((await delComment(bob.token, c1.id)).statusCode).toBe(404);
    row = await prisma.communityPost.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.commentCount).toBe(3);
    const fetched = CommunityPostSchema.parse((await get(`/v1/community/posts/${p.id}`)).json());
    expect(fetched).toMatchObject({ likeCount: 3, commentCount: 3 });
    const comments = CommentPageSchema.parse((await get(`/v1/community/posts/${p.id}/comments`)).json());
    expect(comments.items.map((c) => c.text)).not.toContain('first');

    // An admin can delete anyone's comment.
    const admin = await adminToken(app, prisma);
    const c2 = comments.items[0];
    expect((await delComment(admin, c2?.id ?? '')).statusCode).toBe(204);
    expect((await prisma.communityPost.findUniqueOrThrow({ where: { id: p.id } })).commentCount).toBe(2);

    // Deleted post: likes / comments / comment list all 404.
    await app.inject({ method: 'DELETE', url: `/v1/community/posts/${p.id}`, headers: bearer(alice.token) });
    expect((await app.inject({ method: 'PUT', url: `/v1/community/posts/${p.id}/like`, headers: bearer(bob.token) })).statusCode).toBe(404);
    expect((await post(bob.token, `/v1/community/posts/${p.id}/comments`, { text: 'hello?' })).statusCode).toBe(404);
    expect((await get(`/v1/community/posts/${p.id}/comments`)).statusCode).toBe(404);
    const remaining = await prisma.comment.findFirstOrThrow({ where: { postId: p.id, deletedAt: null } });
    expect((await delComment(remaining.authorId === bob.user.id ? bob.token : carol.token, remaining.id)).statusCode).toBe(404);
  });

  it('lists comments oldest-first with a cursor; validates comment text', async () => {
    const alice = await registerUser(app, fpl, 304);
    const bob = await registerUser(app, fpl, 305);
    const p = await createPost(app, alice.token);
    for (let i = 0; i < 7; i += 1) {
      if (i % 2 === 0) clock.advance(1000);
      await createComment(app, i % 2 === 0 ? bob.token : alice.token, p.id, `c${i}`);
    }
    const first = CommentPageSchema.parse((await get(`/v1/community/posts/${p.id}/comments?limit=4`, bob.token)).json());
    expect(first.items.map((c) => c.text)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(first.items.map((c) => c.mine)).toEqual([true, false, true, false]);
    expect(first.items[0]?.author.id).toBe(bob.user.id);
    const second = CommentPageSchema.parse(
      (await get(`/v1/community/posts/${p.id}/comments?limit=4&cursor=${first.nextCursor ?? ''}`)).json(),
    );
    expect(second.items.map((c) => c.text)).toEqual(['c4', 'c5', 'c6']);
    expect(second.nextCursor).toBeNull();
    expect(second.items.every((c) => !c.mine)).toBe(true);

    for (const payload of [{}, { text: '  ' }, { text: 'x'.repeat(501) }, { text: 'esc\u001b[31m' }]) {
      const res = await post(bob.token, `/v1/community/posts/${p.id}/comments`, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await post(null, `/v1/community/posts/${p.id}/comments`, { text: 'hi' })).statusCode).toBe(401);
    expect((await post(bob.token, '/v1/community/posts/missing/comments', { text: 'hi' })).statusCode).toBe(404);
    expect((await get(`/v1/community/posts/${p.id}/comments?cursor=%%%`)).statusCode).toBe(400);
    expect((await get('/v1/community/posts/missing/comments')).statusCode).toBe(404);
  });

  it('pushes the post author once per comment (he/en copy), never for your own comment, honours prefs', async () => {
    const author = await registerUser(app, fpl, 306, 'Author');
    const fan = await registerUser(app, fpl, 307, 'Noa');
    await subscribe(app, author.token, 'https://push.test/author-phone');
    await subscribe(app, author.token, 'https://push.test/author-laptop');
    await subscribe(app, fan.token, 'https://push.test/fan');
    const p = await createPost(app, author.token);

    const long = 'Salah is the only captain this week, no doubt about it — Haaland blanks against them every time';
    const c = await createComment(app, fan.token, p.id, long);
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual([
      'https://push.test/author-laptop',
      'https://push.test/author-phone',
    ]);
    const payload = push.sent[0]?.payload;
    expect(payload?.title).toBe('💬 Noa הגיב/ה לפוסט שלך');
    expect(payload?.body.length).toBeLessThanOrEqual(60);
    expect(payload?.body.endsWith('…')).toBe(true);
    expect(long.startsWith(payload?.body.slice(0, -1) ?? '')).toBe(true);
    expect(payload?.url).toBe(`/community/?post=${p.id}`);
    expect(await prisma.notificationLog.findMany({ where: { key: `comment:${c.id}` } })).toHaveLength(1);

    // Own comment: nothing.
    push.sent = [];
    await createComment(app, author.token, p.id, 'thanks!');
    expect(push.sent).toHaveLength(0);

    // English locale.
    await prisma.user.update({ where: { id: author.user.id }, data: { locale: 'en' } });
    await createComment(app, fan.token, p.id, 'short one');
    expect(push.sent.map((s) => s.payload.title)).toEqual([
      '💬 Noa commented on your post',
      '💬 Noa commented on your post',
    ]);
    expect(push.sent[0]?.payload.body).toBe('short one');

    // prefs.community off → no push.
    push.sent = [];
    const prefs = await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(author.token),
      payload: { news: true, fpl: true, live: true, community: false },
    });
    expect(prefs.statusCode).toBe(200);
    await createComment(app, fan.token, p.id, 'muted');
    expect(push.sent).toHaveLength(0);
  });

  it('the dedupe key means the same comment is never announced twice', async () => {
    const author = await registerUser(app, fpl, 308);
    const fan = await registerUser(app, fpl, 309);
    await subscribe(app, author.token, 'https://push.test/a');
    const p = await createPost(app, author.token);
    const c = await createComment(app, fan.token, p.id);
    expect(push.sent).toHaveLength(1);
    // Simulate a retry of the same notification (e.g. a replayed request): the log row blocks it.
    const { notify } = await import('../src/push/notify.js');
    const again = await notify(
      { prisma, push, clock },
      {
        to: [author.user.id],
        pref: 'community',
        dedupeKeys: [`comment:${c.id}`],
        build: () => ({ title: 't', body: 'b', url: '/', tag: null, icon: null, image: null }),
      },
    );
    expect(again.recipients).toBe(0);
    expect(push.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('rate limits (per user, not per IP)', () => {
  let limited: FastifyInstance;
  let lfpl: FakeFplService;

  beforeEach(async () => {
    await app.close();
    ({ app: limited, fpl: lfpl } = await buildTestApp(prisma, {
      media,
      rateLimit: { postsPerHour: 2, commentsPerHour: 3, uploadsPerHour: 1, writeMax: 4 },
    }));
    app = limited;
  });

  async function users(): Promise<[AuthResponse, AuthResponse]> {
    return [await registerUser(limited, lfpl, 401), await registerUser(limited, lfpl, 402)];
  }

  it('posts: 429 after the hourly limit for that user only', async () => {
    const [a, b] = await users();
    await createPost(limited, a.token);
    await createPost(limited, a.token);
    const third = await post(a.token, '/v1/community/posts', { text: 'one more' });
    expect(third.statusCode).toBe(429);
    expect(errorOf(third).code).toBe('rate_limited');
    // Same IP, other account: still allowed.
    expect((await post(b.token, '/v1/community/posts', { text: 'mine' })).statusCode).toBe(201);
  });

  it('comments, uploads and likes are limited too', async () => {
    const [a, b] = await users();
    const p = await createPost(limited, b.token);
    for (let i = 0; i < 3; i += 1) await createComment(limited, a.token, p.id);
    expect((await post(a.token, `/v1/community/posts/${p.id}/comments`, { text: 'x' })).statusCode).toBe(429);
    expect((await post(b.token, `/v1/community/posts/${p.id}/comments`, { text: 'x' })).statusCode).toBe(201);

    await upload(limited, a.token, await makeImage('jpeg', 10, 10));
    expect((await uploadRaw(a.token, await makeImage('jpeg', 10, 10))).statusCode).toBe(429);

    const likeUrl = `/v1/community/posts/${p.id}/like`;
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await limited.inject({ method: 'PUT', url: likeUrl, headers: bearer(a.token) })).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 200, 429]);
  });
});
