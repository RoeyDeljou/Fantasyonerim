'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useT } from '@/i18n';
import { ROUTES, useSession } from '@/lib/session';
import { useMe } from '@/lib/queries';
import { CommunityIcon, LiveIcon, NewsIcon, ShirtIcon, TableIcon } from './icons';
import { initials } from '@/lib/text';
import { Skeleton, cx } from './ui';

type TabKey = 'news' | 'community' | 'myTeam' | 'table' | 'live';

const TABS: ReadonlyArray<{ key: TabKey; href: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { key: 'news', href: '/news/', Icon: NewsIcon },
  { key: 'community', href: '/community/', Icon: CommunityIcon },
  { key: 'myTeam', href: '/my-team/', Icon: ShirtIcon },
  { key: 'table', href: '/table/', Icon: TableIcon },
  { key: 'live', href: '/live/', Icon: LiveIcon },
];

function initialsOf(name: string | undefined): string {
  return name ? initials(name) : '';
}

export function Logo({ size = 36 }: { size?: number }) {
  return (
    <img
      src="/brand/logo-320.png"
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-full border border-line bg-accent"
    />
  );
}

export function TopBar({ title, end }: { title?: string | undefined; end?: ReactNode }) {
  const t = useT();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-canvas/80">
      <div className="mx-auto flex h-14 max-w-xl items-center gap-3 ps-4 pe-2">
        <Link href={ROUTES.home} className="flex min-w-0 items-center gap-2.5" aria-label={t.app.name}>
          <Logo />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-base font-extrabold text-ink">{t.app.name}</span>
            {title && <span className="truncate text-xs font-medium text-muted">{title}</span>}
          </span>
        </Link>
        <div className="ms-auto flex items-center gap-1">{end}</div>
      </div>
    </header>
  );
}

function ProfileButton() {
  const t = useT();
  const me = useMe();
  const pathname = usePathname();
  const active = pathname.startsWith('/profile');
  return (
    <Link
      href="/profile/"
      aria-label={t.topBar.profile}
      aria-current={active ? 'page' : undefined}
      className="flex size-11 items-center justify-center rounded-full"
    >
      <span
        className={cx(
          'flex size-9 items-center justify-center rounded-full text-sm font-bold',
          active ? 'bg-primary text-on-primary' : 'bg-accent text-on-accent',
        )}
      >
        {initialsOf(me.data?.name) || '·'}
      </span>
    </Link>
  );
}

function TabBar() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav
      aria-label={t.tabs.label}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto grid h-16 max-w-xl grid-cols-5">
        {TABS.map(({ key, href, Icon }) => {
          const active = pathname.startsWith(href.replace(/\/$/, ''));
          return (
            <li key={key} className="flex">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors',
                  active ? 'text-primary' : 'text-muted hover:text-ink',
                )}
              >
                <span
                  className={cx(
                    'flex h-7 w-12 items-center justify-center rounded-full transition-colors',
                    active && 'bg-primary-soft text-on-primary-soft',
                  )}
                >
                  <Icon width={22} height={22} strokeWidth={active ? 2.2 : 1.8} />
                </span>
                <span className="max-w-full truncate px-0.5">{t.tabs[key]}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Redirects to onboarding when there is no session. Renders nothing meaningful until resolved. */
export function useRequireSession(): boolean {
  const { status } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'signedOut') router.replace(ROUTES.onboarding);
  }, [status, router]);
  return status === 'signedIn';
}

export function AppShell({ title, children }: { title?: string; children: ReactNode }) {
  const ready = useRequireSession();
  return (
    <div className="min-h-dvh">
      <TopBar title={title} end={ready ? <ProfileButton /> : null} />
      <main
        id="main"
        className="mx-auto w-full max-w-xl px-4 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))]"
      >
        {ready ? children : <ShellSkeleton />}
      </main>
      <TabBar />
    </div>
  );
}

export function ShellSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true">
      <Skeleton className="h-28" />
      <Skeleton className="h-12" />
      <Skeleton className="h-72" />
    </div>
  );
}
