import { createHmac, randomBytes } from 'node:crypto';

/** RFC 3986 percent-encoding (what OAuth 1.0a requires; stricter than encodeURIComponent). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export interface OAuth1SignInput {
  method: string;
  /** Full URL; its query parameters are included in the signature. */
  url: string;
  /**
   * `application/x-www-form-urlencoded` body parameters (they are signed). JSON and multipart bodies
   * are NOT signed — pass nothing for them.
   */
  bodyParams?: Readonly<Record<string, string>>;
  /** Injected for deterministic tests; random otherwise. */
  nonce?: string;
  /** Seconds since epoch. */
  timestamp: number;
}

/** Signature base string + HMAC-SHA1 signature, exposed for the known-answer test. */
export function oauth1Signature(
  creds: OAuth1Credentials,
  input: OAuth1SignInput,
): { oauthParams: Record<string, string>; baseString: string; signature: string } {
  const url = new URL(input.url);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(input.timestamp),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  const pairs: [string, string][] = [];
  for (const [k, v] of url.searchParams) pairs.push([rfc3986(k), rfc3986(v)]);
  for (const [k, v] of Object.entries(input.bodyParams ?? {})) pairs.push([rfc3986(k), rfc3986(v)]);
  for (const [k, v] of Object.entries(oauthParams)) pairs.push([rfc3986(k), rfc3986(v)]);
  pairs.sort(([ak, av], [bk, bv]) => (ak === bk ? cmp(av, bv) : cmp(ak, bk)));
  const paramString = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const baseUrl = `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
  const baseString = [input.method.toUpperCase(), rfc3986(baseUrl), rfc3986(paramString)].join('&');
  const key = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret)}`;
  const signature = createHmac('sha1', key).update(baseString).digest('base64');
  return { oauthParams, baseString, signature };
}

/** The `Authorization: OAuth …` header value for a request. */
export function oauth1Header(creds: OAuth1Credentials, input: OAuth1SignInput): string {
  const { oauthParams, signature } = oauth1Signature(creds, input);
  const all: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return (
    'OAuth ' +
    Object.keys(all)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(all[k] ?? '')}"`)
      .join(', ')
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
