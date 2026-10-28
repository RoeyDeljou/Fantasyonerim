'use client';

import { useEffect, useState } from 'react';
import './globals.css';
import { en } from '@/i18n/en';
import { he } from '@/i18n/he';
import type { Messages } from '@/i18n';
import { isChunkLoadError } from '@/lib/appVersion';
import { PREF_KEYS, readPref } from '@/lib/prefs';
import { recoverFromChunkError } from '@/lib/updates';

/**
 * Last-resort boundary (the root layout itself failed, so there are no providers): same chunk-error recovery as
 * app/error.tsx, with the stored language and theme read directly.
 */
export default function GlobalError({ error }: { error: unknown; retry: () => void }) {
  const [env] = useState(() => {
    // Prerendered at build time too (no window there): Hebrew, light.
    if (typeof window === 'undefined') return { locale: 'he', theme: 'light' } as const;
    const locale = readPref(PREF_KEYS.locale) === 'en' ? 'en' : 'he';
    const stored = readPref(PREF_KEYS.theme);
    const theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    return { locale, theme } as const;
  });
  const t: Messages = env.locale === 'en' ? en : he;
  const stale = isChunkLoadError(error);
  useEffect(() => {
    if (stale) recoverFromChunkError();
  }, [stale]);
  return (
    <html lang={env.locale} dir={env.locale === 'he' ? 'rtl' : 'ltr'} data-theme={env.theme}>
      <body className="min-h-dvh antialiased">
        <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-3 px-6 text-center">
          <h1 className="text-lg font-bold text-ink">{stale ? t.updates.staleTitle : t.errors.title}</h1>
          <p className="max-w-xs text-sm text-muted">{stale ? t.updates.staleBody : t.errors.generic}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 rounded-full bg-primary px-5 text-sm font-bold text-on-primary"
          >
            {t.updates.reload}
          </button>
        </main>
      </body>
    </html>
  );
}
