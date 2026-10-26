import {
  AdminAccountSchema,
  AdminSettingsSchema,
  ApiErrorSchema,
  AuthResponseSchema,
  BootstrapSchema,
  CaptainBattleConfigSchema,
  CaptainBattleSchema,
  EntryLiveSchema,
  EntryPicksSchema,
  EntrySummarySchema,
  FixtureSchema,
  LeagueStandingsSchema,
  LiveLeagueSchema,
  MeSchema,
  PublicConfigSchema,
  RecoveryCodeResponseSchema,
  AdminPushResultSchema,
  IntegrationListSchema,
  IntegrationStatusSchema,
  NewsItemSchema,
  NewsPageSchema,
  NotificationPrefsSchema,
  OAuthStartSchema,
  StoriesSchema,
  VapidKeySchema,
} from '@fant/shared';
import type { CreateAdminBodySchema } from '@fant/shared';
import type {
  AdminLoginBody,
  AdminSettings,
  ApiErrorCode,
  AuthResponse,
  Bootstrap,
  CaptainBattle,
  CaptainBattleConfig,
  EntryLive,
  EntryPicks,
  EntrySummary,
  Fixture,
  FplEntryId,
  Gameweek,
  LeagueStandings,
  LiveLeague,
  Me,
  PublicConfig,
  RecoverBody,
  RegisterBody,
  UpdateMeBody,
  AdminNewsBody,
  AdminPushBody,
  AdminPushResult,
  IntegrationId,
  IntegrationList,
  IntegrationStatus,
  IntegrationUpdateBody,
  NewsItem,
  NewsItemId,
  NewsPage,
  NotificationPrefs,
  Stories,
  WebPushSubscriptionBody,
} from '@fant/shared';
import { tokenStore } from './tokenStore';

/** `@fant/shared` exports these schemas but not their inferred types. */
export type AdminAccount = ReturnType<typeof AdminAccountSchema.parse>;
export type CreateAdminBody = ReturnType<typeof CreateAdminBodySchema.parse>;

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

export type ClientErrorCode = ApiErrorCode | 'network' | 'invalid_response';

/** Every failed call rejects with this — server `ApiError` codes plus two client-side ones. */
export class ApiRequestError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  constructor(code: ClientErrorCode, status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

export function isApiError(e: unknown, code?: ClientErrorCode): e is ApiRequestError {
  return e instanceof ApiRequestError && (code === undefined || e.code === code);
}

interface Parser<T> {
  parse(data: unknown): T;
}

function listOf<T>(item: Parser<T>): Parser<T[]> {
  return {
    parse(data) {
      if (!Array.isArray(data)) throw new Error('expected an array');
      return data.map((d: unknown) => item.parse(d));
    },
  };
}

function nullable<T>(item: Parser<T>): Parser<T | null> {
  return { parse: (data) => (data === null ? null : item.parse(data)) };
}

const noContent: Parser<void> = { parse: () => undefined };

let unauthorizedHandler: (() => void) | null = null;
/** Called when an authenticated request comes back 401 (token revoked/expired). */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

type Query = Record<string, string | number | undefined>;

interface RequestOptions {
  body?: unknown;
  query?: Query;
  signal?: AbortSignal | undefined;
}

async function request<T>(
  method: string,
  path: string,
  parser: Parser<T>,
  opts: RequestOptions = {},
): Promise<T> {
  const url = new URL(API_BASE_URL + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const token = await tokenStore.get();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? null : JSON.stringify(opts.body),
      signal: opts.signal ?? null,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiRequestError('network', 0, e instanceof Error ? e.message : 'network error');
  }

  if (res.status === 204) return parser.parse(undefined);

  let json: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }

  if (!res.ok) {
    const parsed = ApiErrorSchema.safeParse(json);
    const err = parsed.success
      ? new ApiRequestError(parsed.data.error.code, res.status, parsed.data.error.message)
      : new ApiRequestError(statusToCode(res.status), res.status, res.statusText);
    if (res.status === 401 && token) {
      await tokenStore.clear();
      unauthorizedHandler?.();
    }
    throw err;
  }

  try {
    return parser.parse(json);
  } catch (e) {
    console.error('API response failed contract validation', path, e);
    throw new ApiRequestError('invalid_response', res.status, 'invalid response');
  }
}

function statusToCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 502:
    case 503:
    case 504:
      return 'upstream_unavailable';
    default:
      return 'internal';
  }
}

type Signal = { signal?: AbortSignal | undefined };

/** The typed REST client. One function per route in docs/API.md. */
export const api = {
  config: (o: Signal = {}): Promise<PublicConfig> => request('GET', '/v1/config', PublicConfigSchema, o),

  register: (body: RegisterBody): Promise<AuthResponse> =>
    request('POST', '/v1/auth/register', AuthResponseSchema, { body }),
  recover: (body: RecoverBody): Promise<AuthResponse> =>
    request('POST', '/v1/auth/recover', AuthResponseSchema, { body }),
  adminLogin: (body: AdminLoginBody): Promise<AuthResponse> =>
    request('POST', '/v1/auth/admin-login', AuthResponseSchema, { body }),
  logout: (): Promise<void> => request('POST', '/v1/auth/logout', noContent),

  me: (o: Signal = {}): Promise<Me> => request('GET', '/v1/me', MeSchema, o),
  updateMe: (body: UpdateMeBody): Promise<Me> => request('PATCH', '/v1/me', MeSchema, { body }),
  recoveryCode: (o: Signal = {}): Promise<string> =>
    request('GET', '/v1/me/recovery-code', RecoveryCodeResponseSchema, o).then((r) => r.recoveryCode),

  bootstrap: (o: Signal = {}): Promise<Bootstrap> => request('GET', '/v1/fpl/bootstrap', BootstrapSchema, o),
  fixtures: (event: Gameweek, o: Signal = {}): Promise<Fixture[]> =>
    request('GET', '/v1/fpl/fixtures', listOf(FixtureSchema), { ...o, query: { event } }),
  entry: (entryId: FplEntryId, o: Signal = {}): Promise<EntrySummary> =>
    request('GET', `/v1/fpl/entries/${entryId}`, EntrySummarySchema, o),
  picks: (entryId: FplEntryId, event: Gameweek | undefined, o: Signal = {}): Promise<EntryPicks> =>
    request('GET', `/v1/fpl/entries/${entryId}/picks`, EntryPicksSchema, { ...o, query: { event } }),
  entryLive: (entryId: FplEntryId, event: Gameweek | undefined, o: Signal = {}): Promise<EntryLive> =>
    request('GET', `/v1/fpl/entries/${entryId}/live`, EntryLiveSchema, { ...o, query: { event } }),

  standings: (page: number, o: Signal = {}): Promise<LeagueStandings> =>
    request('GET', '/v1/league/standings', LeagueStandingsSchema, { ...o, query: { page } }),
  liveLeague: (page: number, o: Signal = {}): Promise<LiveLeague> =>
    request('GET', '/v1/league/live', LiveLeagueSchema, { ...o, query: { page } }),
  captainBattle: (o: Signal = {}): Promise<CaptainBattle> =>
    request('GET', '/v1/captain-battle', CaptainBattleSchema, o),

  news: (cursor: string | undefined, limit: number, o: Signal = {}): Promise<NewsPage> =>
    request('GET', '/v1/news', NewsPageSchema, { ...o, query: { cursor, limit } }),
  stories: (o: Signal = {}): Promise<Stories> => request('GET', '/v1/news/stories', StoriesSchema, o),
  newsItem: (id: NewsItemId, o: Signal = {}): Promise<NewsItem> =>
    request('GET', `/v1/news/${encodeURIComponent(id)}`, NewsItemSchema, o),

  vapidPublicKey: (o: Signal = {}): Promise<string> =>
    request('GET', '/v1/push/vapid-public-key', VapidKeySchema, o).then((r) => r.publicKey),
  savePushSubscription: (body: WebPushSubscriptionBody): Promise<void> =>
    request('POST', '/v1/push/subscriptions', noContent, { body }),
  deletePushSubscription: (endpoint: string): Promise<void> =>
    request('DELETE', '/v1/push/subscriptions', noContent, { body: { endpoint } }),
  notificationPrefs: (o: Signal = {}): Promise<NotificationPrefs> =>
    request('GET', '/v1/me/notification-prefs', NotificationPrefsSchema, o),
  saveNotificationPrefs: (body: NotificationPrefs): Promise<NotificationPrefs> =>
    request('PUT', '/v1/me/notification-prefs', NotificationPrefsSchema, { body }),

  admin: {
    integrations: (o: Signal = {}): Promise<IntegrationList> =>
      request('GET', '/v1/admin/integrations', IntegrationListSchema, o),
    updateIntegration: (id: IntegrationId, body: IntegrationUpdateBody): Promise<IntegrationStatus> =>
      request('PUT', `/v1/admin/integrations/${id}`, IntegrationStatusSchema, { body }),
    syncIntegration: (id: IntegrationId): Promise<IntegrationStatus> =>
      request('POST', `/v1/admin/integrations/${id}/sync`, IntegrationStatusSchema),
    instagramConnectUrl: (): Promise<string> =>
      request('GET', '/v1/admin/integrations/instagram/connect-url', OAuthStartSchema).then((r) => r.url),
    disconnectInstagram: (): Promise<void> =>
      request('DELETE', '/v1/admin/integrations/instagram', noContent),
    postNews: (body: AdminNewsBody): Promise<NewsItem> =>
      request('POST', '/v1/admin/news', NewsItemSchema, { body }),
    hideNews: (id: NewsItemId): Promise<void> =>
      request('DELETE', `/v1/admin/news/${encodeURIComponent(id)}`, noContent),
    push: (body: AdminPushBody): Promise<AdminPushResult> =>
      request('POST', '/v1/admin/push', AdminPushResultSchema, { body }),
    settings: (o: Signal = {}): Promise<AdminSettings> =>
      request('GET', '/v1/admin/settings', AdminSettingsSchema, o),
    saveSettings: (body: AdminSettings): Promise<AdminSettings> =>
      request('PUT', '/v1/admin/settings', AdminSettingsSchema, { body }),
    captainBattle: (o: Signal = {}): Promise<CaptainBattleConfig | null> =>
      request('GET', '/v1/admin/captain-battle', nullable(CaptainBattleConfigSchema), o),
    saveCaptainBattle: (body: CaptainBattleConfig): Promise<CaptainBattleConfig> =>
      request('PUT', '/v1/admin/captain-battle', CaptainBattleConfigSchema, { body }),
    admins: (o: Signal = {}): Promise<AdminAccount[]> =>
      request('GET', '/v1/admin/admins', listOf(AdminAccountSchema), o),
    createAdmin: (body: CreateAdminBody): Promise<AdminAccount> =>
      request('POST', '/v1/admin/admins', AdminAccountSchema, { body }),
  },
};
