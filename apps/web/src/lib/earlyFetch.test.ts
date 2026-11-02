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
