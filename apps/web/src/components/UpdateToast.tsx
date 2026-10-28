'use client';

import { useT } from '@/i18n';
import { applyUpdateNow, useUpdatePrompt } from '@/lib/updates';
import { RefreshIcon } from './icons';

/**
 * "New version — refresh": shown only when a deploy landed while the user is mid-way through something (see
 * lib/updates.ts). Non-blocking, just under the top bar so it never covers the tab bar or a comment box; the app
 * reloads by itself once they are done, or right away on tap (drafts are kept — lib/drafts.ts).
 */
export function UpdateToast() {
  const t = useT();
  const show = useUpdatePrompt();
  if (!show) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(4rem+env(safe-area-inset-top))] z-40 flex justify-center px-4">
      <button
        type="button"
        onClick={applyUpdateNow}
        title={t.updates.availableHint}
        className="pointer-events-auto flex min-h-11 max-w-md items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-canvas shadow-card active:opacity-80"
        data-testid="update-toast"
      >
        <RefreshIcon size={18} />
        <span role="status">{t.updates.available}</span>
      </button>
    </div>
  );
}
