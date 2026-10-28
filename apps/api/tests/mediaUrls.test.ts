import { CommunityPostSchema, NewsItemSchema, NewsPageSchema, PushPayloadSchema } from '@fant/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPost, makeImage, upload } from './communityFixtures.js';
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
} from './helpers.js';

/** MemoryMediaStore returns `https://media.test/<key>`: that is the bucket ("B2") base here. */
const ORIGIN = 'https://media.test';
const CDN = 'https://fantasyonerim.vercel.app/media';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let media: MemoryMediaStore;
let push: FakePushProvider;

async function boot(publicBase: string | null): Promise<void> {
  media = new MemoryMediaStore();
  push = new FakePushProvider();
  ({ app, fpl } = await buildTestApp(prisma, {
    media,
    push,
    config: { mediaOriginBaseUrl: ORIGIN, mediaPublicBaseUrl: publicBase, vapidPublicKey: 'p'.repeat(60) },
  }));
}

async function seedNews(db: PrismaClient): Promise<string> {
  const item = await db.newsItem.create({
    data: {
      dedupeKey: 'instagram:legacy-1',
      source: 'instagram_post',
      text: 'legacy row',
      links: { spotify: null, apple: null, instagram: null, x: null, audio: null },
      publishedAt: new Date('2026-10-24T10:00:00.000Z'),
      media: {
        create: [
          {
            order: 0,
            kind: 'video',
            url: `${ORIGIN}/instagram/1/0.mp4`,
            posterUrl: `${ORIGIN}/instagram/1/0-poster.jpg`,
            sourceUrl: 'https://scontent.cdninstagram.com/0.mp4',
            storageKey: 'instagram/1/0.mp4',
            posterKey: 'instagram/1/0-poster.jpg',
          },
          {
            order: 1,
            kind: 'image',
            url: `${CDN}/instagram/1/1.jpg`,
            sourceUrl: 'https://scontent.cdninstagram.com/1.jpg',
            storageKey: 'instagram/1/1.jpg',
          },
          {
            order: 2,
            kind: 'image',
            url: 'https://i.scdn.co/image/cover.jpg',
            sourceUrl: 'https://i.scdn.co/image/cover.jpg',
          },
        ],
      },
    },
  });
  return item.id;
}

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('media URLs served through the CDN base (MEDIA_PUBLIC_BASE_URL set)', () => {
  beforeEach(() => boot(CDN));

  it('news: stored bucket URLs (url + posterUrl) map to the CDN; CDN and foreign URLs pass through', async () => {
    const id = await seedNews(prisma);
    const expected = [
      { url: `${CDN}/instagram/1/0.mp4`, posterUrl: `${CDN}/instagram/1/0-poster.jpg` },
      { url: `${CDN}/instagram/1/1.jpg`, posterUrl: null },
      { url: 'https://i.scdn.co/image/cover.jpg', posterUrl: null },
    ];
    const page = NewsPageSchema.parse((await app.inject({ method: 'GET', url: '/v1/news' })).json());
    expect(page.items[0]?.media.map((m) => ({ url: m.url, posterUrl: m.posterUrl }))).toEqual(expected);
    const one = NewsItemSchema.parse((await app.inject({ method: 'GET', url: `/v1/news/${id}` })).json());
    expect(one.media.map((m) => ({ url: m.url, posterUrl: m.posterUrl }))).toEqual(expected);
    // The DB keeps the stored form: nothing was rewritten in place.
    const row = await prisma.newsMedia.findFirstOrThrow({ where: { itemId: id, order: 0 } });
    expect(row.url).toBe(`${ORIGIN}/instagram/1/0.mp4`);
  });

  it('community: upload response and post image use the CDN base; the row keeps the bucket URL', async () => {
    const fan = await registerUser(app, fpl, 3001);
    const up = await upload(app, fan.token, await makeImage('jpeg', 40, 30));
    expect(up.image.url.startsWith(`${CDN}/uploads/${fan.user.id}/`)).toBe(true);
    const post = await createPost(app, fan.token, { text: 'pic', uploadId: up.uploadId });
    expect(post.image?.url).toBe(up.image.url);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/community/posts/${post.id}`,
      headers: bearer(fan.token),
    });
    expect(CommunityPostSchema.parse(res.json()).image?.url).toBe(up.image.url);
    const row = await prisma.upload.findUniqueOrThrow({ where: { id: up.uploadId } });
    expect(row.url.startsWith(`${ORIGIN}/uploads/`)).toBe(true);
  });

  it('broadcast: the News card and the push image use the CDN base', async () => {
    const fan = await registerUser(app, fpl, 3002);
    await subscribe(app, fan.token, 'https://push.example/sub-1');
    const admin = await adminToken(app, prisma);
    const up = await upload(app, admin, await makeImage('jpeg', 40, 30));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/broadcast',
      headers: bearer(admin),
      payload: { text: 'Goal!', uploadId: up.uploadId, targets: ['news', 'push'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(up.image.url.startsWith(`${CDN}/uploads/`)).toBe(true);
    const page = NewsPageSchema.parse((await app.inject({ method: 'GET', url: '/v1/news' })).json());
    expect(page.items[0]?.media[0]?.url).toBe(up.image.url);
    const sent = push.sent.map((s) => PushPayloadSchema.parse(s.payload));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((p) => p.image === up.image.url)).toBe(true);
  });

  it('purge deletes by key whichever URL form the upload row stores', async () => {
    const fan = await registerUser(app, fpl, 3003);
    const keys: string[] = [];
    const posts: string[] = [];
    for (const form of ['bucket', 'cdn'] as const) {
      const up = await upload(app, fan.token, await makeImage('jpeg', 40, 30));
      const key = `uploads/${fan.user.id}/${up.uploadId}.webp`;
      expect(media.objects.has(key)).toBe(true);
      const url = form === 'bucket' ? `${ORIGIN}/${key}` : `${CDN}/${key}`;
      await prisma.upload.update({ where: { id: up.uploadId }, data: { url } });
      const post = await createPost(app, fan.token, { text: form, uploadId: up.uploadId });
      keys.push(key);
      posts.push(post.id);
    }
    for (const id of posts) {
      const del = await app.inject({
        method: 'DELETE',
        url: `/v1/community/posts/${id}`,
        headers: bearer(fan.token),
      });
      expect(del.statusCode).toBe(204);
    }
    for (const key of keys) {
      expect(media.deleted).toContain(key);
      expect(media.objects.has(key)).toBe(false);
    }
    expect(await prisma.upload.count()).toBe(0);
  });
});

describe('MEDIA_PUBLIC_BASE_URL unset (fallback)', () => {
  beforeEach(() => boot(null));

  it('serves every URL exactly as stored', async () => {
    await seedNews(prisma);
    const page = NewsPageSchema.parse((await app.inject({ method: 'GET', url: '/v1/news' })).json());
    expect(page.items[0]?.media.map((m) => m.url)).toEqual([
      `${ORIGIN}/instagram/1/0.mp4`,
      `${CDN}/instagram/1/1.jpg`,
      'https://i.scdn.co/image/cover.jpg',
    ]);
    expect(page.items[0]?.media[0]?.posterUrl).toBe(`${ORIGIN}/instagram/1/0-poster.jpg`);
    const fan = await registerUser(app, fpl, 3004);
    const up = await upload(app, fan.token, await makeImage('jpeg', 40, 30));
    expect(up.image.url.startsWith(`${ORIGIN}/uploads/`)).toBe(true);
  });
});
