import { IntegrationRateLimitError, IntegrationUnavailableError } from '@fant/integrations';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { THUMBNAIL_BATCH } from '../src/jobs/episodeThumbnails.js';
import type { IntegrationFactories } from '../src/integrations/factories.js';
import { episode, fakeIntegrations, fakeMediaFetch, MemoryMediaStore, result } from './fakes.js';
import { buildTestApp, createTestPrisma, migrateTestDb, resetDb, type TestClock } from './helpers.js';

const prisma = createTestPrisma();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SPOTIFY = (n: number) => `https://open.spotify.com/episode/${String(n).padStart(22, '0')}`;
const THUMB = (n: number) => `https://image-cdn-fa.spotifycdn.com/image/thumb-${n}`;

let app: FastifyInstance;
let clock: TestClock;
let media: MemoryMediaStore;
let fakes: ReturnType<typeof fakeIntegrations>;
let downloads: string[];
let logLines: string[];
/** oEmbed answers per Spotify URL: a thumbnail, null (audio only) or an error to throw. */
let oembed: Map<string, { url: string; width: number | null; height: number | null } | null | Error>;
let oembedCalls: string[];

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  media = new MemoryMediaStore();
  fakes = fakeIntegrations();
  oembed = new Map();
  oembedCalls = [];
  const fetchThumb: IntegrationFactories['fetchSpotifyEpisodeThumbnail'] = async (url) => {
    oembedCalls.push(url);
    const answer = oembed.get(url);
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  const files = new Map<string, { contentType: string; bytes?: Uint8Array }>();
  for (let n = 1; n <= 30; n++)
    files.set(THUMB(n), { contentType: 'image/jpeg', bytes: new Uint8Array([n]) });
  const mediaFetch = fakeMediaFetch(files);
  downloads = mediaFetch.requested;
  logLines = [];
  ({ app, clock } = await buildTestApp(prisma, {
    media,
    fetch: mediaFetch.fetch,
    integrations: { ...fakes.factories, fetchSpotifyEpisodeThumbnail: fetchThumb },
    logger: { level: 'info', stream: { write: (l: string) => void logLines.push(l) } },
  }));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const ago = (ms: number) => new Date(clock.now().getTime() - ms);

/** Episode n with (by default) a Spotify link; the RSS gives the square show cover as its media. */
function ep(n: number, publishedAgoMs = DAY, spotify = true) {
  const draft = episode(n, ago(publishedAgoMs));
  return { ...draft, links: { ...draft.links, spotify: spotify ? SPOTIFY(n) : null } };
}

async function run() {
  expect(await app.jobs.run('podcast', { force: true })).toBe('ok');
}

function lastSummary(): string {
  const jobs = logLines
    .map((l) => JSON.parse(l) as { msg?: string; job?: string; summary?: string })
    .filter((l) => l.msg === 'job ok' && l.job === 'podcast');
  return jobs[jobs.length - 1]?.summary ?? '';
}

const item = (n: number) =>
  prisma.newsItem.findUniqueOrThrow({ where: { dedupeKey: `podcast:guid-${n}` }, include: { media: true } });

describe('per-episode Spotify thumbnails (podcast job)', () => {
  it('replaces the show cover with the re-hosted 16:9 thumbnail, once; feed polls never put the cover back', async () => {
    oembed.set(SPOTIFY(1), { url: THUMB(1), width: 640, height: 360 });
    fakes.podcast.next = result([ep(1), ep(2, DAY, false)]);
    await run();

    const one = await item(1);
    expect(one.thumbnailStatus).toBe('found');
    expect(one.media).toHaveLength(1);
    expect(one.media[0]).toMatchObject({
      order: 0,
      kind: 'image',
      url: 'https://media.test/spotify/guid-1/thumbnail.jpg',
      width: 640,
      height: 360,
      sourceUrl: THUMB(1),
      storageKey: 'spotify/guid-1/thumbnail.jpg',
    });
    expect(media.objects.get('spotify/guid-1/thumbnail.jpg')?.contentType).toBe('image/jpeg');
    expect(downloads).toEqual([THUMB(1)]);
    // links untouched.
    expect(one.links).toMatchObject({ spotify: SPOTIFY(1), audio: 'https://anchor.test/ep1.mp3' });
    // No Spotify link → never looked up, the cover stays.
    const two = await item(2);
    expect(two.thumbnailStatus).toBeNull();
    expect(two.media[0]?.sourceUrl).toBe('https://cdn.anchor.test/art.jpg');
    expect(oembedCalls).toEqual([SPOTIFY(1)]);
    expect(lastSummary()).toContain('thumbnails: 1 found, 0 none, 0 failed');

    // The feed changes (new episode) and re-ingests episode 1 with its cover: the thumbnail stays.
    fakes.podcast.next = result([ep(1), ep(2, DAY, false), ep(3, HOUR, false)]);
    await run();
    expect((await item(1)).media.map((m) => m.sourceUrl)).toEqual([THUMB(1)]);
    // …and it is never looked up again.
    clock.advance(30 * DAY);
    await run();
    expect(oembedCalls).toEqual([SPOTIFY(1)]);
  });

  it('audio-only: "none", re-checked hourly while recent (video added later), never for old episodes', async () => {
    fakes.podcast.next = result([ep(1, HOUR), ep(2, 30 * DAY)]);
    await run();
    expect((await item(1)).thumbnailStatus).toBe('none');
    expect((await item(2)).thumbnailStatus).toBe('none');
    expect(oembedCalls.sort()).toEqual([SPOTIFY(1), SPOTIFY(2)]);
    expect((await item(1)).media[0]?.sourceUrl).toBe('https://cdn.anchor.test/art.jpg');

    // Within the hour: nothing due.
    clock.advance(30 * 60 * 1000);
    await run();
    expect(oembedCalls).toHaveLength(2);
    expect(lastSummary()).toContain('thumbnails: none due');

    // An hour later the video exists for episode 1; the 30-day-old episode 2 isn't re-checked.
    oembed.set(SPOTIFY(1), { url: THUMB(1), width: 640, height: 360 });
    clock.advance(31 * 60 * 1000);
    await run();
    expect(oembedCalls.slice(2)).toEqual([SPOTIFY(1)]);
    expect((await item(1)).thumbnailStatus).toBe('found');

    // After 7 days, a still audio-only episode stops being re-checked.
    fakes.podcast.next = result([ep(1, HOUR), ep(2, 30 * DAY), ep(3, HOUR)]);
    await run();
    expect((await item(3)).thumbnailStatus).toBe('none');
    const calls = oembedCalls.length;
    clock.advance(8 * DAY);
    await run();
    expect(oembedCalls).toHaveLength(calls);
  });

  it(`backfills existing episodes ${THUMBNAIL_BATCH} per run, newest first`, async () => {
    const drafts = Array.from({ length: 20 }, (_, i) => ep(i + 1, (i + 1) * DAY));
    for (const d of drafts)
      oembed.set(d.links.spotify ?? '', {
        url: THUMB(Number(d.dedupeKey.split('-')[1])),
        width: 640,
        height: 360,
      });
    fakes.podcast.next = result(drafts);
    await run();
    expect(oembedCalls).toHaveLength(THUMBNAIL_BATCH);
    expect(oembedCalls[0]).toBe(SPOTIFY(1)); // newest
    await run();
    expect(oembedCalls).toHaveLength(20);
    expect(await prisma.newsItem.count({ where: { thumbnailStatus: 'found' } })).toBe(20);
    await run();
    expect(oembedCalls).toHaveLength(20);
  });

  it('one episode failing never blocks the others, the feed or the Spotify status; failures retry later', async () => {
    oembed.set(SPOTIFY(1), new IntegrationUnavailableError('Spotify oEmbed failed (HTTP 500).', 500));
    oembed.set(SPOTIFY(2), {
      url: 'https://image-cdn-fa.spotifycdn.com/image/missing',
      width: 640,
      height: 360,
    });
    oembed.set(SPOTIFY(3), { url: THUMB(3), width: 640, height: 360 });
    fakes.podcast.next = result([ep(1, HOUR), ep(2, 2 * HOUR), ep(3, 3 * HOUR)]);
    await run();

    expect(await prisma.newsItem.count({ where: { source: 'podcast' } })).toBe(3);
    expect((await item(1)).thumbnailStatus).toBe('error');
    expect((await item(2)).thumbnailStatus).toBe('error'); // download 404
    expect((await item(3)).thumbnailStatus).toBe('found');
    expect((await item(1)).media[0]?.sourceUrl).toBe('https://cdn.anchor.test/art.jpg');
    expect(lastSummary()).toMatch(/thumbnails: 1 found, 0 none, 2 failed \(.*HTTP 500/);
    const spotify = await prisma.integrationConfig.findUnique({ where: { id: 'spotify' } });
    expect(spotify?.lastError ?? null).toBeNull();
    const lease = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'podcast' } });
    expect(lease.lastError).toBeNull();

    // Errors are retried an hour later (not every 5 minutes).
    oembed.set(SPOTIFY(1), { url: THUMB(1), width: 640, height: 360 });
    await run();
    expect(oembedCalls.filter((u) => u === SPOTIFY(1))).toHaveLength(1);
    clock.advance(HOUR);
    await run();
    expect((await item(1)).thumbnailStatus).toBe('found');
  });

  it('a 429 stops the batch; the rest wait for the next run', async () => {
    fakes.podcast.next = result([ep(1, HOUR), ep(2, 2 * HOUR), ep(3, 3 * HOUR)]);
    oembed.set(SPOTIFY(1), new IntegrationRateLimitError('Spotify oEmbed rate limit reached.', 60));
    await run();
    expect(oembedCalls).toEqual([SPOTIFY(1)]);
    expect((await item(2)).thumbnailStatus).toBeNull();
    await run();
    expect(oembedCalls.slice(1).sort()).toEqual([SPOTIFY(2), SPOTIFY(3)]);
  });
});
