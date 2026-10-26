import { parseApplePodcastId, parseSpotifyShowId, parseXUsername } from '@fant/integrations';
import { IntegrationIdSchema, type IntegrationId } from '@fant/shared';

/**
 * The single config map for every content integration: the client's accounts (docs/CLIENT_ACCOUNTS.md) as
 * defaults, which settings/secrets each one has, and how a setting is validated + normalized.
 */

/** The Instagram account the OAuth connect flow must prefer (NOT pod_fantasyonerim). */
export const EXPECTED_INSTAGRAM_USERNAME = 'fantasyonerimfpl';

export type SettingNormalizer = (
  value: string,
) => { ok: true; value: string } | { ok: false; message: string };

export interface IntegrationDefinition {
  id: IntegrationId;
  /** Platform name used in admin-facing messages. */
  platform: string;
  /** Enabled when the row is first created. */
  defaultEnabled: boolean;
  defaultSettings: Readonly<Record<string, string>>;
  /** Settings the admin may edit via PUT, with their validators. */
  editable: Readonly<Record<string, SettingNormalizer>>;
  /** Settings set server-side (OAuth / API lookups); accepted in a PUT body but ignored. */
  readOnly: readonly string[];
  /** Write-only secrets accepted via PUT (never returned). */
  secretKeys: readonly string[];
  /** X API is pay-per-use. */
  paidFeature: boolean;
  /** All required settings/credentials are present. */
  isConfigured(
    settings: Readonly<Record<string, string>>,
    secrets: Readonly<Record<string, string>>,
  ): boolean;
}

const httpUrl: SettingNormalizer = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return { ok: true, value: url.toString() };
  } catch {
    // fall through
  }
  return { ok: false, message: 'must be the http(s) URL of the podcast RSS feed' };
};

const fromParser =
  (parse: (input: string) => string | null, message: string): SettingNormalizer =>
  (value) => {
    const parsed = parse(value);
    return parsed === null ? { ok: false, message } : { ok: true, value: parsed };
  };

const has = (record: Readonly<Record<string, string>>, ...keys: string[]) =>
  keys.every((k) => (record[k] ?? '') !== '');

export const INTEGRATIONS: Readonly<Record<IntegrationId, IntegrationDefinition>> = {
  podcast_rss: {
    id: 'podcast_rss',
    platform: 'Podcast RSS',
    defaultEnabled: true,
    defaultSettings: { rssUrl: 'https://anchor.fm/s/105778688/podcast/rss' },
    editable: { rssUrl: httpUrl },
    readOnly: [],
    secretKeys: [],
    paidFeature: false,
    isConfigured: (s) => has(s, 'rssUrl'),
  },
  apple: {
    id: 'apple',
    platform: 'Apple Podcasts',
    defaultEnabled: true,
    defaultSettings: { podcastId: '1819558192' },
    editable: {
      podcastId: fromParser(
        parseApplePodcastId,
        'must be the numeric Apple Podcasts show id or the show URL (…/id1819558192)',
      ),
    },
    readOnly: [],
    secretKeys: [],
    paidFeature: false,
    isConfigured: (s) => has(s, 'podcastId'),
  },
  spotify: {
    id: 'spotify',
    platform: 'Spotify',
    // Active as soon as the Client ID / Secret are entered (isConfigured).
    defaultEnabled: true,
    defaultSettings: { showId: '4sYY0tpz7M8gflimZAglHi' },
    editable: {
      showId: fromParser(
        parseSpotifyShowId,
        'must be a Spotify show URL (open.spotify.com/show/…) or show id',
      ),
    },
    readOnly: [],
    secretKeys: ['clientId', 'clientSecret'],
    paidFeature: false,
    isConfigured: (s, secrets) => has(s, 'showId') && has(secrets, 'clientId', 'clientSecret'),
  },
  instagram: {
    id: 'instagram',
    platform: 'Instagram',
    defaultEnabled: false,
    defaultSettings: {},
    editable: {},
    readOnly: ['igUserId', 'username', 'pageId'],
    secretKeys: [],
    paidFeature: false,
    isConfigured: (s, secrets) => has(s, 'igUserId') && has(secrets, 'accessToken'),
  },
  x: {
    id: 'x',
    platform: 'X',
    defaultEnabled: false,
    defaultSettings: { username: 'fantasyonerim' },
    editable: {
      username: fromParser(parseXUsername, 'must be an X username (e.g. @fantasyonerim) or profile URL'),
    },
    readOnly: ['userId'],
    secretKeys: ['bearerToken', 'apiKey', 'apiSecret', 'accessToken', 'accessSecret'],
    paidFeature: true,
    isConfigured: (s, secrets) => has(s, 'username', 'userId') && has(secrets, 'bearerToken'),
  },
};

/** Contract order (the admin console lists them in this order). */
export const INTEGRATION_IDS: readonly IntegrationId[] = IntegrationIdSchema.options;
