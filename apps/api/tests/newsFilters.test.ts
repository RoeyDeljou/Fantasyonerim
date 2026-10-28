import { NEWS_FILTER_SOURCES, NewsFiltersSchema, NewsPageSchema, type NewsFilter } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeNewsCursor } from '../src/routes/news.js';
import { buildTestApp, createTestPrisma, migrateTestDb, resetDb } from './helpers.js';

const prisma = createTestPrisma();
let app: FastifyInstance;
const BASE = Date.parse('2026-10-20T12:00:00.000Z');
let seq = 0;

beforeAll(() => migrateTestDb());
beforeEach(async () => {
  await resetDb(prisma);
  seq = 0;
  ({ app } = await buildTestApp(prisma));
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** One item per call, each a minute newer than the previous one. */
async function add(source: string, extra: { hiddenAt?: Date; suppressed?: boolean; expiresAt?: Date } = {}) {
  seq += 1;
  const row = await prisma.newsItem.create({
    data: {
      dedupeKey: `${source}:${seq}`,
      source,
      title: `${source} ${seq}`,
      text: null,
      links: {},
      publishedAt: new Date(BASE + seq * 60_000),
      ...extra,
    },
  });
  return row.id;
}

async function page(query: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/news${query}` });
  return { status: res.statusCode, body: res.json() as unknown };
}

async function ids(query: string) {
  const res = await page(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return NewsPageSchema.parse(res.body);
}

async function filters() {
  const res = await app.inject({ method: 'GET', url: '/v1/news/filters' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['cache-control']).toBe('public, max-age=60');
  return NewsFiltersSchema.parse(res.json()).filters;
}

describe('GET /v1/news?filter=', () => {
  it('each filter returns only its own sources, newest first; no filter = everything but stories', async () => {
    const all = [
      'podcast',
      'youtube_short',
      'youtube_video',
      'instagram_post',
      'x_post',
      'admin_update',
    ] as const;
    const bySource = new Map<string, string[]>();
    for (let round = 0; round < 2; round++) {
      for (const s of all) bySource.set(s, [...(bySource.get(s) ?? []), await add(s)]);
    }
    await add('instagram_story', { expiresAt: new Date(BASE + 10 * 86_400_000) });

    for (const [filter, sources] of Object.entries(NEWS_FILTER_SOURCES) as [
      NewsFilter,
      readonly string[],
    ][]) {
      const res = await ids(`?filter=${filter}`);
      expect(
        res.items.map((i) => i.source).every((s) => sources.includes(s)),
        filter,
      ).toBe(true);
      const expected = sources.flatMap((s) => bySource.get(s) ?? []).reverse();
      expect(
        res.items.map((i) => i.id),
        filter,
      ).toEqual(expected);
      expect(res.nextCursor).toBeNull();
    }
    const everything = await ids('');
    expect(everything.items).toHaveLength(12);
    expect(everything.items.some((i) => i.source === 'instagram_story')).toBe(false);
  });

  it('paginates within a filter', async () => {
    const shorts: string[] = [];
    for (let i = 0; i < 5; i++) {
      shorts.push(await add('youtube_short'));
      await add('podcast');
    }
    const first = await ids('?filter=shorts&limit=2');
    expect(first.items.map((i) => i.id)).toEqual([shorts[4], shorts[3]]);
    const second = await ids(`?filter=shorts&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.id)).toEqual([shorts[2], shorts[1]]);
    const third = await ids(`?filter=shorts&limit=2&cursor=${second.nextCursor}`);
    expect(third.items.map((i) => i.id)).toEqual([shorts[0]]);
    expect(third.nextCursor).toBeNull();
  });

  it('a cursor only works for the filter it was issued with; bad filters → 400', async () => {
    for (let i = 0; i < 3; i++) {
      await add('youtube_short');
      await add('podcast');
    }
    const shorts = await ids('?filter=shorts&limit=1');
    const unfiltered = await ids('?limit=1');
    for (const [query, cursor] of [
      ['?filter=episodes', shorts.nextCursor],
      ['', shorts.nextCursor],
      ['?filter=shorts', unfiltered.nextCursor],
    ] as const) {
      const res = await page(`${query}${query === '' ? '?' : '&'}cursor=${cursor}`);
      expect(res.status, query).toBe(400);
      expect(res.body).toMatchObject({
        error: { code: 'bad_request', message: expect.stringMatching(/^cursor:/) },
      });
    }
    for (const bad of ['?filter=stories', '?filter=', '?filter=EPISODES', '?filter=podcast']) {
      const res = await page(bad);
      // An empty value is ignored (cleanQuery), like other empty params.
      if (bad === '?filter=') expect(res.status).toBe(200);
      else expect(res.status, bad).toBe(400);
    }
    // Cursors from before filters existed still page the unfiltered feed.
    const last = await prisma.newsItem.findFirstOrThrow({ orderBy: { publishedAt: 'desc' } });
    const legacy = Buffer.from(JSON.stringify([last.publishedAt.toISOString(), last.id])).toString(
      'base64url',
    );
    expect((await ids(`?cursor=${legacy}`)).items).toHaveLength(5);
    expect(encodeNewsCursor(last.publishedAt, last.id, 'x')).not.toBe(legacy);
  });

  it('hidden items and suppressed placeholders are excluded from the page and the filters list', async () => {
    const visible = await add('podcast');
    await add('youtube_video', { hiddenAt: new Date(BASE) });
    await add('x_post', { hiddenAt: new Date(BASE), suppressed: true });
    expect((await ids('?filter=videos')).items).toEqual([]);
    expect((await ids('?filter=x')).items).toEqual([]);
    expect((await ids('?filter=episodes')).items.map((i) => i.id)).toEqual([visible]);
    expect(await filters()).toEqual(['episodes']);
  });
});

describe('GET /v1/news/filters', () => {
  it('lists only the filters with visible items, in display order', async () => {
    expect(await filters()).toEqual([]);
    await add('admin_update');
    await add('x_post');
    await add('podcast');
    await add('instagram_story', { expiresAt: new Date(BASE + 86_400_000) }); // not a filter
    expect(await filters()).toEqual(['episodes', 'x', 'updates']);
    await add('youtube_short');
    await add('instagram_post');
    expect(await filters()).toEqual(['episodes', 'shorts', 'instagram', 'x', 'updates']);
  });
});
