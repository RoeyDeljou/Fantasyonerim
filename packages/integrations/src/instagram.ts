import { z } from 'zod';
import { EMPTY_LINKS, acceptDraft, parseDateOrNull } from './drafts.js';
import { httpUrlOrNull, parseEnvelope, readJson, retryAfterSec, send } from './http.js';
import type { ContentSource, IntegrationContext, MediaDraft, SourceResult } from './types.js';
import {
  IntegrationAuthError,
  IntegrationConfigError,
  IntegrationRateLimitError,
  IntegrationUnavailableError,
} from './types.js';

/**
 * Instagram via **Facebook Login for Business** (graph.facebook.com), Instagram Business/Creator account
 * linked to a Facebook Page. Chosen over "Instagram API with Instagram Login" because:
 *   - the IG User `stories` edge is reliably available here;
 *   - a Page access token obtained from a long-lived user token does not expire, so the feed keeps
 *     syncing with no refresh job (the creator never has to reconnect unless they revoke access).
 */
export const GRAPH_API_VERSION = 'v26.0';
export const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
export const FACEBOOK_DIALOG_URL = `https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth`;
export const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
] as const;

const STORY_LIFETIME_MS = 24 * 3_600_000;

// ---------- errors ----------

const GraphErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});

const AUTH_CODES = new Set([102, 190, 463, 467]);
/** Permission problems: the admin must reconnect and grant the missing permission. */
const PERMISSION_CODES = new Set([10, 200, 210, 230]);
const RATE_CODES = new Set([4, 17, 32, 613, 80001, 80002]);

/** Maps a non-2xx Graph response (or a 2xx body with `error`) onto the typed integration errors. */
export function graphError(status: number, body: unknown, retryAfter: number | null): Error {
  const parsed = GraphErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : undefined;
  const message = parsed.success ? (parsed.data.error.message ?? 'unknown error') : `HTTP ${status}`;
  if (code !== undefined && AUTH_CODES.has(code)) {
    return new IntegrationAuthError(
      `Instagram connection expired or was revoked — reconnect Instagram. (${message})`,
    );
  }
  if (code !== undefined && (PERMISSION_CODES.has(code) || (code >= 200 && code < 300))) {
    return new IntegrationAuthError(
      `Instagram permission missing — reconnect and approve all permissions. (${message})`,
    );
  }
  if ((code !== undefined && RATE_CODES.has(code)) || status === 429) {
    return new IntegrationRateLimitError(`Instagram rate limit reached. (${message})`, retryAfter);
  }
  if (status >= 500 || code === 1 || code === 2) {
    return new IntegrationUnavailableError(`Instagram is temporarily unavailable. (${message})`, status);
  }
  if (code === 100 || code === 803 || status === 404) {
    return new IntegrationConfigError(`Instagram rejected the account settings. (${message})`);
  }
  if (status === 401 || status === 403) {
    return new IntegrationAuthError(`Instagram refused the request — reconnect Instagram. (${message})`);
  }
  return new IntegrationUnavailableError(`Instagram request failed. (${message})`, status);
}

async function graphGet<S extends z.ZodType>(
  ctx: IntegrationContext,
  url: URL,
  schema: S,
): Promise<z.infer<S>> {
  const res = await send(ctx, 'Instagram', url.toString(), { headers: { Accept: 'application/json' } });
  const body = await readJson(res);
  if (!res.ok || GraphErrorSchema.safeParse(body).success) {
    throw graphError(res.status, body, retryAfterSec(res, ctx.now()));
  }
  return parseEnvelope('Instagram', schema, body, res.status);
}

function graphUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(`${GRAPH_BASE_URL}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

// ---------- connect (OAuth) ----------

export interface InstagramConnectUrlInput {
  appId: string;
  /** Must exactly match a "Valid OAuth Redirect URI" of the Meta app. */
  redirectUri: string;
  /** CSRF token; apps/api verifies it on the callback. */
  state: string;
}

/** The Facebook Login dialog URL the admin opens to connect the Instagram account. */
export function buildInstagramConnectUrl(input: InstagramConnectUrlInput): string {
  const url = new URL(FACEBOOK_DIALOG_URL);
  url.searchParams.set('client_id', input.appId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
  return url.toString();
}

export interface CompleteInstagramConnectInput {
  appId: string;
  appSecret: string;
  redirectUri: string;
  /** `code` query parameter of the OAuth callback. */
  code: string;
}

export interface ConnectableInstagramAccount {
  pageId: string;
  pageName: string;
  igUserId: string;
  username: string;
  profilePictureUrl: string | null;
  /** Page access token — store encrypted, use for every poll. */
  accessToken: string;
  /** null = the token does not expire (normal for Page tokens from a long-lived user token). */
  expiresAt: Date | null;
  /**
   * When Meta stops serving data to this token unless the admin re-authorizes (data-access
   * expiration, ~90 days after login for user-derived tokens), or null when not reported. Surface it
   * in the admin console as "reconnect before …".
   */
  dataAccessExpiresAt: Date | null;
}

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
});

const AccountsSchema = z.object({
  data: z.array(z.unknown()),
});

const PageSchema = z.object({
  id: z.string(),
  name: z.string(),
  access_token: z.string().min(1),
  instagram_business_account: z
    .object({
      id: z.string(),
      username: z.string().optional(),
      profile_picture_url: z.string().optional(),
    })
    .optional(),
});

const DebugTokenSchema = z.object({
  data: z.object({
    is_valid: z.boolean().optional(),
    expires_at: z.number().optional(),
    data_access_expires_at: z.number().optional(),
  }),
});

function epochOrNull(sec: number | undefined): Date | null {
  return sec === undefined || sec <= 0 ? null : new Date(sec * 1000);
}

/**
 * OAuth callback: code → short-lived user token → long-lived user token → the admin's Pages with a
 * linked Instagram professional account. Returns every connectable account (usually exactly one); the
 * caller stores the chosen one's `igUserId`, `username`, `pageId` and (encrypted) `accessToken`.
 * Pages without an Instagram account are left out. Throws IntegrationConfigError when there are none.
 */
export async function completeInstagramConnect(
  input: CompleteInstagramConnectInput,
  ctx: IntegrationContext,
): Promise<ConnectableInstagramAccount[]> {
  const short = await graphGet(
    ctx,
    graphUrl('oauth/access_token', {
      client_id: input.appId,
      client_secret: input.appSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    }),
    TokenSchema,
  );
  const long = await graphGet(
    ctx,
    graphUrl('oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: input.appId,
      client_secret: input.appSecret,
      fb_exchange_token: short.access_token,
    }),
    TokenSchema,
  );
  const accounts = await graphGet(
    ctx,
    graphUrl('me/accounts', {
      fields: 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}',
      limit: '100',
      access_token: long.access_token,
    }),
    AccountsSchema,
  );

  const result: ConnectableInstagramAccount[] = [];
  for (const raw of accounts.data) {
    const page = PageSchema.safeParse(raw);
    if (!page.success || page.data.instagram_business_account === undefined) continue;
    const ig = page.data.instagram_business_account;
    let expiresAt: Date | null = null;
    let dataAccessExpiresAt: Date | null = null;
    try {
      const info = await graphGet(
        ctx,
        graphUrl('debug_token', {
          input_token: page.data.access_token,
          access_token: `${input.appId}|${input.appSecret}`,
        }),
        DebugTokenSchema,
      );
      expiresAt = epochOrNull(info.data.expires_at);
      dataAccessExpiresAt = epochOrNull(info.data.data_access_expires_at);
    } catch {
      // Informational only — a Page token from a long-lived user token does not expire.
    }
    result.push({
      pageId: page.data.id,
      pageName: page.data.name,
      igUserId: ig.id,
      username: ig.username ?? page.data.name,
      profilePictureUrl: httpUrlOrNull(ig.profile_picture_url),
      accessToken: page.data.access_token,
      expiresAt,
      dataAccessExpiresAt,
    });
  }
  if (result.length === 0) {
    throw new IntegrationConfigError(
      'No Instagram professional account is linked to a Facebook Page you manage. Convert the Instagram ' +
        'account to Business/Creator, link it to a Facebook Page, then connect again and select that Page.',
    );
  }
  return result;
}

// ---------- polling ----------

export interface InstagramAccountConfig {
  igUserId: string;
  /** Page access token from `completeInstagramConnect`. */
  accessToken: string;
  /** For the admin console label, e.g. "pod_fantasyonerim". */
  username?: string;
  /** Posts per poll (default 25, newest first). */
  limit?: number;
}

const ChildSchema = z.object({
  id: z.string().optional(),
  media_type: z.string(),
  media_url: z.string().optional(),
  thumbnail_url: z.string().optional(),
});

const MediaSchema = z.object({
  id: z.string().min(1),
  caption: z.string().optional(),
  media_type: z.enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']),
  media_product_type: z.string().optional(),
  media_url: z.string().optional(),
  thumbnail_url: z.string().optional(),
  permalink: z.string().optional(),
  timestamp: z.string(),
  children: z.object({ data: z.array(z.unknown()) }).optional(),
});

const MediaListSchema = z.object({
  data: z.array(z.unknown()),
});

const POST_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,' +
  'children{media_type,media_url,thumbnail_url}';
const STORY_FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,timestamp';

/** One IG media node → MediaDraft, or null when the URL is missing (e.g. copyright-restricted video). */
function toMediaDraft(
  mediaType: string,
  mediaUrl: string | undefined,
  thumb: string | undefined,
): MediaDraft | null {
  const url = httpUrlOrNull(mediaUrl);
  if (url === null) return null;
  if (mediaType === 'VIDEO') {
    return {
      kind: 'video',
      sourceUrl: url,
      posterSourceUrl: httpUrlOrNull(thumb),
      width: null,
      height: null,
    };
  }
  return { kind: 'image', sourceUrl: url, posterSourceUrl: null, width: null, height: null };
}

function emptyResult(accountLabel: string | null): SourceResult {
  return { items: [], skipped: [], warnings: [], accountLabel, cursor: null, notModified: false };
}

function label(config: InstagramAccountConfig): string | null {
  return config.username === undefined ? null : `@${config.username.replace(/^@/, '')}`;
}

/**
 * Newest posts (feed + reels) of the connected account. Stateless (no cursor): the first page is
 * re-read every poll and apps/api upserts by dedupeKey `instagram:<media id>`.
 * Media URLs are Instagram CDN URLs that expire — apps/api must re-host `sourceUrl` / `posterSourceUrl`.
 */
export async function fetchInstagramPosts(
  config: InstagramAccountConfig,
  ctx: IntegrationContext,
): Promise<SourceResult> {
  const body = await graphGet(
    ctx,
    graphUrl(`${encodeURIComponent(config.igUserId)}/media`, {
      fields: POST_FIELDS,
      limit: String(Math.min(Math.max(config.limit ?? 25, 1), 50)),
      access_token: config.accessToken,
    }),
    MediaListSchema,
  );
  const result = emptyResult(label(config));
  const { items, skipped } = result;
  for (const raw of body.data) {
    const parsed = MediaSchema.safeParse(raw);
    if (!parsed.success) {
      skipped.push({ externalId: idOf(raw), reason: 'unrecognized Instagram media object' });
      continue;
    }
    const m = parsed.data;
    const publishedAt = parseDateOrNull(m.timestamp);
    if (publishedAt === null) {
      skipped.push({ externalId: m.id, reason: 'invalid timestamp' });
      continue;
    }
    let media: MediaDraft[];
    if (m.media_type === 'CAROUSEL_ALBUM') {
      media = (m.children?.data ?? [])
        .map((c) => ChildSchema.safeParse(c))
        .flatMap((c) =>
          c.success ? [toMediaDraft(c.data.media_type, c.data.media_url, c.data.thumbnail_url)] : [],
        )
        .filter((d): d is MediaDraft => d !== null);
    } else {
      const one = toMediaDraft(m.media_type, m.media_url, m.thumbnail_url);
      media = one === null ? [] : [one];
    }
    if (media.length === 0) {
      skipped.push({ externalId: m.id, reason: 'no media_url (copyright-restricted or unavailable media)' });
      continue;
    }
    const caption = m.caption?.trim() ?? '';
    acceptDraft(
      {
        dedupeKey: `instagram:${m.id}`,
        source: 'instagram_post',
        title: null,
        text: caption === '' ? null : caption,
        media,
        links: { ...EMPTY_LINKS, instagram: httpUrlOrNull(m.permalink) },
        podcast: null,
        publishedAt,
        expiresAt: null,
      },
      m.id,
      items,
      skipped,
    );
  }
  return result;
}

/** Currently live stories (≤ 24 h old). `expiresAt` = timestamp + 24 h. */
export async function fetchInstagramStories(
  config: InstagramAccountConfig,
  ctx: IntegrationContext,
): Promise<SourceResult> {
  const body = await graphGet(
    ctx,
    graphUrl(`${encodeURIComponent(config.igUserId)}/stories`, {
      fields: STORY_FIELDS,
      access_token: config.accessToken,
    }),
    MediaListSchema,
  );
  const result = emptyResult(label(config));
  const { items, skipped } = result;
  for (const raw of body.data) {
    const parsed = MediaSchema.omit({ media_type: true }).extend({ media_type: z.string() }).safeParse(raw);
    if (!parsed.success) {
      skipped.push({ externalId: idOf(raw), reason: 'unrecognized Instagram story object' });
      continue;
    }
    const s = parsed.data;
    const publishedAt = parseDateOrNull(s.timestamp);
    if (publishedAt === null) {
      skipped.push({ externalId: s.id, reason: 'invalid timestamp' });
      continue;
    }
    const media = toMediaDraft(s.media_type, s.media_url, s.thumbnail_url);
    if (media === null) {
      skipped.push({ externalId: s.id, reason: 'no media_url (copyright-restricted or unavailable story)' });
      continue;
    }
    acceptDraft(
      {
        dedupeKey: `instagram_story:${s.id}`,
        source: 'instagram_story',
        title: null,
        text: null,
        media: [media],
        links: { ...EMPTY_LINKS, instagram: httpUrlOrNull(s.permalink) },
        podcast: null,
        publishedAt,
        expiresAt: new Date(publishedAt.getTime() + STORY_LIFETIME_MS),
      },
      s.id,
      items,
      skipped,
    );
  }
  // Instagram returns stories oldest → newest already; keep that (the stories bar order).
  items.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  return result;
}

export function createInstagramPostsSource(
  config: InstagramAccountConfig,
  ctx: IntegrationContext,
): ContentSource {
  return { source: 'instagram_post', fetchLatest: () => fetchInstagramPosts(config, ctx) };
}

export function createInstagramStoriesSource(
  config: InstagramAccountConfig,
  ctx: IntegrationContext,
): ContentSource {
  return { source: 'instagram_story', fetchLatest: () => fetchInstagramStories(config, ctx) };
}

function idOf(raw: unknown): string | null {
  if (raw !== null && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
