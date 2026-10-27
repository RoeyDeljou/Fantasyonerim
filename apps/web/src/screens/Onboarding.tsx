'use client';

import { firstGrapheme } from '@/lib/text';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { DisplayNameSchema, FplEntryIdSchema, RecoverBodySchema, RegisterBodySchema } from '@fant/shared';
import type { EntrySummary, FplEntryId } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { api, isApiError } from '@/lib/api';
import { ROUTES, useSession } from '@/lib/session';
import { qk, useMe, useRedeemInvite } from '@/lib/queries';
import { flash } from '@/lib/flash';
import { clearInviteToken, takeInviteToken } from '@/lib/invite';
import { Logo } from '@/components/AppShell';
import { TermsAgreeLine } from './Terms';
import { ChevronDownIcon, ChevronStartIcon, InfoIcon, KeyIcon } from '@/components/icons';
import {
  Button,
  Card,
  CopyButton,
  ErrorState,
  InlineError,
  Spinner,
  TextField,
  errorMessage,
} from '@/components/ui';

type Step = 'welcome' | 'form' | 'preview' | 'conflict' | 'recover' | 'code' | 'redeem';

/** Formats free text into XXXX-XXXX as the user types. */
function formatRecoveryCode(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function OnboardingScreen() {
  const { t, f, locale } = useI18n();
  const router = useRouter();
  const { status, signIn } = useSession();
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [code, setCode] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [preview, setPreview] = useState<EntrySummary | null>(null);
  const [becameAdmin, setBecameAdmin] = useState(false);
  const invite = useInvite();

  // Already signed in (e.g. opened /onboarding/ directly) → straight to the app — unless an admin invite came
  // with the link, then offer to upgrade this account instead.
  useEffect(() => {
    if (status !== 'signedIn' || step !== 'welcome' || invite.state === 'reading') return;
    if (invite.state === 'none') router.replace(ROUTES.home);
    else if (invite.state !== 'checking') setStep('redeem');
  }, [status, step, router, invite.state]);

  const lookup = useMutation({
    mutationFn: (id: FplEntryId) => api.entry(id),
    onSuccess: (entry) => {
      setPreview(entry);
      setStep('preview');
    },
    onError: (e) => {
      if (isApiError(e, 'not_found') || isApiError(e, 'bad_request')) setTeamError(t.onboarding.teamNotFound);
    },
  });

  const register = useMutation({
    mutationFn: (entryId: FplEntryId) =>
      api.register(
        RegisterBodySchema.parse({
          name: name.trim(),
          entryId,
          locale,
          ...((invite.state === 'valid' || invite.state === 'error') && invite.token
            ? { inviteToken: invite.token }
            : {}),
        }),
      ),
    onSuccess: async (auth) => {
      invite.clear();
      setBecameAdmin(auth.user.role === 'admin');
      await signIn(auth);
      setStep('code');
    },
    onError: (e) => {
      // With a token, a 400 means the invite died meanwhile (used / revoked / expired): nothing was created —
      // show the notice and let them carry on as a fan (the next tap signs up without the token).
      if ((invite.state === 'valid' || invite.state === 'error') && isApiError(e, 'bad_request'))
        invite.reject();
      else if (isApiError(e, 'conflict')) setStep('conflict');
      else if (isApiError(e, 'not_found')) {
        setTeamError(t.onboarding.teamNotFound);
        setStep('form');
      }
    },
  });

  const recover = useMutation({
    mutationFn: () => api.recover(RecoverBodySchema.parse({ entryId: teamId, recoveryCode: code })),
    onSuccess: async (auth) => {
      await signIn(auth);
      // Recovered on this device with an invite in hand → offer the upgrade.
      if (invite.state === 'valid' && auth.user.role !== 'admin') setStep('redeem');
      else router.replace(ROUTES.home);
    },
    onError: (e) => {
      if (isApiError(e, 'unauthorized') || isApiError(e, 'not_found')) setCodeError(t.onboarding.wrongCode);
    },
  });

  const recoveryCode = useQuery({
    queryKey: qk.recoveryCode,
    queryFn: ({ signal }) => api.recoveryCode({ signal }),
    enabled: step === 'code',
    staleTime: Infinity,
  });

  function submitForm(e: FormEvent) {
    e.preventDefault();
    const n = DisplayNameSchema.safeParse(name);
    const id = FplEntryIdSchema.safeParse(teamId.trim());
    setNameError(n.success ? null : t.onboarding.nameInvalid);
    setTeamError(id.success && /^\d+$/.test(teamId.trim()) ? null : t.onboarding.teamIdInvalid);
    if (!n.success || !id.success || !/^\d+$/.test(teamId.trim())) return;
    lookup.mutate(id.data);
  }

  function submitRecover(e: FormEvent) {
    e.preventDefault();
    const parsed = RecoverBodySchema.safeParse({ entryId: teamId.trim(), recoveryCode: code });
    if (!parsed.success) {
      const idOk = FplEntryIdSchema.safeParse(teamId.trim()).success && /^\d+$/.test(teamId.trim());
      setTeamError(idOk ? null : t.onboarding.teamIdInvalid);
      setCodeError(idOk ? t.onboarding.recoveryCodeInvalid : null);
      return;
    }
    setTeamError(null);
    setCodeError(null);
    recover.mutate();
  }

  const teamIdField = (
    <TextField
      label={t.onboarding.teamIdLabel}
      placeholder={t.onboarding.teamIdPlaceholder}
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      dir="ltr"
      value={teamId}
      error={teamError}
      onChange={(e) => {
        setTeamId(e.target.value.replace(/[^\d]/g, '').slice(0, 8));
        setTeamError(null);
      }}
    />
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      {step !== 'code' && step !== 'redeem' && <InviteBanner invite={invite} />}
      {step === 'redeem' && <RedeemStep invite={invite} />}
      {step === 'welcome' && (
        <div className="flex flex-1 flex-col">
          <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
            <div className="rounded-[2.5rem] bg-accent p-3 shadow-card">
              <Logo size={180} />
            </div>
            <h1 className="text-3xl font-extrabold text-ink">{t.onboarding.welcomeTitle}</h1>
            <p className="max-w-xs text-base leading-relaxed text-muted">{t.onboarding.welcomeBody}</p>
          </div>
          <div className="flex flex-col gap-2 pt-6">
            <Button block onClick={() => setStep('form')} className="min-h-12 text-lg">
              {t.onboarding.start}
            </Button>
            <button
              type="button"
              onClick={() => setStep('recover')}
              className="mx-auto flex min-h-11 max-w-full items-center gap-2 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-surface-2"
            >
              <KeyIcon size={18} className="shrink-0" />
              <span className="text-start">{t.onboarding.haveCode}</span>
            </button>
            <TermsAgreeLine />
          </div>
        </div>
      )}

      {step === 'form' && (
        <form onSubmit={submitForm} className="flex flex-1 flex-col gap-5" noValidate>
          <StepHeader title={t.onboarding.welcomeTitle} onBack={() => setStep('welcome')} />
          <TextField
            label={t.onboarding.nameLabel}
            placeholder={t.onboarding.namePlaceholder}
            autoComplete="nickname"
            maxLength={40}
            value={name}
            error={nameError}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
          />
          {teamIdField}
          <TeamIdHelp />
          {lookup.isError && !teamError && <InlineError>{errorMessage(t, lookup.error)}</InlineError>}
          <div className="mt-auto flex flex-col gap-2 pt-2">
            <TermsAgreeLine />
            <Button type="submit" block disabled={lookup.isPending} className="min-h-12">
              {lookup.isPending && <Spinner />}
              {t.onboarding.findTeam}
            </Button>
          </div>
        </form>
      )}

      {step === 'preview' && preview && (
        <div className="flex flex-1 flex-col gap-5">
          <StepHeader title={t.onboarding.previewTitle} onBack={() => setStep('form')} />
          <Card className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-accent text-2xl font-extrabold text-on-accent">
              {firstGrapheme(preview.teamName).toLocaleUpperCase()}
            </span>
            <p dir="auto" className="name-start max-w-full truncate text-2xl font-extrabold text-ink">
              {preview.teamName}
            </p>
            <p className="text-base text-muted">
              {fmt(t.onboarding.previewManager, { name: preview.managerName })}
            </p>
            <p className="text-sm text-muted tabular">
              {fmt(t.onboarding.previewPoints, {
                points: f.num(preview.overallPoints),
                rank: f.rank(preview.overallRank),
              })}
            </p>
          </Card>
          {register.isError &&
            !isApiError(register.error, 'conflict') &&
            // A 400 with an invite = the link died; the invite banner above already says so clearly.
            !(isApiError(register.error, 'bad_request') && invite.state === 'invalid') && (
              <InlineError>{errorMessage(t, register.error)}</InlineError>
            )}
          <div className="mt-auto flex flex-col gap-2">
            <Button
              block
              className="min-h-12"
              disabled={register.isPending}
              onClick={() => register.mutate(preview.entryId)}
            >
              {register.isPending && <Spinner />}
              {register.isPending ? t.onboarding.registering : t.onboarding.confirm}
            </Button>
            <Button block variant="ghost" onClick={() => setStep('form')}>
              {t.onboarding.notMine}
            </Button>
          </div>
        </div>
      )}

      {step === 'conflict' && (
        <div className="flex flex-1 flex-col gap-5">
          <StepHeader title={t.onboarding.alreadyRegisteredTitle} onBack={() => setStep('form')} />
          <Card className="flex gap-3">
            <InfoIcon className="shrink-0 text-primary" />
            <p className="text-base leading-relaxed text-ink">{t.onboarding.alreadyRegisteredBody}</p>
          </Card>
          <div className="mt-auto flex flex-col gap-2">
            <Button block className="min-h-12" onClick={() => setStep('recover')}>
              <KeyIcon size={18} />
              {t.onboarding.useRecovery}
            </Button>
            <Button block variant="ghost" onClick={() => setStep('form')}>
              {t.onboarding.backToRegister}
            </Button>
          </div>
        </div>
      )}

      {step === 'recover' && (
        <form onSubmit={submitRecover} className="flex flex-1 flex-col gap-5" noValidate>
          <StepHeader title={t.onboarding.recoverTitle} onBack={() => setStep('welcome')} />
          <p className="text-base leading-relaxed text-muted">{t.onboarding.recoverBody}</p>
          {teamIdField}
          <TextField
            label={t.onboarding.recoveryCodeLabel}
            placeholder="XXXX-XXXX"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            dir="ltr"
            className="[&_input]:font-mono [&_input]:tracking-widest"
            value={code}
            error={codeError}
            onChange={(e) => {
              setCode(formatRecoveryCode(e.target.value));
              setCodeError(null);
            }}
          />
          {recover.isError && !codeError && <InlineError>{errorMessage(t, recover.error)}</InlineError>}
          <div className="mt-auto flex flex-col gap-2">
            <Button type="submit" block className="min-h-12" disabled={recover.isPending}>
              {recover.isPending && <Spinner />}
              {t.onboarding.recoverSubmit}
            </Button>
            <Button block variant="ghost" onClick={() => setStep('form')}>
              {t.onboarding.backToRegister}
            </Button>
          </div>
        </form>
      )}

      {step === 'code' && (
        <div className="flex flex-1 flex-col gap-5">
          <h1 className="pt-4 text-2xl font-extrabold text-ink">{t.onboarding.savedCodeTitle}</h1>
          <p className="text-base leading-relaxed text-muted">{t.onboarding.savedCodeBody}</p>
          {recoveryCode.isPending && <div className="skeleton h-24 rounded-2xl" />}
          {recoveryCode.isError && (
            <ErrorState error={recoveryCode.error} onRetry={() => recoveryCode.refetch()} />
          )}
          {recoveryCode.data && (
            <Card className="flex flex-col items-center gap-4 py-6">
              <p
                dir="ltr"
                className="font-mono text-3xl font-bold tracking-[0.2em] text-ink select-all"
                aria-label={t.onboarding.recoveryCodeLabel}
              >
                {recoveryCode.data}
              </p>
              <CopyButton value={recoveryCode.data} />
            </Card>
          )}
          <div className="mt-auto">
            <Button
              block
              className="min-h-12"
              onClick={() => {
                if (becameAdmin) {
                  flash(fmt(t.invites.welcome, { name: name.trim() }));
                  router.replace(ROUTES.admin);
                } else router.replace(ROUTES.home);
              }}
            >
              {t.onboarding.savedCodeConfirm}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}

function StepHeader({ title, onBack }: { title: string; onBack(): void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        aria-label={t.common.back}
        className="-ms-2 flex size-11 items-center justify-center rounded-full text-ink hover:bg-surface-2"
      >
        <ChevronStartIcon />
      </button>
      <h1 className="text-xl font-extrabold text-ink">{title}</h1>
    </div>
  );
}

function TeamIdHelp() {
  const { t } = useI18n();
  return (
    <details className="group rounded-2xl border border-line bg-surface">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-semibold text-primary [&::-webkit-details-marker]:hidden">
        <InfoIcon size={18} />
        <span className="flex-1">{t.onboarding.helpToggle}</span>
        <ChevronDownIcon size={18} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 px-4 pb-4 text-sm leading-relaxed text-ink">
        <div>
          <h3 className="mb-1 font-bold">{t.onboarding.helpWebTitle}</h3>
          <ol className="list-decimal space-y-1 ps-5">
            <li>{t.onboarding.helpWeb1}</li>
            <li>{t.onboarding.helpWeb2}</li>
            <li>{t.onboarding.helpWeb3}</li>
          </ol>
          <p
            dir="ltr"
            className="mt-2 overflow-hidden rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-ellipsis whitespace-nowrap text-muted"
          >
            fantasy.premierleague.com/entry/<b className="text-primary">1234567</b>/event/9
          </p>
        </div>
        <div>
          <h3 className="mb-1 font-bold">{t.onboarding.helpAppTitle}</h3>
          <p>{t.onboarding.helpApp1}</p>
          <p className="mt-1 text-muted">{t.onboarding.helpApp2}</p>
        </div>
      </div>
    </details>
  );
}

// ---------- admin invite (`/onboarding/?invite=<token>`) ----------

/** `error` = couldn't check (offline / rate-limited): the token is kept and still sent — the API decides. */
type InviteState = 'reading' | 'none' | 'checking' | 'valid' | 'invalid' | 'error';

interface InviteApi {
  state: InviteState;
  token: string | null;
  label: string | null;
  /** The token was used up (registered / redeemed) — forget it. */
  clear(): void;
  /** The API said the link is dead after all. */
  reject(): void;
  retry(): void;
  error: unknown;
}

function useInvite(): InviteApi {
  const [token, setToken] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const [dead, setDead] = useState(false);
  useEffect(() => {
    setToken(takeInviteToken());
    setRead(true);
  }, []);
  // The token is deliberately not part of the query key (keys show up in devtools / error reports).
  const preview = useQuery({
    queryKey: ['admin-invite', 'preview'],
    queryFn: ({ signal }) =>
      token ? api.adminInvitePreview(token, { signal }) : Promise.reject(new Error('no token')),
    enabled: token !== null && !dead,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  // Only "unknown / used / expired / revoked" (404, or 400) kills the link; a network error or 429 doesn't.
  const invalid =
    dead ||
    (preview.isError && (isApiError(preview.error, 'not_found') || isApiError(preview.error, 'bad_request')));
  useEffect(() => {
    if (invalid) clearInviteToken();
  }, [invalid]);

  const state: InviteState = !read
    ? 'reading'
    : token === null && !dead
      ? 'none'
      : invalid
        ? 'invalid'
        : preview.isSuccess
          ? 'valid'
          : preview.isError
            ? 'error'
            : 'checking';
  return {
    state,
    token,
    label: preview.data?.label ?? null,
    clear: () => {
      clearInviteToken();
      setToken(null);
    },
    reject: () => setDead(true),
    retry: () => void preview.refetch(),
    error: preview.error,
  };
}

function InviteBanner({ invite }: { invite: InviteApi }) {
  const { t } = useI18n();
  const v = t.invites;
  if (invite.state === 'checking')
    return (
      <p
        role="status"
        className="mb-4 flex items-center gap-2 rounded-2xl bg-surface-2 p-3 text-sm text-muted"
      >
        <Spinner className="size-4" />
        {v.checking}
      </p>
    );
  if (invite.state === 'valid')
    return (
      <div
        className="mb-4 flex flex-col gap-1 rounded-2xl bg-primary p-4 text-on-primary shadow-card"
        data-testid="invite-banner"
      >
        <p className="text-base font-extrabold">{v.bannerTitle}</p>
        <p className="text-sm opacity-90">
          <bdi dir="auto">{fmt(v.bannerBody, { label: invite.label ?? '' })}</bdi>
        </p>
      </div>
    );
  if (invite.state === 'error')
    return (
      <div
        role="alert"
        className="mb-4 flex flex-col gap-2 rounded-2xl bg-surface-2 p-3"
        data-testid="invite-error"
      >
        <p className="text-sm font-bold text-ink">{v.checkFailed}</p>
        <p className="text-sm text-muted">{errorMessage(t, invite.error)}</p>
        <Button variant="secondary" className="self-start" onClick={invite.retry}>
          {t.common.retry}
        </Button>
      </div>
    );
  if (invite.state === 'invalid')
    return (
      <div
        role="alert"
        className="mb-4 flex items-start gap-2 rounded-2xl border border-live/30 bg-live-soft p-3"
        data-testid="invite-invalid"
      >
        <InfoIcon size={20} className="mt-px shrink-0 text-live" />
        <div>
          <p className="text-sm font-bold text-live">{v.invalid}</p>
          <p className="text-sm text-ink">{v.invalidBody}</p>
        </div>
      </div>
    );
  return null;
}

/** Already signed in on this device and opened an invite → upgrade this account (POST /v1/me/admin-invite). */
function RedeemStep({ invite }: { invite: InviteApi }) {
  const { t } = useI18n();
  const v = t.invites;
  const router = useRouter();
  const me = useMe();
  const redeem = useRedeemInvite();
  const already = isApiError(redeem.error, 'conflict') || me.data?.role === 'admin';

  if (invite.state !== 'valid' && !redeem.isPending)
    return (
      <div className="flex flex-1 flex-col gap-5">
        <InviteBanner invite={invite} />
        <div className="mt-auto">
          <Button block className="min-h-12" onClick={() => router.replace(ROUTES.home)}>
            {t.admin.toApp}
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-1 flex-col gap-5" data-testid="invite-redeem">
      <InviteBanner invite={invite} />
      <Card className="flex flex-col gap-2">
        <h1 className="text-xl font-extrabold text-ink">{v.redeemTitle}</h1>
        <p className="text-base leading-relaxed text-muted">
          <bdi dir="auto">{fmt(v.redeemBody, { name: me.data?.name ?? '', label: invite.label ?? '' })}</bdi>
        </p>
      </Card>
      {already && <InlineError>{v.redeemAlready}</InlineError>}
      {redeem.isError && !already && (
        <InlineError>
          {isApiError(redeem.error, 'bad_request') ? v.invalid : errorMessage(t, redeem.error)}
        </InlineError>
      )}
      <div className="mt-auto flex flex-col gap-2">
        {already ? (
          <Button block className="min-h-12" onClick={() => router.replace(ROUTES.admin)}>
            {t.profile.adminConsole}
          </Button>
        ) : (
          <Button
            block
            className="min-h-12"
            disabled={redeem.isPending || !invite.token}
            data-testid="invite-redeem-confirm"
            onClick={() => {
              if (!invite.token) return;
              redeem.mutate(invite.token, {
                onSuccess: (upgraded) => {
                  invite.clear();
                  flash(fmt(v.welcome, { name: upgraded.name }));
                  router.replace(ROUTES.admin);
                },
                onError: (e) => {
                  if (isApiError(e, 'bad_request')) invite.reject();
                },
              });
            }}
          >
            {redeem.isPending && <Spinner />}
            {v.redeemYes}
          </Button>
        )}
        <Button
          block
          variant="ghost"
          onClick={() => {
            invite.clear();
            router.replace(ROUTES.home);
          }}
        >
          {v.redeemNo}
        </Button>
      </div>
    </div>
  );
}
