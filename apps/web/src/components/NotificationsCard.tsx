'use client';

import { useEffect, useState } from 'react';
import type { NotificationPrefs } from '@fant/shared';
import { useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { api } from '@/lib/api';
import {
  disablePush,
  enablePush,
  ensurePushSubscription,
  renewPushSubscription,
  usePushState,
} from '@/lib/push';
import { isIos } from '@/lib/pwa';
import type { PushError, PushState } from '@/lib/push';
import { useNotificationPrefs, useSaveNotificationPrefs } from '@/lib/queries';
import { BellIcon, BellOffIcon, CheckIcon, InfoIcon, SendIcon } from './icons';
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

type TestState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'renewing' }
  | { kind: 'sent' }
  | { kind: 'none' }
  | { kind: 'renewFailed' }
  | { kind: 'error'; error: unknown };

/**
 * "Send a test notification": makes sure this device is registered, asks the API to push to the caller's own
 * devices and explains the outcome. A dead subscription (the push service answered 404/410) is replaced and the
 * test retried once.
 */
function TestPush({ onEnable }: { onEnable(): void }) {
  const { t } = useI18n();
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const busy = test.kind === 'sending' || test.kind === 'renewing';

  const run = async () => {
    setTest({ kind: 'sending' });
    await ensurePushSubscription(true).catch(() => undefined);
    try {
      let r = await api.testPush();
      if (r.devices === 0) return setTest({ kind: 'none' });
      if (r.delivered === 0 && r.gone > 0) {
        setTest({ kind: 'renewing' });
        if (!(await renewPushSubscription())) return setTest({ kind: 'renewFailed' });
        r = await api.testPush();
      }
      setTest(r.delivered > 0 ? { kind: 'sent' } : { kind: 'error', error: null });
    } catch (e) {
      setTest({ kind: 'error', error: e });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" onClick={() => void run()} disabled={busy} className="self-start">
        {busy ? <Spinner /> : <SendIcon size={18} />}
        {test.kind === 'sending' ? t.push.testSending : t.push.testButton}
      </Button>
      {test.kind !== 'idle' && test.kind !== 'sending' && (
        <div
          role="status"
          data-testid="push-test-result"
          data-result={test.kind}
          className="flex flex-col gap-2"
        >
          {test.kind === 'sent' && (
            <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
              <CheckIcon size={16} className="shrink-0" />
              {t.push.testSent}
            </p>
          )}
          {test.kind === 'renewing' && (
            <p className="flex items-center gap-1.5 text-sm font-semibold text-warning">
              <Spinner />
              {t.push.testRenewing}
            </p>
          )}
          {test.kind === 'none' && (
            <>
              <p className="text-sm text-ink">
                <span className="font-semibold">{t.push.testNoDevice}</span> · {t.push.testNoDeviceHelp}
              </p>
              <Button onClick={onEnable} className="self-start">
                <BellIcon size={18} />
                {t.push.enable}
              </Button>
            </>
          )}
          {test.kind === 'renewFailed' && <InlineError>{t.push.testRenewFailed}</InlineError>}
          {test.kind === 'error' && (
            <InlineError>
              {test.error ? errorMessage(t, test.error, { internal: t.push.testFailed }) : t.push.testFailed}
            </InlineError>
          )}
        </div>
      )}
    </div>
  );
}

/** Profile → Notifications: device push state + account-wide preference toggles. */
export function NotificationsCard() {
  const { t } = useI18n();
  const push = usePushState();
  const prefs = useNotificationPrefs(true);
  const save = useSaveNotificationPrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PushError | null>(null);
  const [ios, setIos] = useState(false);
  useEffect(() => setIos(isIos()), []);

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
        <>
          <TestPush onEnable={() => void turnOn()} />
          <Button variant="ghost" onClick={() => void turnOff()} disabled={busy} className="self-start">
            {busy ? <Spinner /> : <BellOffIcon size={18} />}
            {t.push.disable}
          </Button>
        </>
      )}
      {push.state === 'denied' && <Help>{ios ? t.push.deniedHelpIos : t.push.deniedHelp}</Help>}
      {push.state === 'unsupported' && (
        <Help>{ios ? t.push.unsupportedHelpIos : t.push.unsupportedHelp}</Help>
      )}
      {push.state === 'needs-install' && (
        <>
          <Help>{t.push.needsInstallHelp}</Help>
          <IosInstallSteps showNote={false} />
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
        {save.isError && (
          <InlineError>{errorMessage(t, save.error, { internal: t.push.prefsError })}</InlineError>
        )}
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
