import type { NextConfig } from 'next';

/**
 * One id per deploy, baked into the HTML (`<html data-build>`), the Next build id, `out/version.json` and the
 * service worker's cache names (scripts/stamp-build.mjs). Installed apps compare it with `/version.json` to know a
 * new deploy is live (src/lib/updates.ts). Commit sha + build time, so a redeploy of the same commit (e.g. after
 * changing an env var) still counts as new. Written back to process.env so build workers that re-read this config
 * inherit the same value instead of computing their own timestamp.
 */
function computeBuildId(): string {
  const stamp = Date.now().toString(36);
  const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 10);
  return sha ? `${sha}-${stamp}` : `local-${stamp}`;
}
const BUILD_ID = (process.env.NEXT_PUBLIC_BUILD_ID ||= computeBuildId());

/**
 * Public JSON (config, bootstrap) through the same-origin Vercel CDN rewrite `/cdn/*` (src/lib/cdn.ts): on when
 * building on Vercel, or with FANT_CDN_JSON=1 (the e2e suite's production-like build). Off in dev and plain e2e.
 */
const CDN_JSON = process.env.FANT_CDN_JSON === '1' || process.env.VERCEL === '1' ? '1' : '0';

/**
 * Static export: the same `out/` folder is served by any static host (Vercel/Netlify/S3) and is
 * wrapped by Capacitor for the app stores. No server features, no API routes, no image optimizer.
 */
const nextConfig: NextConfig = {
  output: 'export',
  // The e2e suite builds a second copy (pointing at its own API) without touching .next/ and out/.
  ...(process.env.FANT_E2E_DIST ? { distDir: process.env.FANT_E2E_DIST } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID, NEXT_PUBLIC_CDN_JSON: CDN_JSON },
  generateBuildId: () => BUILD_ID,
};

export default nextConfig;
