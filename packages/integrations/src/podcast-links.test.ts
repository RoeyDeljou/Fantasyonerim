import { describe, expect, it } from 'vitest';
import { realAppleLookup } from './__fixtures__/apple-lookup.js';
import { fakeContext, json, on, text } from './__fixtures__/fake-fetch.js';
import {
  SPOTIFY_SHOW_ID,
  spotifyEpisodesPage1,
  spotifyEpisodesPage2,
  spotifyToken,
} from './__fixtures__/platform-payloads.js';
import { realPodcastRss } from './__fixtures__/podcast-rss.js';
import { createAppleLinkResolver, parseApplePodcastId } from './apple.js';
import { createPodcastSource, matchEpisodes, mergePodcastLinks } from './podcast-links.js';
import { episodeRefFromDraft, parsePodcastRss } from './podcast-rss.js';
import { createSpotifyLinkResolver, parseSpotifyShowId } from './spotify.js';
import type { EpisodeRef } from './types.js';
import { IntegrationAuthError, IntegrationConfigError } from './types.js';

const drafts = parsePodcastRss(realPodcastRss).items;
const refs = drafts.map(episodeRefFromDraft).filter((r): r is EpisodeRef => r !== null);
const keyOf = (n: number) => refs.find((r) => r.episodeNumber === n)?.dedupeKey ?? 'missing';

const APPLE_LOOKUP = 'itunes.apple.com/lookup';

function appleWith(mutate: (results: Record<string, unknown>[]) => void): unknown {
  const copy = structuredClone(realAppleLookup) as { results: Record<string, unknown>[] };
  mutate(copy.results);
  return copy;
}

describe('Apple link resolver (real recorded lookup)', () => {
  it('matches by GUID and returns clean trackViewUrls', async () => {
    const { ctx, requests } = fakeContext([on('GET', APPLE_LOOKUP, () => json(realAppleLookup))]);
    const links = await createAppleLinkResolver({ podcastId: '1819558192' }, ctx).resolve(refs);
    const params = requests[0]?.url.searchParams;
    expect(params?.get('id')).toBe('1819558192');
    expect(params?.get('entity')).toBe('podcastEpisode');
    expect(params?.get('limit')).toBe('200');
    // Recorded lookup was trimmed to 6 of the 8 RSS episodes; episodes 12 and 1 aren't in it.
    expect(links.size).toBe(6);
    expect(links.get(keyOf(62))?.apple).toBe(
      'https://podcasts.apple.com/us/podcast/%D7%A4%D7%A8%D7%A7-62-%D7%90%D7%99%D7%9F-%D7%A6%D7%99%D7%A4%D7%99%D7%9D-%D7%A0%D7%92%D7%9E%D7%A8%D7%95-%D7%94%D7%A6%D7%99%D7%A4%D7%99%D7%9D/id1819558192?i=1000797351967',
    );
    expect(links.has(keyOf(1))).toBe(false);
  });

  it('falls back to the normalized title when the GUID differs', async () => {
    const lookup = appleWith((results) => {
      for (const r of results) {
        if (r['wrapperType'] !== 'podcastEpisode') continue;
        r['episodeGuid'] = `other-${String(r['episodeGuid'])}`;
        r['trackName'] = String(r['trackName']).replace(/'/g, '׳') + ' 🎙️';
      }
    });
    const { ctx } = fakeContext([on('GET', APPLE_LOOKUP, () => json(lookup))]);
    const links = await createAppleLinkResolver({ podcastId: 'id1819558192' }, ctx).resolve(refs);
    expect(links.size).toBe(6);
    expect(links.get(keyOf(62))?.apple).toContain('i=1000797351967');
  });

  it('falls back to episode number + date within 48 h, and never matches outside it', async () => {
    const lookup = appleWith((results) => {
      for (const r of results) {
        if (r['wrapperType'] !== 'podcastEpisode') continue;
        delete r['episodeGuid'];
        const n = /פרק (\d+)/.exec(String(r['trackName']))?.[1] ?? '?';
        r['trackName'] = `Episode ${n}`;
      }
      const ep61 = results.find((r) => r['trackName'] === 'Episode 61');
      if (ep61) ep61['releaseDate'] = '2026-09-01T00:00:00Z'; // far from RSS date → no match
    });
    const { ctx } = fakeContext([on('GET', APPLE_LOOKUP, () => json(lookup))]);
    const links = await createAppleLinkResolver({ podcastId: '1819558192' }, ctx).resolve(refs);
    expect(links.get(keyOf(62))?.apple).toContain('i=1000797351967');
    expect(links.has(keyOf(61))).toBe(false);
    expect(links.size).toBe(5);
  });

  it('skips malformed episodes and errors on an unknown show', async () => {
    const lookup = appleWith((results) => {
      results.push({ wrapperType: 'podcastEpisode', trackName: 'broken' });
    });
    const ok = fakeContext([on('GET', APPLE_LOOKUP, () => json(lookup))]);
    expect((await createAppleLinkResolver({ podcastId: '1819558192' }, ok.ctx).resolve(refs)).size).toBe(6);

    const none = fakeContext([on('GET', APPLE_LOOKUP, () => json({ resultCount: 0, results: [] }))]);
    await expect(
      createAppleLinkResolver({ podcastId: '1' + '0'.repeat(9) }, none.ctx).resolve(refs),
    ).rejects.toBeInstanceOf(IntegrationConfigError);
    await expect(
      createAppleLinkResolver({ podcastId: 'abc' }, none.ctx).resolve(refs),
    ).rejects.toBeInstanceOf(IntegrationConfigError);
  });

  it('parses the podcast id from URLs', () => {
    expect(parseApplePodcastId('https://podcasts.apple.com/il/podcast/x/id1819558192')).toBe('1819558192');
    expect(parseApplePodcastId('https://podcasts.apple.com/il/podcast/x/id1819558192?i=1000797351967')).toBe(
      '1819558192',
    );
    expect(parseApplePodcastId('1819558192')).toBe('1819558192');
    expect(parseApplePodcastId('hello')).toBeNull();
  });
});

describe('Spotify link resolver', () => {
  const TOKEN = 'accounts.spotify.com/api/token';
  const EPISODES = `api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}/episodes`;

  function spotify(pageCount = { n: 0 }) {
    return fakeContext([
      on('POST', TOKEN, () => json(spotifyToken)),
      on('GET', EPISODES, (req) => {
        pageCount.n++;
        return json(req.url.searchParams.get('offset') === '0' ? spotifyEpisodesPage1 : spotifyEpisodesPage2);
      }),
    ]);
  }

  it('uses client credentials, paginates and matches by title then episode number + date', async () => {
    const { ctx, requests } = spotify();
    const resolver = createSpotifyLinkResolver(
      {
        showId: `https://open.spotify.com/show/${SPOTIFY_SHOW_ID}?si=abc`,
        clientId: 'cid',
        clientSecret: 'secret',
      },
      ctx,
    );
    const recent = refs.filter((r) => (r.episodeNumber ?? 0) >= 58);
    const links = await resolver.resolve(recent);
    expect(links.get(keyOf(62))).toEqual({
      spotify: 'https://open.spotify.com/episode/5Nv2PDZb0j1UN8O1IcPWIr',
    });
    expect(links.get(keyOf(61))).toEqual({
      spotify: 'https://open.spotify.com/episode/3p7qiG6xSrZHNSOyYyfITx',
    });
    expect(links.get(keyOf(60))).toEqual({
      spotify: 'https://open.spotify.com/episode/0aB1cD2eF3gH4iJ5kL6mN7',
    });
    expect(links.has(keyOf(59))).toBe(false);

    const tokenReq = requests[0];
    expect(tokenReq?.method).toBe('POST');
    expect(tokenReq?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('cid:secret').toString('base64')}`,
    );
    expect(tokenReq?.body).toBe('grant_type=client_credentials');
    const first = requests[1];
    expect(first?.url.searchParams.get('market')).toBe('IL');
    expect(first?.url.searchParams.get('limit')).toBe('50');
    expect(first?.headers.get('authorization')).toBe('Bearer BQD-spotify-token-1');
    // Page 2 contains an episode older than every wanted one → paging stops (no 3rd page request).
    expect(requests.map((r) => r.url.pathname)).toEqual([
      '/api/token',
      `/v1/shows/${SPOTIFY_SHOW_ID}/episodes`,
      `/v1/shows/${SPOTIFY_SHOW_ID}/episodes`,
    ]);
  });

  it('caches the token until it expires', async () => {
    const { ctx, requests, advance } = spotify();
    const resolver = createSpotifyLinkResolver(
      { showId: SPOTIFY_SHOW_ID, clientId: 'c', clientSecret: 's' },
      ctx,
    );
    const only62 = refs.filter((r) => r.episodeNumber === 62);
    await resolver.resolve(only62);
    await resolver.resolve(only62);
    expect(requests.filter((r) => r.url.pathname === '/api/token')).toHaveLength(1);
    advance(3600 * 1000);
    await resolver.resolve(only62);
    expect(requests.filter((r) => r.url.pathname === '/api/token')).toHaveLength(2);
  });

  it('refreshes the token once on a 401 and maps bad credentials to an auth error', async () => {
    let calls = 0;
    const { ctx, requests } = fakeContext([
      on('POST', 'accounts.spotify.com/api/token', () => json(spotifyToken)),
      on('GET', `api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}/episodes`, () =>
        ++calls === 1
          ? json({ error: { status: 401, message: 'The access token expired' } }, 401)
          : json(spotifyEpisodesPage1),
      ),
    ]);
    const resolver = createSpotifyLinkResolver(
      { showId: SPOTIFY_SHOW_ID, clientId: 'c', clientSecret: 's' },
      ctx,
    );
    const links = await resolver.resolve(refs.filter((r) => r.episodeNumber === 62));
    expect(links.size).toBe(1);
    expect(requests.filter((r) => r.url.pathname === '/api/token')).toHaveLength(2);

    const bad = fakeContext([
      on('POST', 'accounts.spotify.com/api/token', () => json({ error: 'invalid_client' }, 400)),
    ]);
    await expect(
      createSpotifyLinkResolver(
        { showId: SPOTIFY_SHOW_ID, clientId: 'x', clientSecret: 'y' },
        bad.ctx,
      ).resolve(refs),
    ).rejects.toBeInstanceOf(IntegrationAuthError);
  });

  it('parses show ids from URLs, URIs and bare ids', () => {
    expect(parseSpotifyShowId(`https://open.spotify.com/show/${SPOTIFY_SHOW_ID}?si=24IoWBElTkOTgQcu`)).toBe(
      SPOTIFY_SHOW_ID,
    );
    expect(parseSpotifyShowId(`https://open.spotify.com/intl-he/show/${SPOTIFY_SHOW_ID}`)).toBe(
      SPOTIFY_SHOW_ID,
    );
    expect(parseSpotifyShowId(`spotify:show:${SPOTIFY_SHOW_ID}`)).toBe(SPOTIFY_SHOW_ID);
    expect(parseSpotifyShowId(` ${SPOTIFY_SHOW_ID} `)).toBe(SPOTIFY_SHOW_ID);
    expect(parseSpotifyShowId('https://open.spotify.com/episode/5Nv2PDZb0j1UN8O1IcPWIr')).toBeNull();
    expect(parseSpotifyShowId(`https://evil.example/show/${SPOTIFY_SHOW_ID}`)).toBeNull();
    expect(parseSpotifyShowId('fantasyonerim')).toBeNull();
  });
});

describe('matchEpisodes', () => {
  const ref = (key: string, title: string, iso: string, n: number | null): EpisodeRef => ({
    dedupeKey: key,
    guid: key,
    title,
    publishedAt: new Date(iso),
    episodeNumber: n,
  });

  it('matches on date alone only when unambiguous', () => {
    const r = [ref('a', 'Totally different', '2026-10-20T20:00:00Z', null)];
    const one = [
      {
        url: 'https://x/1',
        title: 'Other name',
        publishedAt: new Date('2026-10-20T00:00:00Z'),
        guid: null,
        dayPrecision: true,
      },
    ];
    expect(matchEpisodes(r, one).get('a')).toBe('https://x/1');
    const two = [...one, { ...one[0]!, url: 'https://x/2', title: 'Another' }];
    expect(matchEpisodes(r, two).size).toBe(0);
  });

  it('never date-matches a platform episode whose number differs', () => {
    const r = [ref('a', 'Totally different', '2026-10-20T20:00:00Z', 63)];
    const c = [
      {
        url: 'https://x/62',
        title: 'פרק 62 - x',
        publishedAt: new Date('2026-10-20T00:00:00Z'),
        guid: null,
        dayPrecision: true,
      },
    ];
    expect(matchEpisodes(r, c).size).toBe(0);
  });
});

describe('mergePodcastLinks + createPodcastSource', () => {
  it('merges links without mutating or overwriting', () => {
    const [first] = drafts;
    if (first === undefined) throw new Error('no draft');
    const withSpotify = {
      ...first,
      links: { ...first.links, spotify: 'https://open.spotify.com/episode/keep' },
    };
    const merged = mergePodcastLinks(
      [withSpotify],
      new Map([
        [
          first.dedupeKey,
          { spotify: 'https://open.spotify.com/episode/new', apple: 'https://podcasts.apple.com/a' },
        ],
      ]),
    );
    expect(merged[0]?.links.spotify).toBe('https://open.spotify.com/episode/keep');
    expect(merged[0]?.links.apple).toBe('https://podcasts.apple.com/a');
    expect(withSpotify.links.apple).toBeNull();
  });

  it('one episode item carries audio + Apple + Spotify links; a failing resolver is only a warning', async () => {
    const { ctx } = fakeContext([
      on('GET', 'anchor.fm/s/105778688/podcast/rss', () => text(realPodcastRss, 200, { etag: '"v1"' })),
      on('GET', APPLE_LOOKUP, () => json(realAppleLookup)),
      on('POST', 'accounts.spotify.com/api/token', () => json(spotifyToken)),
      on('GET', `api.spotify.com/v1/shows/${SPOTIFY_SHOW_ID}/episodes`, (req) =>
        json(req.url.searchParams.get('offset') === '0' ? spotifyEpisodesPage1 : spotifyEpisodesPage2),
      ),
    ]);
    const source = createPodcastSource(
      {
        rssUrl: 'https://anchor.fm/s/105778688/podcast/rss',
        resolvers: [
          createAppleLinkResolver({ podcastId: '1819558192' }, ctx),
          createSpotifyLinkResolver({ showId: SPOTIFY_SHOW_ID, clientId: 'c', clientSecret: 's' }, ctx),
        ],
      },
      ctx,
    );
    const r = await source.fetchLatest(null);
    const ep62 = r.items.find((i) => i.podcast?.episodeNumber === 62);
    expect(ep62?.links).toMatchObject({
      spotify: 'https://open.spotify.com/episode/5Nv2PDZb0j1UN8O1IcPWIr',
      apple: expect.stringContaining('i=1000797351967'),
      audio: expect.stringContaining('anchor.fm'),
    });
    expect(r.warnings).toEqual([]);
    expect(r.items.map((i) => i.dedupeKey)).toEqual(drafts.map((d) => d.dedupeKey));

    const broken = fakeContext([
      on('GET', 'anchor.fm/s/105778688/podcast/rss', () => text(realPodcastRss)),
      on('GET', APPLE_LOOKUP, () => json(realAppleLookup)),
      on('POST', 'accounts.spotify.com/api/token', () => json({ error: 'invalid_client' }, 401)),
    ]);
    const r2 = await createPodcastSource(
      {
        rssUrl: 'https://anchor.fm/s/105778688/podcast/rss',
        resolvers: [
          createAppleLinkResolver({ podcastId: '1819558192' }, broken.ctx),
          createSpotifyLinkResolver(
            { showId: SPOTIFY_SHOW_ID, clientId: 'c', clientSecret: 's' },
            broken.ctx,
          ),
        ],
      },
      broken.ctx,
    ).fetchLatest(null);
    expect(r2.items.find((i) => i.podcast?.episodeNumber === 62)?.links.apple).toContain('i=1000797351967');
    expect(r2.warnings).toHaveLength(1);
    expect(r2.warnings[0]).toMatch(/^spotify lookup failed: Spotify rejected/);
  });
});
