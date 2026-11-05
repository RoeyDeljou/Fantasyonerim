import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EARLY_FETCH_SCRIPT, EARLY_KEY, EARLY_MAX_AGE_MS, earlyPaths } from './earlyFetch';

const API = 'http://localhost:4000';
const TOKEN = 'tok_0123456789abcdefghij';

/** A browser-ish global: localStorage, location and a fetch that records URLs. */
function fakeBrowser(pathname: string, store: Record<string, string> = {}, search = '') {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const win: Record<string, unknown> = {
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => void (store[k] = v),
      removeItem: (k: string) => void delete store[k],
    },
    location: { pathname, search },
    document: { documentElement: { getAttribute: (n: string) => (n === 'data-build' ? 'b1' : null) } },
  };
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get('authorization') ?? undefined });
    return json({});
  });
  win.fetch = fetchFn;
  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', win.localStorage);
  vi.stubGlobal('location', win.location);
  vi.stubGlobal('document', win.document);
  vi.stubGlobal('fetch', fetchFn);
  return { calls, win };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('early fetch (inline <head> script)', () => {
  it('starts exactly the requests lib/api.ts makes first for each tab', async () => {
    const { NEWS_PAGE_SIZE, COMMUNITY_PAGE_SIZE } = await import('./queries');
    expect(earlyPaths('/news/', null)).toContain(`/v1/news?limit=${NEWS_PAGE_SIZE}`);
    expect(earlyPaths('/news/', 'shorts')).toContain(`/v1/news?limit=${NEWS_PAGE_SIZE}&filter=shorts`);
    expect(earlyPaths('/community/', null)).toContain(`/v1/community/posts?limit=${COMMUNITY_PAGE_SIZE}`);
    // Never the league: it 404s until an admin sets one.
    for (const tab of ['/news/', '/community/', '/my-team/', '/table/', '/live/'])
      expect(earlyPaths(tab, null).some((p) => p.startsWith('/v1/league'))).toBe(false);
    expect(earlyPaths('/onboarding/', null)).toEqual([]);

    // The URLs the client builds for the same calls match the keys byte for byte.
    const { calls } = fakeBrowser('/news/', { 'fant.token': TOKEN });
    const { api } = await import('./api');
    await api.news(undefined, NEWS_PAGE_SIZE).catch(() => undefined);
    await api.news(undefined, NEWS_PAGE_SIZE, {}, 'shorts').catch(() => undefined);
    await api.community.posts({ limit: COMMUNITY_PAGE_SIZE }).catch(() => undefined);
    await api.me().catch(() => undefined);
    await api.config().catch(() => undefined);
    await api.bootstrap().catch(() => undefined);
    await api.stories().catch(() => undefined);
    await api.newsFilters().catch(() => undefined);
    const requested = calls.map((c) => c.url.replace(API, ''));
    const expected = new Set([
      ...earlyPaths('/news/', null),
      ...earlyPaths('/news/', 'shorts'),
      ...earlyPaths('/community/', null),
      ...earlyPaths('/live/', null),
    ]);
    for (const p of expected) expect(requested).toContain(p);
  });

  it('runs standalone, and the client adopts each early response once', async () => {
    const { calls, win } = fakeBrowser('/news/', { 'fant.token': TOKEN, 'fant.news.filter': 'all' });
    new Function(EARLY_FETCH_SCRIPT)();
    expect(calls.map((c) => c.url)).toEqual(earlyPaths('/news/', null).map((p) => API + p));
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);

    const { takeEarlyResponse } = await import('./earlyFetch');
    expect(takeEarlyResponse('/v1/me', 'another-token')).toBeNull(); // wrong token: dropped, never reused
    expect(takeEarlyResponse('/v1/me', TOKEN)).toBeNull();
    expect(takeEarlyResponse('/v1/news/stories', TOKEN)).not.toBeNull();
    expect(takeEarlyResponse('/v1/news/stories', TOKEN)).toBeNull(); // once
    const entries = win[EARLY_KEY] as Record<string, { at: number }>;
    const filters = entries['/v1/news/filters'];
    if (filters) filters.at -= EARLY_MAX_AGE_MS + 1;
    expect(takeEarlyResponse('/v1/news/filters', TOKEN)).toBeNull(); // stale
  });

  it('does nothing when signed out or for a deep-linked thread', () => {
    const out = fakeBrowser('/news/');
    new Function(EARLY_FETCH_SCRIPT)();
    expect(out.calls).toEqual([]);
    vi.unstubAllGlobals();
    const thread = fakeBrowser('/community/', { 'fant.token': TOKEN }, '?post=p1');
    new Function(EARLY_FETCH_SCRIPT)();
    expect(thread.calls).toEqual([]);
  });
});

describe('LCP image preload', () => {
  const v = (w: number) => ({ url: `https://cdn.test/m-${w}.webp`, width: w });
  const img = (
    url: string,
    width: number | null,
    height: number | null,
    variants?: { url: string; width: number }[],
  ) => ({
    kind: 'image',
    url,
    posterUrl: null,
    width,
    height,
    ...(variants ? { variants } : {}),
  });
  const video = {
    kind: 'video',
    url: 'https://cdn.test/v.mp4',
    posterUrl: 'https://cdn.test/poster.jpg',
    width: 1080,
    height: 1920,
  };

  it('every source: preloads exactly what its card renders first (srcset + sizes), or nothing', async () => {
    const { lcpImageOf } = await import('./earlyFetch');
    const { MEDIA_LAYOUT, SIZES, firstImageOf, srcSetOf } = await import('./images');
    const { NewsSourceSchema } = await import('@fant/shared');
    const photo = img('https://cdn.test/p.jpg', 1080, 1350, [v(320), v(640)]);
    const wide = img('https://cdn.test/w.jpg', 1280, 720, [v(320), v(640)]);
    const ss = (m: typeof photo) => srcSetOf(m.url, m.width, m.variants) ?? null;
    // What each card renders as its first image (NewsCards.tsx / Media.tsx), with one photo and with two.
    const expected: Record<string, (media: unknown[]) => unknown> = {
      podcast: () => ({ src: wide.url, srcSet: ss(wide), sizes: SIZES.full }),
      instagram_post: () => ({ src: photo.url, srcSet: ss(photo), sizes: SIZES.full }),
      instagram_story: () => null,
      x_post: (media) => ({
        src: photo.url,
        srcSet: ss(photo),
        sizes: media.length > 1 ? SIZES.half : SIZES.full,
      }),
      admin_update: (media) => ({
        src: photo.url,
        srcSet: ss(photo),
        sizes: media.length > 1 ? SIZES.half : SIZES.full,
      }),
      youtube_short: () => ({ src: photo.url, srcSet: ss(photo), sizes: SIZES.short }),
      youtube_video: () => ({ src: photo.url, srcSet: ss(photo), sizes: SIZES.full }),
    };
    expect(Object.keys(MEDIA_LAYOUT).sort()).toEqual([...NewsSourceSchema.options].sort());
    for (const source of NewsSourceSchema.options) {
      for (const media of source === 'podcast' ? [[wide]] : [[photo], [photo, photo]]) {
        const item = { source, media };
        const want = expected[source]?.(media);
        expect(firstImageOf(item, MEDIA_LAYOUT), source).toEqual(want);
        // The preload of a page whose first card is this item (stories are skipped, never preloaded).
        const page = { items: [item] };
        expect(lcpImageOf(page, 'news', firstImageOf, MEDIA_LAYOUT), source).toEqual(
          source === 'instagram_story' ? null : want,
        );
      }
    }
  });

  it('edge cases: square covers, posters, no variants, community photos', async () => {
    const { lcpImageOf } = await import('./earlyFetch');
    const { MEDIA_LAYOUT, SIZES, firstImageOf, srcSetOf } = await import('./images');
    const lcp = (body: unknown, feed: 'news' | 'community' = 'news') =>
      lcpImageOf(body, feed, firstImageOf, MEDIA_LAYOUT);
    const square = img('https://cdn.test/sq.jpg', 640, 640, [v(320)]);
    expect(lcp({ items: [{ source: 'podcast', media: [square] }] })?.sizes).toBe(SIZES.cover);
    expect(lcp({ items: [{ source: 'instagram_post', media: [video] }] })).toEqual({
      src: video.posterUrl,
      srcSet: null,
      sizes: null,
    });
    const plain = img('https://cdn.test/plain.jpg', 1080, 1350);
    expect(lcp({ items: [{ source: 'admin_update', media: [plain] }] })).toEqual({
      src: plain.url,
      srcSet: null,
      sizes: null,
    });
    expect(lcp({ items: [{ source: 'admin_update', media: [] }] })).toBeNull();
    const post = { url: 'https://cdn.test/c.jpg', width: 1080, height: 1080, variants: [v(640)] };
    expect(lcp({ items: [{ image: post }] }, 'community')).toEqual({
      src: post.url,
      srcSet: srcSetOf(post.url, 1080, [v(640)]),
      sizes: SIZES.full,
    });
    expect(lcp(null)).toBeNull();
  });

  it('srcSetOf and the serialized copy inside firstImageOf agree', async () => {
    const { MEDIA_LAYOUT, firstImageOf, srcSetOf } = await import('./images');
    for (const [w, variants] of [
      [1080, [v(320), v(640)]],
      [null, [v(320)]],
      [300, [v(320), v(640)]],
      [1080, undefined],
    ] as const) {
      const m = img('https://cdn.test/a.jpg', w, 1000, variants ? [...variants] : undefined);
      expect(firstImageOf({ source: 'instagram_post', media: [m] }, MEDIA_LAYOUT)?.srcSet ?? undefined).toBe(
        srcSetOf(m.url, m.width, m.variants),
      );
    }
  });
});

describe('warm start and CDN paths', () => {
  it('uses lib/persist.ts’s cache key', async () => {
    const early = await import('./earlyFetch');
    const persist = await import('./persist');
    expect(early.PERSIST_KEY).toBe(persist.PERSIST_KEY);
  });

  it('a warm start (this build’s cache holds `me`) skips the early /v1/me; a cold one asks', () => {
    const cache = JSON.stringify({
      buster: 'b1', // = <html data-build> in fakeBrowser
      timestamp: 1,
      clientState: { mutations: [], queries: [{ queryKey: ['me'], state: {} }] },
    });
    const warm = fakeBrowser('/news/', { 'fant.token': TOKEN, 'fant.queryCache': cache });
    new Function(EARLY_FETCH_SCRIPT)();
    expect(warm.calls.map((c) => c.url)).not.toContain(`${API}/v1/me`);
    expect(warm.calls.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
    const stale = fakeBrowser('/news/', {
      'fant.token': TOKEN,
      'fant.queryCache': cache.replace('"buster"', '"x"'),
    });
    new Function(EARLY_FETCH_SCRIPT)();
    expect(stale.calls.map((c) => c.url)).toContain(`${API}/v1/me`);
  });

  it('off the Vercel build, config and bootstrap go to the API (with the token, as before)', async () => {
    const { calls } = fakeBrowser('/live/', { 'fant.token': TOKEN });
    const { api } = await import('./api');
    await api.config().catch(() => undefined);
    await api.bootstrap().catch(() => undefined);
    expect(calls.map((c) => c.url)).toEqual([`${API}/v1/config`, `${API}/v1/fpl/bootstrap`]);
  });

  it('on the Vercel build they come from the same-origin /cdn/ path, never with the Authorization header', async () => {
    vi.stubEnv('NEXT_PUBLIC_CDN_JSON', '1');
    const { calls, win } = fakeBrowser('/live/', { 'fant.token': TOKEN });
    (win.location as { origin?: string }).origin = 'https://app.test';
    const { api } = await import('./api');
    await api.config().catch(() => undefined);
    await api.bootstrap().catch(() => undefined);
    await api.me().catch(() => undefined);
    expect(calls).toEqual([
      { url: 'https://app.test/cdn/v1/config/', auth: undefined },
      { url: 'https://app.test/cdn/v1/fpl/bootstrap/', auth: undefined },
      { url: `${API}/v1/me`, auth: `Bearer ${TOKEN}` },
    ]);
    vi.unstubAllEnvs();
  });
});

describe('CDN paths in the head script', () => {
  it('match lib/cdn.ts (trailing slash, no 308 hop)', async () => {
    const { cdnPath } = await import('./cdn');
    expect(EARLY_FETCH_SCRIPT).toContain("'/cdn'+paths[i]+'/'");
    expect(cdnPath('/v1/config')).toBe('/cdn/v1/config/');
    expect(cdnPath('/v1/fpl/bootstrap')).toBe('/cdn/v1/fpl/bootstrap/');
  });
});
