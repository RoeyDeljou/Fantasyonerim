import { describe, expect, it } from 'vitest';
import { fakeContext, json, on } from './__fixtures__/fake-fetch.js';
import {
  X_USER_ID,
  xCreditsDepleted,
  xEmptySearch,
  xSearchRecent,
  xStaleSinceId,
  xUser,
} from './__fixtures__/platform-payloads.js';
import { oauth1Header, oauth1Signature, rfc3986 } from './oauth1.js';
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from './types.js';
import {
  XPostTooLongError,
  buildXSearchQuery,
  createXPublisher,
  createXSource,
  fetchXPosts,
  parseXUsername,
  resolveXUser,
} from './x.js';
import { X_MAX_WEIGHTED_LENGTH, xWeightedLength } from './x-text.js';

const SEARCH = 'api.x.com/2/tweets/search/recent';
const base = { bearerToken: 'AAAA-bearer', userId: X_USER_ID, username: 'Fantasyonerim' };
// Default (owner decision): photos in, web links and videos out — excluded types are never returned or billed.
const QUERY = 'from:Fantasyonerim -is:retweet -is:reply -has:links -has:videos';
/** The fixture includes a video post; most mapping tests turn videos on to keep covering it. */
const withVideos = { ...base, includeVideos: true };
const QUERY_WITH_VIDEOS = 'from:Fantasyonerim -is:retweet -is:reply -has:links';

describe('buildXSearchQuery', () => {
  it('builds the default query: original posts, no web links, no videos (photos kept)', () => {
    expect(buildXSearchQuery('Fantasyonerim')).toBe(QUERY);
    expect(buildXSearchQuery('@Fantasyonerim')).toBe(QUERY);
    expect(buildXSearchQuery('Fantasyonerim', { excludeReplies: false, excludeRetweets: false })).toBe(
      'from:Fantasyonerim -has:links -has:videos',
    );
  });

  it('admin toggles map onto query operators', () => {
    expect(buildXSearchQuery('Fantasyonerim', { includeLinks: true })).toBe(
      'from:Fantasyonerim -is:retweet -is:reply -has:videos',
    );
    expect(buildXSearchQuery('Fantasyonerim', { includeVideos: true })).toBe(QUERY_WITH_VIDEOS);
    expect(buildXSearchQuery('Fantasyonerim', { includePhotos: false })).toBe(`${QUERY} -has:images`);
    expect(
      buildXSearchQuery('Fantasyonerim', { includeLinks: true, includeVideos: true, includePhotos: true }),
    ).toBe('from:Fantasyonerim -is:retweet -is:reply');
  });

  it.each([
    ['Fantasyonerim OR from:elonmusk'],
    ['Fantasyonerim has:links'],
    ['Fantasyonerim)'],
    ['"Fantasyonerim"'],
    ['a_handle_way_too_long'],
    [''],
  ])('rejects %j (no query injection)', (handle) => {
    expect(() => buildXSearchQuery(handle)).toThrow(IntegrationConfigError);
  });
});

describe('fetchXPosts (search/recent)', () => {
  it('first run: one page of 10 with the query; maps posts and drops link posts', async () => {
    const page = { ...xSearchRecent, meta: { ...xSearchRecent.meta, next_token: 'more' } };
    const { ctx, requests } = fakeContext([on('GET', SEARCH, () => json(page))]);
    const r = await fetchXPosts(withVideos, ctx);
    expect(requests).toHaveLength(1); // next_token is ignored on the first run: no backfill
    const p = requests[0]?.url.searchParams;
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer AAAA-bearer');
    expect(p?.get('query')).toBe(QUERY_WITH_VIDEOS);
    expect(requests[0]?.url.search).toContain(
      'query=from%3AFantasyonerim+-is%3Aretweet+-is%3Areply+-has%3Alinks',
    );
    expect(p?.get('max_results')).toBe('10');
    expect(p?.get('tweet.fields')).toBe('created_at,entities,attachments,note_tweet');
    expect(p?.get('expansions')).toBe('attachments.media_keys');
    expect(p?.get('media.fields')).toBe('type,url,preview_image_url,width,height,variants');
    expect(p?.has('since_id')).toBe(false);
    expect(p?.has('next_token')).toBe(false);
    expect(p?.has('exclude')).toBe(false);

    expect(r.accountLabel).toBe('@Fantasyonerim');
    expect(r.cursor).toBe('1850000000000000005');
    expect(r.items.map((i) => i.dedupeKey)).toEqual([
      'x:1850000000000000005',
      'x:1850000000000000003',
      'x:1850000000000000002',
    ]);
    expect(r.warnings).toEqual([
      'X: skipped 1 post(s) containing links (the client does not import link posts).',
    ]);
    expect(r.skipped).toEqual([
      { externalId: '1850000000000000001', reason: 'invalid created_at' },
      { externalId: null, reason: 'unrecognized X post object' },
    ]);

    const [plain, longPost, videoPost] = r.items;
    expect(plain).toMatchObject({
      source: 'x_post',
      title: null,
      text: 'מי הקפטן שלכם למחזור 9? 🧢',
      media: [],
      links: { x: 'https://x.com/Fantasyonerim/status/1850000000000000005', instagram: null },
      podcast: null,
      expiresAt: null,
    });
    expect(longPost?.text).toBe(
      'שרשור ארוך על הקפטנים למחזור 8 — האלאנד, סלאח, פאלמר ומה עם הדיפנס של ארסנל?\n\nמה אתם עושים עם האלאנד?',
    );
    expect(videoPost?.text).toBe('תקציר המחזור 🎥');
    expect(videoPost?.media).toEqual([
      {
        kind: 'video',
        sourceUrl: 'https://video.twimg.com/ext_tw_video/200/pu/vid/1280x720/high.mp4',
        posterSourceUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/1850000000000000200/pu/img/thumb.jpg',
        width: 1280,
        height: 720,
      },
    ]);
  });

  it('dedupe keys and cursor are unchanged by the switch (x:<post id>, newest id)', async () => {
    const { ctx } = fakeContext([on('GET', SEARCH, () => json(xSearchRecent))]);
    const source = createXSource(base, ctx);
    const a = await source.fetchLatest(null);
    const b = await source.fetchLatest(null);
    expect(b.items.map((i) => i.dedupeKey)).toEqual(a.items.map((i) => i.dedupeKey));
    expect(a.items.every((i) => /^x:\d+$/.test(i.dedupeKey))).toBe(true);
  });

  it('polls with since_id and keeps the cursor when nothing is new', async () => {
    const { ctx, requests } = fakeContext([on('GET', SEARCH, () => json(xEmptySearch))]);
    const r = await createXSource({ ...base, maxResults: 5 }, ctx).fetchLatest('1850000000000000005');
    expect(requests[0]?.url.searchParams.get('since_id')).toBe('1850000000000000005');
    expect(requests[0]?.url.searchParams.get('max_results')).toBe('10'); // search/recent minimum
    expect(r.items).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.cursor).toBe('1850000000000000005');
  });

  it('defaults: the video post is dropped too (videos off), photos/plain posts kept', async () => {
    const { ctx, requests } = fakeContext([on('GET', SEARCH, () => json(xSearchRecent))]);
    const r = await fetchXPosts(base, ctx);
    expect(requests[0]?.url.searchParams.get('query')).toBe(QUERY);
    expect(r.items.every((i) => i.media.every((m) => m.kind !== 'video'))).toBe(true);
    expect(r.warnings).toContain('X: skipped 1 post(s) with a media type the admin turned off.');
    expect(r.cursor).toBe('1850000000000000005'); // dropped posts still advance the cursor
  });

  it('quote posts and the post\'s own photo links are not "links" (same as X\'s -has:links)', async () => {
    const mk = (id: string, url: string, mediaKey?: string) => ({
      id,
      text: `post ${id} https://t.co/x${id}`,
      created_at: '2026-11-08T10:00:00.000Z',
      entities: {
        urls: [
          {
            start: 9,
            end: 30,
            url: `https://t.co/x${id}`,
            expanded_url: url,
            display_url: 'x',
            media_key: mediaKey,
          },
        ],
      },
    });
    const payload = {
      data: [
        mk('1900000000000000003', 'https://twitter.com/dor_dabush/status/2100000000000000000'),
        mk('1900000000000000002', 'https://x.com/Fantasyonerim/status/1900000000000000002/photo/1'),
        mk('1900000000000000001', 'https://fantasy.premierleague.com/leagues/auto-join/KJJGKB'),
      ],
      meta: { result_count: 3, newest_id: '1900000000000000003' },
    };
    const { ctx } = fakeContext([on('GET', SEARCH, () => json(payload))]);
    const r = await fetchXPosts(base, ctx);
    expect(r.items.map((i) => i.dedupeKey)).toEqual(['x:1900000000000000003', 'x:1900000000000000002']);
    const withLinks = await fetchXPosts(
      { ...base, includeLinks: true },
      fakeContext([on('GET', SEARCH, () => json(payload))]).ctx,
    );
    expect(withLinks.items).toHaveLength(3);
  });

  it('includePhotos: false drops photo posts', async () => {
    const { ctx } = fakeContext([on('GET', SEARCH, () => json(xSearchRecent))]);
    const all = await fetchXPosts(withVideos, ctx);
    const noPhotos = await fetchXPosts(
      { ...withVideos, includePhotos: false },
      fakeContext([on('GET', SEARCH, () => json(xSearchRecent))]).ctx,
    );
    const hasPhoto = (i: (typeof all.items)[number]) => i.media.some((m) => m.kind === 'image');
    expect(noPhotos.items.some(hasPhoto)).toBe(false);
    expect(noPhotos.items.length).toBe(all.items.filter((i) => !hasPhoto(i)).length);
  });

  it('a dropped link post still advances the cursor (never re-read, never re-billed)', async () => {
    const onlyLink = {
      data: [xSearchRecent.data[1]],
      meta: { result_count: 1, newest_id: '1850000000000000004' },
    };
    const { ctx } = fakeContext([on('GET', SEARCH, () => json(onlyLink))]);
    const r = await fetchXPosts({ ...base, sinceId: '1850000000000000000' }, ctx);
    expect(r.items).toEqual([]);
    expect(r.cursor).toBe('1850000000000000004');
    expect(r.warnings).toHaveLength(1);
  });

  it('follows next_token only while catching up with since_id (bounded)', async () => {
    const page = (id: string, next?: string) =>
      json({
        data: [{ id, text: `post ${id}`, created_at: '2026-10-24T10:00:00.000Z' }],
        meta: { result_count: 1, newest_id: id, ...(next === undefined ? {} : { next_token: next }) },
      });
    const { ctx, requests } = fakeContext([
      on('GET', SEARCH, (req) => {
        const token = req.url.searchParams.get('next_token');
        return token === null ? page('900', 't1') : token === 't1' ? page('800', 't2') : page('700', 't3');
      }),
    ]);
    const r = await fetchXPosts({ ...base, sinceId: '100', maxPages: 2 }, ctx);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.searchParams.get('next_token')).toBe('t1');
    expect(requests[1]?.url.searchParams.get('since_id')).toBe('100');
    expect(r.items.map((i) => i.dedupeKey)).toEqual(['x:900', 'x:800']);
    expect(r.cursor).toBe('900');
  });

  it('since_id older than 7 days (400) → one fresh page without since_id + a warning', async () => {
    const { ctx, requests } = fakeContext([
      on('GET', SEARCH, (req) =>
        req.url.searchParams.has('since_id') ? json(xStaleSinceId, 400) : json(xSearchRecent),
      ),
    ]);
    const r = await fetchXPosts({ ...withVideos, sinceId: '1700000000000000000' }, ctx);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.searchParams.has('since_id')).toBe(false);
    expect(r.items).toHaveLength(3);
    expect(r.cursor).toBe('1850000000000000005');
    expect(r.warnings[0]).toMatch(/older than 7 days/);
  });

  it('invalid username → config error before any request', async () => {
    const { ctx, requests } = fakeContext([on('GET', SEARCH, () => json(xSearchRecent))]);
    await expect(fetchXPosts({ ...base, username: 'x OR from:elonmusk' }, ctx)).rejects.toBeInstanceOf(
      IntegrationConfigError,
    );
    expect(requests).toHaveLength(0);
  });

  it('maps errors: 401/403 auth, 402 credits depleted, 429 with x-rate-limit-reset, 5xx', async () => {
    const run = (res: Response) => fetchXPosts(base, fakeContext([() => res]).ctx).catch((e: unknown) => e);
    expect(
      await run(json({ title: 'Unauthorized', status: 401, detail: 'Unauthorized' }, 401)),
    ).toBeInstanceOf(IntegrationAuthError);
    const forbidden = await run(json({ title: 'Client Forbidden', detail: 'When authenticating…' }, 403));
    expect(forbidden).toBeInstanceOf(IntegrationAuthError);
    expect((forbidden as Error).message).toMatch(/plan\/credits/);
    const depleted = await run(json(xCreditsDepleted, 402));
    expect(depleted).toBeInstanceOf(IntegrationUnavailableError);
    expect((depleted as Error).message).toMatch(/^X credits depleted/);
    expect((depleted as IntegrationUnavailableError).status).toBe(402);
    const nowSec = Date.parse('2026-10-25T12:00:00Z') / 1000;
    const limited = await run(
      json({ title: 'Too Many Requests' }, 429, { 'x-rate-limit-reset': String(nowSec + 900) }),
    );
    expect(limited).toBeInstanceOf(IntegrationRateLimitError);
    expect((limited as IntegrationRateLimitError).retryAfterSec).toBe(900);
    expect(await run(json({}, 503))).toBeInstanceOf(IntegrationUnavailableError);
  });
});

describe('resolveXUser', () => {
  it('looks up the id by username (accepts @handle and profile URLs)', async () => {
    const { ctx, requests } = fakeContext([
      on('GET', 'api.x.com/2/users/by/username/Fantasyonerim', () => json(xUser)),
    ]);
    expect(await resolveXUser({ bearerToken: 'b', username: 'https://x.com/Fantasyonerim' }, ctx)).toEqual({
      id: X_USER_ID,
      username: 'Fantasyonerim',
      name: 'פנטזיונרים',
    });
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer b');
    expect(parseXUsername('@Fantasyonerim')).toBe('Fantasyonerim');
    expect(parseXUsername('not a handle!')).toBeNull();
  });

  it('unknown user → IntegrationConfigError', async () => {
    const { ctx } = fakeContext([
      () =>
        json({
          errors: [{ title: 'Not Found Error', detail: 'Could not find user with username: [nobody].' }],
        }),
    ]);
    await expect(resolveXUser({ bearerToken: 'b', username: 'nobody' }, ctx)).rejects.toBeInstanceOf(
      IntegrationConfigError,
    );
  });
});

describe('OAuth 1.0a', () => {
  // Known answer from X's "Creating a signature" documentation.
  const creds = {
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  };
  const input = {
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    bodyParams: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: 1318622958,
  };

  it('matches the documented signature base string and signature', () => {
    const { baseString, signature } = oauth1Signature(creds, input);
    expect(baseString).toBe(
      'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
    );
    expect(signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
    expect(oauth1Header(creds, input)).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  it('percent-encodes per RFC 3986', () => {
    expect(rfc3986("!*'()~ a+b/ש")).toBe('%21%2A%27%28%29~%20a%2Bb%2F%D7%A9');
  });
});

describe('xWeightedLength', () => {
  it('counts URLs as 23, Hebrew/Latin as 1, emoji and CJK as 2', () => {
    expect(xWeightedLength('hello')).toBe(5);
    expect(xWeightedLength('שלום')).toBe(4);
    expect(xWeightedLength('https://open.spotify.com/episode/5Nv2PDZb0j1UN8O1IcPWIr?si=abcdef')).toBe(23);
    expect(xWeightedLength('🎙️')).toBe(2);
    expect(xWeightedLength('👨‍👩‍👧')).toBe(2);
    expect(xWeightedLength('日本')).toBe(4);
    expect(xWeightedLength('a — b')).toBe(5);
  });
});

describe('createXPublisher', () => {
  const config = {
    apiKey: 'ck',
    apiSecret: 'cs',
    accessToken: 'at',
    accessSecret: 'as',
    username: 'Fantasyonerim',
  };

  it('posts text with an OAuth 1.0a header', async () => {
    const { ctx, requests } = fakeContext([
      on('POST', 'api.x.com/2/tweets', () =>
        json({ data: { id: '1850000000000000999', text: 'גול!' } }, 201),
      ),
    ]);
    const result = await createXPublisher(config, ctx).publish({ text: ' גול! ⚽ ', image: null });
    expect(result).toEqual({
      externalId: '1850000000000000999',
      url: 'https://x.com/Fantasyonerim/status/1850000000000000999',
    });
    const req = requests[0];
    expect(JSON.parse(String(req?.body))).toEqual({ text: 'גול! ⚽' });
    expect(req?.headers.get('content-type')).toBe('application/json');
    const auth = req?.headers.get('authorization') ?? '';
    expect(auth).toMatch(/^OAuth /);
    for (const k of [
      'oauth_consumer_key="ck"',
      'oauth_token="at"',
      'oauth_signature_method="HMAC-SHA1"',
      'oauth_signature="',
    ]) {
      expect(auth).toContain(k);
    }
    expect(auth).toContain(`oauth_timestamp="${Date.parse('2026-10-25T12:00:00Z') / 1000}"`);
  });

  it('uploads an image first and attaches media_ids', async () => {
    const { ctx, requests } = fakeContext([
      on('POST', 'api.x.com/2/media/upload', () =>
        json({ data: { id: '1880000000000000001', media_key: '3_1880000000000000001', size: 3 } }),
      ),
      on('POST', 'api.x.com/2/tweets', () => json({ data: { id: '42', text: 'x' } }, 201)),
    ]);
    await createXPublisher(config, ctx).publish({
      text: 'תמונה',
      image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
    });
    const [upload, post] = requests;
    expect(upload?.body).toBeInstanceOf(FormData);
    const form = upload?.body as FormData;
    expect(form.get('media_category')).toBe('tweet_image');
    expect(form.get('media')).toBeInstanceOf(Blob);
    expect(upload?.headers.get('authorization')).toMatch(/^OAuth /);
    expect(JSON.parse(String(post?.body))).toEqual({
      text: 'תמונה',
      media: { media_ids: ['1880000000000000001'] },
    });
  });

  it('rejects posts over 280 weighted characters before calling X', async () => {
    const { ctx, requests } = fakeContext([]);
    const publisher = createXPublisher(config, ctx);
    const err = await publisher.publish({ text: '😀'.repeat(141), image: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XPostTooLongError);
    expect((err as XPostTooLongError).weightedLength).toBe(282);
    expect(requests).toHaveLength(0);
    expect(xWeightedLength('א'.repeat(X_MAX_WEIGHTED_LENGTH))).toBe(280);
  });

  it('403 on posting → auth error that mentions plan/permissions', async () => {
    const { ctx } = fakeContext([
      () => json({ title: 'Forbidden', detail: 'You are not permitted to perform this action.' }, 403),
    ]);
    const err = await createXPublisher(config, ctx)
      .publish({ text: 'hi', image: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationAuthError);
    expect((err as Error).message).toMatch(/Read and write/);
  });
});

describe('xWeightedLength bare domains', () => {
  it('counts bare domains and www links as 23, like X and the web composer', async () => {
    const { xWeightedLength } = await import('./x-text.js');
    expect(xWeightedLength('x.com and www.google.com')).toBe(23 + 5 + 23);
    expect(xWeightedLength('https://example.com/a')).toBe(23);
  });
});
