import type { NextConfig } from 'next';

/**
 * Static export: the same `out/` folder is served by any static host (Vercel/Netlify/S3) and is
 * wrapped by Capacitor for the app stores. No server features, no API routes, no image optimizer.
 */
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
