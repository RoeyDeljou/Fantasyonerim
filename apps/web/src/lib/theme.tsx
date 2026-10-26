'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { THEME_META_COLORS } from '@/app/theme-meta';
import { PREF_KEYS, isThemePref, readPref, writePref } from './prefs';
import type { ThemePref } from './prefs';

interface ThemeValue {
  pref: ThemePref;
  resolved: 'light' | 'dark';
  setPref(p: ThemePref): void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies the theme and keeps the status-bar colour in sync: on "system" each media-specific theme-color meta
 * keeps its own colour; with a manual choice every meta gets the chosen theme's colour.
 */
function applyTheme(resolved: 'light' | 'dark', pref: ThemePref) {
  document.documentElement.setAttribute('data-theme', resolved);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = meta.media.includes('dark') ? THEME_META_COLORS.dark : THEME_META_COLORS.light;
    meta.content = pref === 'system' ? own : THEME_META_COLORS[resolved];
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const stored = readPref(PREF_KEYS.theme);
    const p = isThemePref(stored) ? stored : 'system';
    setPrefState(p);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const r = pref === 'system' ? systemTheme() : pref;
      setResolved(r);
      applyTheme(r, pref);
    };
    update();
    if (pref !== 'system') return;
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    writePref(PREF_KEYS.theme, p);
    setPrefState(p);
  }, []);

  const value = useMemo(() => ({ pref, resolved, setPref }), [pref, resolved, setPref]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
