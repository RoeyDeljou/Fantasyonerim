'use client';

import { useI18n } from './index';

/**
 * A lazy section dictionary: the strings of one feature that lives in its own chunk (the Community captain vote,
 * its admin card…). They are NOT part of `he.ts` / `en.ts`, which every route downloads, so a feature's copy only
 * costs the fans who open it. Flat `key -> string` maps (templates use `{name}` placeholders with `fmt()`), with the
 * English object forced to have exactly the Hebrew keys.
 */
export interface Section<K extends string> {
  he: Readonly<Record<K, string>>;
  en: Readonly<Record<K, string>>;
}

export function defineSection<const H extends Record<string, string>>(
  he: H,
  en: Record<keyof H, string>,
): Section<keyof H & string> {
  return { he, en };
}

/** The section's strings in the active language. Only the lazy chunks that own a section import this. */
export function useSection<K extends string>(section: Section<K>): Readonly<Record<K, string>> {
  return section[useI18n().locale];
}
