import { z } from 'zod';
import { parseEnvelope, readJson, retryAfterSec, send } from './http.js';
import type { IntegrationContext } from './types.js';
import { IntegrationRateLimitError, IntegrationUnavailableError } from './types.js';

/**
 * Spotify's public oEmbed endpoint (no auth). Unlike the Web API, RSS `itunes:image` and Apple — which all
 * return the square show cover — it returns the per-episode 16:9 thumbnail of a video podcast episode.
 */
export const SPOTIFY_OEMBED_URL = 'https://open.spotify.com/oembed';

export interface SpotifyEpisodeThumbnail {
  url: string;
  width: number | null;
  height: number | null;
}

const EPISODE_PATH = /^\/(?:intl-[a-z]{2}(?:-[a-z0-9]{2,4})?\/)?episode\/([A-Za-z0-9]{22})\/?$/i;

/**
 * Normalizes an open.spotify.com episode URL (incl. `/intl-xx/` forms, `?si=…` and trailing slashes) to
 * `https://open.spotify.com/episode/<id>`. Returns null for anything else (shows, other hosts, URIs, ids).
 */
export function normalizeSpotifyEpisodeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname.toLowerCase() !== 'open.spotify.com' || url.port !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  const id = EPISODE_PATH.exec(url.pathname)?.[1];
  return id === undefined ? null : `https://open.spotify.com/episode/${id}`;
}

const Dimension = z.number().positive().nullish();

/** Only the fields we use; everything else in the oEmbed body (html, iframe_url, title…) is ignored. */
const OEmbedSchema = z.object({
  type: z.string().nullish(),
  thumbnail_url: z.string().nullish(),
  thumbnail_width: Dimension,
  thumbnail_height: Dimension,
});

function httpsUrlOrNull(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the per-episode thumbnail for a Spotify episode URL via oEmbed.
 *
 * Returns null (no fetch) when `episodeUrl` is not an open.spotify.com episode URL; null on 404, a missing or
 * non-https `thumbnail_url`, or when the thumbnail is clearly the show cover. Throws
 * IntegrationRateLimitError on 429 and IntegrationUnavailableError on 5xx / other errors / network failure /
 * a body that isn't the expected shape.
 *
 * Show-cover rule (kept deliberately simple): video episodes come back as `type: "video"` with a 16:9
 * thumbnail; audio-only episodes are expected to come back as another type (e.g. `"rich"`) with the square
 * show cover. So a thumbnail is dropped iff `type !== "video"` AND width === height. If either dimension is
 * missing we can't tell it's square, so the thumbnail is kept.
 */
export async function fetchSpotifyEpisodeThumbnail(
  episodeUrl: string,
  ctx: IntegrationContext,
): Promise<SpotifyEpisodeThumbnail | null> {
  const normalized = normalizeSpotifyEpisodeUrl(episodeUrl);
  if (normalized === null) return null;

  const res = await send(
    ctx,
    'Spotify oEmbed',
    `${SPOTIFY_OEMBED_URL}?url=${encodeURIComponent(normalized)}`,
    {
      headers: { Accept: 'application/json' },
    },
  );
  if (res.status === 404) return null;
  if (res.status === 429) {
    throw new IntegrationRateLimitError('Spotify oEmbed rate limit reached.', retryAfterSec(res, ctx.now()));
  }
  if (!res.ok) {
    throw new IntegrationUnavailableError(`Spotify oEmbed failed (HTTP ${res.status}).`, res.status);
  }
  const body = parseEnvelope('Spotify oEmbed', OEmbedSchema, await readJson(res), res.status);

  if (body.thumbnail_url === null || body.thumbnail_url === undefined) return null;
  const url = httpsUrlOrNull(body.thumbnail_url);
  if (url === null) return null;
  const width = body.thumbnail_width ?? null;
  const height = body.thumbnail_height ?? null;

  const isSquare = width !== null && height !== null && width === height;
  if (body.type !== 'video' && isSquare) return null;

  return { url, width, height };
}
