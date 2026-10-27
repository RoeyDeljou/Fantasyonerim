import { describe, expect, it } from 'vitest';
import { fakeContext, json, on, text } from './__fixtures__/fake-fetch.js';
import {
  SPOTIFY_EP61_ID,
  assumedSpotifyOEmbedAudioOnly,
  realSpotifyOEmbedEp61,
} from './__fixtures__/spotify-oembed.js';
import { fetchSpotifyEpisodeThumbnail, normalizeSpotifyEpisodeUrl } from './spotify-oembed.js';
import { IntegrationRateLimitError, IntegrationUnavailableError } from './types.js';

const OEMBED = 'open.spotify.com/oembed';
const EP61_URL = `https://open.spotify.com/episode/${SPOTIFY_EP61_ID}`;

describe('fetchSpotifyEpisodeThumbnail (real recorded oEmbed)', () => {
  it('returns the 16:9 per-episode thumbnail of a video episode', async () => {
    const { ctx, requests } = fakeContext([on('GET', OEMBED, () => json(realSpotifyOEmbedEp61))]);
    const thumb = await fetchSpotifyEpisodeThumbnail(EP61_URL, ctx);
    expect(thumb).toEqual({
      url: 'https://image-cdn-fa.spotifycdn.com/image/ab6772ab000015be436269816b65777337ae72b9',
      width: 640,
      height: 360,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.searchParams.get('url')).toBe(EP61_URL);
    expect(requests[0]?.headers.get('authorization')).toBeNull();
  });

  it('normalizes intl / query / trailing-slash / http forms before calling', async () => {
    const { ctx, requests } = fakeContext([on('GET', OEMBED, () => json(realSpotifyOEmbedEp61))]);
    for (const input of [
      `https://open.spotify.com/intl-he/episode/${SPOTIFY_EP61_ID}?si=abc123&t=0`,
      `https://open.spotify.com/intl-pt-BR/episode/${SPOTIFY_EP61_ID}/`,
      `  http://OPEN.spotify.com/episode/${SPOTIFY_EP61_ID}#x  `,
    ]) {
      expect(await fetchSpotifyEpisodeThumbnail(input, ctx)).not.toBeNull();
    }
    expect(requests.map((r) => r.url.searchParams.get('url'))).toEqual([EP61_URL, EP61_URL, EP61_URL]);
  });

  it('rejects non-episode URLs without fetching', async () => {
    const { ctx, requests } = fakeContext([on('GET', OEMBED, () => json(realSpotifyOEmbedEp61))]);
    for (const input of [
      'https://open.spotify.com/show/4sYY0tpz7M8gflimZAglHi',
      `https://open.spotify.com/track/${SPOTIFY_EP61_ID}`,
      `https://evil.example/episode/${SPOTIFY_EP61_ID}`,
      `https://open.spotify.com.evil.example/episode/${SPOTIFY_EP61_ID}`,
      `https://spotify.com/episode/${SPOTIFY_EP61_ID}`,
      `spotify:episode:${SPOTIFY_EP61_ID}`,
      SPOTIFY_EP61_ID,
      `https://open.spotify.com/episode/${SPOTIFY_EP61_ID}/extra`,
      'https://open.spotify.com/episode/short',
      'not a url',
    ]) {
      expect(normalizeSpotifyEpisodeUrl(input)).toBeNull();
      expect(await fetchSpotifyEpisodeThumbnail(input, ctx)).toBeNull();
    }
    expect(requests).toHaveLength(0);
  });

  it('returns null for an audio-only episode whose thumbnail is the square show cover', async () => {
    const { ctx } = fakeContext([on('GET', OEMBED, () => json(assumedSpotifyOEmbedAudioOnly))]);
    expect(await fetchSpotifyEpisodeThumbnail(EP61_URL, ctx)).toBeNull();
  });

  it('keeps a square thumbnail when type is video, and a non-video one that is not square', async () => {
    const squareVideo = { ...realSpotifyOEmbedEp61, thumbnail_width: 640, thumbnail_height: 640 };
    const wideRich = { ...realSpotifyOEmbedEp61, type: 'rich' };
    const { ctx } = fakeContext([
      on('GET', OEMBED, (req) =>
        json(req.url.searchParams.get('url')?.endsWith('A') ? wideRich : squareVideo),
      ),
    ]);
    expect((await fetchSpotifyEpisodeThumbnail(EP61_URL, ctx))?.width).toBe(640);
    const id = `${SPOTIFY_EP61_ID.slice(0, 21)}A`;
    expect(await fetchSpotifyEpisodeThumbnail(`https://open.spotify.com/episode/${id}`, ctx)).toEqual({
      url: realSpotifyOEmbedEp61.thumbnail_url,
      width: 640,
      height: 360,
    });
  });

  it('returns null dimensions when Spotify omits them', async () => {
    const body: Record<string, unknown> = { ...realSpotifyOEmbedEp61, type: 'rich' };
    delete body['thumbnail_width'];
    delete body['thumbnail_height'];
    const { ctx } = fakeContext([on('GET', OEMBED, () => json(body))]);
    expect(await fetchSpotifyEpisodeThumbnail(EP61_URL, ctx)).toEqual({
      url: realSpotifyOEmbedEp61.thumbnail_url,
      width: null,
      height: null,
    });
  });

  it('returns null when thumbnail_url is missing or not https', async () => {
    const missing: Record<string, unknown> = { ...realSpotifyOEmbedEp61 };
    delete missing['thumbnail_url'];
    const insecure = {
      ...realSpotifyOEmbedEp61,
      thumbnail_url: 'http://image-cdn-fa.spotifycdn.com/image/x',
    };
    const relative = { ...realSpotifyOEmbedEp61, thumbnail_url: '/image/x' };
    for (const body of [missing, insecure, relative]) {
      const { ctx } = fakeContext([on('GET', OEMBED, () => json(body))]);
      expect(await fetchSpotifyEpisodeThumbnail(EP61_URL, ctx)).toBeNull();
    }
  });

  it('returns null on 404', async () => {
    const { ctx } = fakeContext([on('GET', OEMBED, () => json({ error: 'not found' }, 404))]);
    expect(await fetchSpotifyEpisodeThumbnail(EP61_URL, ctx)).toBeNull();
  });

  it('throws IntegrationRateLimitError with Retry-After on 429', async () => {
    const { ctx } = fakeContext([on('GET', OEMBED, () => text('slow down', 429, { 'retry-after': '30' }))]);
    const err = await fetchSpotifyEpisodeThumbnail(EP61_URL, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationRateLimitError);
    expect((err as IntegrationRateLimitError).retryAfterSec).toBe(30);
  });

  it('throws IntegrationUnavailableError on 5xx and network failure', async () => {
    const down = fakeContext([on('GET', OEMBED, () => text('oops', 503))]);
    const err = await fetchSpotifyEpisodeThumbnail(EP61_URL, down.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrationUnavailableError);
    expect((err as IntegrationUnavailableError).status).toBe(503);

    const offline = fakeContext([]); // no route → fetch throws
    await expect(fetchSpotifyEpisodeThumbnail(EP61_URL, offline.ctx)).rejects.toBeInstanceOf(
      IntegrationUnavailableError,
    );
  });

  it('throws IntegrationUnavailableError on a malformed body', async () => {
    for (const res of [
      () => text('<html>not json</html>', 200),
      () => json(['not', 'an', 'object']),
      () => json({ ...realSpotifyOEmbedEp61, thumbnail_url: 42 }),
      () => json({ ...realSpotifyOEmbedEp61, thumbnail_width: '640' }),
    ]) {
      const { ctx } = fakeContext([on('GET', OEMBED, res)]);
      await expect(fetchSpotifyEpisodeThumbnail(EP61_URL, ctx)).rejects.toBeInstanceOf(
        IntegrationUnavailableError,
      );
    }
  });
});
