'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/lib/theme';
import { SessionProvider, useSession } from '@/lib/session';
import { resyncPush, shareWithWorker } from '@/lib/push';
import { onResume } from '@/lib/resume';
import { makeQueryClient, qk, useMe } from '@/lib/queries';
import { usePathname } from 'next/navigation';
import { lazyWhenOpen } from '@/components/lazy';
import { scheduleMeRevalidation } from '@/lib/meRevalidate';
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
      onSuccess={() => {
        // `me` is the exception: revalidated off the critical path (lib/meRevalidate.ts).
        void queryClient.invalidateQueries({
          predicate: (q) =>
            isPersistedKey(q.queryKey) && !(q.queryKey.length === 1 && q.queryKey[0] === 'me'),
        });
        if (queryClient.getQueryData(qk.me) !== undefined) scheduleMeRevalidation(queryClient);
      }}
    >
      <I18nProvider>
        <ThemeProvider>
          <SessionProvider>
            <PushSync />
            <EmailPromptGate />
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
    if (status === 'signedOut' || status === 'guest') void shareWithWorker();
    if (status !== 'signedIn') return;
    void resyncPush();
    return onResume(() => void resyncPush());
  }, [status]);
  return null;
}

/** Page load: a `me` restored from the device is older than this, so it doesn't count until revalidated. */
const BOOT_AT = Date.now();

const EmailPrompt = lazyWhenOpen(
  () => import('@/components/EmailPrompt').then((m) => m.EmailPrompt),
  (p: { open: boolean }) => p.open,
);

/**
 * Accounts made before email was required are asked for it once, on app load (blocking pop-up). Only a signed-in
 * fan (has a Team ID — admin-only accounts sign in with a password) and only on a `me` the API answered during this
 * page load — a stale copy restored from the device must not flash the pop-up at someone who already added one.
 * It reads the shared `me` query (never fetches it ahead of the boot path) and stays out of onboarding.
 */
function EmailPromptGate() {
  const { status } = useSession();
  const me = useMe(status === 'signedIn');
  const pathname = usePathname();
  const user = me.data;
  const open =
    status === 'signedIn' &&
    !pathname.startsWith('/onboarding') &&
    user !== undefined &&
    me.dataUpdatedAt >= BOOT_AT &&
    user.entryId !== null &&
    user.email === null;
  return <EmailPrompt open={open} />;
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
