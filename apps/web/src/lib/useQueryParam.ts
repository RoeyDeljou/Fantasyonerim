'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Read/write one query param with `router.replace` (detail views & sub-tabs live in the URL). */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(name);
  const set = useCallback(
    (next: string | null) => {
      const sp = new URLSearchParams(window.location.search);
      if (next === null) sp.delete(name);
      else sp.set(name, next);
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [name, pathname, router],
  );
  return [value, set];
}
