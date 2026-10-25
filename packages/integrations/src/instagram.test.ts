import { describe, expect, it } from 'vitest';
import { fakeContext, json, on } from './__fixtures__/fake-fetch.js';
import {
  IG_USER_ID,
  graphErrorBody,
  igAccounts,
  igDebugToken,
  igLongToken,
  igMedia,
  igShortToken,
  igStories,
} from './__fixtures__/platform-payloads.js';
import {
  GRAPH_API_VERSION,
  buildInstagramConnectUrl,
  completeInstagramConnect,
  createInstagramStoriesSource,
  fetchInstagramPosts,
  fetchInstagramStories,
} from './instagram.js';
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from './types.js';

const MEDIA_PATH = `graph.facebook.com/${GRAPH_API_VERSION}/${IG_USER_ID}/media`;
const STORIES_PATH = `graph.facebook.com/${GRAPH_API_VERSION}/${IG_USER_ID}/stories`;
const account = { igUserId: IG_USER_ID, accessToken: 'EAApagetoken', username: 'pod_fantasyonerim' };

describe('Instagram connect (Facebook Login for Business)', () => {
  it('builds the OAuth dialog URL with the required scopes', () => {
    const url = new URL(
      buildInstagramConnectUrl({ appId: '123', redirectUri: 'https://api.example.com/cb', state: 'csrf-1' }),
    );
    expect(url.origin + url.pathname).toBe(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`);
    expect(url.searchParams.get('client_id')).toBe('123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.example.com/cb');
    expect(url.searchParams.get('state')).toBe('csrf-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(
      'instagram_basic,pages_show_list,pages_read_engagement,business_management',
    );
  });

  it('exchanges code → short-lived → long-lived token → Pages with an IG account', async () => {
    const { ctx, requests } = fakeContext([
      on('GET', `graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, (req) =>
        json(req.url.searchParams.get('grant_type') === 'fb_exchange_token' ? igLongToken : igShortToken),
      ),
      on('GET', `graph.facebook.com/${GRAPH_API_VERSION}/me/accounts`, () => json(igAccounts)),
      on('GET', `graph.facebook.com/${GRAPH_API_VERSION}/debug_token`, () => json(igDebugToken)),
    ]);
    const accounts = await completeInstagramConnect(
      { appId: '123', appSecret: 'shh', redirectUri: 'https://api.example.com/cb', code: 'AQBcode' },
      ctx,
    );
    expect(accounts).toEqual([
      {
        pageId: '1000000000000001',
        pageName: 'Fantasyonerim',
        igUserId: IG_USER_ID,
        username: 'pod_fantasyonerim',
        profilePictureUrl: 'https://scontent.cdninstagram.com/v/t51/profile.jpg?_nc_ht=x&oe=6900AAAA',
        accessToken: 'EAApagetoken',
        expiresAt: null,
        dataAccessExpiresAt: new Date(1800000000 * 1000),
      },
    ]);
    const [codeReq, longReq, accountsReq, debugReq] = requests;
    expect(codeReq?.url.searchParams.get('code')).toBe('AQBcode');
    expect(codeReq?.url.searchParams.get('redirect_uri')).toBe('https://api.example.com/cb');
    expect(longReq?.url.searchParams.get('fb_exchange_token')).toBe('EAAshort');
    expect(accountsReq?.url.searchParams.get('access_token')).toBe('EAAlonglived');
    expect(accountsReq?.url.searchParams.get('fields')).toBe(
      'id,name,access_token,instagram_business_account{id,username,profile_picture_url}',
    );
    expect(debugReq?.url.searchParams.get('input_token')).toBe('EAApagetoken');
  });

  it('fails clearly when no Page has an Instagram professional account; bad code → auth error', async () => {
    const none = fakeContext([
      on('GET', `graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`, () => json(igLongToken)),
      on('GET', `graph.facebook.com/${GRAPH_API_VERSION}/me/accounts`, () => json({ data: [] })),
    ]);
    await expect(
      completeInstagramConnect(
        { appId: '1', appSecret: 's', redirectUri: 'https://x.test/cb', code: 'c' },
        none.ctx,
      ),
    ).rejects.toBeInstanceOf(IntegrationConfigError);

    const badCode = fakeContext([
      () => json(graphErrorBody(100, 'This authorization code has been used.', 36009), 400),
    ]);
    await expect(
      completeInstagramConnect(
        { appId: '1', appSecret: 's', redirectUri: 'https://x.test/cb', code: 'c' },
        badCode.ctx,
      ),
    ).rejects.toBeInstanceOf(IntegrationConfigError);
  });
});

describe('fetchInstagramPosts', () => {
  it('maps images, reels and carousels; skips missing media_url and malformed items', async () => {
    const { ctx, requests } = fakeContext([on('GET', MEDIA_PATH, () => json(igMedia))]);
    const r = await fetchInstagramPosts(account, ctx);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.searchParams.get('limit')).toBe('25');
    expect(requests[0]?.url.searchParams.get('fields')).toBe(
      'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}',
    );
    expect(r.accountLabel).toBe('@pod_fantasyonerim');
    expect(r.cursor).toBeNull();
    expect(r.items.map((i) => i.dedupeKey)).toEqual([
      'instagram:18000000000000001',
      'instagram:18000000000000002',
      'instagram:18000000000000003',
      'instagram:18000000000000006',
    ]);
    expect(r.skipped).toEqual([
      { externalId: '18000000000000004', reason: 'no media_url (copyright-restricted or unavailable media)' },
      { externalId: '18000000000000005', reason: 'unrecognized Instagram media object' },
    ]);

    const [image, reel, carousel, noCaption] = r.items;
    expect(image).toMatchObject({
      source: 'instagram_post',
      title: null,
      text: 'קפטן למחזור 8? 🧢\nהאלאנד או סלאח',
      links: {
        instagram: 'https://www.instagram.com/p/DAAAAAAAAA1/',
        spotify: null,
        apple: null,
        x: null,
        audio: null,
      },
      podcast: null,
      expiresAt: null,
    });
    expect(image?.publishedAt.toISOString()).toBe('2026-10-24T18:30:00.000Z');
    expect(image?.media).toEqual([
      {
        kind: 'image',
        sourceUrl: 'https://scontent.cdninstagram.com/v/t51/img1.jpg?oe=6900AAAA',
        posterSourceUrl: null,
        width: null,
        height: null,
      },
    ]);
    expect(reel?.media).toEqual([
      {
        kind: 'video',
        sourceUrl: 'https://scontent.cdninstagram.com/o1/v/t16/reel.mp4?oe=6900AAAA',
        posterSourceUrl: 'https://scontent.cdninstagram.com/v/t51/reel-thumb.jpg?oe=6900AAAA',
        width: null,
        height: null,
      },
    ]);
    expect(carousel?.media.map((m) => [m.kind, m.sourceUrl, m.posterSourceUrl])).toEqual([
      ['image', 'https://scontent.cdninstagram.com/v/t51/c1.jpg?oe=6900AAAA', null],
      [
        'video',
        'https://scontent.cdninstagram.com/o1/v/t16/c2.mp4?oe=6900AAAA',
        'https://scontent.cdninstagram.com/v/t51/c2-thumb.jpg?oe=6900AAAA',
      ],
    ]);
    expect(noCaption?.text).toBeNull();
  });

  it('handles an empty account', async () => {
    const { ctx } = fakeContext([on('GET', MEDIA_PATH, () => json({ data: [] }))]);
    const r = await fetchInstagramPosts(account, ctx);
    expect(r.items).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});

describe('fetchInstagramStories', () => {
  it('maps stories oldest first with expiresAt = timestamp + 24 h', async () => {
    const { ctx } = fakeContext([on('GET', STORIES_PATH, () => json(igStories))]);
    const r = await createInstagramStoriesSource(account, ctx).fetchLatest(null);
    expect(r.items.map((i) => i.dedupeKey)).toEqual([
      'instagram_story:17900000000000001',
      'instagram_story:17900000000000002',
    ]);
    const [first, second] = r.items;
    expect(first?.source).toBe('instagram_story');
    expect(first?.publishedAt.toISOString()).toBe('2026-10-25T07:00:00.000Z');
    expect(first?.expiresAt?.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    expect(second?.media[0]).toMatchObject({
      kind: 'video',
      posterSourceUrl: 'https://scontent.cdninstagram.com/v/t51/story2-thumb.jpg?oe=6900AAAA',
    });
    expect(second?.links.instagram).toBe('https://instagram.com/stories/pod_fantasyonerim/17900000000000002');
    expect(r.skipped).toHaveLength(1);
  });

  it('no live stories → empty', async () => {
    const { ctx } = fakeContext([on('GET', STORIES_PATH, () => json({ data: [] }))]);
    expect((await fetchInstagramStories(account, ctx)).items).toEqual([]);
  });
});

describe('Graph error mapping', () => {
  const run = (res: () => Response) =>
    fetchInstagramPosts(account, fakeContext([res]).ctx).catch((e: unknown) => e);

  it.each([190, 102, 463, 467])('OAuthException %i → IntegrationAuthError', async (code) => {
    expect(await run(() => json(graphErrorBody(code, 'Error validating access token'), 400))).toBeInstanceOf(
      IntegrationAuthError,
    );
  });

  it('permission errors → IntegrationAuthError', async () => {
    expect(
      await run(() => json(graphErrorBody(10, 'Application does not have permission'), 403)),
    ).toBeInstanceOf(IntegrationAuthError);
  });

  it.each([4, 17, 32, 613])('code %i → IntegrationRateLimitError', async (code) => {
    expect(await run(() => json(graphErrorBody(code, 'Too many calls'), 400))).toBeInstanceOf(
      IntegrationRateLimitError,
    );
  });

  it('HTTP 429 → rate limit with Retry-After', async () => {
    const err = await run(() => json({}, 429, { 'retry-after': '60' }));
    expect(err).toBeInstanceOf(IntegrationRateLimitError);
    expect((err as IntegrationRateLimitError).retryAfterSec).toBe(60);
  });

  it('5xx, non-JSON and network errors → IntegrationUnavailableError', async () => {
    expect(await run(() => json(graphErrorBody(2, 'Service temporarily unavailable'), 503))).toBeInstanceOf(
      IntegrationUnavailableError,
    );
    expect(await run(() => new Response('<html>oops</html>', { status: 502 }))).toBeInstanceOf(
      IntegrationUnavailableError,
    );
    expect(await run(() => json({ unexpected: true }))).toBeInstanceOf(IntegrationUnavailableError);
    const offline = await fetchInstagramPosts(account, fakeContext([]).ctx).catch((e: unknown) => e);
    expect(offline).toBeInstanceOf(IntegrationUnavailableError);
  });

  it('unknown IG user id (code 100) → IntegrationConfigError', async () => {
    expect(await run(() => json(graphErrorBody(100, 'Unsupported get request'), 400))).toBeInstanceOf(
      IntegrationConfigError,
    );
  });
});
