import type {
  ContentSource,
  EpisodeRef,
  NewsItemDraft,
  PodcastLinkResolver,
  ResolvedPodcastLinks,
  SourceResult,
} from '@fant/integrations';
import type { PushPayload } from '@fant/shared';
import type { FastifyInstance } from 'fastify';
import type { IntegrationFactories } from '../src/integrations/factories.js';
import type { MediaStore } from '../src/media/store.js';
import type { PushProvider, PushSendOptions, PushSendResult, PushTarget } from '../src/push/provider.js';
import { bearer } from './helpers.js';

// ---------- push ----------
export class FakePushProvider implements PushProvider {
  sent: { endpoint: string; payload: PushPayload; options: PushSendOptions | undefined }[] = [];
  /** Per-endpoint result (default 'ok'). */
  results = new Map<string, PushSendResult>();

  async send(sub: PushTarget, payload: PushPayload, options?: PushSendOptions): Promise<PushSendResult> {
    this.sent.push({ endpoint: sub.endpoint, payload, options });
    return this.results.get(sub.endpoint) ?? 'ok';
  }
}

export async function subscribe(app: FastifyInstance, token: string, endpoint: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/push/subscriptions',
    headers: bearer(token),
    payload: { endpoint, keys: { p256dh: 'p256dh-key-0123456789', auth: 'auth-1234' } },
  });
  if (res.statusCode !== 204) throw new Error(`subscribe failed: ${res.statusCode} ${res.body}`);
}

// ---------- media ----------
export class MemoryMediaStore implements MediaStore {
  objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  deleted: string[] = [];

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    this.objects.set(key, { bytes, contentType });
    return `https://media.test/${key}`;
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

/** fetch for media downloads: URL → bytes with a content type; anything else 404s. */
export function fakeMediaFetch(files: Map<string, { contentType: string; bytes?: Uint8Array }>): {
  fetch: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const file = files.get(url);
    if (file === undefined) return new Response('not found', { status: 404 });
    return new Response(file.bytes ?? new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': file.contentType },
    });
  };
  return { fetch: impl as typeof fetch, requested };
}

// ---------- content sources ----------
export function result(items: NewsItemDraft[], extra: Partial<SourceResult> = {}): SourceResult {
  return {
    items,
    skipped: [],
    warnings: [],
    accountLabel: null,
    cursor: null,
    notModified: false,
    ...extra,
  };
}

/** A scripted ContentSource: each poll returns `next` (or throws `error`) and records the cursor. */
export class ScriptedSource {
  next: SourceResult = result([]);
  error: Error | null = null;
  cursors: (string | null)[] = [];
  /** When set, fetchLatest waits for this promise (lease tests). */
  gate: Promise<void> | null = null;
  configs: unknown[] = [];

  constructor(readonly source: ContentSource['source']) {}

  create = (config: unknown): ContentSource => {
    this.configs.push(config);
    return {
      source: this.source,
      fetchLatest: async (cursor) => {
        this.cursors.push(cursor);
        if (this.gate !== null) await this.gate;
        if (this.error !== null) throw this.error;
        return this.next;
      },
    };
  };
}

const EMPTY_LINKS = { spotify: null, apple: null, instagram: null, x: null, audio: null };

export function episode(n: number, publishedAt: Date, overrides: Partial<NewsItemDraft> = {}): NewsItemDraft {
  return {
    dedupeKey: `podcast:guid-${n}`,
    source: 'podcast',
    title: `פרק ${n} - כותרת`,
    text: `Episode ${n} description`,
    media: [
      {
        kind: 'image',
        sourceUrl: 'https://cdn.anchor.test/art.jpg',
        posterSourceUrl: null,
        width: null,
        height: null,
      },
    ],
    links: { ...EMPTY_LINKS, audio: `https://anchor.test/ep${n}.mp3` },
    podcast: { episodeNumber: n, seasonNumber: 1, durationSec: 3600 },
    publishedAt,
    expiresAt: null,
    ...overrides,
  };
}

export function igPost(id: string, publishedAt: Date, mediaUrls: string[]): NewsItemDraft {
  return {
    dedupeKey: `instagram:${id}`,
    source: 'instagram_post',
    title: null,
    text: `caption ${id}`,
    media: mediaUrls.map((u) => ({
      kind: u.endsWith('.mp4') ? ('video' as const) : ('image' as const),
      sourceUrl: u,
      posterSourceUrl: u.endsWith('.mp4') ? `${u}.jpg` : null,
      width: 1080,
      height: 1350,
    })),
    links: { ...EMPTY_LINKS, instagram: `https://www.instagram.com/p/${id}/` },
    podcast: null,
    publishedAt,
    expiresAt: null,
  };
}

export function igStory(id: string, publishedAt: Date, mediaUrl: string): NewsItemDraft {
  return {
    ...igPost(id, publishedAt, [mediaUrl]),
    dedupeKey: `instagram_story:${id}`,
    source: 'instagram_story',
    text: null,
    expiresAt: new Date(publishedAt.getTime() + 24 * 3600_000),
  };
}

export function xPost(id: string, publishedAt: Date): NewsItemDraft {
  return {
    dedupeKey: `x:${id}`,
    source: 'x_post',
    title: null,
    text: `tweet ${id}`,
    media: [],
    links: { ...EMPTY_LINKS, x: `https://x.com/fantasyonerim/status/${id}` },
    podcast: null,
    publishedAt,
    expiresAt: null,
  };
}

/** Fakes for every integration entry point the API uses. */
export function fakeIntegrations() {
  const podcast = new ScriptedSource('podcast');
  const igPosts = new ScriptedSource('instagram_post');
  const igStories = new ScriptedSource('instagram_story');
  const x = new ScriptedSource('x_post');
  const resolved: { links: ResolvedPodcastLinks; calls: EpisodeRef[][] } = { links: new Map(), calls: [] };
  const appleResolver: PodcastLinkResolver = { platform: 'apple', resolve: async () => new Map() };
  const factories: Partial<IntegrationFactories> = {
    createPodcastSource: podcast.create as IntegrationFactories['createPodcastSource'],
    createInstagramPostsSource: igPosts.create as IntegrationFactories['createInstagramPostsSource'],
    createInstagramStoriesSource: igStories.create as IntegrationFactories['createInstagramStoriesSource'],
    createXSource: x.create as IntegrationFactories['createXSource'],
    createAppleLinkResolver: () => appleResolver,
    resolveEpisodeLinks: async (refs) => {
      resolved.calls.push([...refs]);
      return { links: resolved.links, warnings: [] };
    },
    resolveXUser: async ({ username }) => ({ id: '4242', username: username.replace(/^@/, ''), name: 'X' }),
  };
  return { factories, podcast, igPosts, igStories, x, resolved };
}
