'use client';

import { lazyWhenOpen } from '@/components/lazy';

/** The share picture + sheet (canvas, QR code): a chunk of its own, fetched when an admin card opens the sheet. */
export const ShareCaptainsSheet = lazyWhenOpen(
  () => import('./ShareCaptains').then((m) => m.ShareCaptainsSheet),
  (p) => p.open,
);
