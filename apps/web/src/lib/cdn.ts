import { isNativeShell } from './platform';

/**
 * Public JSON through the Vercel CDN. `/v1/config` and `/v1/fpl/bootstrap` are the same for everyone, so the web
 * build fetches them from its own origin under `/cdn/…` — rewritten by Vercel to the API and cached at the edge
 * (vercel.json) — and a kickoff-time wave of app opens never reaches the API for them.
 *
 * Only on the Vercel web build (`NEXT_PUBLIC_CDN_JSON=1`, set by next.config.ts when building on Vercel or with
 * FANT_CDN_JSON=1); dev, e2e and the Capacitor shell (no same-origin CDN there) call the API directly. A CDN
 * request never carries the Authorization header: these responses are shared by every user.
 */
export const CDN_PATHS: readonly string[] = ['/v1/config', '/v1/fpl/bootstrap'];
export const CDN_JSON = process.env.NEXT_PUBLIC_CDN_JSON === '1';

/**
 * The CDN URL path for an API path: `/cdn/v1/config/`. With the trailing slash, because the site is built with
 * `trailingSlash: true` and Vercel would otherwise answer the slash-less form with a 308 redirect first.
 */
export function cdnPath(apiPath: string): string {
  return `/cdn${apiPath}/`;
}

/** Same-origin CDN URL for a public path, or null when it goes to the API as usual. */
export function cdnUrl(pathWithSearch: string): string | null {
  if (!CDN_JSON || typeof window === 'undefined' || isNativeShell()) return null;
  return CDN_PATHS.includes(pathWithSearch) ? `${window.location.origin}${cdnPath(pathWithSearch)}` : null;
}
