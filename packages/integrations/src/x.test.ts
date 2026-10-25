import { describe, expect, it } from 'vitest';
import { fakeContext, json, on } from './__fixtures__/fake-fetch.js';
import { X_USER_ID, xEmptyTimeline, xTimeline, xUser } from './__fixtures__/platform-payloads.js';
import { oauth1Header, oauth1Signature, rfc3986 } from './oauth1.js';
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from './types.js';
import {
  XPostTooLongError,
  createXPublisher,
  createXSource,
  fetchXPosts,
  parseXUsername,
  resolveXUser,
} from './x.js';
import { X_MAX_WEIGHTED_LENGTH, xWeightedLength } from './x-text.js';

const TIMELINE = `api.x.com/2/users/${X_USER_ID}/tweets`;
const base = { bearerToken: 'AAAA-bearer', userId: X_USER_ID, username: 'Fantasyonerim' };

describe('fetchXPosts', () => {
  it('requests only what is needed and maps posts (note_tweet, t.co expansion, media)', async () => {
    const { ctx, requests } = fakeContext([on('GET', TIMELINE, () => json(xTimeline))]);
    const r = await fetchXPosts(base, ctx);
    expect(requests).toHaveLength(1);
    const p = requests[0]?.url.searchParams;
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer AAAA-bearer');
    expect(p?.get('exclude')).toBe('replies,retweets');
    expect(p?.get('max_results')).toBe('10');
    expect(p?.get('tweet.fields')).toBe('created_at,entities,attachments,note_tweet');
    expect(p?.get('expansions')).toBe('attachments.media_keys');
    expect(p?.get('media.fields')).toBe('type,url,preview_image_url,width,height,variants');
    expect(p?.has('since_id')).toBe(false);

    expect(r.accountLabel).toBe('@Fantasyonerim');
    expect(r.cursor).toBe('1850000000000000003');
    expect(r.items.map((i) => i.dedupeKey)).toEqual(['x:1850000000000000003', 'x:1850000000000000002']);
    expect(r.skipped).toEqual([
      { externalId: '1850000000000000001', reason: 'invalid created_at' },
      { externalId: null, reason: 'unrecognized X post object' },
    ]);

    const [photoPost, longPost] = r.items;
    expect(photoPost).toMatchObject({
      source: 'x_post',
      title: null,
      text: 'פרק 62 באוויר! 🎙️ https://open.spotify.com/episode/5Nv2PDZb0j1UN8O1IcPWIr',
      links: { x: 'https://x.com/Fantasyonerim/status/1850000000000000003', instagram: null },
      podcast: null,
      expiresAt: null,
    });
    expect(photoPost?.media).toEqual([
      {
        kind: 'image',
        sourceUrl: 'https://pbs.twimg.com/media/GaAAAAAAAAA.jpg',
        posterSourceUrl: null,
        width: 1200,
        height: 675,
      },
    ]);
    expect(longPost?.text).toBe(
      'שרשור ארוך על הקפטנים למחזור 8 — האלאנד, סלאח, פאלמר ומה עם הדיפנס של ארסנל?\n\nכל הנתונים בטבלה: https://docs.google.com/spreadsheets/d/abc',
    );
    expect(longPost?.media).toEqual([
      {
        kind: 'video',
        sourceUrl: 'https://video.twimg.com/ext_tw_video/200/pu/vid/1280x720/high.mp4',
        posterSourceUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/1850000000000000200/pu/img/thumb.jpg',
        width: 1280,
        height: 720,
      },
    ]);
  });

  it('polls with since_id and keeps the cursor when nothing is new', async () => {
    const { ctx, requests } = fakeContext([on('GET', TIMELINE, () => json(xEmptyTimeline))]);
    const source = createXSource({ ...base, maxResults: 5 }, ctx);
    const r = await source.fetchLatest('1850000000000000003');
    expect(requests[0]?.url.searchParams.get('since_id')).toBe('1850000000000000003');
    expect(requests[0]?.url.searchParams.get('max_results')).toBe('5');
    expect(r.items).toEqual([]);
    expect(r.cursor).toBe('1850000000000000003');
  });

  it('follows next_token only while catching up with since_id (bounded)', async () => {
    const page = (id: string, next?: string) =>
      json({
        data: [{ id, text: `post ${id}`, created_at: '2026-10-24T10:00:00.000Z' }],
        meta: { result_count: 1, newest_id: id, ...(next === undefined ? {} : { next_token: next }) },
      });
    const { ctx, requests } = fakeContext([
      on('GET', TIMELINE, (req) => {
        const token = req.url.searchParams.get('pagination_token');
        return token === null ? page('900', 't1') : token === 't1' ? page('800', 't2') : page('700', 't3');
      }),
    ]);
    const r = await fetchXPosts({ ...base, sinceId: '100', maxPages: 2 }, ctx);
    expect(requests).toHaveLength(2);
    expect(r.items.map((i) => i.dedupeKey)).toEqual(['x:900', 'x:800']);
    expect(r.cursor).toBe('900');

    const first = fakeContext([on('GET', TIMELINE, () => page('900', 't1'))]);
    await fetchXPosts(base, first.ctx);
    expect(first.requests).toHaveLength(1); // first poll never pages
  });

  it('uses /i/status links without a username', async () => {
    const { ctx } = fakeContext([on('GET', TIMELINE, () => json(xTimeline))]);
    const r = await fetchXPosts({ bearerToken: 'b', userId: X_USER_ID }, ctx);
    expect(r.items[0]?.links.x).toBe('https://x.com/i/status/1850000000000000003');
    expect(r.accountLabel).toBeNull();
  });

  it('maps errors: 401/403 auth (403 mentions plan/credits), 429 with x-rate-limit-reset, 5xx', async () => {
    const run = (res: Response) => fetchXPosts(base, fakeContext([() => res]).ctx).catch((e: unknown) => e);
    expect(
      await run(json({ title: 'Unauthorized', status: 401, detail: 'Unauthorized' }, 401)),
    ).toBeInstanceOf(IntegrationAuthError);
    const forbidden = await run(
      json(
        {
          title: 'Client Forbidden',
          detail: 'When authenticating requests to the Twitter API v2 endpoints…',
        },
        403,
      ),
    );
    expect(forbidden).toBeInstanceOf(IntegrationAuthError);
    expect((forbidden as Error).message).toMatch(/plan\/credits/);
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
