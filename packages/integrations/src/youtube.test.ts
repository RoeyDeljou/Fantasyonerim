import { describe, expect, it } from 'vitest';
import { fakeContext, on, text } from './__fixtures__/fake-fetch.js';
import { realPodcastRss } from './__fixtures__/podcast-rss.js';
import {
  YOUTUBE_CHANNEL_ID,
  YT_EPISODE_IDS,
  YT_SHORT_IDS,
  channelPageCanonical,
  channelPageChannelIdOnly,
  channelPageJsonOnly,
  channelPageMetaOnly,
  channelPageNoId,
  consentPage,
  realYouTubeFeed,
} from './__fixtures__/youtube.js';
import type { Route } from './__fixtures__/fake-fetch.js';
import { createPodcastSource, mergePodcastLinks } from './podcast-links.js';
import { episodeRefFromDraft, parsePodcastRss } from './podcast-rss.js';
import { tidyPlainText } from './text.js';
import type { EpisodeRef, NewsItemDraft } from './types.js';
import { IntegrationConfigError, IntegrationRateLimitError, IntegrationUnavailableError } from './types.js';
import {
  classifyYouTubeVideos,
  createYouTubeLinkResolver,
  createYouTubeSource,
  extractYouTubeChannelId,
  isEpisodeVideo,
  matchYouTubeEpisodes,
  parseYouTubeChannel,
  parseYouTubeFeed,
  probeYouTubeShort,
  resolveYouTubeChannel,
  resolveYouTubeChannelId,
  splitTrailingHashtags,
  youTubeVideoIdFromUrl,
  youTubeVideoRefFromDraft,
} from './youtube.js';
import type { YouTubeKindCache, YouTubeVideoRef } from './youtube.js';

const ID = YOUTUBE_CHANNEL_ID;
const FEED = 'www.youtube.com/feeds/videos.xml';
const SHORT_IDS = new Set<string>(YT_SHORT_IDS);
const ALL_IDS = [...Object.values(YT_EPISODE_IDS), ...YT_SHORT_IDS];

/** The feed as older YouTube feeds wrote it: every alternate link is /watch, so probing is required. */
const watchOnlyFeed = realYouTubeFeed.replace(
  /https:\/\/www\.youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/g,
  'https://www.youtube.com/watch?v=$1',
);

const feedRoute = (xml = realYouTubeFeed, headers: Record<string, string> = {}): Route =>
  on('GET', FEED, () => text(xml, 200, { 'content-type': 'application/atom+xml', ...headers }));

/** Live behaviour (verified 2026-10-28): 200 for a Short, 303 → /watch for a regular video. */
const shortsRoute: Route = on('HEAD', /^www\.youtube\.com\/shorts\//, (req) => {
  const id = req.url.pathname.split('/')[2] ?? '';
  return SHORT_IDS.has(id)
    ? new Response(null, { status: 200 })
    : new Response(null, { status: 303, headers: { location: `https://www.youtube.com/watch?v=${id}` } });
});

const probes = (requests: { method: string; url: URL }[]) =>
  requests.filter((r) => r.method === 'HEAD' && r.url.pathname.startsWith('/shorts/'));

const byKey = (items: readonly NewsItemDraft[], id: string) =>
  items.find((d) => d.dedupeKey === `youtube:${id}`);

describe('parseYouTubeChannel', () => {
  it.each([
    ['@Fantasyonerim', { kind: 'handle', handle: 'Fantasyonerim' }],
    ['Fantasyonerim', { kind: 'handle', handle: 'Fantasyonerim' }],
    ['https://m.youtube.com/@Fantasyonerim?ra=m', { kind: 'handle', handle: 'Fantasyonerim' }],
    ['https://www.youtube.com/@Fantasyonerim', { kind: 'handle', handle: 'Fantasyonerim' }],
    ['youtube.com/@Fantasyonerim/videos', { kind: 'handle', handle: 'Fantasyonerim' }],
    ['m.youtube.com/@Fantasyonerim/shorts?si=abc', { kind: 'handle', handle: 'Fantasyonerim' }],
    ['https://www.youtube.com/@%D7%A4%D7%A0%D7%98%D7%96%D7%99', { kind: 'handle', handle: 'פנטזי' }],
    [`https://www.youtube.com/channel/${ID}`, { kind: 'id', channelId: ID }],
    [`https://m.youtube.com/channel/${ID}/featured?app=desktop`, { kind: 'id', channelId: ID }],
    [`youtube.com/channel/${ID}`, { kind: 'id', channelId: ID }],
    [`  ${ID}  `, { kind: 'id', channelId: ID }],
  ])('%s', (input, expected) => {
    expect(parseYouTubeChannel(input)).toEqual(expected);
  });

  it.each([
    [''],
    ['https://www.youtube.com/'],
    ['https://www.youtube.com/c/Fantasyonerim'],
    ['https://www.youtube.com/user/Fantasyonerim'],
    ['https://www.youtube.com/channel/UCtooShort'],
    ['https://example.com/@Fantasyonerim'],
    ['https://www.youtube.com.evil.com/@Fantasyonerim'],
    ['@a'],
    ['two words'],
  ])('rejects %j', (input) => {
    expect(parseYouTubeChannel(input)).toBeNull();
  });
});

describe('extractYouTubeChannelId', () => {
  it('reads <link rel="canonical"> (real page)', () => {
    expect(extractYouTubeChannelId(channelPageCanonical)).toBe(ID);
  });
  it('reads <meta itemprop="channelId|identifier">', () => {
    expect(extractYouTubeChannelId(channelPageMetaOnly)).toBe(ID);
    expect(extractYouTubeChannelId(channelPageMetaOnly.replace(/<meta itemprop="channelId"[^>]*>/, ''))).toBe(
      ID,
    );
  });
  it('prefers "externalId" (page owner) over a featured channel\'s "channelId"', () => {
    expect(extractYouTubeChannelId(channelPageJsonOnly)).toBe(ID);
  });
  it('falls back to "channelId"', () => {
    expect(extractYouTubeChannelId(channelPageChannelIdOnly)).toBe(ID);
  });
  it('ignores ids that fail ^UC[A-Za-z0-9_-]{22}$', () => {
    expect(extractYouTubeChannelId(channelPageNoId)).toBeNull();
    expect(extractYouTubeChannelId('"externalId":"UCGjQpoCQcIMtirSjDW1IfxAx"')).toBeNull();
  });
});

describe('resolveYouTubeChannelId', () => {
  const page = (html: string, status = 200, headers: Record<string, string> = {}): Route =>
    on('GET', 'www.youtube.com/@Fantasyonerim', () => text(html, status, headers));

  it('fetches the channel page like a browser, in Hebrew', async () => {
    const { ctx, requests } = fakeContext([page(channelPageCanonical)]);
    await expect(resolveYouTubeChannelId('@Fantasyonerim', ctx)).resolves.toBe(ID);
    const req = requests[0];
    expect(req?.url.href).toBe('https://www.youtube.com/@Fantasyonerim');
    expect(req?.headers.get('accept-language')).toMatch(/^he/);
    expect(req?.headers.get('user-agent')).toMatch(/Mozilla\/5\.0/);
  });

  it('percent-encodes Hebrew handles', async () => {
    const { ctx, requests } = fakeContext([
      on('GET', /^www\.youtube\.com\/@/, () => text(channelPageMetaOnly)),
    ]);
    await expect(resolveYouTubeChannelId('פנטזי', ctx)).resolves.toBe(ID);
    expect(requests[0]?.url.pathname).toBe('/@%D7%A4%D7%A0%D7%98%D7%96%D7%99');
  });

  it('consent redirect → IntegrationUnavailableError with a clear message', async () => {
    const { ctx } = fakeContext([
      page('', 302, {
        location: 'https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F%40Fantasyonerim',
      }),
    ]);
    const err = await resolveYouTubeChannelId('Fantasyonerim', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationUnavailableError);
    expect((err as Error).message).toMatch(/consent\.youtube\.com.*channel id \(UC…/s);
  });

  it('consent page after a followed redirect (res.url) or in the body → unavailable', async () => {
    const followed = text(consentPage);
    Object.defineProperty(followed, 'url', { value: 'https://consent.youtube.com/m?continue=x' });
    const b = fakeContext([on('GET', 'www.youtube.com/@Fantasyonerim', () => followed)]);
    await expect(resolveYouTubeChannelId('Fantasyonerim', b.ctx)).rejects.toThrow(/consent/);
    const c = fakeContext([page(consentPage)]);
    await expect(resolveYouTubeChannelId('Fantasyonerim', c.ctx)).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    );
  });

  it('404 → config (no such handle), 429 → rate limit, 500 / no id → unavailable', async () => {
    await expect(
      resolveYouTubeChannelId('Fantasyonerim', fakeContext([page('', 404)]).ctx),
    ).rejects.toBeInstanceOf(IntegrationConfigError);
    const limited = await resolveYouTubeChannelId(
      'Fantasyonerim',
      fakeContext([page('', 429, { 'retry-after': '120' })]).ctx,
    ).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(IntegrationRateLimitError);
    expect((limited as IntegrationRateLimitError).retryAfterSec).toBe(120);
    await expect(
      resolveYouTubeChannelId('Fantasyonerim', fakeContext([page('', 500)]).ctx),
    ).rejects.toBeInstanceOf(IntegrationUnavailableError);
    await expect(
      resolveYouTubeChannelId('Fantasyonerim', fakeContext([page(channelPageNoId)]).ctx),
    ).rejects.toThrow(/Could not find the channel id/);
    await expect(resolveYouTubeChannelId('Fantasyonerim', fakeContext([]).ctx)).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    );
  });

  it('resolveYouTubeChannel: ids need no request; garbage → config error', async () => {
    const { ctx, requests } = fakeContext([page(channelPageCanonical)]);
    await expect(resolveYouTubeChannel(`https://www.youtube.com/channel/${ID}`, ctx)).resolves.toEqual({
      channelId: ID,
      handle: null,
    });
    expect(requests).toHaveLength(0);
    await expect(resolveYouTubeChannel('https://m.youtube.com/@Fantasyonerim?ra=m', ctx)).resolves.toEqual({
      channelId: ID,
      handle: 'Fantasyonerim',
    });
    await expect(resolveYouTubeChannel('https://www.youtube.com/c/legacy', ctx)).rejects.toBeInstanceOf(
      IntegrationConfigError,
    );
  });
});

describe('parseYouTubeFeed (real recorded feed)', () => {
  const { videos, skipped, channelTitle } = parseYouTubeFeed(realYouTubeFeed);

  it('reads all 15 uploads with id, title, date, description, views and the feed link kind', () => {
    expect(channelTitle).toBe('פנטזיונרים FPL');
    expect(skipped).toEqual([]);
    expect(videos.map((v) => v.videoId)).toEqual([
      'zDzFZbqJUa0',
      'uf2qPDejzuk',
      'rshPXhyPiWQ',
      'tD_i58SGsAs',
      'LvOsbmQk0sU',
      'JrjkcBexeeQ',
      'P1QQ14F22es',
      'co4AXb37Xz0',
      'igdWAjC9J4g',
      'mSrNXJSUXGA',
      'xjshWdWca3c',
      'ZoJF_k8lPZs',
      'ePxQuDmJEAg',
      'sXu5BmLn4hc',
      '9VBhl6hWTY0',
    ]);
    const ep63 = videos[0];
    expect(ep63?.title).toBe('פרק 63 - בוחרים קפטן');
    expect(ep63?.publishedAt.toISOString()).toBe('2026-10-27T01:41:57.000Z');
    expect(ep63?.feedKind).toBe('video');
    expect(ep63?.views).toBe(16);
    expect(ep63?.description).toContain('פינה חדשה: "פנטזיה או מציאות?"'); // &quot; decoded
    expect(ep63?.description).toContain('\n02:15 - סיכום GW8 שלנו\n'); // line breaks kept
    expect(
      videos
        .filter((v) => v.feedKind === 'short')
        .map((v) => v.videoId)
        .sort(),
    ).toEqual([...YT_SHORT_IDS].sort());
  });

  it('skips malformed entries and keeps the rest', () => {
    const broken = realYouTubeFeed
      .replace('<yt:videoId>uf2qPDejzuk</yt:videoId>', '<yt:videoId>bad id!</yt:videoId>')
      .replace('<published>2026-10-21T00:01:01+00:00</published>', '<published>yesterday</published>');
    const result = parseYouTubeFeed(broken);
    expect(result.videos).toHaveLength(13);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.reason).toMatch(/videoId/);
    expect(result.skipped[1]).toMatchObject({ externalId: 'rshPXhyPiWQ' });
  });

  it('an empty channel has no entries; a non-feed is a config error', () => {
    const empty = realYouTubeFeed.replace(/<entry>[\s\S]*<\/entry>/, '');
    expect(parseYouTubeFeed(empty).videos).toEqual([]);
    expect(() => parseYouTubeFeed('<html><body>hi</body></html>')).toThrow(IntegrationConfigError);
  });
});

describe('Short vs regular classification', () => {
  const { videos } = parseYouTubeFeed(watchOnlyFeed);

  it('HEAD /shorts/<id> without following redirects: 200 → short, 303 → /watch → video', async () => {
    const { ctx, requests } = fakeContext([shortsRoute]);
    await expect(probeYouTubeShort('uf2qPDejzuk', ctx)).resolves.toBe('short');
    await expect(probeYouTubeShort('zDzFZbqJUa0', ctx)).resolves.toBe('video');
    expect(requests[0]?.method).toBe('HEAD');
    expect(requests[0]?.url.href).toBe('https://www.youtube.com/shorts/uf2qPDejzuk');
  });

  it('network error, consent redirect or 404 → null (never throws)', async () => {
    await expect(probeYouTubeShort('zDzFZbqJUa0', fakeContext([]).ctx)).resolves.toBeNull();
    const consent = fakeContext([
      on(
        'HEAD',
        /shorts/,
        () => new Response(null, { status: 302, headers: { location: 'https://consent.youtube.com/m' } }),
      ),
    ]);
    await expect(probeYouTubeShort('zDzFZbqJUa0', consent.ctx)).resolves.toBeNull();
    const gone = fakeContext([on('HEAD', /shorts/, () => new Response(null, { status: 404 }))]);
    await expect(probeYouTubeShort('zDzFZbqJUa0', gone.ctx)).resolves.toBeNull();
  });

  it('probes each unknown video once (≤ 15), then answers from the cache', async () => {
    const cache: YouTubeKindCache = new Map();
    const { ctx, requests } = fakeContext([shortsRoute]);
    const first = await classifyYouTubeVideos(videos, ctx, { cache });
    expect(first.requests).toBe(15);
    expect(
      first.videos
        .filter((v) => v.kind === 'short')
        .map((v) => v.videoId)
        .sort(),
    ).toEqual([...YT_SHORT_IDS].sort());
    expect(first.videos.every((v) => v.kindKnown)).toBe(true);
    const second = await classifyYouTubeVideos(videos, ctx, { cache });
    expect(second.requests).toBe(0);
    expect(probes(requests)).toHaveLength(15);
  });

  it("trusts the feed's /shorts/ links (real feed: 0 probes for shorts)", async () => {
    const { ctx, requests } = fakeContext([shortsRoute]);
    const real = parseYouTubeFeed(realYouTubeFeed).videos;
    const result = await classifyYouTubeVideos(real, ctx, { cache: new Map() });
    expect(result.requests).toBe(8);
    expect(probes(requests).every((r) => !SHORT_IDS.has(r.url.pathname.split('/')[2] ?? ''))).toBe(true);
  });

  it('probe failure: falls back to regular (unknown) — unless the feed demonstrably marks shorts', async () => {
    const offline = fakeContext([]);
    const unknown = await classifyYouTubeVideos(videos, offline.ctx, { cache: new Map() });
    expect(unknown.videos.every((v) => v.kind === 'video' && !v.kindKnown)).toBe(true);
    const real = await classifyYouTubeVideos(parseYouTubeFeed(realYouTubeFeed).videos, offline.ctx, {
      cache: new Map(),
    });
    expect(real.videos.every((v) => v.kindKnown)).toBe(true);
    expect(real.videos.filter((v) => v.kind === 'short')).toHaveLength(7);
  });
});

describe('createYouTubeSource', () => {
  it('turns the real feed into drafts', async () => {
    const { ctx } = fakeContext([feedRoute(), shortsRoute]);
    const result = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, ctx).fetchLatest(null);
    expect(result.accountLabel).toBe('פנטזיונרים FPL');
    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.notModified).toBe(false);
    expect(result.items).toHaveLength(15);
    expect(result.items.filter((d) => d.source === 'youtube_short')).toHaveLength(7);

    const ep63 = byKey(result.items, 'zDzFZbqJUa0');
    expect(ep63).toMatchObject({
      source: 'youtube_video',
      title: 'פרק 63 - בוחרים קפטן',
      podcast: null,
      expiresAt: null,
      links: {
        youtube: 'https://www.youtube.com/watch?v=zDzFZbqJUa0',
        spotify: null,
        apple: null,
        instagram: null,
        x: null,
        audio: null,
      },
      media: [
        {
          kind: 'image',
          sourceUrl: 'https://i.ytimg.com/vi/zDzFZbqJUa0/hq720.jpg',
          posterSourceUrl: null,
          width: 1280,
          height: 720,
          fallback: {
            sourceUrl: 'https://i.ytimg.com/vi/zDzFZbqJUa0/hqdefault.jpg',
            width: 480,
            height: 360,
          },
        },
      ],
    });
    expect(ep63?.publishedAt.toISOString()).toBe('2026-10-27T01:41:57.000Z');
    expect(ep63?.text?.startsWith('מי הקפטן שלכם בקלפי?\n')).toBe(true);
    expect(ep63?.text?.endsWith('https://linktr.ee/Fantasyonerim')).toBe(true);

    const short = byKey(result.items, 'uf2qPDejzuk');
    expect(short).toMatchObject({
      source: 'youtube_short',
      title: 'כשפודן בכושר הוא בלתי ניתן לעצירה 🔥',
      text: 'כשפודן בכושר הוא בלתי ניתן לעצירה 🔥 מה עושים איתו עכשיו ? ⚽⚽⚽\n\n#fantasy #football #פנטזיהכדורגל #פרמיירליג #פנטזי',
      links: { youtube: 'https://www.youtube.com/shorts/uf2qPDejzuk' },
      media: [
        {
          sourceUrl: 'https://i.ytimg.com/vi/uf2qPDejzuk/oar2.jpg',
          width: 1080,
          height: 1920,
          fallback: {
            sourceUrl: 'https://i.ytimg.com/vi/uf2qPDejzuk/hqdefault.jpg',
            width: 480,
            height: 360,
          },
        },
      ],
    });
    // A short without title hashtags keeps its title; its description already has its tags.
    expect(byKey(result.items, 'igdWAjC9J4g')).toMatchObject({
      title: 'שער בכורה לענאן חלאיילי בליגה הטובה בעולם🦁⚽️',
      text: '#fantasy #podcast #פנטזי #פרמיירליג #פרמייר_ליג #fpl\nהאם הוא אצלכם בהרכב ?! ☁️🚀',
    });
  });

  it('dedupe: re-polling yields the same keys; an unchanged feed costs 0 probes, even after a restart', async () => {
    const { ctx, requests } = fakeContext([feedRoute(watchOnlyFeed), shortsRoute]);
    const cache: YouTubeKindCache = new Map();
    const first = await createYouTubeSource({ channelId: ID, kindCache: cache }, ctx).fetchLatest(null);
    expect(probes(requests)).toHaveLength(15);
    const keys = first.items.map((d) => d.dedupeKey);
    expect(new Set(keys).size).toBe(15);
    expect([...keys].sort()).toEqual(ALL_IDS.map((id) => `youtube:${id}`).sort());

    const again = await createYouTubeSource({ channelId: ID, kindCache: cache }, ctx).fetchLatest(
      first.cursor,
    );
    expect(again.items.map((d) => d.dedupeKey)).toEqual(keys);
    expect(again.items).toEqual(first.items);
    expect(probes(requests)).toHaveLength(15);

    // New process (empty cache): the persisted cursor carries the classification.
    const restarted = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, ctx).fetchLatest(
      again.cursor,
    );
    expect(restarted.items).toEqual(first.items);
    expect(probes(requests)).toHaveLength(15);
  });

  it('only new uploads are probed', async () => {
    const cache: YouTubeKindCache = new Map();
    const older = watchOnlyFeed.replace(/<entry>[\s\S]*?<\/entry>/, ''); // drop the newest (episode 63)
    const a = fakeContext([feedRoute(older), shortsRoute]);
    const first = await createYouTubeSource({ channelId: ID, kindCache: cache }, a.ctx).fetchLatest(null);
    expect(first.items).toHaveLength(14);
    const b = fakeContext([feedRoute(watchOnlyFeed), shortsRoute]);
    const second = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, b.ctx).fetchLatest(
      first.cursor,
    );
    expect(probes(b.requests).map((r) => r.url.pathname)).toEqual(['/shorts/zDzFZbqJUa0']);
    expect(byKey(second.items, 'zDzFZbqJUa0')?.source).toBe('youtube_video');
  });

  it('classification failure: listed as regular + a warning, and re-checked next poll under the same key', async () => {
    const offline = fakeContext([feedRoute(watchOnlyFeed)]);
    const first = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, offline.ctx).fetchLatest(
      null,
    );
    expect(first.items.every((d) => d.source === 'youtube_video')).toBe(true);
    expect(first.warnings).toEqual([expect.stringMatching(/15 YouTube upload\(s\)/)]);

    const online = fakeContext([feedRoute(watchOnlyFeed), shortsRoute]);
    const second = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, online.ctx).fetchLatest(
      first.cursor,
    );
    expect(probes(online.requests)).toHaveLength(15);
    expect(second.warnings).toEqual([]);
    expect(byKey(second.items, 'uf2qPDejzuk')?.source).toBe('youtube_short');
    expect(second.items.map((d) => d.dedupeKey)).toEqual(first.items.map((d) => d.dedupeKey));
  });

  it('uses conditional GET when YouTube sends validators (304 → notModified, cursor kept)', async () => {
    const first = fakeContext([feedRoute(realYouTubeFeed, { etag: '"abc"' }), shortsRoute]);
    const r1 = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, first.ctx).fetchLatest(
      null,
    );
    const second = fakeContext([
      on('GET', FEED, (req) => text('', req.headers.get('if-none-match') === '"abc"' ? 304 : 200)),
    ]);
    const r2 = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, second.ctx).fetchLatest(
      r1.cursor,
    );
    expect(r2).toEqual({
      items: [],
      skipped: [],
      warnings: [],
      accountLabel: null,
      cursor: r1.cursor,
      notModified: true,
    });
    expect(second.requests[0]?.url.searchParams.get('channel_id')).toBe(ID);
  });

  it('a garbage cursor is ignored', async () => {
    const { ctx } = fakeContext([feedRoute(), shortsRoute]);
    const r = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, ctx).fetchLatest(
      '{not json',
    );
    expect(r.items).toHaveLength(15);
  });

  it('empty channel → no items, no probes', async () => {
    const empty = realYouTubeFeed.replace(/<entry>[\s\S]*<\/entry>/, '');
    const { ctx, requests } = fakeContext([feedRoute(empty), shortsRoute]);
    const r = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, ctx).fetchLatest(null);
    expect(r.items).toEqual([]);
    expect(probes(requests)).toHaveLength(0);
  });

  it('typed errors: bad channel id, 404, 429, 5xx, network', async () => {
    const run = (routes: Route[], channelId = ID) =>
      createYouTubeSource({ channelId, kindCache: new Map() }, fakeContext(routes).ctx).fetchLatest(null);
    await expect(run([], '@Fantasyonerim')).rejects.toBeInstanceOf(IntegrationConfigError);
    await expect(run([on('GET', FEED, () => text('', 404))])).rejects.toBeInstanceOf(IntegrationConfigError);
    const limited = await run([on('GET', FEED, () => text('', 429, { 'retry-after': '60' }))]).catch(
      (e: unknown) => e,
    );
    expect(limited).toBeInstanceOf(IntegrationRateLimitError);
    expect((limited as IntegrationRateLimitError).retryAfterSec).toBe(60);
    await expect(run([on('GET', FEED, () => text('', 503))])).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    );
    await expect(run([])).rejects.toBeInstanceOf(IntegrationUnavailableError);
    await expect(run([on('GET', FEED, () => text('<html>oops</html>'))])).rejects.toBeInstanceOf(
      IntegrationConfigError,
    );
  });
});

describe('episode matching', () => {
  const rssDrafts = parsePodcastRss(realPodcastRss).items;
  const rssRefs = rssDrafts.map(episodeRefFromDraft).filter((r): r is EpisodeRef => r !== null);
  const ep63: EpisodeRef = {
    dedupeKey: 'podcast:ep-63',
    guid: 'ep-63',
    title: 'פרק 63 - בוחרים קפטן',
    publishedAt: new Date('2026-10-26T22:30:00Z'),
    episodeNumber: 63,
  };
  const refs = [ep63, ...rssRefs];
  const keyOf = (n: number) => refs.find((r) => r.episodeNumber === n)?.dedupeKey ?? 'missing';
  const feedVideos: YouTubeVideoRef[] = parseYouTubeFeed(realYouTubeFeed).videos.map((v) => ({
    videoId: v.videoId,
    title: v.title,
    publishedAt: v.publishedAt,
    isShort: v.feedKind === 'short',
  }));

  it('matches by title and by episode number (YouTube "נגמר" vs RSS "נגמרו")', () => {
    const matched = matchYouTubeEpisodes(refs, feedVideos);
    expect(matched.get(keyOf(63))).toBe(YT_EPISODE_IDS[63]);
    expect(matched.get(keyOf(62))).toBe(YT_EPISODE_IDS[62]);
    for (const n of [61, 60, 59, 58] as const) expect(matched.get(keyOf(n))).toBe(YT_EPISODE_IDS[n]);
    expect(matched.size).toBe(6); // 57/56 are not in the recorded RSS; 34/12/1 are older than the feed
    expect([...matched.values()].some((id) => SHORT_IDS.has(id))).toBe(false);
  });

  it('never matches a short — even one with the same title or episode number', () => {
    const ref: EpisodeRef = {
      dedupeKey: 'podcast:fh',
      guid: 'fh',
      title: 'פרי היט VS ווילדקארד',
      publishedAt: new Date('2026-09-03T10:00:00Z'),
      episodeNumber: null,
    };
    const shortWithNumber: YouTubeVideoRef = {
      videoId: 'AAAAAAAAAAA',
      title: 'פרק 64 - הקטע הכי מצחיק #shorts',
      publishedAt: new Date('2026-11-03T10:00:00Z'),
      isShort: true,
    };
    const ep64: EpisodeRef = {
      ...ep63,
      dedupeKey: 'podcast:ep-64',
      guid: 'ep-64',
      title: 'פרק 64 - x',
      episodeNumber: 64,
      publishedAt: new Date('2026-11-03T09:00:00Z'),
    };
    expect(matchYouTubeEpisodes([ref, ep64], [...feedVideos, shortWithNumber]).size).toBe(0);
  });

  it('episode number only within the date window (default 7 days)', () => {
    const late: YouTubeVideoRef = {
      videoId: 'BBBBBBBBBBB',
      title: 'פרק 63 | פנטזיונרים',
      publishedAt: new Date('2026-11-05T00:00:00Z'),
      isShort: false,
    };
    expect(matchYouTubeEpisodes([ep63], [late]).size).toBe(0);
    expect(
      matchYouTubeEpisodes([ep63], [late], { maxDateDistanceMs: 14 * 86_400_000 }).get(ep63.dedupeKey),
    ).toBe('BBBBBBBBBBB');
  });

  it('title containment when the video has no number; a conflicting number blocks it', () => {
    const ep64: EpisodeRef = {
      dedupeKey: 'podcast:64',
      guid: '64',
      title: 'פרק 64 - דרבי צפון לונדון',
      publishedAt: new Date('2026-11-03T20:00:00Z'),
      episodeNumber: 64,
    };
    const video = (title: string): YouTubeVideoRef => ({
      videoId: 'CCCCCCCCCCC',
      title,
      publishedAt: new Date('2026-11-04T08:00:00Z'),
      isShort: false,
    });
    expect(matchYouTubeEpisodes([ep64], [video('דרבי צפון לונדון | פנטזיונרים FPL')]).size).toBe(1);
    expect(matchYouTubeEpisodes([ep64], [video('פרק 65 - דרבי צפון לונדון')]).size).toBe(0);
    // Never on date alone.
    expect(matchYouTubeEpisodes([ep64], [video('טיפים לדראפט')]).size).toBe(0);
  });

  it('isEpisodeVideo', () => {
    const episodes = refs.map((r) => ({ ...r, youtube: null }));
    const video = (id: string) => feedVideos.find((v) => v.videoId === id) as YouTubeVideoRef;
    expect(isEpisodeVideo(video(YT_EPISODE_IDS[62]), episodes)).toBe(true);
    expect(isEpisodeVideo(video(YT_EPISODE_IDS[63]), episodes)).toBe(true);
    expect(isEpisodeVideo(video(YT_EPISODE_IDS[57]), episodes)).toBe(false); // episode not in the RSS
    expect(isEpisodeVideo(video('uf2qPDejzuk'), episodes)).toBe(false); // short
    const other: YouTubeVideoRef = {
      videoId: 'DDDDDDDDDDD',
      title: 'טיפים לדראפט',
      publishedAt: ep63.publishedAt,
      isShort: false,
    };
    expect(isEpisodeVideo(other, episodes)).toBe(false);

    // Already linked: by link id (whatever the title), and a second upload of that episode stays separate.
    const linked = [{ ...ep63, youtube: 'https://www.youtube.com/watch?v=zDzFZbqJUa0&t=5' }];
    expect(isEpisodeVideo({ ...video(YT_EPISODE_IDS[63]), title: 'renamed' }, linked)).toBe(true);
    const highlights: YouTubeVideoRef = {
      videoId: 'EEEEEEEEEEE',
      title: 'פרק 63 - הרגעים הכי טובים',
      publishedAt: ep63.publishedAt,
      isShort: false,
    };
    expect(isEpisodeVideo(highlights, linked)).toBe(false);
    expect(isEpisodeVideo(highlights, [{ ...ep63, youtube: null }])).toBe(true);
  });

  it('youTubeVideoRefFromDraft / youTubeVideoIdFromUrl', async () => {
    const { ctx } = fakeContext([feedRoute(), shortsRoute]);
    const { items } = await createYouTubeSource({ channelId: ID, kindCache: new Map() }, ctx).fetchLatest(
      null,
    );
    const refsFromDrafts = items.map(youTubeVideoRefFromDraft);
    expect(refsFromDrafts.filter((r) => r?.isShort)).toHaveLength(7);
    expect(youTubeVideoRefFromDraft(rssDrafts[0] as NewsItemDraft)).toBeNull();
    expect(youTubeVideoIdFromUrl('https://youtu.be/zDzFZbqJUa0?si=x')).toBe('zDzFZbqJUa0');
    expect(youTubeVideoIdFromUrl('https://m.youtube.com/shorts/uf2qPDejzuk')).toBe('uf2qPDejzuk');
    expect(youTubeVideoIdFromUrl('https://www.youtube.com/watch?v=zDzFZbqJUa0')).toBe('zDzFZbqJUa0');
    expect(youTubeVideoIdFromUrl('https://example.com/watch?v=zDzFZbqJUa0')).toBeNull();
    expect(youTubeVideoIdFromUrl(null)).toBeNull();
  });
});

describe('YouTube podcast link resolver', () => {
  it('adds links.youtube to podcast episodes via createPodcastSource, never a short', async () => {
    const { ctx } = fakeContext([
      on('GET', 'anchor.fm/s/105778688/podcast/rss', () => text(realPodcastRss)),
      feedRoute(),
      shortsRoute,
    ]);
    const resolver = createYouTubeLinkResolver({ channelId: ID, kindCache: new Map() }, ctx);
    expect(resolver.platform).toBe('youtube');
    const source = createPodcastSource(
      { rssUrl: 'https://anchor.fm/s/105778688/podcast/rss', resolvers: [resolver] },
      ctx,
    );
    const result = await source.fetchLatest(null);
    expect(result.warnings).toEqual([]);
    const linkOf = (n: number) => result.items.find((d) => d.podcast?.episodeNumber === n)?.links.youtube;
    expect(linkOf(62)).toBe('https://www.youtube.com/watch?v=rshPXhyPiWQ');
    expect(linkOf(58)).toBe('https://www.youtube.com/watch?v=mSrNXJSUXGA');
    expect(result.items.filter((d) => d.links.youtube !== undefined)).toHaveLength(5);
    expect(linkOf(34)).toBeUndefined(); // no link → the optional key stays absent
  });

  it('skips videos whose classification failed; a feed failure becomes a warning', async () => {
    const offline = fakeContext([feedRoute(watchOnlyFeed)]);
    const refs = parsePodcastRss(realPodcastRss)
      .items.map(episodeRefFromDraft)
      .filter((r): r is EpisodeRef => r !== null);
    const links = await createYouTubeLinkResolver(
      { channelId: ID, kindCache: new Map() },
      offline.ctx,
    ).resolve(refs);
    expect(links.size).toBe(0);

    const { ctx } = fakeContext([
      on('GET', 'anchor.fm/s/105778688/podcast/rss', () => text(realPodcastRss)),
      on('GET', FEED, () => text('', 500)),
    ]);
    const result = await createPodcastSource(
      {
        rssUrl: 'https://anchor.fm/s/105778688/podcast/rss',
        resolvers: [createYouTubeLinkResolver({ channelId: ID }, ctx)],
      },
      ctx,
    ).fetchLatest(null);
    expect(result.items).toHaveLength(8);
    expect(result.warnings).toEqual([expect.stringMatching(/^youtube lookup failed/)]);
  });

  it('mergePodcastLinks keeps an existing youtube link', () => {
    const draft = parsePodcastRss(realPodcastRss).items[0] as NewsItemDraft;
    const withLink = {
      ...draft,
      links: { ...draft.links, youtube: 'https://www.youtube.com/watch?v=keepKEEPkee' },
    };
    const merged = mergePodcastLinks(
      [withLink],
      new Map([[draft.dedupeKey, { youtube: 'https://www.youtube.com/watch?v=otherOTHERo' }]]),
    );
    expect(merged[0]?.links.youtube).toBe('https://www.youtube.com/watch?v=keepKEEPkee');
  });
});

describe('text helpers', () => {
  it('splitTrailingHashtags', () => {
    expect(splitTrailingHashtags('פרי היט VS ווילדקארד  #fantasy #fpl #פרמייר_ליג')).toEqual({
      title: 'פרי היט VS ווילדקארד',
      hashtags: ['#fantasy', '#fpl', '#פרמייר_ליג'],
    });
    expect(splitTrailingHashtags('#fpl #fantasy')).toEqual({ title: '#fpl #fantasy', hashtags: [] });
    expect(splitTrailingHashtags('GW #9 preview')).toEqual({ title: 'GW #9 preview', hashtags: [] });
  });

  it('tidyPlainText keeps line breaks, trims trailing spaces and extra blank lines', () => {
    expect(tidyPlainText('a  \r\nb\n\n\n\nc  ')).toBe('a\nb\n\nc');
    expect(tidyPlainText('   ')).toBeNull();
    expect(tidyPlainText(null)).toBeNull();
  });
});
