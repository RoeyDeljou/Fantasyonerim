import type { Locale } from '@fant/shared';

export type ThemePref = 'system' | 'light' | 'dark';

export const PREF_KEYS = { locale: 'fant.locale', theme: 'fant.theme' } as const;

export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore — preference just won't persist
  }
}

export function isLocale(v: unknown): v is Locale {
  return v === 'he' || v === 'en';
}

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark';
}

/**
 * Inline <head> script: applies the stored locale (lang/dir) and theme before first paint so there is
 * no flash of the wrong direction or colour scheme. Kept tiny and dependency-free.
 */
export const BOOT_SCRIPT = `(function(){try{var d=document.documentElement;var l=localStorage.getItem('${PREF_KEYS.locale}');if(l==='en'){d.lang='en';d.dir='ltr';}var t=localStorage.getItem('${PREF_KEYS.theme}');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}d.setAttribute('data-theme',t);}catch(e){}})();`;
