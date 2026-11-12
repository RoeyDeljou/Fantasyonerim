import {
  AdminUserListSchema,
  AdminUserSchema,
  ApiErrorSchema,
  AuthResponseSchema,
  AvatarResponseSchema,
  CommentPageSchema,
  CommunityPageSchema,
  LeagueAvatarsSchema,
  MeSchema,
  type AvatarResponse,
} from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AVATAR_SIDE } from '../src/community/images.js';
import { cleanupJob } from '../src/jobs/fpl.js';
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
} from './helpers.js';

const prisma = createTestPrisma();

/** A MediaStore whose deletes can be made to fail (the old-photo delete is best-effort). */
class FlakyMediaStore extends MemoryMediaStore {
  failDeletes = false;
  override async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error('bucket down');
    return super.delete(key);
  }
}

let app: FastifyInstance;
let fpl: FakeFplService;

let media: FlakyMediaStore;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  media = new FlakyMediaStore();
  ({ app, fpl } = await buildTestApp(prisma, { media }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const errorOf = (res: { json: () => unknown }) => ApiErrorSchema.parse(res.json()).error;

async function uploadAvatarRaw(token: string | null, bytes: Uint8Array, part: { field?: string } = {}) {
  const body = multipart({ ...part, bytes });
  return app.inject({
    method: 'POST',
    url: '/v1/me/avatar',
    headers: { ...(token === null ? {} : bearer(token)), ...body.headers },
    payload: body.payload,
  });
}

async function uploadAvatar(token: string, bytes: Uint8Array): Promise<AvatarResponse> {
  const res = await uploadAvatarRaw(token, bytes);
  if (res.statusCode !== 200) throw new Error(`avatar upload failed: ${res.statusCode} ${res.body}`);
  return AvatarResponseSchema.parse(res.json());
}

/** The MediaStore key behind a returned URL (MemoryMediaStore URLs are `https://media.test/<key>`). */
const keyOf = (url: string | null) => (url ?? '').replace('https://media.test/', '');

async function leagueAvatars() {
  const res = await app.inject({ method: 'GET', url: '/v1/league/avatars' });
  expect(res.statusCode).toBe(200);
  return { res, body: LeagueAvatarsSchema.parse(res.json()) };
}

// ---------------------------------------------------------------------------------------------------------
describe('POST /v1/me/avatar', () => {
  it('stores ONE 256×256 JPEG (auto-rotated, centre-cropped, no metadata) and returns the updated Me', async () => {
    const fan = await registerUser(app, fpl, 501);
    expect(fan.user.avatarUrl).toBeNull();
    // A 600×200 landscape sensor image with EXIF orientation 6 (portrait) + GPS + camera tags.
    const original = await makeImage('jpeg', 600, 200, { orientation: 6, exif: true });
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const res = await uploadAvatar(fan.token, original);
    expect(res.user).toMatchObject({ id: fan.user.id, name: fan.user.name, canPost: true });
    const url = res.user.avatarUrl;
    expect(url).toMatch(new RegExp(`^https://media\\.test/uploads/avatars/${fan.user.id}/[\\w-]+\\.jpg$`));

    expect(media.objects.size).toBe(1);
    const stored = media.objects.get(keyOf(url));
    expect(stored?.contentType).toBe('image/jpeg');
    const bytes = Buffer.from(stored?.bytes ?? new Uint8Array());
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: AVATAR_SIDE, height: AVATAR_SIDE });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(bytes.includes('Secret Model')).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: fan.user.id } });
    expect(row.avatarUrl).toBe(url);
    expect(row.avatarKey).toBe(keyOf(url));

    // Me carries it everywhere: GET /v1/me, PATCH /v1/me, and sign-in.
    const me = MeSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(fan.token) })).json(),
    );
    expect(me.avatarUrl).toBe(url);
    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: bearer(fan.token),
      payload: { locale: 'en' },
    });
    expect(MeSchema.parse(patched.json()).avatarUrl).toBe(url);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/email-login',
      payload: { email: 'fan501@example.test', entryId: 501 },
    });
    expect(login.statusCode).toBe(200);
    expect(AuthResponseSchema.parse(login.json()).user.avatarUrl).toBe(url);
  });

  it('accepts PNG (transparency flattened) and small images (upscaled to 256×256)', async () => {
    const fan = await registerUser(app, fpl, 502);
    const png = await sharp({
      create: { width: 40, height: 90, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const res = await uploadAvatar(fan.token, png);
    const meta = await sharp(Buffer.from(media.objects.get(keyOf(res.user.avatarUrl))?.bytes ?? [])).stats();
    // Transparent → white, not black.
    expect(meta.channels[0]?.mean).toBeGreaterThan(250);
    const dims = await sharp(
      Buffer.from(media.objects.get(keyOf(res.user.avatarUrl))?.bytes ?? []),
    ).metadata();
    expect(dims).toMatchObject({ width: 256, height: 256, format: 'jpeg' });
  });

  it('replacing gets a new URL and deletes the previous object; a failed delete never fails the request', async () => {
    const fan = await registerUser(app, fpl, 503);
    const first = await uploadAvatar(fan.token, await makeImage('jpeg', 300, 300));
    const second = await uploadAvatar(fan.token, await makeImage('png', 300, 300));
    expect(second.user.avatarUrl).not.toBe(first.user.avatarUrl);
    expect(media.deleted).toEqual([keyOf(first.user.avatarUrl)]);
    expect([...media.objects.keys()]).toEqual([keyOf(second.user.avatarUrl)]);

    // The bucket refuses the delete: the upload still succeeds, the old key is retried by the cleanup job.
    media.failDeletes = true;
    const third = await uploadAvatar(fan.token, await makeImage('webp', 300, 300));
    expect(third.user.avatarUrl).not.toBe(second.user.avatarUrl);
    expect(media.objects.has(keyOf(second.user.avatarUrl))).toBe(true);
    expect(await prisma.pendingMediaDelete.count({ where: { key: keyOf(second.user.avatarUrl) } })).toBe(1);

    media.failDeletes = false;
    await app.jobs.run(cleanupJob.name, { force: true });
    expect(media.objects.has(keyOf(second.user.avatarUrl))).toBe(false);
    expect(await prisma.pendingMediaDelete.count()).toBe(0);
    expect([...media.objects.keys()]).toEqual([keyOf(third.user.avatarUrl)]);
  });

  it('415 for a non-image (bytes are sniffed) or a corrupt image; nothing is stored', async () => {
    const fan = await registerUser(app, fpl, 504);
    const text = Buffer.from('<html><script>alert(1)</script></html> definitely not a photo');
    const res = await uploadAvatarRaw(fan.token, text);
    expect(res.statusCode).toBe(415);
    expect(errorOf(res).code).toBe('unsupported_media_type');
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
    expect((await uploadAvatarRaw(fan.token, corrupt)).statusCode).toBe(415);
    expect(media.objects.size).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fan.user.id } })).avatarUrl).toBeNull();
  });

  it('413 over 10 MB; 400 without a multipart "file" field, with an empty file, or a JSON body', async () => {
    const fan = await registerUser(app, fpl, 505);
    const jpeg = await makeImage('jpeg', 10, 10);
    const huge = Buffer.concat([jpeg, Buffer.alloc(10 * 1024 * 1024 + 1 - jpeg.length)]);
    const tooBig = await uploadAvatarRaw(fan.token, huge);
    expect(tooBig.statusCode).toBe(413);
    expect(errorOf(tooBig).code).toBe('payload_too_large');

    expect((await uploadAvatarRaw(fan.token, jpeg, { field: 'image' })).statusCode).toBe(400);
    expect((await uploadAvatarRaw(fan.token, new Uint8Array())).statusCode).toBe(400);
    const json = await app.inject({
      method: 'POST',
      url: '/v1/me/avatar',
      headers: bearer(fan.token),
      payload: { file: 'x' },
    });
    expect(json.statusCode).toBe(400);
    expect(media.objects.size).toBe(0);
  });

  it('401 anonymous / bad token; 403 banned (DELETE of the own photo is still allowed)', async () => {
    const jpeg = await makeImage('jpeg', 64, 64);
    expect((await uploadAvatarRaw(null, jpeg)).statusCode).toBe(401);
    expect((await uploadAvatarRaw('not-a-real-token', jpeg)).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/v1/me/avatar' })).statusCode).toBe(401);

    const fan = await registerUser(app, fpl, 506);
    await uploadAvatar(fan.token, jpeg);
    const admin = await adminToken(app, prisma);
    const ban = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${fan.user.id}/ban`,
      headers: bearer(admin),
      payload: { reason: 'spam' },
    });
    expect(ban.statusCode).toBe(204);
    const res = await uploadAvatarRaw(fan.token, jpeg);
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('forbidden');
    expect(media.objects.size).toBe(1);

    const del = await app.inject({ method: 'DELETE', url: '/v1/me/avatar', headers: bearer(fan.token) });
    expect(del.statusCode).toBe(200);
    expect(AvatarResponseSchema.parse(del.json()).user).toMatchObject({ avatarUrl: null, canPost: false });
  });

  it('is rate-limited per user like /v1/uploads', async () => {
    await app.close();
    ({ app, fpl } = await buildTestApp(prisma, { media, rateLimit: { uploadsPerHour: 1 } }));
    const fan = await registerUser(app, fpl, 507);
    const jpeg = await makeImage('jpeg', 32, 32);
    expect((await uploadAvatarRaw(fan.token, jpeg)).statusCode).toBe(200);
    expect((await uploadAvatarRaw(fan.token, jpeg)).statusCode).toBe(429);
  });
});

describe('DELETE /v1/me/avatar', () => {
  it('clears the photo, deletes the object and returns Me; idempotent', async () => {
    const fan = await registerUser(app, fpl, 511);
    const up = await uploadAvatar(fan.token, await makeImage('jpeg', 100, 100));
    const res = await app.inject({ method: 'DELETE', url: '/v1/me/avatar', headers: bearer(fan.token) });
    expect(res.statusCode).toBe(200);
    expect(AvatarResponseSchema.parse(res.json()).user.avatarUrl).toBeNull();
    expect(media.deleted).toEqual([keyOf(up.user.avatarUrl)]);
    expect(media.objects.size).toBe(0);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: fan.user.id } });
    expect(row).toMatchObject({ avatarUrl: null, avatarKey: null });
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(fan.token) });
    expect(MeSchema.parse(me.json()).avatarUrl).toBeNull();

    const again = await app.inject({ method: 'DELETE', url: '/v1/me/avatar', headers: bearer(fan.token) });
    expect(again.statusCode).toBe(200);
    expect(media.deleted).toHaveLength(1);
  });

  it('account deletion removes the photo object too', async () => {
    const fan = await registerUser(app, fpl, 512);
    const up = await uploadAvatar(fan.token, await makeImage('jpeg', 100, 100));
    await uploadAvatar((await registerUser(app, fpl, 513)).token, await makeImage('jpeg', 100, 100));
    expect((await leagueAvatars()).body.avatars).toHaveLength(2);
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(fan.token),
      payload: { confirm: 'DELETE' },
    });
    expect(res.statusCode).toBe(204);
    expect(media.objects.has(keyOf(up.user.avatarUrl))).toBe(false);
    expect((await leagueAvatars()).body.avatars.map((a) => a.entryId)).toEqual([513]);
  });
});

describe('DELETE /v1/admin/users/:id/avatar', () => {
  it('an admin removes a photo (200 + AdminUser); non-admins get 403, anonymous 401, unknown id 404', async () => {
    const fan = await registerUser(app, fpl, 521);
    const other = await registerUser(app, fpl, 522);
    const up = await uploadAvatar(fan.token, await makeImage('jpeg', 100, 100));
    const url = `/v1/admin/users/${fan.user.id}/avatar`;

    expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
    const forbidden = await app.inject({ method: 'DELETE', url, headers: bearer(other.token) });
    expect(forbidden.statusCode).toBe(403);
    const self = await app.inject({ method: 'DELETE', url, headers: bearer(fan.token) });
    expect(self.statusCode).toBe(403);
    expect(media.objects.size).toBe(1);

    const admin = await adminToken(app, prisma);
    const res = await app.inject({ method: 'DELETE', url, headers: bearer(admin) });
    expect(res.statusCode).toBe(200);
    expect(AdminUserSchema.parse(res.json())).toMatchObject({
      id: fan.user.id,
      avatarUrl: null,
      postCount: 0,
    });
    expect(media.deleted).toEqual([keyOf(up.user.avatarUrl)]);
    // The fan's own session sees it gone at once (session cache dropped).
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(fan.token) });
    expect(MeSchema.parse(me.json()).avatarUrl).toBeNull();

    const missing = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/users/cknotarealuser00000000000/avatar',
      headers: bearer(admin),
    });
    expect(missing.statusCode).toBe(404);
    // Removing an already-removed photo is a no-op (200), not an error.
    const again = await app.inject({ method: 'DELETE', url, headers: bearer(admin) });
    expect(again.statusCode).toBe(200);
    expect(media.deleted).toHaveLength(1);
  });

  it('admin users list carries avatarUrl, also for banned users', async () => {
    const fan = await registerUser(app, fpl, 523);
    const up = await uploadAvatar(fan.token, await makeImage('jpeg', 100, 100));
    const admin = await adminToken(app, prisma);
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${fan.user.id}/ban`,
      headers: bearer(admin),
      payload: { reason: 'spam' },
    });
    const list = AdminUserListSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/admin/users', headers: bearer(admin) })).json(),
    );
    const row = list.items.find((u) => u.id === fan.user.id);
    expect(row?.bannedAt).not.toBeNull();
    expect(row?.avatarUrl).toBe(up.user.avatarUrl);
    expect(list.items.find((u) => u.id !== fan.user.id)?.avatarUrl).toBeNull();
  });
});

describe('GET /v1/league/avatars', () => {
  it('lists non-banned users with a Team ID and a photo; public CDN caching; updated on every change', async () => {
    const a = await registerUser(app, fpl, 531);
    const b = await registerUser(app, fpl, 532);
    await registerUser(app, fpl, 533); // no photo
    const admin = await adminToken(app, prisma); // admin-only account, no Team ID

    const empty = await leagueAvatars();
    expect(empty.body.avatars).toEqual([]);
    expect(empty.res.headers['cache-control']).toBe(
      'public, max-age=60, s-maxage=60, stale-while-revalidate=120',
    );
    expect(empty.res.headers.etag).toBeDefined();
    expect(String(empty.res.headers.vary ?? '')).not.toMatch(/authorization|cookie/i);
    expect(empty.res.headers['set-cookie']).toBeUndefined();

    const upA = await uploadAvatar(a.token, await makeImage('jpeg', 100, 100));
    const upB = await uploadAvatar(b.token, await makeImage('jpeg', 100, 100));
    // An admin without a Team ID with a photo is not listed (keyed by entryId).
    const adminUp = await uploadAvatar(admin, await makeImage('jpeg', 100, 100));
    expect(adminUp.user.entryId).toBeNull();

    // Fresh immediately after the uploads (hot key dropped), the same for guests and signed-in users.
    const listed = await leagueAvatars();
    expect(listed.body.avatars).toEqual([
      { entryId: 531, url: upA.user.avatarUrl },
      { entryId: 532, url: upB.user.avatarUrl },
    ]);
    const signedIn = await app.inject({ method: 'GET', url: '/v1/league/avatars', headers: bearer(a.token) });
    expect(signedIn.body).toBe(listed.res.body);

    // Ban → left out; unban → back.
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${b.user.id}/ban`,
      headers: bearer(admin),
      payload: { reason: 'spam' },
    });
    expect((await leagueAvatars()).body.avatars.map((x) => x.entryId)).toEqual([531]);
    await app.inject({ method: 'DELETE', url: `/v1/admin/users/${b.user.id}/ban`, headers: bearer(admin) });
    expect((await leagueAvatars()).body.avatars.map((x) => x.entryId)).toEqual([531, 532]);

    // Own delete and admin delete both drop it at once.
    await app.inject({ method: 'DELETE', url: '/v1/me/avatar', headers: bearer(a.token) });
    expect((await leagueAvatars()).body.avatars.map((x) => x.entryId)).toEqual([532]);
    await app.inject({
      method: 'DELETE',
      url: `/v1/admin/users/${b.user.id}/avatar`,
      headers: bearer(admin),
    });
    expect((await leagueAvatars()).body.avatars).toEqual([]);
  });

  it('serves media URLs through MEDIA_PUBLIC_BASE_URL like every other stored media URL', async () => {
    await app.close();
    ({ app, fpl } = await buildTestApp(prisma, {
      media,
      config: { mediaOriginBaseUrl: 'https://media.test', mediaPublicBaseUrl: 'https://app.test/media' },
    }));
    const fan = await registerUser(app, fpl, 541);
    const up = await uploadAvatar(fan.token, await makeImage('jpeg', 100, 100));
    expect(up.user.avatarUrl).toMatch(/^https:\/\/app\.test\/media\/uploads\/avatars\//);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: fan.user.id } });
    expect(row.avatarUrl).toMatch(/^https:\/\/media\.test\/uploads\/avatars\//);
    expect((await leagueAvatars()).body.avatars).toEqual([{ entryId: 541, url: up.user.avatarUrl }]);
  });
});

describe('community authors carry avatarUrl', () => {
  it('posts, comments and the feed show the current photo (no cached feeds: changes show at once)', async () => {
    const alice = await registerUser(app, fpl, 551);
    const bob = await registerUser(app, fpl, 552);
    const post = await createPost(app, alice.token);
    expect(post.author.avatarUrl).toBeNull();
    const up = await uploadAvatar(alice.token, await makeImage('jpeg', 100, 100));
    const bobUp = await uploadAvatar(bob.token, await makeImage('jpeg', 100, 100));
    const comment = await createComment(app, bob.token, post.id);
    expect(comment.author.avatarUrl).toBe(bobUp.user.avatarUrl);

    const feed = CommunityPageSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/community/posts' })).json(),
    );
    expect(feed.items[0]?.author).toMatchObject({ id: alice.user.id, avatarUrl: up.user.avatarUrl });
    const comments = CommentPageSchema.parse(
      (await app.inject({ method: 'GET', url: `/v1/community/posts/${post.id}/comments` })).json(),
    );
    expect(comments.items[0]?.author.avatarUrl).toBe(bobUp.user.avatarUrl);

    // A banned author keeps showing as before (with the photo) in the feed.
    const admin = await adminToken(app, prisma);
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${alice.user.id}/ban`,
      headers: bearer(admin),
      payload: { reason: 'spam' },
    });
    const after = CommunityPageSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/community/posts' })).json(),
    );
    expect(after.items[0]?.author.avatarUrl).toBe(up.user.avatarUrl);

    await app.inject({ method: 'DELETE', url: '/v1/me/avatar', headers: bearer(bob.token) });
    const cleared = CommentPageSchema.parse(
      (await app.inject({ method: 'GET', url: `/v1/community/posts/${post.id}/comments` })).json(),
    );
    expect(cleared.items[0]?.author.avatarUrl).toBeNull();
  });
});
