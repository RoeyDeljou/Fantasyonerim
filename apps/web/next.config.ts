import type { NextConfig } from 'next';

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
};

export default nextConfig;
