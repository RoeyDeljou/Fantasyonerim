'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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

function applyTheme(resolved: 'light' | 'dark') {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  const color = getComputedStyle(root).getPropertyValue('--theme-color').trim();
  if (!color) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = color;
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
      applyTheme(r);
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
