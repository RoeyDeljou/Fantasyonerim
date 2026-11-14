'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useSection } from '@/i18n/section';
import { assistant } from '@/i18n/sections/assistant';
import { assistantUrl, FPL_LAD_LOGO } from '@/lib/assistant/context';
import type { AssistantContext } from '@/lib/assistant/context';
import { openExternal } from '@/lib/external';
import { CloseIcon, ExternalIcon } from '../icons';
import { IconButton, Spinner } from '../ui';

/** After this long the "Not loading? Open in fpl-lad.com" line appears (a refused frame can't be detected). */
const HINT_MS = 4_000;

/**
 * Our own Alfie panel, used while FPL Lad's embed script isn't set (or fails): their site in an iframe with our
 * context in the URL (lib/assistant/context.ts). A native modal <dialog> (globals.css `dialog.alfie`): full screen
 * on a phone, a 420×640 panel in the bottom inline-end corner on wide screens. Focus trap, inert background, Escape
 * and the Android back gesture (the dialog's cancel) for free; `onClose` hands focus back to the launcher.
 *
 * No `sandbox`: FPL Lad signs visitors in with Google in a popup, which a sandbox would break.
 */
export function AlfiePanel({
  open,
  onClose,
  fallbackUrl,
  ctx,
}: {
  open: boolean;
  onClose(): void;
  fallbackUrl: string;
  ctx: AssistantContext;
}) {
  const s = useSection(assistant);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [loaded, setLoaded] = useState(false);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoaded(false);
    setHint(false);
    const id = window.setTimeout(() => setHint(true), HINT_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  const frameSrc = assistantUrl(fallbackUrl, ctx, { embed: true });
  const tabUrl = assistantUrl(fallbackUrl, ctx, { embed: false });
  const openTab = (e: MouseEvent) => {
    e.preventDefault();
    openExternal(tabUrl);
  };

  return (
    <dialog
      ref={ref}
      className="alfie"
      aria-labelledby={titleId}
      data-testid="alfie-panel"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // the backdrop (wide screens)
      }}
    >
      {open && (
        <div className="flex h-full flex-col pb-[env(safe-area-inset-bottom)]">
          <div className="shrink-0 border-b border-line pt-[env(safe-area-inset-top)]">
            <div className="flex items-center gap-2 ps-3 pe-1 py-1.5">
              <span className="flex h-9 shrink-0 items-center rounded-full border border-line bg-logo-chip px-2.5">
                <img src={FPL_LAD_LOGO} alt="" width={74} height={15} className="h-[15px] w-[74px]" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <h2 id={titleId} className="truncate text-base font-extrabold text-ink">
                  <span className="sr-only">{s.dialogLabel}</span>
                  <span aria-hidden="true">{s.panelTitle}</span>
                </h2>
                <span className="truncate text-xs font-medium text-muted" aria-hidden="true">
                  {s.by}
                </span>
              </div>
              {/* Close first in the DOM so it gets the dialog's initial focus; shown last. */}
              <IconButton label={s.close} onClick={onClose} className="order-last" data-testid="alfie-close">
                <CloseIcon />
              </IconButton>
              <a
                href={tabUrl}
                target="_blank"
                rel="noopener"
                onClick={openTab}
                aria-label={s.openInTab}
                title={s.openInTab}
                data-testid="alfie-open-tab"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-surface-2"
              >
                <ExternalIcon size={20} />
              </a>
            </div>
            {hint && (
              <p className="px-4 pb-2 text-xs text-muted" data-testid="alfie-hint">
                {s.notLoading}{' '}
                <a
                  href={tabUrl}
                  target="_blank"
                  rel="noopener"
                  onClick={openTab}
                  className="font-semibold text-primary underline underline-offset-2"
                >
                  {s.openSite}
                </a>
              </p>
            )}
          </div>
          <div className="relative min-h-0 flex-1 bg-surface">
            {!loaded && (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted"
                role="status"
              >
                <Spinner />
                {s.loading}
              </div>
            )}
            <iframe
              src={frameSrc}
              title={s.frameTitle}
              allow="clipboard-write"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => setLoaded(true)}
              data-testid="alfie-frame"
              className="absolute inset-0 size-full border-0"
            />
          </div>
        </div>
      )}
    </dialog>
  );
}
