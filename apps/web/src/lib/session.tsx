'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, Me } from '@fant/shared';
import { api, setUnauthorizedHandler } from './api';
import { tokenStore } from './tokenStore';
import { qk } from './queries';
import { clearPersistedQueries } from './persist';
import { useI18n } from '@/i18n';

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut';

interface SessionValue {
  status: SessionStatus;
  /** `adoptLocale` (default true) switches the UI to the account's saved language. */
  signIn(auth: AuthResponse, opts?: { adoptLocale?: boolean }): Promise<void>;
  signOut(): Promise<void>;
  /** Ends the session on this device only (the token is already dead, e.g. the account was deleted). */
  forget(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export const ROUTES = {
  onboarding: '/onboarding/',
  home: '/news/',
  admin: '/admin/',
  adminLogin: '/admin/login/',
} as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const router = useRouter();
  const qc = useQueryClient();
  const { setLocale } = useI18n();

  useEffect(() => {
    let alive = true;
    void tokenStore.get().then((t) => {
      if (alive) setStatus(t ? 'signedIn' : 'signedOut');
    });
    return () => {
      alive = false;
    };
  }, []);

  /** After the active session ends: bring back a stashed fan session, else go to onboarding. */
  const afterSessionEnded = useCallback(async () => {
    qc.clear();
    clearPersistedQueries(); // nothing of the old session stays on the device
    const fan = await tokenStore.get('fan');
    if (fan) {
      await tokenStore.set(fan);
      await tokenStore.clear('fan');
      setStatus('signedIn');
      router.replace(ROUTES.home);
      return;
    }
    setStatus('signedOut');
    router.replace(ROUTES.onboarding);
  }, [qc, router]);

  useEffect(() => {
    setUnauthorizedHandler(() => void afterSessionEnded());
    return () => setUnauthorizedHandler(null);
  }, [afterSessionEnded]);

  const signIn = useCallback(
    async (auth: AuthResponse, opts: { adoptLocale?: boolean } = {}) => {
      // Admin signing in on a fan's device: keep the fan's session aside and restore it on admin sign-out.
      const previous = await tokenStore.get();
      const previousMe = qc.getQueryData<Me>(qk.me);
      if (auth.user.role === 'admin' && previous && previous !== auth.token && previousMe?.role !== 'admin') {
        await tokenStore.set(previous, 'fan');
      }
      await tokenStore.set(auth.token);
      qc.removeQueries({ queryKey: qk.me });
      qc.setQueryData(qk.me, auth.user);
      if (opts.adoptLocale !== false) setLocale(auth.user.locale);
      setStatus('signedIn');
    },
    [qc, setLocale],
  );

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // already invalid / offline — sign out locally regardless
    }
    await tokenStore.clear();
    await afterSessionEnded();
  }, [afterSessionEnded]);

  const forget = useCallback(async () => {
    await tokenStore.clear();
    await afterSessionEnded();
  }, [afterSessionEnded]);

  const value = useMemo(() => ({ status, signIn, signOut, forget }), [status, signIn, signOut, forget]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
