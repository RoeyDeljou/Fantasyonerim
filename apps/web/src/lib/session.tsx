'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse } from '@fant/shared';
import { api, setUnauthorizedHandler } from './api';
import { tokenStore } from './tokenStore';
import { qk } from './queries';
import { useI18n } from '@/i18n';

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut';

interface SessionValue {
  status: SessionStatus;
  signIn(auth: AuthResponse): Promise<void>;
  signOut(): Promise<void>;
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

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStatus('signedOut');
      qc.clear();
      router.replace(ROUTES.onboarding);
    });
    return () => setUnauthorizedHandler(null);
  }, [qc, router]);

  const signIn = useCallback(
    async (auth: AuthResponse) => {
      await tokenStore.set(auth.token);
      qc.removeQueries({ queryKey: qk.me });
      qc.setQueryData(qk.me, auth.user);
      setLocale(auth.user.locale);
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
    qc.clear();
    setStatus('signedOut');
    router.replace(ROUTES.onboarding);
  }, [qc, router]);

  const value = useMemo(() => ({ status, signIn, signOut }), [status, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
