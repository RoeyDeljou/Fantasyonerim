'use client';

import { Suspense, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { AdminLoginBodySchema } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useMe } from '@/lib/queries';
import { api, isApiError } from '@/lib/api';
import { ROUTES, useSession } from '@/lib/session';
import { Logo } from '@/components/AppShell';
import { InfoIcon, ShieldIcon } from '@/components/icons';
import { Button, Card, InlineError, Spinner, TextField, errorMessage } from '@/components/ui';
import { AdminFrame } from './AdminShell';

export function AdminLoginScreen() {
  const { t } = useI18n();
  return (
    <AdminFrame title={t.admin.loginTitle}>
      <Suspense fallback={null}>
        <AdminLoginForm />
      </Suspense>
    </AdminFrame>
  );
}

function AdminLoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const denied = useSearchParams().get('denied') === '1';
  const { signIn, status } = useSession();
  const me = useMe(status === 'signedIn');
  const fanName = me.data && me.data.role !== 'admin' ? me.data.name : null;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invalid, setInvalid] = useState(false);

  const login = useMutation({
    mutationFn: () => api.adminLogin(AdminLoginBodySchema.parse({ username, password })),
    onSuccess: async (auth) => {
      await signIn(auth, { adoptLocale: false }); // keep this device's language
      router.replace(ROUTES.admin);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const ok = AdminLoginBodySchema.safeParse({ username, password }).success;
    setInvalid(!ok);
    if (ok) login.mutate();
  }

  return (
    <form onSubmit={submit} className="mx-auto flex max-w-sm flex-col gap-4 pt-6" noValidate>
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo size={88} />
        <h1 className="flex items-center gap-2 text-2xl font-extrabold text-ink">
          <ShieldIcon className="text-primary" />
          {t.admin.loginTitle}
        </h1>
      </div>
      {denied && <InlineError>{t.admin.notAdmin}</InlineError>}
      {fanName && (
        <p role="note" className="flex gap-2 rounded-xl bg-accent px-3 py-2 text-sm text-on-accent">
          <InfoIcon size={18} className="mt-0.5 shrink-0" />
          <span>{fmt(t.admin.fanKept, { name: fanName })}</span>
        </p>
      )}
      <Card className="flex flex-col gap-4">
        <TextField
          label={t.admin.username}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          dir="ltr"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          label={t.admin.password}
          type="password"
          autoComplete="current-password"
          dir="ltr"
          hint={t.admin.passwordHint}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {(invalid || isApiError(login.error, 'unauthorized')) && (
          <InlineError>{t.admin.badLogin}</InlineError>
        )}
        {login.isError && !isApiError(login.error, 'unauthorized') && (
          <InlineError>{errorMessage(t, login.error)}</InlineError>
        )}
        <Button type="submit" block disabled={login.isPending}>
          {login.isPending && <Spinner />}
          {t.admin.login}
        </Button>
      </Card>
    </form>
  );
}
