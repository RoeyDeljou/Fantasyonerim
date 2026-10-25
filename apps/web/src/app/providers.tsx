'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/lib/theme';
import { SessionProvider } from '@/lib/session';
import { makeQueryClient } from '@/lib/queries';
import { registerServiceWorker, wireInstallPrompt } from '@/lib/pwa';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  useEffect(() => {
    wireInstallPrompt();
    registerServiceWorker();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <SessionProvider>{children}</SessionProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
