'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { CloseIcon } from './icons';
import { IconButton } from './ui';

/**
 * Bottom sheet on top of the native <dialog> (focus trap, Esc, inert background for free).
 * Tapping the backdrop closes it.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="flex max-h-[88dvh] flex-col">
          <div className="flex justify-center pt-2" aria-hidden="true">
            <span className="h-1.5 w-10 rounded-full bg-line" />
          </div>
          <div className="flex items-center justify-between gap-2 px-4 pt-1 pb-2">
            <h2 className="truncate text-lg font-bold">{title}</h2>
            <IconButton label={t.common.close} onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </div>
          <div className="overflow-y-auto overscroll-contain px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            {children}
          </div>
        </div>
      )}
    </dialog>
  );
}
