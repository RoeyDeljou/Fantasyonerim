'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ROUTES, useSession } from '@/lib/session';
import { Logo } from '@/components/AppShell';
import { Spinner } from '@/components/ui';

/** `/` — sends signed-in users to News and everyone else to onboarding. */
export default function RootRedirect() {
  const { status } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'signedIn') router.replace(ROUTES.home);
    if (status === 'signedOut') router.replace(ROUTES.onboarding);
  }, [status, router]);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-accent text-on-accent">
      <Logo size={120} />
      <Spinner />
    </main>
  );
}
