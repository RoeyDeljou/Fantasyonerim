import { CommunityPostSchema, NewsPageSchema, UploadResponseSchema } from '@fant/shared';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  IMAGE_VARIANTS_BATCH,
  IMAGE_VARIANTS_EVERY_MS,
  UPLOAD_VARIANTS_GRACE_MS,
} from '../src/jobs/imageVariants.js';
import {
  generateVariants,
  mediaKeysWithVariants,
  VARIANT_WIDTHS,
  variantKey,
} from '../src/media/variants.js';
import { UPLOAD_VARIANTS_BUDGET_MS } from '../src/routes/uploads.js';
import { createPost, makeImage, multipart } from './communityFixtures.js';
import { MemoryMediaStore } from './fakes.js';
import { makeFixture, type FakeFplService } from './fakeFpl.js';
import {
  bearer,
  buildTestApp,
  createTestPrisma,
  migrateTestDb,
  registerUser,
  resetDb,
  type TestClock,
} from './helpers.js';

/** MemoryMediaStore returns `https://media.test/<key>` (the bucket); clients load through the CDN base. */
const ORIGIN = 'https://media.test';
const CDN = 'https://fantasyonerim.vercel.app/media';

const prisma = createTestPrisma();
let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let media: MemoryMediaStore;
let downloads: string[];
let networkDown = false;

/** Media downloads go through the CDN URL: serve whatever the store holds under that key. */
const cdnFetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  downloads.push(url);
  if (networkDown) throw new Error('ECONNRESET');
  const key = url.startsWith(`${CDN}/`) ? url.slice(CDN.length + 1) : null;
  const object = key === null ? undefined : media.objects.get(key);
  if (object === undefined) return new Response('not found', { status: 404 });
  return new Response(Buffer.from(object.bytes), {
    status: 200,
    headers: { 'content-type': object.contentType },
  });
}) as typeof fetch;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  media = new MemoryMediaStore();
  downloads = [];
  networkDown = false;
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    media,
    fetch: cdnFetch,
    config: { mediaOriginBaseUrl: ORIGIN, mediaPublicBaseUrl: CDN },
  }));
  // No live match unless a test says so.
  fpl.fixtures = [makeFixture(100, 9, 'finished')];
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function photo(width: number, height: number, options: { orientation?: number; exif?: boolean } = {}) {
  return new Uint8Array(await makeImage('jpeg', width, height, options));
}

/** A re-hosted Instagram image whose variants haven't been generated yet (as rows from before this change). */
async function legacyImage(n: number, width = 1080, publishedAt = new Date(Date.UTC(2026, 9, 1, 0, n))) {
  const key = `instagram/legacy${n}/0.jpg`;
  await media.put(key, await photo(width, Math.round(width * 1.25)), 'image/jpeg');
  return prisma.newsItem.create({
    data: {
      dedupeKey: `instagram:legacy${n}`,
      source: 'instagram_post',
      text: `post ${n}`,
      links: {},
      publishedAt,
      media: {
        create: [
          {
            order: 0,
            kind: 'image',
            url: `${ORIGIN}/${key}`,
            sourceUrl: `https://scontent.cdninstagram.com/${n}.jpg`,
            storageKey: key,
            width,
            height: Math.round(width * 1.25),
          },
        ],
      },
    },
  });
}

describe('variant generation', () => {
  it('WebP at 320 and 640 px wide, never upscaled, metadata dropped', async () => {
    const big = await generateVariants(await photo(1080, 1350, { exif: true }));
    expect(big.map((v) => [v.width, v.height])).toEqual([
      [320, 400],
      [640, 800],
    ]);
    for (const v of big) {
      const meta = await sharp(v.bytes).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.exif).toBeUndefined();
      expect(meta.width).toBe(v.width);
    }
    // Widths ≥ the original are skipped: 500 px → only 320; 640 px exactly → only 320; 320 px or smaller → none.
    expect((await generateVariants(await photo(500, 300))).map((v) => v.width)).toEqual([320]);
    expect((await generateVariants(await photo(640, 480))).map((v) => v.width)).toEqual([320]);
    expect(await generateVariants(await photo(320, 200))).toEqual([]);
    expect(await generateVariants(await photo(120, 90))).toEqual([]);
    // Not an image → no variants, no throw.
    expect(await generateVariants(new TextEncoder().encode('definitely not an image'))).toEqual([]);
    expect(VARIANT_WIDTHS).toEqual([320, 640]);
  });

  it('follows the EXIF orientation (a portrait phone photo stored landscape)', async () => {
    // 1200×800 pixels with orientation 6 (rotate 90°) is a 800×1200 portrait: both widths fit.
    const variants = await generateVariants(await photo(1200, 800, { orientation: 6 }));
    expect(variants.map((v) => [v.width, v.height])).toEqual([
      [320, 480],
      [640, 960],
    ]);
  });

  it('keys sit next to the original (same CDN folder rules)', () => {
    expect(variantKey('uploads/u1/abc.webp', 320)).toBe('uploads/u1/abc.webp.w320.webp');
    expect(mediaKeysWithVariants('instagram/1/0.jpg')).toEqual([
      'instagram/1/0.jpg',
      'instagram/1/0.jpg.w320.webp',
      'instagram/1/0.jpg.w640.webp',
    ]);
  });
});

describe('serialization through the public-URL mapping', () => {
  it('News media: variants smallest first, on the CDN base; videos and unprocessed rows have none', async () => {
    const item = await legacyImage(1);
    await prisma.newsMedia.updateMany({
      where: { itemId: item.id },
      data: {
        variants: [
          {
            width: 640,
            url: `${ORIGIN}/instagram/legacy1/0.jpg.w640.webp`,
            key: 'instagram/legacy1/0.jpg.w640.webp',
          },
          {
            width: 320,
            url: `${ORIGIN}/instagram/legacy1/0.jpg.w320.webp`,
            key: 'instagram/legacy1/0.jpg.w320.webp',
          },
        ],
      },
    });
    await legacyImage(2);
    app.hot.invalidateNews();
    const page = NewsPageSchema.parse((await app.inject({ method: 'GET', url: '/v1/news' })).json());
    const withVariants = page.items.find((i) => i.id === item.id)!;
    expect(withVariants.media[0]).toMatchObject({
      url: `${CDN}/instagram/legacy1/0.jpg`,
      variants: [
        { width: 320, url: `${CDN}/instagram/legacy1/0.jpg.w320.webp` },
        { width: 640, url: `${CDN}/instagram/legacy1/0.jpg.w640.webp` },
      ],
    });
    const without = page.items.find((i) => i.id !== item.id)!;
    expect(without.media[0]).not.toHaveProperty('variants');
  });

  it('community upload: variants stored after the upload, served on the post through the CDN base', async () => {
    const fan = await registerUser(app, fpl, 501);
    const body = multipart({ bytes: await makeImage('jpeg', 1600, 1200) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: { ...bearer(fan.token), ...body.headers },
      payload: body.payload,
    });
    expect(res.statusCode).toBe(201);
    const uploaded = UploadResponseSchema.parse(res.json());
    expect(uploaded.image.url.startsWith(`${CDN}/uploads/`)).toBe(true);
    // Whether or not they made the 300 ms budget, the row gets them shortly after.
    await waitFor(
      async () =>
        (await prisma.upload.findUniqueOrThrow({ where: { id: uploaded.uploadId } })).variants !== null,
    );
    const key = `uploads/${fan.user.id}/${uploaded.uploadId}.webp`;
    expect(media.objects.has(variantKey(key, 320))).toBe(true);
    expect(media.objects.get(variantKey(key, 640))?.contentType).toBe('image/webp');
    const post = await createPost(app, fan.token, { text: 'kit', uploadId: uploaded.uploadId });
    expect(post.image?.variants).toEqual([
      { width: 320, url: `${CDN}/${variantKey(key, 320)}` },
      { width: 640, url: `${CDN}/${variantKey(key, 640)}` },
    ]);
    const feed = await app.inject({ method: 'GET', url: '/v1/community/posts', headers: bearer(fan.token) });
    expect(CommunityPostSchema.parse(feed.json().items[0]).image?.variants).toHaveLength(2);
  });
});

describe('upload path timing guard', () => {
  it('a slow variant generation never holds the upload response beyond the budget', async () => {
    // Variant writes take 2 s (a 0.1-CPU host is ~2 s for a phone photo): the response must not wait for them.
    const slowPut = media.put.bind(media);
    media.put = async (key, bytes, type) => {
      if (/\.w\d+\.webp$/.test(key)) await new Promise((r) => setTimeout(r, 2_000));
      return slowPut(key, bytes, type);
    };
    const fan = await registerUser(app, fpl, 502);
    const body = multipart({ bytes: await makeImage('jpeg', 1600, 1200) });
    const started = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: { ...bearer(fan.token), ...body.headers },
      payload: body.payload,
    });
    const ms = performance.now() - started;
    expect(res.statusCode).toBe(201);
    const uploaded = UploadResponseSchema.parse(res.json());
    expect(uploaded.image.variants).toBeUndefined();
    // Upload processing (decode + re-encode) plus at most the budget; far less than the 2 s variant write.
    expect(ms).toBeLessThan(UPLOAD_VARIANTS_BUDGET_MS + 1_200);
    await waitFor(
      async () =>
        (await prisma.upload.findUniqueOrThrow({ where: { id: uploaded.uploadId } })).variants !== null,
      8_000,
    );
  });

  it('a fast generation is included in the response itself', async () => {
    const fan = await registerUser(app, fpl, 503);
    const body = multipart({ bytes: await makeImage('png', 700, 400) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: { ...bearer(fan.token), ...body.headers },
      payload: body.payload,
    });
    const uploaded = UploadResponseSchema.parse(res.json());
    // A 700 px solid image encodes in a few ms on this machine: inside the budget → in the response.
    expect(uploaded.image.variants?.map((v) => v.width)).toEqual([320, 640]);
    expect(uploaded.image.variants?.[0]?.url.startsWith(`${CDN}/uploads/`)).toBe(true);
  });
});

describe('backfill job', () => {
  const pending = () => prisma.newsMedia.count({ where: { variants: { equals: Prisma.DbNull } } });
  /** One scheduled run (not forced: the live-fixture / quiet-hours guards apply). */
  async function runBackfill(): Promise<string> {
    clock.advance(IMAGE_VARIANTS_EVERY_MS);
    return app.jobs.run('image_variants');
  }

  it('works through existing media in batches of 10, newest first, downloading each once via the CDN', async () => {
    for (let n = 1; n <= 23; n += 1) await legacyImage(n);
    expect(await runBackfill()).toBe('ok');
    const doneKeys = (
      await prisma.newsMedia.findMany({ where: { NOT: { variants: { equals: Prisma.DbNull } } } })
    )
      .map((m) => m.storageKey)
      .sort();
    // Newest first: legacy23 … legacy14.
    expect(doneKeys).toEqual(
      Array.from({ length: IMAGE_VARIANTS_BATCH }, (_, i) => `instagram/legacy${23 - i}/0.jpg`).sort(),
    );
    expect(downloads).toHaveLength(10);
    expect(downloads.every((u) => u.startsWith(`${CDN}/instagram/`))).toBe(true);
    await runBackfill();
    expect(await pending()).toBe(3);
    await runBackfill();
    expect(await pending()).toBe(0);
    // Resumable + idempotent: nothing left, nothing downloaded again.
    await runBackfill();
    expect(downloads).toHaveLength(23);
    const row = await prisma.newsMedia.findFirstOrThrow({ where: { storageKey: 'instagram/legacy5/0.jpg' } });
    expect((row.variants as { width: number }[]).map((v) => v.width)).toEqual([320, 640]);
    expect(media.objects.has('instagram/legacy5/0.jpg.w640.webp')).toBe(true);
  });

  it('small images: done with no variants; a gone file: not retried; a network error: stops the batch', async () => {
    await legacyImage(1, 300);
    await legacyImage(2);
    media.objects.delete('instagram/legacy2/0.jpg');
    await runBackfill();
    const rows = await prisma.newsMedia.findMany({ orderBy: { storageKey: 'asc' } });
    expect(rows.map((m) => m.variants)).toEqual([[], []]);
    expect(downloads).toHaveLength(2);
    await runBackfill();
    expect(downloads).toHaveLength(2);

    await legacyImage(3);
    await legacyImage(4);
    networkDown = true;
    await runBackfill();
    expect(downloads).toHaveLength(3); // the first failure stops the batch
    expect(await pending()).toBe(2); // both still pending for the next run
    networkDown = false;
    await runBackfill();
    expect(await pending()).toBe(0);
  });

  it('skips while a fixture is live; uploads wait out their grace period', async () => {
    await legacyImage(1);
    fpl.fixtures = [makeFixture(100, 9, 'live')];
    await runBackfill();
    expect(await pending()).toBe(1);
    fpl.fixtures = [makeFixture(100, 9, 'finished')];
    await runBackfill();
    expect(await pending()).toBe(0);

    // An upload whose own generation was lost (e.g. a restart): picked up once older than the grace period.
    const fan = await registerUser(app, fpl, 504);
    const key = `uploads/${fan.user.id}/lost.webp`;
    await media.put(
      key,
      await sharp(await photo(900, 600))
        .webp()
        .toBuffer(),
      'image/webp',
    );
    await prisma.upload.create({
      data: {
        id: 'lost',
        ownerId: fan.user.id,
        storageKey: key,
        url: `${ORIGIN}/${key}`,
        width: 900,
        height: 600,
        contentType: 'image/webp',
        createdAt: new Date(clock.now().getTime() + IMAGE_VARIANTS_EVERY_MS),
      },
    });
    await runBackfill();
    expect((await prisma.upload.findUniqueOrThrow({ where: { id: 'lost' } })).variants).toBeNull();
    clock.advance(UPLOAD_VARIANTS_GRACE_MS);
    await runBackfill();
    const variants = (await prisma.upload.findUniqueOrThrow({ where: { id: 'lost' } })).variants;
    expect((variants as { width: number }[]).map((v) => v.width)).toEqual([320, 640]);
  });

  it('skips during quiet hours (Israel night)', async () => {
    await app.close();
    ({ app, fpl, clock } = await buildTestApp(prisma, {
      media,
      fetch: cdnFetch,
      config: { mediaOriginBaseUrl: ORIGIN, mediaPublicBaseUrl: CDN, keepAlive: { quietHours: [2, 7] } },
    }));
    fpl.fixtures = [makeFixture(100, 9, 'finished')];
    await legacyImage(1);
    clock.advance(Date.parse('2026-10-26T01:30:00Z') - clock.now().getTime()); // 03:30 in Israel
    expect(await app.jobs.run('image_variants', { force: false })).toBe('ok');
    expect(await pending()).toBe(1);
    clock.advance(6 * 3_600_000); // 09:30
    expect(await app.jobs.run('image_variants')).toBe('ok');
    expect(await pending()).toBe(0);
  });
});

describe('purge', () => {
  it('deleting a post deletes its image and the image variants', async () => {
    const fan = await registerUser(app, fpl, 601);
    const body = multipart({ bytes: await makeImage('jpeg', 1600, 1200) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: { ...bearer(fan.token), ...body.headers },
      payload: body.payload,
    });
    const uploaded = UploadResponseSchema.parse(res.json());
    await waitFor(
      async () =>
        (await prisma.upload.findUniqueOrThrow({ where: { id: uploaded.uploadId } })).variants !== null,
    );
    const post = await createPost(app, fan.token, { text: 'pic', uploadId: uploaded.uploadId });
    const key = `uploads/${fan.user.id}/${uploaded.uploadId}.webp`;
    expect(mediaKeysWithVariants(key).every((k) => media.objects.has(k))).toBe(true);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/community/posts/${post.id}`,
      headers: bearer(fan.token),
    });
    expect(del.statusCode).toBe(204);
    expect(mediaKeysWithVariants(key).some((k) => media.objects.has(k))).toBe(false);
    expect(media.deleted.sort()).toEqual(mediaKeysWithVariants(key).sort());
  });

  it('expired story media: original, poster and their variants are deleted by the cleanup job', async () => {
    const item = await legacyImage(7);
    await prisma.newsItem.update({
      where: { id: item.id },
      data: {
        source: 'instagram_story',
        publishedAt: new Date(clock.now().getTime() - 72 * 3_600_000),
        expiresAt: new Date(clock.now().getTime() - 48 * 3_600_000),
      },
    });
    expect(await app.jobs.run('image_variants', { force: true })).toBe('ok');
    expect(media.objects.has('instagram/legacy7/0.jpg.w320.webp')).toBe(true);
    expect(await app.jobs.run('cleanup', { force: true })).toBe('ok');
    expect(media.deleted).toEqual(mediaKeysWithVariants('instagram/legacy7/0.jpg'));
    expect([...media.objects.keys()].filter((k) => k.includes('legacy7'))).toEqual([]);
  });
});

async function waitFor(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}
