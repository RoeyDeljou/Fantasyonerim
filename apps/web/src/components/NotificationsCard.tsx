'use client';

import { useState } from 'react';
import type { NotificationPrefs } from '@fant/shared';
import { useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { disablePush, enablePush, usePushState } from '@/lib/push';
import type { PushError, PushState } from '@/lib/push';
import { useNotificationPrefs, useSaveNotificationPrefs } from '@/lib/queries';
import { BellIcon, BellOffIcon, InfoIcon } from './icons';
import { IosInstallSteps } from './InstallGuide';
import { Badge, Button, Card, ErrorState, InlineError, Skeleton, Spinner, Switch, errorMessage } from './ui';

const PREF_ROWS: ReadonlyArray<{ key: keyof NotificationPrefs; label: keyof Messages['push'] }> = [
  { key: 'news', label: 'prefNews' },
  { key: 'fpl', label: 'prefFpl' },
  { key: 'live', label: 'prefLive' },
  { key: 'community', label: 'prefCommunity' },
];

export function pushErrorText(t: Messages, e: PushError): string {
  return e === 'unconfigured' ? t.push.unconfigured : e === 'dismissed' ? t.push.dismissed : t.push.failed;
}

function StateLine({ state }: { state: PushState }) {
  const { t } = useI18n();
  switch (state) {
    case 'enabled':
      return <Badge tone="success">{t.push.stateEnabled}</Badge>;
    case 'disabled':
      return <Badge>{t.push.stateDisabled}</Badge>;
    case 'denied':
      return <Badge tone="live">{t.push.stateDenied}</Badge>;
    case 'unsupported':
      return <Badge tone="warning">{t.push.stateUnsupported}</Badge>;
    case 'needs-install':
      return <Badge tone="warning">{t.push.stateNeedsInstall}</Badge>;
    case 'loading':
      return <Skeleton className="h-5 w-40" />;
  }
}

/** Profile → Notifications: device push state + account-wide preference toggles. */
export function NotificationsCard() {
  const { t } = useI18n();
  const push = usePushState();
  const prefs = useNotificationPrefs(true);
  const save = useSaveNotificationPrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PushError | null>(null);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    const r = await enablePush();
    push.setState(r.state);
    if (r.error) setError(r.error);
    setBusy(false);
  };
  const turnOff = async () => {
    setBusy(true);
    setError(null);
    push.setState(await disablePush());
    setBusy(false);
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-3" data-testid="push-state" data-state={push.state}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-on-primary-soft">
          {push.state === 'enabled' ? <BellIcon size={20} /> : <BellOffIcon size={20} />}
        </span>
        <div className="flex min-w-0 flex-col items-start gap-1">
          <h2 className="font-bold text-ink">{t.push.sectionTitle}</h2>
          <StateLine state={push.state} />
        </div>
      </div>

      {push.state === 'disabled' && (
        <Button onClick={() => void turnOn()} disabled={busy}>
          {busy ? <Spinner /> : <BellIcon size={18} />}
          {t.push.enable}
        </Button>
      )}
      {push.state === 'enabled' && (
        <Button variant="ghost" onClick={() => void turnOff()} disabled={busy} className="self-start">
          {busy ? <Spinner /> : <BellOffIcon size={18} />}
          {t.push.disable}
        </Button>
      )}
      {push.state === 'denied' && <Help>{t.push.deniedHelp}</Help>}
      {push.state === 'unsupported' && <Help>{t.push.unsupportedHelp}</Help>}
      {push.state === 'needs-install' && (
        <>
          <Help>{t.push.needsInstallHelp}</Help>
          <IosInstallSteps />
        </>
      )}
      {error && <InlineError>{pushErrorText(t, error)}</InlineError>}

      <div className="border-t border-line pt-3">
        <h3 className="text-sm font-bold text-ink">{t.push.prefsTitle}</h3>
        <p className="mb-1 text-xs text-muted">{t.push.prefsHint}</p>
        {prefs.isPending ? (
          <div className="flex flex-col gap-2">
            {PREF_ROWS.map((r) => (
              <Skeleton key={r.key} className="h-10" />
            ))}
          </div>
        ) : prefs.isError ? (
          <ErrorState error={prefs.error} onRetry={() => prefs.refetch()} />
        ) : (
          <div className="flex flex-col" data-testid="notification-prefs">
            {PREF_ROWS.map((r) => (
              <Switch
                key={r.key}
                label={t.push[r.label]}
                checked={prefs.data[r.key]}
                onChange={(v) => save.mutate({ ...prefs.data, [r.key]: v })}
              />
            ))}
          </div>
        )}
        {save.isError && <InlineError>{errorMessage(t, save.error, { internal: t.push.prefsError })}</InlineError>}
      </div>
    </Card>
  );
}

function Help({ children }: { children: string }) {
  return (
    <p className="flex gap-2 rounded-xl bg-surface-2 p-3 text-sm text-ink">
      <InfoIcon size={18} className="mt-0.5 shrink-0 text-muted" />
      <span>{children}</span>
    </p>
  );
}
