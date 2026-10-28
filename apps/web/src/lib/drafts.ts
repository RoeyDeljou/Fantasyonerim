'use client';

import { useCallback, useState } from 'react';

/**
 * Unsent text survives a reload (a "new version" refresh, the OS reloading a suspended tab): composers keep their
 * text in sessionStorage under `fant.draft.<key>` until it is sent. Session-scoped on purpose — a draft from last
 * week reappearing would be stranger than losing it.
 */
const PREFIX = 'fant.draft.';

function read(key: string): string {
  try {
    return window.sessionStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(PREFIX + key, value);
    else window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // storage full / disabled: the draft just isn't persisted
  }
}

/** `useState('')` that persists. `key` null = not persisted (e.g. no post id yet). */
export function useDraft(key: string | null): [string, (v: string) => void] {
  const [value, setValue] = useState(() => (key && typeof window !== 'undefined' ? read(key) : ''));
  const set = useCallback(
    (v: string) => {
      setValue(v);
      if (key) write(key, v);
    },
    [key],
  );
  return [value, set];
}

const EDITABLE =
  'textarea, input:not([type]), input[type=text], input[type=search], input[type=url], input[type=email], input[type=tel], input[type=number], input[type=password], [contenteditable=""], [contenteditable=true]';

function hasContent(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly && el.value.trim().length > 0;
  }
  return (el.textContent ?? '').trim().length > 0;
}

/**
 * Is the user in the middle of writing something a reload would interrupt? True for any textarea with text
 * (textareas are only used for composing: posts, comments, reports, live updates), the focused field when it has
 * content, and any filled field inside an open sheet/dialog.
 */
export function hasActiveDraft(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (active && active.matches(EDITABLE) && hasContent(active)) return true;
  for (const el of document.querySelectorAll(EDITABLE)) {
    if (!hasContent(el)) continue;
    if (el instanceof HTMLTextAreaElement || el.closest('dialog[open], [role=dialog]')) return true;
  }
  return false;
}
