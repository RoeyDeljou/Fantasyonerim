'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n';
import { ROUTES, useSession } from '@/lib/session';
import { useMe } from '@/lib/queries';
import { ShellSkeleton, TopBar } from '@/components/AppShell';
import { ChevronStartIcon, LogOutIcon } from '@/components/icons';
import { ErrorState, IconButton } from '@/components/ui';

export function AdminFrame({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  const { status, signOut } = useSession();
  const me = useMe(status === 'signedIn');
  return (
    <div className="min-h-dvh">
      <TopBar
        title={title}
        end={
          <>
            {me.data?.role === 'admin' && (
              <IconButton label={t.admin.signOutAdmin} onClick={() => void signOut()}>
                <LogOutIcon />
              </IconButton>
            )}
            <Link
              href={ROUTES.home}
              className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-semibold text-primary hover:bg-surface-2"
            >
              <ChevronStartIcon width={18} height={18} />
              {t.admin.toApp}
            </Link>
          </>
        }
      />
      <main className="mx-auto w-full max-w-xl px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        {children}
      </main>
    </div>
  );
}

/** Admin-only guard: no session → admin login; signed in but not admin → admin login (with a notice). */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const router = useRouter();
  const me = useMe(status === 'signedIn');
  const isAdmin = me.data?.role === 'admin';

  useEffect(() => {
    if (status === 'signedOut') router.replace(ROUTES.adminLogin);
    else if (status === 'signedIn' && me.data && me.data.role !== 'admin')
      router.replace(`${ROUTES.adminLogin}?denied=1`);
  }, [status, me.data, router]);

  if (status === 'signedIn' && me.isError && !me.data)
    return <ErrorState error={me.error} onRetry={() => me.refetch()} />;
  if (!isAdmin) return <ShellSkeleton />;
  return <>{children}</>;
}
