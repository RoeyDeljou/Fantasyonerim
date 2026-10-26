'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from '@fant/shared';
import { he } from './he';
import type { Messages } from './he';
import { en } from './en';
import { PREF_KEYS, isLocale, readPref, writePref } from '@/lib/prefs';

export type { Messages };

const DICTS: Record<Locale, Messages> = { he, en };
/** Times are always shown in Israel time — the audience is Israeli, wherever the phone is. */
export const DISPLAY_TIME_ZONE = 'Asia/Jerusalem';

export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = values[key];
    return v === undefined ? m : String(v);
  });
}

export interface Formatters {
  num(n: number): string;
  rank(n: number | null | undefined): string;
  price(tenths: number | null | undefined): string;
  decimal(n: number, digits?: number): string;
  time(iso: string): string;
  dayTime(iso: string): string;
  percent(n: number): string;
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
  return {
    // Negatives get a real minus sign inside a directional isolate (LRI…PDI), so "−1" never turns into "1-"
    // when the string lands in Hebrew text (also inside fmt() templates).
    num: (n) => (n < 0 ? `\u2066−${int.format(-n)}\u2069` : int.format(n)),
    rank: (n) => (n === null || n === undefined ? '—' : int.format(n)),
    price: (t) =>
      t === null || t === undefined
        ? '—'
        : `£${new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(t / 10)}m`,
    decimal: (n, digits = 1) =>
      new Intl.NumberFormat(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n),
    time: (iso) => time.format(new Date(iso)),
    dayTime: (iso) => dayTime.format(new Date(iso)),
    percent: (n) => `${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(n)}%`,
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

  useEffect(() => {
    const stored = readPref(PREF_KEYS.locale);
    if (isLocale(stored) && stored !== 'he') setLocaleState(stored);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    writePref(PREF_KEYS.locale, next);
    applyLocaleToDocument(next);
    setLocaleState(next);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      dir: locale === 'he' ? 'rtl' : 'ltr',
      t: DICTS[locale],
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
