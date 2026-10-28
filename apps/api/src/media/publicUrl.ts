/**
 * Maps stored media URLs to the URL clients should load.
 *
 * The DB stores the bucket's own URL (`S3_PUBLIC_BASE_URL/<key>`, e.g. Backblaze B2). In production every client
 * URL goes through the web app's CDN instead (`MEDIA_PUBLIC_BASE_URL/<key>`, a Vercel rewrite of `/media/*` to the
 * bucket), so the bucket is hit about once per object rather than once per viewer (B2 free-tier download caps).
 *
 * Applied at serialization time, so existing rows need no migration and unsetting MEDIA_PUBLIC_BASE_URL reverts
 * to direct bucket URLs. URLs already in the public form, and any other URL (platform CDNs, admin links), pass
 * through untouched. Purges never read URLs: every delete goes by the stored key.
 */
export type MediaUrlMapper = (url: string) => string;

export const identityMediaUrl: MediaUrlMapper = (url) => url;

function trimSlashes(base: string): string {
  return base.replace(/\/+$/, '');
}

export function createMediaUrlMapper(
  originBaseUrl: string | null | undefined,
  publicBaseUrl: string | null | undefined,
): MediaUrlMapper {
  if (!originBaseUrl || !publicBaseUrl) return identityMediaUrl;
  const origin = trimSlashes(originBaseUrl);
  const target = trimSlashes(publicBaseUrl);
  if (origin === target) return identityMediaUrl;
  const prefix = `${origin}/`;
  return (url) => (url.startsWith(prefix) ? `${target}/${url.slice(prefix.length)}` : url);
}

/** Null-preserving convenience for optional columns (posterUrl). */
export function mapMediaUrl(mapper: MediaUrlMapper, url: string | null): string | null {
  return url === null ? null : mapper(url);
}

/**
 * AppConfig media URL fields from env. Without MEDIA_PUBLIC_BASE_URL the mapper is the identity, so URLs are
 * served exactly as stored (direct bucket URLs) — safe to deploy before the variable is set.
 */
export function mediaUrlConfigFromEnv(env: {
  S3_PUBLIC_BASE_URL?: string | undefined;
  MEDIA_PUBLIC_BASE_URL?: string | undefined;
}): { mediaOriginBaseUrl: string | null; mediaPublicBaseUrl: string | null } {
  return {
    mediaOriginBaseUrl: env.S3_PUBLIC_BASE_URL ?? null,
    mediaPublicBaseUrl: env.MEDIA_PUBLIC_BASE_URL ?? null,
  };
}
