'use client';

import { useEffect, useRef } from 'react';
import type { AssistantConfig } from '@fant/shared';
import { useSection } from '@/i18n/section';
import { assistant } from '@/i18n/sections/assistant';
import { FPL_LAD_LOGO } from '@/lib/assistant/context';
import { ShellDock } from '../ShellDock';
import { cx } from '../ui';
import { AlfiePanel } from './AlfiePanel';
import { useAlfie } from './useAlfie';

/**
 * The floating "Ask Alfie" launcher (FPL Lad's AI assistant) on every tab, its sub-views and Profile. Its own chunk,
 * mounted by the tab shell after first paint (AppShell.tsx `AlfieSlot`) only when `assistantFor()` says it shows.
 *
 * Portalled into the shell's dock (ShellDock.tsx) like the tables' floating buttons — laid out by the non-scrolling
 * shell, never `position: fixed` over the scroller (iOS 26). It floats at the inline-end corner just above the tab
 * bar (and above anything in the dock, e.g. a thread's reply bar), stacked over a floating "Join" / "My team"
 * button via `--fab-space`. `data-alfie` on <html> sets `--alfie-space` so the end of the content and toasts clear
 * it. Hidden (globals.css) while a sheet/dialog is open or a composer has focus, and while Alfie itself is open.
 */
export default function AskAlfie({ config }: { config: AssistantConfig }) {
  const s = useSection(assistant);
  const alfie = useAlfie(config);
  const button = useRef<HTMLButtonElement>(null);
  const open = alfie.panelOpen || alfie.widgetOpen;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-alfie', '');
    return () => root.removeAttribute('data-alfie');
  }, []);

  const wasOpen = useRef(false);
  useEffect(() => {
    // Back from Alfie: focus returns to the launcher (it was hidden while Alfie was open).
    if (wasOpen.current && !open) requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <ShellDock>
        <div
          className="pointer-events-none absolute inset-x-0 bottom-full mb-[calc(0.5rem+var(--fab-space))]"
          data-alfie-launcher=""
        >
          <div className="mx-auto flex max-w-xl justify-end px-3">
            <button
              ref={button}
              type="button"
              onClick={() => void alfie.open()}
              onPointerDown={alfie.warm}
              onPointerEnter={alfie.warm}
              aria-label={alfie.busy ? `${s.launcherLabel} – ${s.opening}` : s.launcherLabel}
              aria-haspopup="dialog"
              aria-busy={alfie.busy || undefined}
              data-testid="alfie-launcher"
              className={cx(
                'pointer-events-auto flex min-w-11 flex-col items-center gap-0.5 rounded-2xl p-0.5 transition-transform active:scale-95',
                open && 'invisible',
              )}
            >
              {/* FPL Lad's round badge IS the button's circle: edge to edge, no border/background of our own. */}
              <img
                src={FPL_LAD_LOGO}
                alt=""
                width={52}
                height={52}
                draggable={false}
                className={cx('size-[52px] rounded-full shadow-card', alfie.busy && 'animate-pulse')}
              />
              <span className="rounded-full border border-line bg-surface px-1.5 text-[11px] leading-4 font-bold whitespace-nowrap text-ink shadow-card">
                {s.launcher}
              </span>
            </button>
          </div>
        </div>
      </ShellDock>
      <AlfiePanel
        open={alfie.panelOpen}
        onClose={alfie.closePanel}
        fallbackUrl={config.fallbackUrl}
        ctx={alfie.ctx}
      />
    </>
  );
}
