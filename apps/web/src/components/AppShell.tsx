'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useT } from '@/i18n';
import { ROUTES, useSession } from '@/lib/session';
import { useMe } from '@/lib/queries';
import { useRefresh } from '@/lib/refresh';
import { prefetchTab, tabOf } from '@/lib/prefetch';
import type { RefreshScope } from '@/lib/refresh';
import { PullToRefresh, RefreshButton, RefreshDone } from './RefreshControl';
import { JoinLeagueBar } from './JoinLeague';
import { CommunityIcon, LiveIcon, NewsIcon, ShirtIcon, TableIcon } from './icons';
import { initials } from '@/lib/text';
import { Skeleton, cx } from './ui';
import { ShellDockProvider } from './ShellDock';
import { rememberScroll, watchHistoryScroll } from '@/lib/scroller';

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

export function TopBar({
  title,
  end,
  joinBar = false,
}: {
  title?: string | undefined;
  end?: ReactNode;
  /** The app's tabs: the "Join our league" strip sits on top of the header (JoinLeague.tsx). */
  joinBar?: boolean;
}) {
  const t = useT();
  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-line bg-canvas/90 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-canvas/80">
      {joinBar && <JoinLeagueBar />}
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
        <bdi dir="auto">{initialsOf(me.data?.name) || '·'}</bdi>
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
      data-tab-bar=""
      className="relative z-30 shrink-0 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
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

/**
 * Redirects to onboarding when there is no session. Renders nothing meaningful until resolved. Guests count as
 * ready: the tabs are public (account-only actions inside them prompt sign-up).
 */
export function useRequireSession(): boolean {
  const { status } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'signedOut') router.replace(ROUTES.onboarding);
  }, [status, router]);
  return status === 'signedIn' || status === 'guest';
}

const NO_SCOPE: RefreshScope = [];

/** Signed in: start everything this tab shows at once, and warm its neighbours when idle (lib/prefetch.ts). */
function usePrefetchTab(ready: boolean) {
  const qc = useQueryClient();
  const pathname = usePathname();
  const tab = tabOf(pathname);
  useEffect(() => {
    if (!ready || !tab) return;
    return prefetchTab(qc, tab);
  }, [ready, tab, qc]);
}

/**
 * The tabs' frame: one screen tall (`.app-shell`, globals.css), never scrolling itself — header on top, the content
 * area as the ONLY scroller (lib/scroller.ts), the dock (components/ShellDock.tsx) and the tab bar at the bottom as
 * plain flex children. Nothing here is `position: fixed` over a scrolling document, which iOS 26 WebKit misplaces
 * (the tab bar used to end up mid-screen while scrolling).
 *
 * `refresh` = the query-key prefixes this screen shows: adds the header refresh button and touch
 * pull-to-refresh (lib/refresh.ts).
 */
export function AppShell({
  title,
  refresh,
  skeleton,
  children,
}: {
  title?: string;
  refresh?: RefreshScope;
  /** Shown until the session is known — and so in the static HTML: shaped like the tab's real content. */
  skeleton?: ReactNode;
  children: ReactNode;
}) {
  const ready = useRequireSession();
  usePrefetchTab(ready);
  const r = useRefresh(refresh ?? NO_SCOPE);
  const canRefresh = ready && !!refresh;
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(watchHistoryScroll, []);
  return (
    <div className="app-shell flex flex-col overflow-hidden">
      <TopBar
        title={title}
        joinBar={ready}
        end={
          ready ? (
            <>
              {canRefresh && <RefreshButton refreshing={r.refreshing} onRefresh={() => void r.refresh()} />}
              <ProfileButton />
            </>
          ) : null
        }
      />
      {canRefresh && (
        <>
          <PullToRefresh refreshing={r.refreshing} onRefresh={() => void r.refresh()} />
          <RefreshDone state={r.state} />
        </>
      )}
      <ShellDockProvider value={dock}>
        <div
          data-app-scroller=""
          className="app-scroller isolate min-h-0 flex-1"
          onScroll={(e) => rememberScroll(e.currentTarget.scrollTop)}
        >
          {/* The end clears a floating button over the content (`--fab-space`, ShellDock). */}
          <main id="main" className="mx-auto w-full max-w-xl px-4 pt-4 pb-[calc(1.5rem+var(--fab-space))]">
            {ready ? children : (skeleton ?? <ShellSkeleton />)}
          </main>
        </div>
        <div ref={setDock} data-shell-dock="" className="relative z-20 shrink-0" />
      </ShellDockProvider>
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

/** News, before anything loaded: the profile header, the filter chips and two cards. */
export function NewsShellSkeleton({ card }: { card: ReactNode }) {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true">
      <div className="flex flex-col items-center gap-2 pt-2 pb-1">
        <Skeleton className="size-[7.5rem] rounded-full" />
        <Skeleton className="h-6 w-36" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-11 w-16 rounded-full" />
        <Skeleton className="h-11 w-24 rounded-full" />
        <Skeleton className="h-11 w-24 rounded-full" />
      </div>
      {card}
      {card}
    </div>
  );
}

/** A league table before anything loaded: the title line and its rows. */
export function TableShellSkeleton({ tabs = false }: { tabs?: boolean }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true">
      {tabs && <Skeleton className="h-11 rounded-full" />}
      <Skeleton className="h-8 w-48" />
      {Array.from({ length: 9 }, (_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  );
}
