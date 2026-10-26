'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { DisplayNameSchema } from '@fant/shared';
import type { Locale } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { useMe, useRecoveryCode, useUpdateMe } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import type { ThemePref } from '@/lib/prefs';
import { promptInstall, useInstallState } from '@/lib/pwa';
import { AppShell } from '@/components/AppShell';
import {
  AddSquareIcon,
  CheckIcon,
  ChevronEndIcon,
  DownloadIcon,
  KeyIcon,
  LogOutIcon,
  ShareIcon,
  ShieldIcon,
} from '@/components/icons';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorState,
  InlineError,
  SectionTitle,
  Segmented,
  Skeleton,
  Spinner,
  TextField,
  errorMessage,
} from '@/components/ui';

const APP_VERSION = '0.1.0';

export function ProfileScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.profile.title}>
      <ProfileInner />
    </AppShell>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <span className="text-sm text-muted">{label}</span>
      <span className="min-w-0 truncate text-end font-semibold text-ink">{children}</span>
    </div>
  );
}

function ProfileInner() {
  const { t, locale, setLocale } = useI18n();
  const me = useMe();
  const update = useUpdateMe();
  const theme = useTheme();
  const { signOut } = useSession();
  const [confirmOut, setConfirmOut] = useState(false);

  if (me.isPending) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-busy="true">
        <Skeleton className="h-36" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  }
  if (me.isError) return <ErrorState error={me.error} onRetry={() => me.refetch()} />;
  const user = me.data;

  const changeLocale = (l: Locale) => {
    setLocale(l);
    update.mutate({ locale: l });
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-1">
        <NameEditor current={user.name} />
        <div className="mt-2 border-t border-line pt-2">
          <Row label={t.profile.team}>
            <bdi dir="auto">{user.teamName ?? '—'}</bdi>
          </Row>
          <Row label={t.profile.teamId}>
            <span dir="ltr" className="tabular">
              {user.entryId ?? '—'}
            </span>
          </Row>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <div>
          <SectionTitle>{t.profile.language}</SectionTitle>
          <Segmented<Locale>
            label={t.profile.language}
            value={locale}
            onChange={changeLocale}
            options={[
              { value: 'he', label: t.profile.langHe },
              { value: 'en', label: t.profile.langEn },
            ]}
          />
        </div>
        <div>
          <SectionTitle>{t.profile.theme}</SectionTitle>
          <Segmented<ThemePref>
            label={t.profile.theme}
            value={theme.pref}
            onChange={theme.setPref}
            options={[
              { value: 'system', label: t.profile.themeSystem },
              { value: 'light', label: t.profile.themeLight },
              { value: 'dark', label: t.profile.themeDark },
            ]}
          />
        </div>
      </Card>

      <RecoveryCard />
      <InstallCard />

      {user.role === 'admin' && (
        <Link
          href="/admin/"
          className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-surface px-4 font-semibold text-ink shadow-card hover:bg-surface-2"
        >
          <ShieldIcon className="text-primary" />
          <span className="flex-1">{t.profile.adminConsole}</span>
          <ChevronEndIcon className="text-muted" />
        </Link>
      )}

      <Card className="flex flex-col gap-3">
        {confirmOut ? (
          <>
            <p className="text-sm text-ink">{t.profile.signOutConfirm}</p>
            <div className="flex gap-2">
              <Button variant="danger" className="flex-1" onClick={() => void signOut()}>
                <LogOutIcon size={18} />
                {t.profile.signOut}
              </Button>
              <Button variant="ghost" className="flex-1" onClick={() => setConfirmOut(false)}>
                {t.common.cancel}
              </Button>
            </div>
          </>
        ) : (
          <Button variant="danger" block onClick={() => setConfirmOut(true)}>
            <LogOutIcon size={18} />
            {t.profile.signOut}
          </Button>
        )}
      </Card>
      <p className="text-center text-xs text-muted">{fmt(t.profile.version, { v: APP_VERSION })}</p>
    </div>
  );
}

function NameEditor({ current }: { current: string }) {
  const { t } = useI18n();
  const update = useUpdateMe();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = DisplayNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(t.onboarding.nameInvalid);
      return;
    }
    update.mutate(
      { name: parsed.data },
      {
        onSuccess: () => {
          setEditing(false);
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2500);
        },
      },
    );
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent text-lg font-extrabold text-on-accent">
          {current.slice(0, 1).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-xs text-muted">{t.profile.name}</span>
          <span dir="auto" className="name-start truncate text-lg font-bold text-ink">
            {current}
          </span>
          {saved && (
            <span className="flex items-center gap-1 text-xs font-semibold text-success" role="status">
              <CheckIcon size={14} />
              {t.profile.nameSaved}
            </span>
          )}
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setName(current);
            setError(null);
            setEditing(true);
          }}
        >
          {t.common.edit}
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
      <TextField
        label={t.profile.editName}
        value={name}
        maxLength={40}
        autoFocus
        error={error}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
      />
      {update.isError && <InlineError>{errorMessage(t, update.error)}</InlineError>}
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={update.isPending}>
          {update.isPending && <Spinner />}
          {t.common.save}
        </Button>
        <Button variant="ghost" className="flex-1" onClick={() => setEditing(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}

function RecoveryCard() {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const code = useRecoveryCode(revealed);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-on-primary-soft">
          <KeyIcon size={20} />
        </span>
        <div>
          <h2 className="font-bold text-ink">{t.profile.recoveryTitle}</h2>
          <p className="text-sm text-muted">{t.profile.recoveryBody}</p>
        </div>
      </div>
      {!revealed ? (
        <Button variant="secondary" onClick={() => setRevealed(true)}>
          {t.profile.reveal}
        </Button>
      ) : code.isPending ? (
        <Skeleton className="h-14" />
      ) : code.isError ? (
        <ErrorState error={code.error} onRetry={() => code.refetch()} />
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <span dir="ltr" className="font-mono text-xl font-bold tracking-[0.15em] text-ink select-all">
            {code.data}
          </span>
          <CopyButton value={code.data} />
        </div>
      )}
    </Card>
  );
}

function InstallCard() {
  const { t } = useI18n();
  const state = useInstallState();
  if (state === 'unknown') return null;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
          <DownloadIcon size={20} />
        </span>
        <div>
          <h2 className="font-bold text-ink">{t.profile.installTitle}</h2>
          {state !== 'installed' && <p className="text-sm text-muted">{t.profile.installBody}</p>}
        </div>
      </div>
      {state === 'installed' && <Badge tone="success">{t.profile.installed}</Badge>}
      {state === 'promptable' && (
        <Button onClick={() => void promptInstall()}>
          <DownloadIcon size={18} />
          {t.profile.installButton}
        </Button>
      )}
      {state === 'ios' && (
        <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3">
          <p className="text-sm font-bold text-ink">{t.profile.iosStepsTitle}</p>
          <ol className="flex flex-col gap-2 text-sm text-ink">
            <IosStep n={1} icon={<ShareIcon size={18} />}>
              {t.profile.iosStep1}
            </IosStep>
            <IosStep n={2} icon={<AddSquareIcon size={18} />}>
              {t.profile.iosStep2}
            </IosStep>
            <IosStep n={3} icon={<CheckIcon size={18} />}>
              {t.profile.iosStep3}
            </IosStep>
          </ol>
          <p className="text-xs text-muted">{t.profile.iosNote}</p>
        </div>
      )}
      {state === 'manual' && <p className="text-sm text-muted">{t.profile.otherBrowser}</p>}
    </Card>
  );
}

function IosStep({ n, icon, children }: { n: number; icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-on-primary">
        {n}
      </span>
      <span className="flex-1">{children}</span>
      <span className="text-primary">{icon}</span>
    </li>
  );
}
