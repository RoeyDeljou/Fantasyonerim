import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/rubik';
import './globals.css';
import { Providers } from './providers';
import { BOOT_SCRIPT } from '@/lib/prefs';
import { THEME_META_COLORS } from './theme-meta';

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
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
