'use client';

import { useSyncExternalStore } from 'react';

/**
 * A one-shot toast that survives a client-side navigation (e.g. "account deleted" shown on onboarding). In memory
 * only — a full reload drops it, which is fine for a confirmation.
 */
export interface Flash {
  message: string;
  tone: 'neutral' | 'success' | 'error';
  key: number;
}

let current: Flash | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function flash(message: string, tone: Flash['tone'] = 'success'): void {
  current = { message, tone, key: Date.now() };
  emit();
}

export function clearFlash(): void {
  current = null;
  emit();
}

export function useFlashMessage(): Flash | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null,
  );
}
