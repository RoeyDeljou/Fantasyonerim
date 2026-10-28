'use client';

import { useEffect } from 'react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui';
import { RefreshIcon } from '@/components/icons';
import { isChunkLoadError } from '@/lib/appVersion';
import { recoverFromChunkError } from '@/lib/updates';

/**
 * Route-level error boundary. A chunk that vanished with the previous deploy (a long-lived installed app lazily
 * loading code of a build that is no longer served) is not a bug: reload once into the new build. Anything else —
 * or a chunk error that survives that one reload — gets a friendly retry screen.
 */
export default function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useT();
  const stale = isChunkLoadError(error);
  useEffect(() => {
    if (stale) recoverFromChunkError();
  }, [stale]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-3 px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center">
      <div
        role="alert"
        className="flex flex-col items-center gap-3 rounded-2xl border border-line bg-surface px-6 py-8"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-live-soft text-live">
          <RefreshIcon />
        </div>
        <h1 className="text-base font-bold text-ink">{stale ? t.updates.staleTitle : t.errors.title}</h1>
        <p className="max-w-xs text-sm text-muted">{stale ? t.updates.staleBody : t.errors.generic}</p>
        <Button variant="secondary" onClick={() => (stale ? window.location.reload() : retry())}>
          <RefreshIcon size={18} />
          {stale ? t.updates.reload : t.common.retry}
        </Button>
      </div>
    </main>
  );
}
