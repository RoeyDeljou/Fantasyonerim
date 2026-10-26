import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from '@fant/integrations';
import { NewsItemSchema, NewsPageSchema, StoriesSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecrets } from '../src/integrations/store.js';
import { LocalDiskMediaStore } from '../src/media/store.js';
import { devSecretsKey } from '../src/secrets.js';
import {
  FakePushProvider,
  MemoryMediaStore,
  episode,
  fakeIntegrations,
  fakeMediaFetch,
  igPost,
  igStory,
  result,
  subscribe,
  xPost,
} from './fakes.js';
import type { FakeFplService } from './fakeFpl.js';
import type { TestClock } from './helpers.js';
import { buildTestApp, createTestPrisma, migrateTestDb, registerUser, resetDb } from './helpers.js';

const prisma = createTestPrisma();
const HOUR = 3_600_000;
const CRON = 'cron-secret-0123456789abcdef';

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let push: FakePushProvider;
let media: MemoryMediaStore;
let fakes: ReturnType<typeof fakeIntegrations>;
let files: Map<string, { contentType: string }>;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  fakes = fakeIntegrations();
  push = new FakePushProvider();
  media = new MemoryMediaStore();
  files = new Map();
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    integrations: fakes.factories,
    push,
    media,
    fetch: fakeMediaFetch(files).fetch,
    config: { cronSecret: CRON },
  }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const ago = (ms: number) => new Date(clock.now().getTime() - ms);

async function fan(entryId = 501, endpoint = `https://push.test/${entryId}`) {
  const user = await registerUser(app, fpl, entryId);
  await subscribe(app, user.token, endpoint);
  return user;
}

async function connectInstagram() {
  await prisma.integrationConfig.upsert({
    where: { id: 'instagram' },
    update: {
      enabled: true,
      settings: { igUserId: '1784', username: 'fantasyonerimfpl', pageId: '99' },
      secretsEnc: encryptSecrets(devSecretsKey(), { accessToken: 'page-token' }),
    },
    create: {
      id: 'instagram',
      enabled: true,
      settings: { igUserId: '1784', username: 'fantasyonerimfpl', pageId: '99' },
      secretsEnc: encryptSecrets(devSecretsKey(), { accessToken: 'page-token' }),
    },
  });
}

const integration = (id: 'podcast_rss' | 'instagram' | 'x' | 'apple') =>
  prisma.integrationConfig.findUniqueOrThrow({ where: { id } });

describe('podcast job', () => {
  it('upserts by dedupe key: a second run adds nothing, a changed title updates in place', async () => {
    fakes.podcast.next = result([episode(1, ago(48 * HOUR)), episode(2, ago(24 * HOUR))], {
      cursor: 'etag-1',
    });
    expect(await app.jobs.run('podcast', { force: true })).toBe('ok');
    const before = await prisma.newsItem.findMany({ orderBy: { dedupeKey: 'asc' } });
    expect(await app.jobs.run('podcast', { force: true })).toBe('ok');
    expect(await prisma.newsItem.count()).toBe(2);
    // An identical re-run is a true no-op: jsonb key order must not make every row look changed.
    const after = await prisma.newsItem.findMany({ orderBy: { dedupeKey: 'asc' } });
    expect(after.map((r) => r.updatedAt.getTime())).toEqual(before.map((r) => r.updatedAt.getTime()));
    expect(fakes.podcast.cursors).toEqual([null, 'etag-1']);

    fakes.podcast.next = result([
      episode(1, ago(48 * HOUR)),
      episode(2, ago(24 * HOUR), { title: 'פרק 2 - מתוקן' }),
    ]);
    await app.jobs.run('podcast', { force: true });
    const items = await prisma.newsItem.findMany({ orderBy: { publishedAt: 'asc' } });
    expect(items.map((i) => i.title)).toEqual(['פרק 1 - כותרת', 'פרק 2 - מתוקן']);
    expect(await prisma.newsMedia.count()).toBe(2);
    expect((await integration('podcast_rss')).itemsImported).toBe(2);
    // The RSS feed URL was the client's default.
    expect(fakes.podcast.configs[0]).toMatchObject({ rssUrl: 'https://anchor.fm/s/105778688/podcast/rss' });
  });

  it('backfills silently on the first sync, then pushes a new episode exactly once', async () => {
    await fan();
    fakes.podcast.next = result([episode(1, ago(2 * HOUR)), episode(2, ago(HOUR))]);
    await app.jobs.run('podcast', { force: true });
    expect(push.sent).toHaveLength(0);
    expect((await integration('podcast_rss')).initialSyncDone).toBe(true);

    fakes.podcast.next = result([episode(1, ago(2 * HOUR)), episode(2, ago(HOUR)), episode(3, ago(60_000))]);
    await app.jobs.run('podcast', { force: true });
    await app.jobs.run('podcast', { force: true });
    expect(push.sent).toHaveLength(1);
    const ep3 = await prisma.newsItem.findUniqueOrThrow({ where: { dedupeKey: 'podcast:guid-3' } });
    expect(push.sent[0]?.payload).toMatchObject({
      title: '🎙️ פרק חדש: פרק 3 - כותרת',
      url: `/news/?item=${ep3.id}`,
      tag: 'news-podcast',
      image: 'https://cdn.anchor.test/art.jpg',
    });
    expect(push.sent[0]?.options).toMatchObject({ ttlSec: 86_400 });
    expect(await prisma.notificationLog.count({ where: { key: `news:${ep3.id}` } })).toBe(1);
  });

  it('does not push items published more than 12 h ago', async () => {
    await fan();
    fakes.podcast.next = result([episode(1, ago(48 * HOUR))]);
    await app.jobs.run('podcast', { force: true });
    fakes.podcast.next = result([episode(1, ago(48 * HOUR)), episode(2, ago(13 * HOUR))]);
    await app.jobs.run('podcast', { force: true });
    expect(await prisma.newsItem.count()).toBe(2);
    expect(push.sent).toHaveLength(0);
  });

  it('re-resolves missing Spotify/Apple links for recent episodes without overwriting known ones', async () => {
    fakes.podcast.next = result([
      episode(1, ago(48 * HOUR), {
        links: { spotify: null, apple: 'https://apple.test/known', instagram: null, x: null, audio: null },
      }),
      episode(2, ago(24 * HOUR)),
    ]);
    await app.jobs.run('podcast', { force: true });
    // RSS unchanged (304) → the job re-checks recent episodes still missing a link.
    fakes.podcast.next = result([], { notModified: true, cursor: 'etag' });
    fakes.resolved.links = new Map([
      ['podcast:guid-1', { apple: 'https://apple.test/other' }],
      ['podcast:guid-2', { apple: 'https://apple.test/ep2' }],
    ]);
    await app.jobs.run('podcast', { force: true });
    expect(fakes.resolved.calls).toHaveLength(1);
    expect(fakes.resolved.calls[0]?.map((r) => r.guid).sort()).toEqual(['guid-1', 'guid-2']);
    const links = Object.fromEntries(
      (await prisma.newsItem.findMany()).map((i) => [
        i.dedupeKey,
        (i.links as { apple: string | null }).apple,
      ]),
    );
    expect(links).toEqual({
      'podcast:guid-1': 'https://apple.test/known',
      'podcast:guid-2': 'https://apple.test/ep2',
    });
    // Links found earlier are never wiped by a later poll that lacks them.
    fakes.podcast.next = result([episode(2, ago(24 * HOUR))]);
    await app.jobs.run('podcast', { force: true });
    const ep2 = await prisma.newsItem.findUniqueOrThrow({ where: { dedupeKey: 'podcast:guid-2' } });
    expect((ep2.links as { apple: string | null }).apple).toBe('https://apple.test/ep2');
  });

  it('throttles link re-resolution to every 30 minutes when not forced', async () => {
    fakes.podcast.next = result([episode(1, ago(HOUR))]);
    await app.jobs.run('podcast', { force: true });
    fakes.podcast.next = result([], { notModified: true });
    await app.jobs.run('podcast', { force: true });
    expect(fakes.resolved.calls).toHaveLength(1);
    clock.advance(6 * 60_000);
    await app.jobs.run('podcast');
    expect(fakes.resolved.calls).toHaveLength(1);
    clock.advance(30 * 60_000);
    await app.jobs.run('podcast');
    expect(fakes.resolved.calls).toHaveLength(2);
  });
});

describe('instagram jobs', () => {
  it('re-hosts every media file (and video posters) through the MediaStore', async () => {
    await connectInstagram();
    files.set('https://cdn.ig.test/a.jpg', { contentType: 'image/jpeg' });
    files.set('https://cdn.ig.test/b.mp4', { contentType: 'video/mp4' });
    files.set('https://cdn.ig.test/b.mp4.jpg', { contentType: 'image/jpeg' });
    fakes.igPosts.next = result([
      igPost('111', ago(HOUR), ['https://cdn.ig.test/a.jpg', 'https://cdn.ig.test/b.mp4']),
    ]);
    await app.jobs.run('instagram_posts', { force: true });
    const res = await app.inject({ method: 'GET', url: '/v1/news' });
    const page = NewsPageSchema.parse(res.json());
    expect(page.items[0]?.media).toEqual([
      {
        kind: 'image',
        url: 'https://media.test/instagram/111/0.jpg',
        posterUrl: null,
        width: 1080,
        height: 1350,
      },
      {
        kind: 'video',
        url: 'https://media.test/instagram/111/1.mp4',
        posterUrl: 'https://media.test/instagram/111/1-poster.jpg',
        width: 1080,
        height: 1350,
      },
    ]);
    expect([...media.objects.keys()].sort()).toEqual([
      'instagram/111/0.jpg',
      'instagram/111/1-poster.jpg',
      'instagram/111/1.mp4',
    ]);
    expect(fakes.igPosts.configs[0]).toEqual({
      igUserId: '1784',
      accessToken: 'page-token',
      username: 'fantasyonerimfpl',
    });
  });

  it('skips and reports items whose media fail to download, and imports them once they work', async () => {
    await connectInstagram();
    files.set('https://cdn.ig.test/ok.jpg', { contentType: 'image/jpeg' });
    fakes.igPosts.next = result(
      [
        igPost('1', ago(HOUR), ['https://cdn.ig.test/ok.jpg']),
        igPost('2', ago(HOUR), ['https://cdn.ig.test/broken.jpg']),
      ],
      { cursor: 'c1' },
    );
    await app.jobs.run('instagram_posts', { force: true });
    expect(await prisma.newsItem.count()).toBe(1);
    const row = await integration('instagram');
    expect(row.lastError).toMatch(
      /1 item\(s\) not imported yet, will retry \(instagram:2: download failed with HTTP 404\)/,
    );
    expect(row.lastSuccessAt).not.toBeNull();

    files.set('https://cdn.ig.test/broken.jpg', { contentType: 'image/png' });
    await app.jobs.run('instagram_posts', { force: true });
    expect(await prisma.newsItem.count()).toBe(2);
    expect((await integration('instagram')).lastError).toBeNull();
    expect(media.objects.has('instagram/2/0.png')).toBe(true);
  });

  it('rejects media with a disallowed content type', async () => {
    await connectInstagram();
    files.set('https://cdn.ig.test/x.jpg', { contentType: 'text/html' });
    fakes.igPosts.next = result([igPost('9', ago(HOUR), ['https://cdn.ig.test/x.jpg'])]);
    await app.jobs.run('instagram_posts', { force: true });
    expect(await prisma.newsItem.count()).toBe(0);
    expect((await integration('instagram')).lastError).toMatch(/unexpected content type "text\/html"/);
  });

  it('batches several new stories into one push, and hides expired stories from /v1/news/stories', async () => {
    await connectInstagram();
    await fan();
    for (const id of ['s0', 's1', 's2', 's3', 'old'])
      files.set(`https://cdn.ig.test/${id}.jpg`, { contentType: 'image/jpeg' });
    fakes.igStories.next = result([
      igStory('old', ago(25 * HOUR), 'https://cdn.ig.test/old.jpg'),
      igStory('s0', ago(2 * HOUR), 'https://cdn.ig.test/s0.jpg'),
    ]);
    await app.jobs.run('instagram_stories', { force: true });
    expect(push.sent).toHaveLength(0); // first sync

    fakes.igStories.next = result(
      ['s0', 's1', 's2', 's3'].map((id, i) =>
        igStory(id, ago((4 - i) * 60_000), `https://cdn.ig.test/${id}.jpg`),
      ),
    );
    await app.jobs.run('instagram_stories', { force: true });
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload.title).toBe('3 סטוריז חדשים מפנטזיונרים');
    expect(push.sent[0]?.payload.tag).toBe('news-instagram_story');
    expect(push.sent[0]?.payload.image).toMatch(/^https:\/\/media\.test\/instagram\//);
    expect(await prisma.notificationLog.count()).toBe(3);

    const stories = StoriesSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/news/stories' })).json(),
    );
    expect(stories.items.map((s) => s.text === null && s.expiresAt !== null)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(stories.items).toHaveLength(4); // "old" (published 25 h ago) has expired
    const publishedOrder = stories.items.map((s) => Date.parse(s.publishedAt));
    expect([...publishedOrder].sort((a, b) => a - b)).toEqual(publishedOrder);
    // Stories never appear in the main feed.
    const feed = NewsPageSchema.parse((await app.inject({ method: 'GET', url: '/v1/news' })).json());
    expect(feed.items).toHaveLength(0);
  });

  it('cleanup hides expired stories and deletes their media after 48 h', async () => {
    await connectInstagram();
    files.set('https://cdn.ig.test/st.jpg', { contentType: 'image/jpeg' });
    fakes.igStories.next = result([igStory('st', ago(HOUR), 'https://cdn.ig.test/st.jpg')]);
    await app.jobs.run('instagram_stories', { force: true });
    expect(media.objects.has('instagram/st/0.jpg')).toBe(true);
    clock.advance(30 * HOUR);
    await app.jobs.run('cleanup', { force: true });
    const story = await prisma.newsItem.findUniqueOrThrow({ where: { dedupeKey: 'instagram_story:st' } });
    expect(story.hiddenAt).not.toBeNull();
    expect(media.deleted).toEqual([]);
    clock.advance(18 * HOUR);
    await app.jobs.run('cleanup', { force: true });
    expect(media.deleted).toEqual(['instagram/st/0.jpg']);
    expect((await prisma.newsMedia.findFirstOrThrow()).storageKey).toBeNull();
  });

  it('does nothing while Instagram is not connected', async () => {
    await app.jobs.run('instagram_posts', { force: true });
    expect(fakes.igPosts.configs).toHaveLength(0);
  });
});

describe('x job', () => {
  it('polls with the since_id cursor only when enabled with a bearer token', async () => {
    fakes.x.next = result([xPost('100', ago(HOUR))], { cursor: '100' });
    await app.jobs.run('x', { force: true });
    expect(fakes.x.configs).toHaveLength(0);
    await prisma.integrationConfig.update({
      where: { id: 'x' },
      data: { enabled: true, secretsEnc: encryptSecrets(devSecretsKey(), { bearerToken: 'bt' }) },
    });
    await app.jobs.run('x', { force: true });
    await app.jobs.run('x', { force: true });
    expect(fakes.x.cursors).toEqual([null, '100']);
    // userId was resolved once (the PUT couldn't) and stored.
    expect((await integration('x')).settings).toEqual({ username: 'fantasyonerim', userId: '4242' });
    expect(fakes.x.configs[0]).toEqual({ bearerToken: 'bt', userId: '4242', username: 'fantasyonerim' });
    expect(await prisma.newsItem.count({ where: { source: 'x_post' } })).toBe(1);
  });
});

describe('failures, leases and the cron tick', () => {
  it('one failing source never blocks the others; lastError is admin-readable', async () => {
    await connectInstagram();
    files.set('https://cdn.ig.test/p.jpg', { contentType: 'image/jpeg' });
    fakes.podcast.error = new IntegrationConfigError(
      'The podcast RSS URL returned HTTP 404 — check the URL.',
    );
    fakes.igPosts.next = result([igPost('p', ago(HOUR), ['https://cdn.ig.test/p.jpg'])]);
    fpl.failAll = new Error('FPL exploded');

    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/tick',
      headers: { 'x-cron-secret': CRON },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ran).toEqual([
      'podcast',
      'instagram_stories',
      'instagram_posts',
      'x',
      'deadline_reminders',
      'gameweek_summary',
      'cleanup',
    ]);
    expect(await prisma.newsItem.count({ where: { source: 'instagram_post' } })).toBe(1);
    const rss = await integration('podcast_rss');
    expect(rss.lastError).toBe('The podcast RSS URL returned HTTP 404 — check the URL.');
    expect(rss.lastSuccessAt).toBeNull();
    expect(
      (await prisma.jobLease.findUniqueOrThrow({ where: { name: 'deadline_reminders' } })).lastError,
    ).toBe('FPL exploded');

    fakes.podcast.error = new IntegrationRateLimitError('429 from host', 120);
    await app.jobs.run('podcast', { force: true });
    expect((await integration('podcast_rss')).lastError).toBe(
      'Podcast RSS rate limit reached — will retry automatically in ~2 min. (429 from host)',
    );
    fakes.podcast.error = new IntegrationUnavailableError('HTTP 502', 502);
    await app.jobs.run('podcast', { force: true });
    expect((await integration('podcast_rss')).lastError).toBe(
      'Podcast RSS is unavailable — will retry automatically. (HTTP 502)',
    );
  });

  it('the job lease prevents concurrent runs of the same job', async () => {
    let release: () => void = () => undefined;
    fakes.podcast.gate = new Promise((r) => (release = r));
    fakes.podcast.next = result([episode(1, ago(HOUR))]);
    const first = app.jobs.run('podcast', { force: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(await app.jobs.run('podcast', { force: true })).toBe('locked');
    release();
    expect(await first).toBe('ok');
    expect(fakes.podcast.cursors).toHaveLength(1);
    // Free again afterwards.
    fakes.podcast.gate = null;
    expect(await app.jobs.run('podcast', { force: true })).toBe('ok');
  });

  it('runs a job only when due; the tick reports what ran', async () => {
    const tick = () =>
      app.inject({ method: 'POST', url: '/internal/jobs/tick', headers: { 'x-cron-secret': CRON } });
    expect((await tick()).json().ran).toHaveLength(7);
    expect((await tick()).json().ran).toEqual([]);
    clock.advance(5 * 60_000);
    expect((await tick()).json().ran).toEqual(['podcast', 'instagram_stories', 'deadline_reminders']);
  });

  it('tick requires the cron secret (401) and is disabled without CRON_SECRET (503)', async () => {
    expect((await app.inject({ method: 'POST', url: '/internal/jobs/tick' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/internal/jobs/tick',
      headers: { 'x-cron-secret': 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: { code: 'unauthorized', message: 'Bad cron secret' } });
    const { app: noSecret } = await buildTestApp(prisma, { integrations: fakes.factories });
    const res = await noSecret.inject({
      method: 'POST',
      url: '/internal/jobs/tick',
      headers: { 'x-cron-secret': CRON },
    });
    expect(res.statusCode).toBe(503);
    await noSecret.close();
  });
});

describe('news feed', () => {
  async function seed() {
    const base = clock.now().getTime();
    const same = new Date(base - 5 * HOUR);
    const rows = [
      { key: 'a', at: new Date(base - HOUR) },
      { key: 'b', at: same },
      { key: 'c', at: same },
      { key: 'd', at: new Date(base - 9 * HOUR) },
      { key: 'e', at: new Date(base - 10 * HOUR) },
      { key: 'hidden', at: new Date(base - 2 * HOUR), hidden: true },
    ];
    for (const r of rows) {
      await prisma.newsItem.create({
        data: {
          dedupeKey: `x:${r.key}`,
          source: 'x_post',
          text: r.key,
          links: { spotify: null, apple: null, instagram: null, x: null, audio: null },
          publishedAt: r.at,
          hiddenAt: r.hidden ? clock.now() : null,
        },
      });
    }
  }

  it('pages newest first with an opaque keyset cursor, excluding hidden items', async () => {
    await seed();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/news?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = NewsPageSchema.parse((await app.inject({ method: 'GET', url })).json());
      seen.push(...page.items.map((i) => i.text ?? ''));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen[0]).toBe('a');
    expect(seen.slice(3)).toEqual(['d', 'e']);
    expect(pages).toBe(3);
  });

  it('validates the query and serves single items (404 when hidden or unknown)', async () => {
    await seed();
    expect((await app.inject({ method: 'GET', url: '/v1/news?limit=0' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/news?limit=51' })).statusCode).toBe(400);
    const bad = await app.inject({ method: 'GET', url: '/v1/news?cursor=garbage' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/cursor/);
    const a = await prisma.newsItem.findUniqueOrThrow({ where: { dedupeKey: 'x:a' } });
    const ok = await app.inject({ method: 'GET', url: `/v1/news/${a.id}` });
    expect(NewsItemSchema.parse(ok.json()).text).toBe('a');
    const hidden = await prisma.newsItem.findUniqueOrThrow({ where: { dedupeKey: 'x:hidden' } });
    expect((await app.inject({ method: 'GET', url: `/v1/news/${hidden.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/news/nope' })).statusCode).toBe(404);
  });
});

describe('local media store + /media route', () => {
  it('serves stored files with content type and long cache headers; rejects traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fant-media-'));
    const store = new LocalDiskMediaStore(dir, 'http://localhost:4000');
    const { app: local } = await buildTestApp(prisma, { media: store });
    const url = await store.put('instagram/5/0.jpg', new Uint8Array([9, 8, 7]), 'image/jpeg');
    expect(url).toBe('http://localhost:4000/media/instagram/5/0.jpg');
    const res = await local.inject({ method: 'GET', url: '/media/instagram/5/0.jpg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect([...res.rawPayload]).toEqual([9, 8, 7]);
    expect((await local.inject({ method: 'GET', url: '/media/instagram/5/missing.jpg' })).statusCode).toBe(
      404,
    );
    expect((await local.inject({ method: 'GET', url: '/media/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(
      404,
    );
    await store.delete('instagram/5/0.jpg');
    expect((await local.inject({ method: 'GET', url: '/media/instagram/5/0.jpg' })).statusCode).toBe(404);
    await local.close();
    await rm(dir, { recursive: true, force: true });
  });
});
