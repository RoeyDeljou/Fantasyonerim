'use client';

import { Suspense, lazy, useEffect, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { whenIdle } from '@/lib/idle';

/**
 * Code-splits a component that is closed on first paint (bottom sheets, the story viewer, the composer…), so a
 * tab's first load only ships what is on screen.
 *
 * Nothing is rendered — and nothing downloaded — until `isOpen(props)` is true for the first time; from then on
 * it stays mounted, so the sheet's own close animation and state behave exactly as before. The chunk is also
 * fetched in the background once the page is idle (online, no data saver), so the first tap rarely waits.
 */
export function lazyWhenOpen<P extends object>(
  load: () => Promise<ComponentType<P>>,
  isOpen: (props: P) => boolean,
  /** Shown while the chunk downloads (sheets: nothing — they animate in once ready). */
  fallback: ReactNode = null,
): ComponentType<P> {
  let promise: Promise<{ default: ComponentType<P> }> | null = null;
  const fetchChunk = () =>
    (promise ??= load().then(
      (c) => ({ default: c }),
      (e: unknown) => {
        promise = null; // offline / a vanished deploy: the next attempt tries again (errors → app/error.tsx)
        throw e;
      },
    ));
  const Lazy = lazy(fetchChunk);

  function LazyWhenOpen(props: P) {
    const open = isOpen(props);
    const [mounted, setMounted] = useState(open);
    if (open && !mounted) setMounted(true);
    useEffect(() => whenIdle(() => void fetchChunk().catch(() => undefined)), []);
    if (!mounted) return null;
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return LazyWhenOpen;
}
