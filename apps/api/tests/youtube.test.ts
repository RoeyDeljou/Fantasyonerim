import { IntegrationUnavailableError, youTubeDraft, type NewsItemDraft } from '@fant/integrations';
import { HiddenNewsListSchema, NewsPageSchema } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecrets, ensureIntegrationRows } from '../src/integrations/store.js';
import { devSecretsKey } from '../src/secrets.js';
import {
  episode,
  fakeIntegrations,
  fakeMediaFetch,
  FakePushProvider,
  MemoryMediaStore,
  result,
  subscribe,
} from './fakes.js';
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
  type TestClock,
} from './helpers.js';

const prisma = createTestPrisma();
const HOUR = 60 * 60 * 1000;
const SHORT_ID = 'uf2qPDejzuk';
const VIDEO_ID = 'aaaaaaaaaaa';
const EPISODE_VIDEO_ID = 'zDzFZbqJUa0';

let app: FastifyInstance;
let fpl: FakeFplService;
let clock: TestClock;
let fakes: ReturnType<typeof fakeIntegrations>;
let media: MemoryMediaStore;
let push: FakePushProvider;
let files: Map<string, { contentType: string; bytes?: Uint8Array }>;

const thumb = (id: string, name: string) => `https://i.ytimg.com/vi/${id}/${name}`;

async function boot(options: TestAppOptions = {}) {
  fakes = fakeIntegrations();
  media = new MemoryMediaStore();
  push = new FakePushProvider();
  files = new Map();
  for (const id of [SHORT_ID, VIDEO_ID, EPISODE_VIDEO_ID]) {
    for (const name of ['oar2.jpg', 'hq720.jpg', 'hqdefault.jpg']) {
      files.set(thumb(id, name), { contentType: 'image/jpeg' });
    }
  }
  ({ app, fpl, clock } = await buildTestApp(prisma, {
    integrations: fakes.factories,
    media,
    push,
    fetch: fakeMediaFetch(files).fetch,
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

const ago = (ms: number) => new Date(clock.now().getTime() - ms);

function yt(videoId: string, kind: 'short' | 'video', title: string, publishedAt: Date): NewsItemDraft {
  return youTubeDraft({
    videoId,
    title,
    description: `About ${title}`,
    publishedAt,
    feedKind: kind,
    views: null,
    kind,
    kindKnown: true,
  });
}

async function run(job: 'youtube' | 'podcast') {
  expect(await app.jobs.run(job, { force: true })).toBe('ok');
}

/**
 * The podcast job's relink pass (unchanged feed) resolves the YouTube link: the fake `resolveEpisodeLinks`
 * returns `fakes.resolved.links` for whatever resolvers the job built (incl. the YouTube one).
 */
async function linkEpisode62(watch: string) {
  fakes.resolved.links = new Map([['podcast:guid-62', { youtube: watch }]]);
  fakes.podcast.next = result([], { notModified: true });
  await run('podcast');
}

const item = (videoId: string) =>
  prisma.newsItem.findUnique({ where: { dedupeKey: `youtube:${videoId}` }, include: { media: true } });

async function feed() {
  const res = await app.inject({ method: 'GET', url: '/v1/news' });
  expect(res.statusCode).toBe(200);
  return NewsPageSchema.parse(res.json()).items;
}

describe('youtube job', () => {
  it('imports Shorts and videos with re-hosted thumbnails; the backfill is silent, a new upload pushes once', async () => {
    const fan = await registerUser(app, fpl, 7);
    await subscribe(app, fan.token, 'https://push.test/fan');
    fakes.youtube.next = result([
      yt(SHORT_ID, 'short', 'גול של האלאנד', ago(2 * HOUR)),
      yt(VIDEO_ID, 'video', 'Q&A עם המאזינים', ago(3 * HOUR)),
    ]);
    await run('youtube');

    const short = await item(SHORT_ID);
    expect(short).toMatchObject({ source: 'youtube_short', title: 'גול של האלאנד' });
    expect(short?.media).toEqual([
      expect.objectContaining({
        kind: 'image',
        width: 1080,
        height: 1920,
        sourceUrl: thumb(SHORT_ID, 'oar2.jpg'),
        storageKey: `youtube/${SHORT_ID}/youtube_short/0.jpg`,
        url: `https://media.test/youtube/${SHORT_ID}/youtube_short/0.jpg`,
      }),
    ]);
    const video = await item(VIDEO_ID);
    expect(video?.source).toBe('youtube_video');
    expect(video?.media[0]).toMatchObject({
      width: 1280,
      height: 720,
      sourceUrl: thumb(VIDEO_ID, 'hq720.jpg'),
    });
    expect(push.sent).toHaveLength(0); // first sync = backfill: no notifications

    const items = await feed();
    expect(items.find((i) => i.source === 'youtube_short')?.links.youtube).toBe(
      `https://www.youtube.com/shorts/${SHORT_ID}`,
    );
    expect(items.find((i) => i.source === 'youtube_video')?.links.youtube).toBe(
      `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    );

    // A new Short after the backfill → exactly one push (news preference).
    const NEW_ID = 'bbbbbbbbbbb';
    files.set(thumb(NEW_ID, 'oar2.jpg'), { contentType: 'image/jpeg' });
    fakes.youtube.next = result([...fakes.youtube.next.items, yt(NEW_ID, 'short', 'שורט חדש', ago(60_000))]);
    await run('youtube');
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toMatchObject({ title: '▶️ שורט חדש ביוטיוב', body: 'שורט חדש' });
    await run('youtube');
    expect(push.sent).toHaveLength(1);
  });

  it('respects the news preference for YouTube pushes', async () => {
    const fan = await registerUser(app, fpl, 8);
    await subscribe(app, fan.token, 'https://push.test/fan8');
    await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-prefs',
      headers: bearer(fan.token),
      payload: { news: false, fpl: true, live: true, community: true },
    });
    fakes.youtube.next = result([]);
    await run('youtube'); // backfill done
    fakes.youtube.next = result([yt(VIDEO_ID, 'video', 'סרטון', ago(60_000))]);
    await run('youtube');
    expect(await item(VIDEO_ID)).not.toBeNull();
    expect(push.sent).toHaveLength(0);
  });

  it('falls back to hqdefault when the main thumbnail is missing', async () => {
    files.delete(thumb(VIDEO_ID, 'hq720.jpg'));
    fakes.youtube.next = result([yt(VIDEO_ID, 'video', 'סרטון', ago(HOUR))]);
    await run('youtube');
    expect((await item(VIDEO_ID))?.media[0]).toMatchObject({
      sourceUrl: thumb(VIDEO_ID, 'hqdefault.jpg'),
      width: 480,
      height: 360,
      storageKey: `youtube/${VIDEO_ID}/youtube_video/0.jpg`,
    });
  });

  it('a video later reclassified as a Short updates source, media and text', async () => {
    fakes.youtube.next = result([yt(VIDEO_ID, 'video', 'Title #fpl', ago(HOUR))]);
    await run('youtube');
    expect((await item(VIDEO_ID))?.source).toBe('youtube_video');

    fakes.youtube.next = result([yt(VIDEO_ID, 'short', 'Title #fpl', ago(HOUR))]);
    await run('youtube');
    const after = await item(VIDEO_ID);
    expect(after?.source).toBe('youtube_short');
    expect(after?.title).toBe('Title');
    expect(after?.text).toContain('#fpl');
    expect(after?.media).toHaveLength(1);
    expect(after?.media[0]).toMatchObject({
      sourceUrl: thumb(VIDEO_ID, 'oar2.jpg'),
      width: 1080,
      height: 1920,
      storageKey: `youtube/${VIDEO_ID}/youtube_short/0.jpg`,
    });
    expect(await prisma.newsItem.count({ where: { dedupeKey: `youtube:${VIDEO_ID}` } })).toBe(1);
  });

  it('an episode video gets no item of its own; the episode gets links.youtube', async () => {
    const watch = `https://www.youtube.com/watch?v=${EPISODE_VIDEO_ID}`;
    fakes.podcast.next = result([episode(62, ago(2 * HOUR)), episode(61, ago(200 * HOUR))]);
    await run('podcast');
    await linkEpisode62(watch);
    expect(fakes.youtubeLinks.channelIds[0]).toBe('UCGjQpoCQcIMtirSjDW1IfxA');
    expect(fakes.resolved.calls.length).toBeGreaterThan(0);
    const ep62 = await prisma.newsItem.findUniqueOrThrow({ where: { dedupeKey: 'podcast:guid-62' } });
    expect(ep62.links).toMatchObject({ youtube: watch });

    fakes.youtube.next = result([
      yt(EPISODE_VIDEO_ID, 'video', 'פרק 62 - כותרת', ago(HOUR)),
      yt(SHORT_ID, 'short', 'קטע מהפרק', ago(HOUR)),
    ]);
    await run('youtube');
    expect(await item(EPISODE_VIDEO_ID)).toBeNull();
    expect(await item(SHORT_ID)).not.toBeNull();

    const items = await feed();
    expect(items.find((i) => i.id === ep62.id)?.links.youtube).toBe(watch);
    expect(items.find((i) => i.source === 'podcast' && i.id !== ep62.id)?.links.youtube).toBeNull();
  });

  it('a video imported before its episode was linked is hidden for good once it is', async () => {
    fakes.podcast.next = result([episode(62, ago(2 * HOUR))]);
    await run('podcast'); // no YouTube link yet
    // Unrelated-looking title: not matched by title, so it's imported as its own video…
    fakes.youtube.next = result([yt(EPISODE_VIDEO_ID, 'video', 'Full stream', ago(HOUR))]);
    await run('youtube');
    expect((await feed()).some((i) => i.source === 'youtube_video')).toBe(true);

    // …until the episode's resolver links it.
    await linkEpisode62(`https://www.youtube.com/watch?v=${EPISODE_VIDEO_ID}`);
    await run('youtube');
    const hidden = await item(EPISODE_VIDEO_ID);
    expect(hidden?.hiddenAt).not.toBeNull();
    expect(hidden?.suppressed).toBe(true);
    expect((await feed()).some((i) => i.source === 'youtube_video')).toBe(false);
    // Not an admin-hidden item (not listed, can't be restored by accident).
    const admin = await adminToken(app, prisma);
    const list = await app.inject({ method: 'GET', url: '/v1/admin/news/hidden', headers: bearer(admin) });
    expect(HiddenNewsListSchema.parse(list.json()).items).toEqual([]);
    // Re-polls stay a no-op.
    await run('youtube');
    expect(await prisma.newsItem.count({ where: { source: 'youtube_video' } })).toBe(1);
  });
});

describe('podcast relink is per platform', () => {
  const linked = (n: number, publishedAt: Date, youtube: string | null = null) => {
    const ep = episode(n, publishedAt);
    return {
      ...ep,
      links: {
        ...ep.links,
        spotify: `https://open.spotify.com/episode/${String(n).padStart(22, '0')}`,
        apple: `https://podcasts.apple.com/podcast/id1819558192?i=${n}`,
        ...(youtube === null ? {} : { youtube }),
      },
    };
  };
  const relink = async () => {
    fakes.podcast.next = result([], { notModified: true });
    await run('podcast');
  };

  beforeEach(async () => {
    await ensureIntegrationRows(prisma);
    await prisma.integrationConfig.update({
      where: { id: 'spotify' },
      data: { secretsEnc: encryptSecrets(devSecretsKey(), { clientId: 'id', clientSecret: 'secret' }) },
    });
  });

  it('Spotify + Apple linked, YouTube missing → only the youtube resolver; everything linked → none', async () => {
    fakes.podcast.next = result([linked(62, ago(2 * HOUR)), linked(61, ago(7 * 24 * HOUR))]);
    await run('podcast'); // feed changed: the feed's own resolvers ran, no relink
    await relink();
    expect(fakes.resolved.platforms).toEqual([['youtube']]);

    fakes.resolved.links = new Map([
      ['podcast:guid-62', { youtube: `https://www.youtube.com/watch?v=${EPISODE_VIDEO_ID}` }],
      ['podcast:guid-61', { youtube: `https://www.youtube.com/watch?v=${VIDEO_ID}` }],
    ]);
    await relink();
    expect(fakes.resolved.platforms).toHaveLength(2);
    await relink(); // nothing missing any more
    expect(fakes.resolved.platforms).toHaveLength(2);
  });

  it('episodes older than the oldest upload in the YouTube feed (− 7 days) never trigger the youtube resolver', async () => {
    fakes.podcast.next = result([linked(30, ago(60 * 24 * HOUR))]);
    await run('podcast');
    // The youtube job saw a feed whose oldest upload is 20 days old.
    fakes.youtube.next = result([
      yt(SHORT_ID, 'short', 'שורט', ago(2 * HOUR)),
      yt(VIDEO_ID, 'video', 'ישן', ago(20 * 24 * HOUR)),
    ]);
    await run('youtube');
    const lease = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'youtube' } });
    expect(lease.state).toMatchObject({ feedOldestAt: ago(20 * 24 * HOUR).getTime() });

    await relink();
    expect(fakes.resolved.platforms).toEqual([]);

    // A recent episode without its video → youtube only, for that episode.
    fakes.podcast.next = result([linked(30, ago(60 * 24 * HOUR)), linked(63, ago(HOUR))]);
    await run('podcast');
    await relink();
    expect(fakes.resolved.platforms).toEqual([['youtube']]);
  });
});

describe('youtube integration settings', () => {
  const put = (token: string, channel: string, enabled = true) =>
    app.inject({
      method: 'PUT',
      url: '/v1/admin/integrations/youtube',
      headers: bearer(token),
      payload: { enabled, settings: { channel } },
    });

  it('saving the channel resolves and stores the channel id + handle label', async () => {
    const admin = await adminToken(app, prisma);
    const res = await put(admin, 'https://www.youtube.com/@OtherChannel');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'youtube',
      configured: true,
      accountLabel: '@OtherChannel',
      settings: { channel: 'https://www.youtube.com/@OtherChannel', channelId: 'UCresolvedFakeChannel0000' },
    });
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'youtube' } });
    expect(row.initialSyncDone).toBe(false); // a new channel backfills silently

    const byId = await put(admin, 'UCGjQpoCQcIMtirSjDW1IfxA');
    expect(byId.json().settings.channelId).toBe('UCGjQpoCQcIMtirSjDW1IfxA');

    const bad = await put(admin, 'not a channel!!');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/^settings\.channel:/);
  });

  it('a lookup the server cannot do (consent page) → 400 asking for the UC… id; nothing saved', async () => {
    await app.close();
    await resetDb(prisma);
    const base = fakeIntegrations();
    await boot({
      integrations: {
        ...base.factories,
        resolveYouTubeChannel: async () => {
          throw new IntegrationUnavailableError('YouTube sent a consent page instead of the channel.', null);
        },
      },
    });
    const admin = await adminToken(app, prisma);
    const res = await put(admin, '@SomeHandle');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/paste the channel id \(UC…/);
    const row = await prisma.integrationConfig.findUnique({ where: { id: 'youtube' } });
    expect(row?.settings ?? { channelId: 'UCGjQpoCQcIMtirSjDW1IfxA' }).toMatchObject({
      channelId: 'UCGjQpoCQcIMtirSjDW1IfxA',
    });
  });

  it('the migration adds the enum value and existing installs get the youtube row', async () => {
    const values = await prisma.$queryRaw<
      { v: string }[]
    >`SELECT unnest(enum_range(NULL::"IntegrationId"))::text AS v`;
    expect(values.map((r) => r.v)).toContain('youtube');
    await ensureIntegrationRows(prisma);
    await prisma.integrationConfig.delete({ where: { id: 'youtube' } }); // an install from before YouTube
    await ensureIntegrationRows(prisma);
    const row = await prisma.integrationConfig.findUniqueOrThrow({ where: { id: 'youtube' } });
    expect(row.enabled).toBe(true);
    expect(row.settings).toEqual({
      channel: 'https://www.youtube.com/@Fantasyonerim',
      channelId: 'UCGjQpoCQcIMtirSjDW1IfxA',
    });
  });

  it('disabled → the job does nothing', async () => {
    await ensureIntegrationRows(prisma);
    await prisma.integrationConfig.update({ where: { id: 'youtube' }, data: { enabled: false } });
    fakes.youtube.next = result([yt(VIDEO_ID, 'video', 'x', ago(HOUR))]);
    await run('youtube');
    expect(fakes.youtube.configs).toHaveLength(0);
    expect(await item(VIDEO_ID)).toBeNull();
  });
});
