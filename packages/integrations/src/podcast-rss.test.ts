import { NewsLinksSchema, PodcastMetaSchema } from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { fakeContext, on, text } from './__fixtures__/fake-fetch.js';
import { RECORDED_RSS_ITEM_COUNT, realPodcastRss } from './__fixtures__/podcast-rss.js';
import {
  createPodcastRssSource,
  episodeRefFromDraft,
  fetchPodcastFeed,
  parseDurationSec,
  parsePodcastRss,
} from './podcast-rss.js';
import { IntegrationConfigError, IntegrationRateLimitError, IntegrationUnavailableError } from './types.js';

const RSS_URL = 'https://anchor.fm/s/105778688/podcast/rss';
const CHANNEL_IMAGE =
  'https://d3t3ozftmdmh3i.cloudfront.net/staging/podcast_uploaded_nologo/43766866/43766866-1787569550568-468427bd00244.jpg';

describe('parsePodcastRss (real recorded feed)', () => {
  const result = parsePodcastRss(realPodcastRss);

  it('parses every item of the recorded feed', () => {
    expect(result.accountLabel).toBe('פנטזיונרים');
    expect(result.items).toHaveLength(RECORDED_RSS_ITEM_COUNT);
    expect(result.skipped).toEqual([]);
  });

  it('maps the newest episode completely', () => {
    const ep = result.items[0];
    expect(ep).toBeDefined();
    if (ep === undefined) return;
    expect(ep.dedupeKey).toBe('podcast:8b6c59ed-743a-4eba-996a-8691259baea9');
    expect(ep.source).toBe('podcast');
    expect(ep.title).toBe("פרק 62 - אין צ'יפים, נגמרו הצ'יפים");
    expect(ep.publishedAt.toISOString()).toBe('2026-10-20T23:53:52.000Z');
    expect(ep.podcast).toEqual({ episodeNumber: 62, seasonNumber: null, durationSec: 4403 });
    expect(ep.links.audio).toMatch(/^https:\/\/anchor\.fm\/s\/105778688\/podcast\/play\/127804722\//);
    expect(ep.links.spotify).toBeNull();
    expect(ep.links.apple).toBeNull();
    expect(ep.media).toEqual([
      { kind: 'image', sourceUrl: CHANNEL_IMAGE, posterSourceUrl: null, width: null, height: null },
    ]);
    expect(ep.expiresAt).toBeNull();
    // CDATA HTML → plain text: one line per <p>, entity &#39; decoded, no tags.
    expect(ep.text).not.toMatch(/<|&#39;|&amp;/);
    expect(ep.text?.split('\n')[0]).toBe('תם עידן הצ׳יפים?');
    expect(ep.text).toContain("1:04:19 - צ'יפים וקפטנים לGW8 + שאלות מהקהל");
    expect(ep.text?.endsWith('https://linktr.ee/Fantasyonerim')).toBe(true);
    expect(NewsLinksSchema.parse(ep.links)).toEqual(ep.links);
    expect(PodcastMetaSchema.parse(ep.podcast)).toEqual(ep.podcast);
  });

  it('keeps an empty <p><br></p> as a blank line, reads itunes:season, tolerates a missing episode number', () => {
    const pilot = result.items.find((i) => i.podcast?.episodeNumber === 1);
    expect(pilot?.text).toContain('מקום 17 בעולם.\n\nבואו לעמוד הטוויטר שלנו');
    const season = result.items.find((i) => i.podcast?.seasonNumber !== null);
    expect(season?.podcast).toMatchObject({ episodeNumber: 34, seasonNumber: 34 });
    const unnumbered = result.items.find((i) => i.title === 'פרק 12 - חייבים פגרה');
    expect(unnumbered?.podcast?.episodeNumber).toBeNull();
  });

  it('builds EpisodeRefs for the link resolvers', () => {
    const ep = result.items[0];
    if (ep === undefined) throw new Error('no item');
    expect(episodeRefFromDraft(ep)).toEqual({
      dedupeKey: ep.dedupeKey,
      guid: '8b6c59ed-743a-4eba-996a-8691259baea9',
      title: ep.title,
      publishedAt: ep.publishedAt,
      episodeNumber: 62,
    });
  });
});

describe('parsePodcastRss edge cases', () => {
  const wrap = (items: string, channelExtra = '') =>
    `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show &amp; Co</title>${channelExtra}${items}</channel></rss>`;

  it('falls back to the channel <image>, then to no media', () => {
    const item =
      '<item><title>A</title><guid>g1</guid><pubDate>Tue, 20 Oct 2026 23:53:52 GMT</pubDate><description>x</description></item>';
    const withImage = parsePodcastRss(wrap(item, '<image><url>https://example.com/c.jpg</url></image>'));
    expect(withImage.accountLabel).toBe('Show & Co');
    expect(withImage.items[0]?.media[0]?.sourceUrl).toBe('https://example.com/c.jpg');
    const without = parsePodcastRss(wrap(item));
    expect(without.items[0]?.media).toEqual([]);
    expect(without.items[0]?.links.audio).toBeNull();
    expect(without.items[0]?.podcast).toEqual({ episodeNumber: null, seasonNumber: null, durationSec: null });
  });

  it('prefers the per-item itunes:image', () => {
    const xml = wrap(
      '<item><title>A</title><guid>g1</guid><pubDate>Tue, 20 Oct 2026 23:53:52 GMT</pubDate><itunes:image href="https://example.com/ep.jpg"/></item>',
      '<itunes:image href="https://example.com/show.jpg"/>',
    );
    expect(parsePodcastRss(xml).items[0]?.media[0]?.sourceUrl).toBe('https://example.com/ep.jpg');
  });

  it('skips malformed items instead of throwing', () => {
    const xml = wrap(
      [
        '<item><title>No guid</title><pubDate>Tue, 20 Oct 2026 23:53:52 GMT</pubDate></item>',
        '<item><guid>g-no-title</guid><pubDate>Tue, 20 Oct 2026 23:53:52 GMT</pubDate></item>',
        '<item><title>Bad date</title><guid>g-bad-date</guid><pubDate>yesterday-ish</pubDate></item>',
        '<item><title>OK</title><guid>g-ok</guid><pubDate>Tue, 20 Oct 2026 23:53:52 GMT</pubDate><itunes:duration>42:07</itunes:duration><itunes:episode>-3</itunes:episode></item>',
      ].join(''),
    );
    const r = parsePodcastRss(xml);
    expect(r.items.map((i) => i.dedupeKey)).toEqual(['podcast:g-ok']);
    expect(r.items[0]?.podcast).toEqual({ episodeNumber: null, seasonNumber: null, durationSec: 2527 });
    expect(r.skipped.map((s) => s.externalId)).toEqual(['No guid', 'g-no-title', 'g-bad-date']);
  });

  it('handles an empty feed', () => {
    const r = parsePodcastRss(wrap(''));
    expect(r.items).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it('rejects documents that are not RSS', () => {
    expect(() => parsePodcastRss('<html><body>Not found</body></html>')).toThrow(IntegrationConfigError);
    expect(() => parsePodcastRss('{"json":true}')).toThrow(IntegrationConfigError);
  });
});

describe('parseDurationSec', () => {
  it('parses HH:MM:SS, MM:SS and seconds', () => {
    expect(parseDurationSec('01:13:23')).toBe(4403);
    expect(parseDurationSec('1:13:23')).toBe(4403);
    expect(parseDurationSec('73:23')).toBe(4403);
    expect(parseDurationSec('4403')).toBe(4403);
    expect(parseDurationSec('4403.6')).toBe(4404);
    expect(parseDurationSec('00:00:00')).toBe(0);
  });
  it('rejects garbage', () => {
    expect(parseDurationSec('1:61:00')).toBeNull();
    expect(parseDurationSec('12:75')).toBeNull();
    expect(parseDurationSec('about an hour')).toBeNull();
    expect(parseDurationSec('')).toBeNull();
    expect(parseDurationSec(null)).toBeNull();
  });
});

describe('fetchPodcastFeed (conditional GET)', () => {
  it('stores ETag/Last-Modified in the cursor and sends them back; 304 → notModified', async () => {
    const etag = 'W/"370ee-oyZu7OC0SJgJm4OX+DdlrgXIXB0"';
    const lastModified = 'Fri, 23 Oct 2026 15:19:24 GMT';
    const { ctx, requests } = fakeContext([
      on('GET', 'anchor.fm/s/105778688/podcast/rss', (req) =>
        req.headers.get('if-none-match') === etag
          ? text('', 304, { etag })
          : text(realPodcastRss, 200, { etag, 'last-modified': lastModified }),
      ),
    ]);
    const source = createPodcastRssSource({ rssUrl: RSS_URL }, ctx);
    const first = await source.fetchLatest(null);
    expect(first.notModified).toBe(false);
    expect(first.items).toHaveLength(RECORDED_RSS_ITEM_COUNT);
    expect(first.cursor).not.toBeNull();
    expect(requests[0]?.headers.get('if-none-match')).toBeNull();

    const second = await source.fetchLatest(first.cursor);
    expect(requests[1]?.headers.get('if-none-match')).toBe(etag);
    expect(requests[1]?.headers.get('if-modified-since')).toBe(lastModified);
    expect(second).toEqual({
      items: [],
      skipped: [],
      warnings: [],
      accountLabel: null,
      cursor: first.cursor,
      notModified: true,
    });
  });

  it('works without validators (cursor null) and ignores a corrupt cursor', async () => {
    const { ctx, requests } = fakeContext([
      on('GET', 'anchor.fm/s/105778688/podcast/rss', () => text(realPodcastRss)),
    ]);
    const r = await fetchPodcastFeed({ rssUrl: RSS_URL, cursor: '{not json' }, ctx);
    expect(r.cursor).toBeNull();
    expect(r.items.length).toBeGreaterThan(0);
    expect(requests[0]?.headers.get('if-none-match')).toBeNull();
  });

  it('maps HTTP failures onto typed errors', async () => {
    const cases: [number, unknown][] = [
      [404, IntegrationConfigError],
      [410, IntegrationConfigError],
      [429, IntegrationRateLimitError],
      [503, IntegrationUnavailableError],
    ];
    for (const [status, type] of cases) {
      const { ctx } = fakeContext([() => text('nope', status, { 'retry-after': '120' })]);
      const err = await fetchPodcastFeed({ rssUrl: RSS_URL }, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(type);
      if (err instanceof IntegrationRateLimitError) expect(err.retryAfterSec).toBe(120);
    }
    const down = fakeContext([]);
    await expect(fetchPodcastFeed({ rssUrl: RSS_URL }, down.ctx)).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    );
    await expect(fetchPodcastFeed({ rssUrl: 'ftp://nope' }, down.ctx)).rejects.toBeInstanceOf(
      IntegrationConfigError,
    );
  });
});
