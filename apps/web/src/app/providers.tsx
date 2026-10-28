'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/lib/theme';
import { SessionProvider, useSession } from '@/lib/session';
import { resyncPush, shareWithWorker } from '@/lib/push';
import { onResume } from '@/lib/resume';
import { makeQueryClient } from '@/lib/queries';
import { isPersistedKey, persistOptions, wirePersistFlush } from '@/lib/persist';
import { wireWarmUp } from '@/lib/warmup';
import { registerServiceWorker, wireInstallPrompt } from '@/lib/pwa';
import { onHidden, wireQueryFocus } from '@/lib/resume';
import { startUpdateWatcher, wireChunkErrorRecovery } from '@/lib/updates';
import { clearFlash, useFlashMessage } from '@/lib/flash';
import { Toast } from '@/components/ui';
import { UpdateToast } from '@/components/UpdateToast';
import { SyncStatus } from '@/components/SyncStatus';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  useEffect(() => {
    const offWarmUp = wireWarmUp(); // start waking a sleeping API now (and on every resume)
    wireQueryFocus(); // resume → refetch stale data (also in the native shell)
    wireChunkErrorRecovery(); // web only, like the two below
    wireInstallPrompt();
    registerServiceWorker();
    startUpdateWatcher();
    const offFlush = wirePersistFlush(queryClient, onHidden); // the device copy is current when the app goes away
    return () => {
      offWarmUp();
      offFlush();
    };
  }, [queryClient]);

  return (
    // The last good copy of the read screens comes back from the device instantly (lib/persist.ts), then
    // revalidates in the background.
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      // Restored data is shown at once but never trusted as fresh: everything that came from the device is
      // revalidated (on mount for inactive queries), whatever its staleTime says.
      onSuccess={() => void queryClient.invalidateQueries({ predicate: (q) => isPersistedKey(q.queryKey) })}
    >
      <I18nProvider>
        <ThemeProvider>
          <SessionProvider>
            <PushSync />
            {children}
            <FlashToast />
            <UpdateToast />
            <SyncStatus />
          </SessionProvider>
        </ThemeProvider>
      </I18nProvider>
    </PersistQueryClientProvider>
  );
}

/**
 * Keeps this device's push subscription alive (see `ensurePushSubscription`): on start and on every resume while
 * signed in. Signing out tells the service worker to forget the token.
 */
function PushSync() {
  const { status } = useSession();
  useEffect(() => {
    if (status === 'signedOut') void shareWithWorker();
    if (status !== 'signedIn') return;
    void resyncPush();
    return onResume(() => void resyncPush());
  }, [status]);
  return null;
}

/** App-wide one-shot toast (`flash()` in lib/flash.ts). */
function FlashToast() {
  const f = useFlashMessage();
  return (
    <Toast
      key={f?.key}
      message={f?.message ?? null}
      tone={f?.tone ?? 'success'}
      ms={6000}
      onDone={clearFlash}
    />
  );
}
