'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { UploadedImage } from '@fant/shared';
import { useI18n } from '@/i18n';
import { CloseIcon, PlusIcon } from '@/components/icons';
import { cx } from '@/components/ui';

const MIN = 1;
const MAX = 4;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface View {
  scale: number;
  x: number;
  y: number;
}
const RESET: View = { scale: 1, x: 0, y: 0 };

/**
 * Full-screen photo viewer on a native <dialog> (Esc, focus trap). Pinch / wheel / double-tap to zoom,
 * drag to pan while zoomed. Always dark chrome, like the story viewer.
 */
export function ImageViewer({
  image,
  alt,
  open,
  onClose,
}: {
  image: UploadedImage;
  alt: string;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<View>(RESET);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; scale: number } | null>(null);
  const lastTap = useRef(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setView(RESET);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const zoomTo = (scale: number) =>
    setView((v) => {
      const s = clamp(scale, MIN, MAX);
      return s === MIN ? RESET : { ...v, scale: s };
    });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setDragging(true);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (a && b) gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
    } else if (pointers.current.size === 1 && e.pointerType !== 'mouse') {
      const now = Date.now();
      if (now - lastTap.current < 300) zoomTo(view.scale > 1 ? 1 : 2.5);
      lastTap.current = now;
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, next);
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      if (a && b && gesture.current.dist > 0) {
        const s = clamp(
          (gesture.current.scale * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.current.dist,
          MIN,
          MAX,
        );
        setView((v) => (s === MIN ? RESET : { ...v, scale: s }));
      }
    } else if (pointers.current.size === 1 && view.scale > 1) {
      setView((v) => ({ ...v, x: v.x + next.x - prev.x, y: v.y + next.y - prev.y }));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) =>
    zoomTo(view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));

  return (
    <dialog
      ref={ref}
      className="story"
      aria-label={t.community.imageViewer}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div className="relative flex size-full items-center justify-center overflow-hidden">
          <div
            className="flex size-full touch-none items-center justify-center select-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onDoubleClick={() => zoomTo(view.scale > 1 ? 1 : 2.5)}
            onClick={(e) => {
              if (e.target === e.currentTarget && view.scale === 1) onClose();
            }}
            data-testid="image-viewer"
          >
            <img
              src={image.url}
              alt={alt}
              width={image.width}
              height={image.height}
              draggable={false}
              className={cx(
                'max-h-full max-w-full object-contain',
                !dragging && 'transition-transform duration-150',
              )}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            />
          </div>
          <div className="story-shade-top pointer-events-none absolute inset-x-0 top-0 h-24" />
          <div className="absolute end-2 top-[calc(0.5rem+env(safe-area-inset-top))] flex gap-1">
            <button
              type="button"
              onClick={() => zoomTo(view.scale > 1 ? 1 : 2.5)}
              aria-label={view.scale > 1 ? t.community.zoomOut : t.community.zoomIn}
              className="flex size-11 items-center justify-center rounded-full bg-media-scrim text-on-media"
            >
              {view.scale > 1 ? (
                <span aria-hidden="true" className="block h-0.5 w-4 rounded bg-current" />
              ) : (
                <PlusIcon size={20} />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t.common.close}
              className="flex size-11 items-center justify-center rounded-full bg-media-scrim text-on-media"
            >
              <CloseIcon size={22} />
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
