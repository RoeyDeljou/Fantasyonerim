import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';
import { BOOT_SCRIPT } from '@/lib/prefs';
import { CHUNK_GUARD_SCRIPT } from '@/lib/appVersion';
import { WARMUP_SCRIPT } from '@/lib/warmupScript';
import { EARLY_FETCH_SCRIPT } from '@/lib/earlyFetch';
import { THEME_META_COLORS } from './theme-meta';

/** The API is another origin: open its connection (DNS + TLS) while the HTML is still parsing. */
const API_ORIGIN = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').origin;

export const metadata: Metadata = {
  title: { default: 'Fantasyonerim · פנטזיונרים', template: '%s · Fantasyonerim' },
  description: 'האפליקציה הרשמית של פנטזיונרים — הפודקאסט הישראלי לפנטזי פרמייר ליג',
  applicationName: 'Fantasyonerim',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32 48x48' },
      { url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  appleWebApp: { capable: true, title: 'Fantasyonerim', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_META_COLORS.light },
    { media: '(prefers-color-scheme: dark)', color: THEME_META_COLORS.dark },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-build: the deploy this page belongs to (compared with /version.json — src/lib/updates.ts).
    <html lang="he" dir="rtl" data-build={process.env.NEXT_PUBLIC_BUILD_ID} suppressHydrationWarning>
      <head>
        {/* anonymous: the API calls carry a bearer header, never cookies — the same connection pool. */}
        <link rel="preconnect" href={API_ORIGIN} crossOrigin="anonymous" />
        <link rel="dns-prefetch" href={API_ORIGIN} />
        {/* First: start waking the (possibly sleeping) API before anything else loads. */}
        <script dangerouslySetInnerHTML={{ __html: WARMUP_SCRIPT }} />
        {/* Then the tab's own first requests, so they overlap the bundle download (lib/earlyFetch.ts). */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_FETCH_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: CHUNK_GUARD_SCRIPT }} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* The Hebrew subset of the UI font (globals.css): needed by every screen's first paint. */}
        <link
          rel="preload"
          href="/fonts/rubik-hebrew-wght-normal.v5.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
