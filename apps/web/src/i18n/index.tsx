'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from '@fant/shared';
import { he } from './he';
import type { Messages } from './he';
import { PREF_KEYS, isLocale, readPref, writePref } from '@/lib/prefs';
import { relativeParts } from '@/lib/newsFormat';

export type { Messages };

/**
 * Hebrew (the default, and what the static HTML is rendered in) ships with every page; English is its own chunk,
 * fetched only by people who chose it — a fan in Hebrew never downloads it.
 */
const DICTS: Partial<Record<Locale, Messages>> = { he };
let enLoad: Promise<Messages> | null = null;
export function loadDictionary(locale: Locale): Promise<Messages> {
  const ready = DICTS[locale];
  if (ready) return Promise.resolve(ready);
  enLoad ??= import('./en').then((m) => (DICTS.en = m.en));
  return enLoad;
}
// Stored English: start fetching the dictionary as soon as this module runs, in parallel with hydration.
if (typeof window !== 'undefined' && readPref(PREF_KEYS.locale) === 'en') void loadDictionary('en');
/** Times are always shown in Israel time — the audience is Israeli, wherever the phone is. */
export const DISPLAY_TIME_ZONE = 'Asia/Jerusalem';

export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = values[key];
    return v === undefined ? m : String(v);
  });
}

/** "{n} likes" with a separate singular string ("1 like" / "לייק אחד"). */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : fmt(many, { n });
}

export interface Formatters {
  num(n: number): string;
  rank(n: number | null | undefined): string;
  price(tenths: number | null | undefined): string;
  decimal(n: number, digits?: number): string;
  time(iso: string): string;
  dayTime(iso: string): string;
  percent(n: number): string;
  /** "לפני 5 דקות" / "5 minutes ago"; a date once older than a week. */
  relative(iso: string, now?: number): string;
  /** "26 באוק׳" (adds the year when it isn't this year). */
  date(iso: string): string;
  dateTime(iso: string): string;
}

/** Intl formatters are costly to build: one per (locale, options), reused by every row of every list. */
const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(tag: string, min: number, max: number): Intl.NumberFormat {
  const key = `${tag}|${min}|${max}`;
  let nf = numberFormats.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(tag, { minimumFractionDigits: min, maximumFractionDigits: max });
    numberFormats.set(key, nf);
  }
  return nf;
}

function makeFormatters(locale: Locale): Formatters {
  const tag = locale === 'he' ? 'he-IL' : 'en-GB';
  const int = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
  const time = new Intl.DateTimeFormat(tag, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });
  const dayTime = new Intl.DateTimeFormat(tag, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });
  const rel = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'long' });
  const dayMonth = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    timeZone: DISPLAY_TIME_ZONE,
  });
  const dayMonthYear = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
  });
  const dateTime = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });
  const date = (iso: string) => {
    const d = new Date(iso);
    return (d.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear).format(d);
  };
  return {
    // Negatives get a real minus sign inside a directional isolate (LRI…PDI), so "−1" never turns into "1-"
    // when the string lands in Hebrew text (also inside fmt() templates).
    num: (n) => (n < 0 ? `\u2066−${int.format(-n)}\u2069` : int.format(n)),
    rank: (n) => (n === null || n === undefined ? '—' : int.format(n)),
    price: (t) => (t === null || t === undefined ? '—' : `£${numberFormat(tag, 1, 1).format(t / 10)}m`),
    decimal: (n, digits = 1) => numberFormat(tag, digits, digits).format(n),
    time: (iso) => time.format(new Date(iso)),
    dayTime: (iso) => dayTime.format(new Date(iso)),
    percent: (n) => `${numberFormat(tag, 0, 1).format(n)}%`,
    relative: (iso, now = Date.now()) => {
      const p = relativeParts(iso, now);
      if (p === 'now') return rel.format(0, 'second');
      // Some ICU builds (Chromium's) render Hebrew duals as "לפני שעתיים (2)" — drop the redundant count.
      return p ? rel.format(p.value, p.unit).replace(/\s*\(\d+\)$/, '') : date(iso);
    },
    date,
    dateTime: (iso) => dateTime.format(new Date(iso)),
  };
}

interface I18nValue {
  locale: Locale;
  dir: 'rtl' | 'ltr';
  t: Messages;
  f: Formatters;
  setLocale(locale: Locale): void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function applyLocaleToDocument(locale: Locale): void {
  const el = document.documentElement;
  el.lang = locale;
  el.dir = locale === 'he' ? 'rtl' : 'ltr';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Static HTML is rendered in Hebrew; the stored choice is applied right after hydration.
  const [locale, setLocaleState] = useState<Locale>('he');
  // The latest requested locale: a slow dictionary load never overrides a newer choice.
  const wanted = useRef<Locale>('he');

  const show = useCallback((next: Locale) => {
    wanted.current = next;
    void loadDictionary(next).then(
      () => {
        if (wanted.current === next) setLocaleState(next);
      },
      () => undefined, // offline before the chunk was ever cached: stay in the current language
    );
  }, []);

  useEffect(() => {
    const stored = readPref(PREF_KEYS.locale);
    if (isLocale(stored) && stored !== 'he') show(stored);
  }, [show]);

  const setLocale = useCallback(
    (next: Locale) => {
      writePref(PREF_KEYS.locale, next);
      applyLocaleToDocument(next);
      show(next);
    },
    [show],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: locale === 'he' ? 'rtl' : 'ltr',
      t: DICTS[locale] ?? he,
      f: makeFormatters(locale),
      setLocale,
    }),
    [locale, setLocale],
  );

  useEffect(() => {
    applyLocaleToDocument(locale);
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

/** The dictionary for the active locale. */
export function useT(): Messages {
  return useI18n().t;
}
