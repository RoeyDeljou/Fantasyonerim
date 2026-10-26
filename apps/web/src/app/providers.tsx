'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/lib/theme';
import { SessionProvider, useSession } from '@/lib/session';
import { resyncPush } from '@/lib/push';
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
          <SessionProvider>
            <PushSync />
            {children}
          </SessionProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

/** Re-syncs the push subscription once per signed-in session (see `resyncPush`). */
function PushSync() {
  const { status } = useSession();
  useEffect(() => {
    if (status === 'signedIn') void resyncPush();
  }, [status]);
  return null;
}
