'use client';

import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AdminNewsBodySchema, AdminPushBodySchema } from '@fant/shared';
import type { IntegrationId, IntegrationStatus } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { api, isApiError } from '@/lib/api';
import { applePodcastId, expiresWithin, spotifyShowId, xUsername } from '@/lib/newsFormat';
import {
  useAdminPush,
  useDisconnectInstagram,
  useIntegrations,
  usePostNews,
  useSyncIntegration,
  useUpdateIntegration,
} from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import {
  ApplePodcastsIcon,
  CameraIcon,
  CheckIcon,
  ChevronDownIcon,
  InfoIcon,
  MegaphoneIcon,
  RefreshIcon,
  RssIcon,
  SendIcon,
  SpotifyIcon,
  XBrandIcon,
} from '@/components/icons';
import { RelativeTime } from '@/components/news/parts';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  InlineError,
  SectionTitle,
  Skeleton,
  Spinner,
  Switch,
  TextField,
  cx,
  errorMessage,
} from '@/components/ui';

type I = Messages['integrations'];

const ORDER: readonly IntegrationId[] = ['podcast_rss', 'apple', 'spotify', 'instagram', 'x'];
const EXPECTED_IG = 'fantasyonerimfpl';

const ICONS: Record<IntegrationId, ReactNode> = {
  podcast_rss: <RssIcon size={20} />,
  apple: <ApplePodcastsIcon size={20} />,
  spotify: <SpotifyIcon size={20} />,
  instagram: <CameraIcon size={20} />,
  x: <XBrandIcon size={18} />,
};

interface FieldDef {
  key: string;
  label: keyof I;
  help?: keyof I;
  /** Normalizes the input; null = invalid (shows `invalid`). */
  parse(v: string): string | null;
  invalid: keyof I;
  placeholder?: string;
}

const httpsUrl = (v: string) => {
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};

const SETTINGS: Record<IntegrationId, readonly FieldDef[]> = {
  podcast_rss: [
    {
      key: 'rssUrl',
      label: 'rssUrl',
      help: 'rssUrlHelp',
      parse: httpsUrl,
      invalid: 'invalidUrl',
      placeholder: 'https://anchor.fm/s/…/podcast/rss',
    },
  ],
  apple: [
    {
      key: 'podcastId',
      label: 'podcastId',
      help: 'podcastIdHelp',
      parse: applePodcastId,
      invalid: 'invalidApple',
      placeholder: 'https://podcasts.apple.com/…/id1819558192',
    },
  ],
  spotify: [
    {
      key: 'showId',
      label: 'showId',
      help: 'showIdHelp',
      parse: spotifyShowId,
      invalid: 'invalidShow',
      placeholder: 'https://open.spotify.com/show/…',
    },
  ],
  instagram: [],
  x: [
    {
      key: 'username',
      label: 'xUsername',
      parse: xUsername,
      invalid: 'invalidUsername',
      placeholder: '@Fantasyonerim',
    },
  ],
};

const SECRETS: Record<IntegrationId, ReadonlyArray<{ key: string; label: keyof I }>> = {
  podcast_rss: [],
  apple: [],
  spotify: [
    { key: 'clientId', label: 'clientId' },
    { key: 'clientSecret', label: 'clientSecret' },
  ],
  instagram: [],
  x: [
    { key: 'bearerToken', label: 'bearerToken' },
    { key: 'apiKey', label: 'apiKey' },
    { key: 'apiSecret', label: 'apiSecret' },
    { key: 'accessToken', label: 'accessToken' },
    { key: 'accessSecret', label: 'accessSecret' },
  ],
};

type Status = 'active' | 'disabled' | 'needsSetup' | 'error';

/** Error = the latest run failed (no success since). */
function statusOf(s: IntegrationStatus): Status {
  if (!s.enabled) return 'disabled';
  if (!s.configured) return 'needsSetup';
  const failedLast =
    s.lastError !== null &&
    (s.lastSuccessAt === null || (s.lastRunAt !== null && Date.parse(s.lastRunAt) > Date.parse(s.lastSuccessAt)));
  return failedLast ? 'error' : 'active';
}

function StatusChip({ status }: { status: Status }) {
  const { t } = useI18n();
  const map = {
    active: { tone: 'success', label: t.integrations.statusActive },
    disabled: { tone: 'neutral', label: t.integrations.statusDisabled },
    needsSetup: { tone: 'warning', label: t.integrations.statusNeedsSetup },
    error: { tone: 'live', label: t.integrations.statusError },
  } as const;
  const m = map[status];
  return (
    <Badge tone={m.tone} className="shrink-0">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {m.label}
    </Badge>
  );
}

// ---------- screen ----------

export function IntegrationsView() {
  const { t } = useI18n();
  const list = useIntegrations(true);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-extrabold text-ink">{t.integrations.title}</h2>
        <p className="text-sm text-muted">{t.integrations.intro}</p>
      </div>
      {list.isPending ? (
        ORDER.map((id) => <Skeleton key={id} className="h-44" />)
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        [...list.data.integrations]
          .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
          .map((s) => <IntegrationCard key={s.id} status={s} />)
      )}
      <h2 className="mt-2 text-lg font-extrabold text-ink">{t.integrations.toolsTitle}</h2>
      <AdminPushCard />
      <ManualPostCard />
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl bg-surface-2 px-2.5 py-2">
      <dt className="truncate text-[11px] text-muted">{label}</dt>
      <dd className="truncate text-sm font-semibold text-ink">{children}</dd>
    </div>
  );
}

function IntegrationCard({ status: s }: { status: IntegrationStatus }) {
  const { t } = useI18n();
  const it = t.integrations;
  const status = statusOf(s);
  const sync = useSyncIntegration(s.id);
  const update = useUpdateIntegration(s.id);
  const [synced, setSynced] = useState(false);
  const [open, setOpen] = useState(!s.configured && s.id !== 'instagram');
  const hasForm = SETTINGS[s.id].length > 0 || SECRETS[s.id].length > 0;

  useEffect(() => {
    if (!synced) return;
    const id = window.setTimeout(() => setSynced(false), 3000);
    return () => window.clearTimeout(id);
  }, [synced]);

  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card"
      data-testid="integration-card"
      data-integration={s.id}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-on-primary-soft">
          {ICONS[s.id]}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate font-bold text-ink">{it[`name_${s.id}`]}</h3>
            <StatusChip status={status} />
          </div>
          <p className="text-xs text-muted">{it[`desc_${s.id}`]}</p>
        </div>
      </div>

      {s.paidFeature && (
        <p
          className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm font-bold text-warning"
          data-testid="x-paid-note"
        >
          <InfoIcon size={20} className="shrink-0" />
          <span>{it.xPaid}</span>
        </p>
      )}

      {s.accountLabel && (
        <p className="text-sm text-muted">
          {it.account}:{' '}
          <bdi dir="auto" className="font-semibold text-ink">
            {s.accountLabel}
          </bdi>
        </p>
      )}

      <dl className="grid grid-cols-3 gap-2">
        <Stat label={it.lastSync}>{s.lastRunAt ? <RelativeTime iso={s.lastRunAt} /> : it.never}</Stat>
        <Stat label={it.lastSuccess}>
          {s.lastSuccessAt ? <RelativeTime iso={s.lastSuccessAt} /> : it.never}
        </Stat>
        <Stat label={it.itemsImported}>
          <bdi dir="ltr" className="tabular">
            {s.itemsImported}
          </bdi>
        </Stat>
      </dl>

      {s.lastError && status === 'error' && (
        <div role="alert" className="rounded-xl border border-live/30 bg-live-soft p-3">
          <p className="text-xs font-bold text-live">{it.lastError}</p>
          <p dir="auto" className="mt-0.5 text-sm break-words text-ink">
            {s.lastError}
          </p>
        </div>
      )}

      {s.id === 'instagram' && <InstagramConnect status={s} />}

      <div className="border-t border-line pt-1">
        <Switch
          label={it.enabledLabel}
          checked={s.enabled}
          disabled={update.isPending}
          onChange={(enabled) => update.mutate({ enabled, settings: s.settings })}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          disabled={sync.isPending || !s.configured}
          onClick={() => sync.mutate(undefined, { onSuccess: () => setSynced(true) })}
        >
          {sync.isPending ? <Spinner /> : <RefreshIcon size={18} />}
          {sync.isPending ? it.syncing : it.syncNow}
        </Button>
        {synced && (
          <span role="status" className="flex items-center gap-1 text-sm font-semibold text-success">
            <CheckIcon size={16} />
            {it.syncDone}
          </span>
        )}
        {hasForm && (
          <Button
            variant="ghost"
            className="ms-auto"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {it.settingsToggle}
            <ChevronDownIcon size={18} className={cx('transition-transform', open && 'rotate-180')} />
          </Button>
        )}
      </div>
      {sync.isError && <InlineError>{apiText(t, sync.error)}</InlineError>}
      {update.isError && !open && <InlineError>{apiText(t, update.error)}</InlineError>}
      {open && hasForm && <SettingsForm status={s} />}
    </section>
  );
}

/** Server validation messages are field-specific and more useful than a generic "invalid". */
function apiText(t: Messages, e: unknown): string {
  if (isApiError(e, 'bad_request') && e.message) return e.message;
  return errorMessage(t, e);
}

function SettingsForm({ status: s }: { status: IntegrationStatus }) {
  const { t } = useI18n();
  const it = t.integrations;
  const update = useUpdateIntegration(s.id);
  const fields = SETTINGS[s.id];
  const secrets = SECRETS[s.id];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, s.settings[f.key] ?? ''])),
  );
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    const settings: Record<string, string | null> = { ...s.settings };
    for (const f of fields) {
      const raw = (values[f.key] ?? '').trim();
      if (!raw) {
        settings[f.key] = null;
        continue;
      }
      const parsed = f.parse(raw);
      if (parsed === null) next[f.key] = it[f.invalid];
      else settings[f.key] = parsed;
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    const secretBody: Record<string, string> = {};
    for (const sec of secrets) {
      const v = (secretValues[sec.key] ?? '').trim();
      if (v) secretBody[sec.key] = v;
    }
    update.mutate(
      {
        enabled: s.enabled,
        settings,
        ...(Object.keys(secretBody).length ? { secrets: secretBody } : {}),
      },
      {
        onSuccess: (st) => {
          setSecretValues({});
          setReplacing({});
          setValues(Object.fromEntries(fields.map((f) => [f.key, st.settings[f.key] ?? ''])));
          setSaved(true);
          window.setTimeout(() => setSaved(false), 3000);
        },
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-2xl bg-surface-2/60 p-3">
      {fields.map((f) => (
        <TextField
          key={f.key}
          label={it[f.label]}
          hint={f.help ? it[f.help] : undefined}
          dir="ltr"
          inputMode={f.key === 'podcastId' ? 'url' : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={f.placeholder}
          value={values[f.key] ?? ''}
          error={errors[f.key]}
          onChange={(e) => {
            setValues({ ...values, [f.key]: e.target.value });
            setErrors({ ...errors, [f.key]: '' });
          }}
        />
      ))}
      {secrets.length > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-bold text-ink">
            {s.id === 'x' ? it.xKeysTitle : `${it.clientId} / ${it.clientSecret}`}
          </legend>
          {s.id === 'spotify' && <p className="-mt-2 text-xs text-muted">{it.spotifyKeysHelp}</p>}
          {secrets.map((sec) =>
            s.hasSecret && !replacing[sec.key] ? (
              <div key={sec.key} className="flex min-h-12 items-center justify-between gap-2">
                <span className="text-sm font-semibold text-ink">{it[sec.label]}</span>
                <span className="flex items-center gap-1 text-sm">
                  <span className="font-semibold text-success">{it.secretSaved}</span>
                  <span aria-hidden="true" className="text-muted">
                    ·
                  </span>
                  <button
                    type="button"
                    className="min-h-11 rounded-lg px-2 font-semibold text-primary hover:bg-surface-3"
                    onClick={() => setReplacing({ ...replacing, [sec.key]: true })}
                  >
                    {it.secretReplace}
                  </button>
                </span>
              </div>
            ) : (
              <div key={sec.key} className="flex items-end gap-2">
                <TextField
                  className="flex-1"
                  label={it[sec.label]}
                  type="password"
                  autoComplete="off"
                  dir="ltr"
                  spellCheck={false}
                  placeholder={it.secretPlaceholder}
                  hint={it.secretHint}
                  value={secretValues[sec.key] ?? ''}
                  onChange={(e) => setSecretValues({ ...secretValues, [sec.key]: e.target.value })}
                />
                {s.hasSecret && (
                  <Button
                    variant="ghost"
                    className="mb-6"
                    onClick={() => {
                      setReplacing({ ...replacing, [sec.key]: false });
                      setSecretValues({ ...secretValues, [sec.key]: '' });
                    }}
                  >
                    {it.secretKeep}
                  </Button>
                )}
              </div>
            ),
          )}
        </fieldset>
      )}
      {update.isError && <InlineError>{apiText(t, update.error)}</InlineError>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending && <Spinner />}
          {it.save}
        </Button>
        {saved && (
          <span role="status" className="flex items-center gap-1 text-sm font-semibold text-success">
            <CheckIcon size={16} />
            {t.common.saved}
          </span>
        )}
      </div>
    </form>
  );
}

// ---------- instagram ----------

function InstagramConnect({ status: s }: { status: IntegrationStatus }) {
  const { t, f } = useI18n();
  const it = t.integrations;
  const disconnect = useDisconnectInstagram();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const now = Date.now();

  const username = s.settings.username ?? null;
  const connected = s.configured && (username !== null || s.accountLabel !== null);
  const shown = username ? `@${username.replace(/^@/, '')}` : (s.accountLabel ?? '');
  const wrongAccount = username !== null && username.replace(/^@/, '').toLowerCase() !== EXPECTED_IG;

  const connect = async () => {
    setStarting(true);
    setError(null);
    try {
      const url = await api.admin.instagramConnectUrl();
      window.location.href = url;
    } catch (e) {
      setStarting(false);
      setError(isApiError(e) && e.status === 503 ? it.igUnavailable : errorMessage(t, e));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {connected && (
        <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <CameraIcon size={18} className="text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm text-ink">
            {it.igConnectedAs}
            <bdi dir="ltr" className="font-bold">
              {shown}
            </bdi>
          </span>
          <Button variant="ghost" className="text-live" onClick={() => setConfirm(true)}>
            {it.igDisconnect}
          </Button>
        </div>
      )}
      {wrongAccount && <InlineError>{fmt(it.igWrongAccount, { got: `⁦${shown}⁩` })}</InlineError>}
      {expiresWithin(s.dataAccessExpiresAt, 14, now) && s.dataAccessExpiresAt && (
        <p className="rounded-xl bg-warning-soft p-3 text-sm font-medium text-warning" role="alert">
          {fmt(it.igExpiry, { date: f.date(s.dataAccessExpiresAt) })}
        </p>
      )}
      {expiresWithin(s.tokenExpiresAt, 14, now) && s.tokenExpiresAt && (
        <p className="rounded-xl bg-warning-soft p-3 text-sm font-medium text-warning" role="alert">
          {fmt(it.igTokenExpiry, { date: f.date(s.tokenExpiresAt) })}
        </p>
      )}
      {!connected && <p className="text-xs text-muted">{it.igConnectHelp}</p>}
      <Button onClick={() => void connect()} disabled={starting} variant={connected ? 'secondary' : 'primary'}>
        {starting ? <Spinner /> : <CameraIcon size={18} />}
        {connected ? it.igReconnect : it.igConnect}
      </Button>
      {error && <InlineError>{error}</InlineError>}
      <BottomSheet open={confirm} onClose={() => setConfirm(false)} title={it.igDisconnect}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">{it.igDisconnectConfirm}</p>
          {disconnect.isError && <InlineError>{errorMessage(t, disconnect.error)}</InlineError>}
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(undefined, { onSuccess: () => setConfirm(false) })}
            >
              {disconnect.isPending && <Spinner />}
              {it.igDisconnect}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setConfirm(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}

// ---------- tools ----------

function AdminPushCard() {
  const { t } = useI18n();
  const it = t.integrations;
  const push = useAdminPush();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('/news/');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const parsed = AdminPushBodySchema.safeParse({ title, body, url: url.trim() || '/news/' });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed.success) {
      setError(url.trim() && !url.trim().startsWith('/') ? it.pushUrlInvalid : it.pushRequired);
      return;
    }
    setError(null);
    setConfirm(true);
  }

  return (
    <form onSubmit={submit} noValidate>
      <Card className="flex flex-col gap-3">
        <SectionTitle>
          <span className="flex items-center gap-2">
            <SendIcon size={18} className="text-primary" />
            {it.pushTitle}
          </span>
        </SectionTitle>
        <p className="-mt-2 text-xs text-muted">{it.pushNote}</p>
        <TextField label={it.pushTitleField} value={title} maxLength={80} dir="auto" onChange={(e) => setTitle(e.target.value)} />
        <TextArea label={it.pushBody} value={body} maxLength={300} onChange={setBody} />
        <TextField
          label={it.pushUrl}
          hint={it.pushUrlHelp}
          value={url}
          dir="ltr"
          onChange={(e) => setUrl(e.target.value)}
        />
        {error && <InlineError>{error}</InlineError>}
        {push.isError && <InlineError>{apiText(t, push.error)}</InlineError>}
        {push.data && (
          <p role="status" className="flex items-center gap-1 text-sm font-semibold text-success" data-testid="push-result">
            <CheckIcon size={16} />
            {fmt(it.pushResult, { delivered: push.data.delivered, recipients: push.data.recipients })}
          </p>
        )}
        <Button type="submit" disabled={push.isPending} className="self-start">
          {push.isPending ? <Spinner /> : <SendIcon size={18} />}
          {it.pushSubmit}
        </Button>
      </Card>
      <BottomSheet open={confirm} onClose={() => setConfirm(false)} title={it.pushConfirm}>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl bg-surface-2 p-3">
            <p dir="auto" className="font-bold text-ink">
              {title}
            </p>
            <p dir="auto" className="text-sm text-muted">
              {body}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => {
                if (!parsed.success) return;
                setConfirm(false);
                push.mutate(parsed.data);
              }}
            >
              <SendIcon size={18} />
              {it.pushSubmit}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setConfirm(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </form>
  );
}

function ManualPostCard() {
  const { t } = useI18n();
  const it = t.integrations;
  const post = usePostNews();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const l = link.trim();
    let links: Record<string, string> | undefined;
    let body = text;
    if (l) {
      const u = httpsUrl(l);
      if (!u) {
        setError(it.invalidUrl);
        return;
      }
      // Route the link to the matching slot so the card shows the right button; NewsLinks has no generic
      // slot, so any other link is appended to the text (the card linkifies it).
      const host = new URL(u).hostname;
      const slot = /(^|\.)spotify\.com$|spoti\.fi$/.test(host)
        ? 'spotify'
        : /(^|\.)apple\.com$/.test(host)
          ? 'apple'
          : /(^|\.)instagram\.com$/.test(host)
            ? 'instagram'
            : /(^|\.)(x|twitter)\.com$/.test(host)
              ? 'x'
              : null;
      if (slot) links = { [slot]: u };
      else body = `${text.trim()}\n\n${u}`;
    }
    const parsed = AdminNewsBodySchema.safeParse({
      title: title.trim() || null,
      text: body,
      ...(links ? { links } : {}),
    });
    if (!parsed.success) {
      setError(it.manualTextRequired);
      return;
    }
    setError(null);
    post.mutate(parsed.data, {
      onSuccess: () => {
        setTitle('');
        setText('');
        setLink('');
        setDone(true);
        window.setTimeout(() => setDone(false), 3000);
      },
    });
  }

  return (
    <form onSubmit={submit} noValidate>
      <Card className="flex flex-col gap-3 border-dashed shadow-none">
        <SectionTitle>
          <span className="flex items-center gap-2">
            <MegaphoneIcon size={18} className="text-muted" />
            {it.manualTitle}
          </span>
        </SectionTitle>
        <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted">
          <InfoIcon size={14} />
          {it.manualNote}
        </p>
        <TextField label={it.manualTitleField} value={title} maxLength={120} dir="auto" onChange={(e) => setTitle(e.target.value)} />
        <TextArea label={it.manualText} value={text} maxLength={2000} onChange={setText} />
        <TextField
          label={`${it.manualLink} (${t.common.optional})`}
          value={link}
          type="url"
          inputMode="url"
          dir="ltr"
          placeholder="https://"
          onChange={(e) => setLink(e.target.value)}
        />
        {error && <InlineError>{error}</InlineError>}
        {post.isError && <InlineError>{apiText(t, post.error)}</InlineError>}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" disabled={post.isPending}>
            {post.isPending && <Spinner />}
            {it.manualSubmit}
          </Button>
          {done && (
            <span role="status" className="flex items-center gap-1 text-sm font-semibold text-success">
              <CheckIcon size={16} />
              {it.manualDone}
            </span>
          )}
        </div>
      </Card>
    </form>
  );
}

function TextArea({
  label,
  value,
  maxLength,
  onChange,
}: {
  label: string;
  value: string;
  maxLength: number;
  onChange(v: string): void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex justify-between text-sm font-semibold text-ink">
        <span>{label}</span>
        <bdi dir="ltr" className="text-xs font-normal text-muted tabular">
          {value.length}/{maxLength}
        </bdi>
      </label>
      <textarea
        id={id}
        dir="auto"
        rows={4}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-base text-ink placeholder:text-muted focus:border-primary focus:outline-none"
      />
    </div>
  );
}
