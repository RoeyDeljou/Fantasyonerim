'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryParam } from '@/lib/useQueryParam';
import { IntegrationsView } from './Integrations';
import { ModerationView } from './Moderation';
import { BroadcastView, LiveUpdateCard } from './Broadcast';
import { AccountView } from './Account';
import { InvitesCard } from './Invites';
import type { FormEvent, ReactNode } from 'react';
import {
  AdminSettingsSchema,
  CaptainBattleConfigSchema,
  CreateAdminBodySchema,
  FplEntryIdSchema,
  FplLeagueIdSchema,
  HttpsUrlSchema,
} from '@fant/shared';
import type {
  AdminSettings,
  CaptainBattleEntryInput,
  FplEntryId,
  FplPlayerId,
  Gameweek,
  PublicConfig,
} from '@fant/shared';
import { GameweekSchema } from '@fant/shared';
import { fmt, plural, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { isApiError } from '@/lib/api';
import {
  useAdminCaptainBattle,
  useAdminSettings,
  useAdmins,
  useConfig,
  useCreateAdmin,
  useEntry,
  useFplIndex,
  useSaveAdminCaptainBattle,
  useSaveAdminSettings,
} from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { ImageWithFallback, fplImage } from '@/components/FplImages';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CloseIcon,
  GlobeIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  ShirtIcon,
  TableIcon,
  TrashIcon,
} from '@/components/icons';
import { Collapsible, MoreInfo, loadProblem, saveProblem } from '@/components/Collapsible';
import {
  Badge,
  Button,
  ErrorState,
  IconButton,
  InlineError,
  Segmented,
  Skeleton,
  Spinner,
  TextField,
  Toast,
  cx,
  errorMessage,
} from '@/components/ui';
import { CLIENT_HOSTS } from '@/lib/clientConfig';
import { AdminFrame, AdminGuard } from './AdminShell';

export function AdminScreen() {
  const { t } = useI18n();
  return (
    <AdminFrame title={t.admin.title}>
      <AdminGuard>
        <Suspense fallback={<Skeleton className="h-64" />}>
          <AdminViews />
        </Suspense>
      </AdminGuard>
    </AdminFrame>
  );
}

type AdminView = 'settings' | 'broadcast' | 'integrations' | 'community' | 'account';
const VIEWS: readonly AdminView[] = ['settings', 'broadcast', 'integrations', 'community', 'account'];

function isView(v: string | null): v is AdminView {
  return v !== null && (VIEWS as readonly string[]).includes(v);
}

/**
 * `/admin/?view=integrations` — and the Instagram OAuth callback lands on `/admin/?instagram=connected` or
 * `?instagram=error&reason=…`, which opens Integrations with a notice and then cleans the URL.
 */
function AdminViews() {
  const { t } = useI18n();
  const [viewParam, setView] = useQueryParam('view');
  const params = useSearchParams();
  const router = useRouter();
  const ig = params.get('instagram');
  const reason = params.get('reason');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (ig !== 'connected' && ig !== 'error') return;
    setNotice(
      ig === 'connected'
        ? { ok: true, text: t.integrations.igConnected }
        : {
            ok: false,
            text: reason ? fmt(t.integrations.igErrorReason, { reason }) : t.integrations.igError,
          },
    );
    router.replace('/admin/?view=integrations', { scroll: false });
  }, [ig, reason, router, t]);

  const view: AdminView = ig ? 'integrations' : isView(viewParam) ? viewParam : 'settings';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-ink">{t.admin.title}</h1>
      <Toast
        message={notice?.text ?? null}
        tone={notice?.ok ? 'success' : 'error'}
        ms={notice?.ok ? 4000 : 8000}
        onDone={clearNotice}
      />
      <AdminNav
        value={view}
        onChange={(v) => setView(v === 'settings' ? null : v)}
        options={[
          { value: 'settings', label: t.integrations.viewSettings },
          { value: 'broadcast', label: t.broadcast.view },
          { value: 'integrations', label: t.integrations.viewIntegrations },
          { value: 'community', label: t.moderation.view },
          { value: 'account', label: t.account.view },
        ]}
      />
      {view === 'settings' ? (
        <>
          <LiveUpdateCard />
          <SettingsSection />
          <CaptainBattleEditor />
          <InvitesCard />
          <AdminsSection />
        </>
      ) : view === 'broadcast' ? (
        <BroadcastView />
      ) : view === 'integrations' ? (
        <IntegrationsView />
      ) : view === 'community' ? (
        <ModerationView />
      ) : (
        <AccountView />
      )}
    </div>
  );
}

/**
 * The admin sections as two rows of pill tabs (3 + 2): five labels don't fit one row at 360 px, and a scrolling
 * strip would hide some of them. Same tablist semantics as `Segmented`.
 */
function AdminNav({
  value,
  options,
  onChange,
}: {
  value: AdminView;
  options: ReadonlyArray<{ value: AdminView; label: string }>;
  onChange(v: AdminView): void;
}) {
  const { t } = useI18n();
  return (
    <div role="tablist" aria-label={t.integrations.viewsLabel} className="grid grid-cols-6 gap-1.5">
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cx(
              'min-h-11 min-w-0 truncate rounded-full border px-2 text-sm font-semibold transition-colors',
              i < 3 ? 'col-span-2' : 'col-span-3',
              active
                ? 'border-primary bg-primary text-on-primary'
                : 'border-line bg-surface text-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SaveFeedback({ ok }: { ok: boolean }) {
  const { t } = useI18n();
  if (!ok) return null;
  return (
    <span role="status" className="flex items-center gap-1 text-sm font-semibold text-success">
      <CheckIcon size={16} />
      {t.common.saved}
    </span>
  );
}

/** Flash a "saved" confirmation for a few seconds after a successful mutation. */
function useFlash(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const id = window.setTimeout(() => setOn(false), 3000);
    return () => window.clearTimeout(id);
  }, [on]);
  return [on, () => setOn(true)];
}

// ---------- settings: league, socials, reminders ----------

type SocialKey = keyof PublicConfig['socials'];
const SOCIAL_FIELDS: ReadonlyArray<{ key: SocialKey; label: keyof Messages['admin'] }> = [
  { key: 'spotifyUrl', label: 'spotifyUrl' },
  { key: 'appleUrl', label: 'appleUrl' },
  { key: 'instagramUrl', label: 'instagramUrl' },
  { key: 'xUrl', label: 'xUrl' },
  { key: 'whatsappUrl', label: 'whatsappUrl' },
];

/**
 * League, socials and reminders each save on their own: a card PUTs the server's current settings with only
 * its own fields replaced, and shows its own success / error. Unsaved edits in other cards are untouched.
 */
function SettingsSection() {
  const settings = useAdminSettings(true);
  if (settings.isPending) {
    return (
      <>
        <Skeleton className="h-40" />
        <Skeleton className="h-72" />
        <Skeleton className="h-40" />
      </>
    );
  }
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  return (
    <>
      <LeagueCard server={settings.data} />
      <SocialsCard server={settings.data} />
      <RemindersCard server={settings.data} />
    </>
  );
}

function SaveRow({ label, pending, flash }: { label: string; pending: boolean; flash: boolean }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <Button type="submit" disabled={pending}>
        {pending && <Spinner />}
        {label}
      </Button>
      <SaveFeedback ok={flash} />
    </div>
  );
}

function LeagueCard({ server }: { server: AdminSettings }) {
  const { t } = useI18n();
  const config = useConfig();
  const save = useSaveAdminSettings();
  const [flash, triggerFlash] = useFlash();
  const [value, setValue] = useState(server.leagueId === null ? '' : String(server.leagueId));
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    let leagueId: AdminSettings['leagueId'] = null;
    if (trimmed) {
      const parsed = FplLeagueIdSchema.safeParse(trimmed);
      if (!parsed.success || !/^\d+$/.test(trimmed)) {
        setError(t.admin.leagueIdInvalid);
        return;
      }
      leagueId = parsed.data;
    }
    setError(null);
    save.mutate({ ...server, leagueId }, { onSuccess: triggerFlash });
  }

  // Prefer the name the API resolved on save; fall back to the public config.
  const league =
    server.leagueId !== null
      ? { id: server.leagueId, name: server.leagueName ?? config.data?.league?.name ?? null }
      : null;
  return (
    <form onSubmit={submit} noValidate>
      <Collapsible
        id="settings.league"
        icon={<TableIcon width={18} height={18} />}
        title={t.admin.leagueSection}
        tone={league ? 'success' : 'warning'}
        summary={league ? fmt(t.adminUi.league, { id: league.id }) : t.adminUi.notSet}
        defaultOpen={!league}
        saveError={saveProblem(t, save)}
      >
        <TextField
          label={t.admin.leagueId}
          hint={t.admin.leagueHelp}
          inputMode="numeric"
          dir="ltr"
          value={value}
          error={error}
          onChange={(e) => {
            setValue(e.target.value.replace(/[^\d]/g, ''));
            setError(null);
          }}
        />
        <p className="text-sm text-muted">
          {league ? (
            <>
              {fmt(t.admin.leagueCurrent, { name: '' })}
              <bdi dir={league.name ? 'auto' : 'ltr'} className="font-semibold text-ink">
                {league.name ?? `#${league.id}`}
              </bdi>
            </>
          ) : (
            t.admin.leagueNone
          )}
        </p>
        {save.isError && (
          <InlineError>
            {errorMessage(t, save.error, {
              not_found: t.admin.leagueNotFound,
              bad_request: t.admin.leagueNotFound,
            })}
          </InlineError>
        )}
        <SaveRow label={t.admin.saveLeague} pending={save.isPending} flash={flash} />
      </Collapsible>
    </form>
  );
}

function SocialsCard({ server }: { server: AdminSettings }) {
  const { t } = useI18n();
  const save = useSaveAdminSettings();
  const [flash, triggerFlash] = useFlash();
  const [draft, setDraft] = useState<Record<SocialKey, string>>(() => ({
    spotifyUrl: server.socials.spotifyUrl ?? '',
    appleUrl: server.socials.appleUrl ?? '',
    instagramUrl: server.socials.instagramUrl ?? '',
    xUrl: server.socials.xUrl ?? '',
    whatsappUrl: server.socials.whatsappUrl ?? '',
  }));
  const [errors, setErrors] = useState<Partial<Record<SocialKey, string>>>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: Partial<Record<SocialKey, string>> = {};
    const socials = { ...server.socials };
    for (const { key } of SOCIAL_FIELDS) {
      const v = draft[key].trim();
      if (v === '') {
        socials[key] = null;
        continue;
      }
      // Same rule as the API (HttpsUrlSchema): https:// links only.
      const parsed = HttpsUrlSchema.safeParse(v);
      if (parsed.success) socials[key] = parsed.data;
      else next[key] = t.admin.urlInvalid;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate({ ...server, socials }, { onSuccess: triggerFlash });
  }

  const setCount = SOCIAL_FIELDS.filter(({ key }) => server.socials[key] !== null).length;
  return (
    <form onSubmit={submit} noValidate>
      <Collapsible
        id="settings.socials"
        icon={<GlobeIcon size={18} />}
        title={t.admin.socialsSection}
        tone={setCount > 0 ? 'success' : 'neutral'}
        summary={fmt(t.adminUi.links, { n: setCount, total: SOCIAL_FIELDS.length })}
        saveError={saveProblem(t, save)}
      >
        {SOCIAL_FIELDS.map(({ key, label }) => (
          <TextField
            key={key}
            label={t.admin[label]}
            type="url"
            inputMode="url"
            dir="ltr"
            placeholder="https://"
            value={draft[key]}
            error={errors[key]}
            onChange={(e) => {
              setDraft({ ...draft, [key]: e.target.value });
              setErrors({ ...errors, [key]: undefined });
            }}
          />
        ))}
        {save.isError && (
          <InlineError>{errorMessage(t, save.error, { bad_request: t.admin.urlInvalid })}</InlineError>
        )}
        <SaveRow label={t.admin.saveSocials} pending={save.isPending} flash={flash} />
      </Collapsible>
    </form>
  );
}

function RemindersCard({ server }: { server: AdminSettings }) {
  const { t } = useI18n();
  const save = useSaveAdminSettings();
  const [flash, triggerFlash] = useFlash();
  const [reminders, setReminders] = useState<number[]>(() => [...server.deadlineReminderMinutes]);
  const savedCount = server.deadlineReminderMinutes.length;
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = AdminSettingsSchema.shape.deadlineReminderMinutes.safeParse(reminders);
    if (!parsed.success) {
      setError(t.admin.reminderRange);
      return;
    }
    setError(null);
    save.mutate({ ...server, deadlineReminderMinutes: parsed.data }, { onSuccess: triggerFlash });
  }

  return (
    <form onSubmit={submit} noValidate>
      <Collapsible
        id="settings.reminders"
        icon={<ClockIcon width={18} height={18} />}
        title={t.admin.remindersSection}
        tone={savedCount > 0 ? 'success' : 'neutral'}
        summary={
          savedCount > 0 ? plural(savedCount, t.adminUi.reminderOne, t.adminUi.reminders) : t.adminUi.off
        }
        info={t.admin.remindersHelp}
        saveError={saveProblem(t, save)}
      >
        <RemindersEditor value={reminders} onChange={setReminders} error={error ?? undefined} />
        {save.isError && <InlineError>{errorMessage(t, save.error)}</InlineError>}
        <SaveRow label={t.admin.saveReminders} pending={save.isPending} flash={flash} />
      </Collapsible>
    </form>
  );
}

function reminderLabel(min: number, t: Messages): string {
  return min % 60 === 0
    ? fmt(t.admin.reminderHours, { n: min / 60 })
    : fmt(t.admin.reminderMinutes, { n: min });
}

function RemindersEditor({
  value,
  onChange,
  error,
}: {
  value: number[];
  onChange(v: number[]): void;
  error?: string | undefined;
}) {
  const { t } = useI18n();
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'minutes' | 'hours'>('hours');
  const [localError, setLocalError] = useState<string | null>(null);

  function add() {
    const n = Number(amount);
    const minutes = unit === 'hours' ? n * 60 : n;
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 4320) {
      setLocalError(t.admin.reminderRange);
      return;
    }
    if (value.length >= 5) {
      setLocalError(t.admin.reminderMax);
      return;
    }
    setLocalError(null);
    setAmount('');
    onChange([...new Set([...value, minutes])].sort((a, b) => b - a));
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-2">
        {value.map((m) => (
          <li key={m}>
            <span className="inline-flex min-h-9 items-center gap-1 rounded-full bg-primary-soft ps-3 pe-1 text-sm font-semibold text-on-primary-soft">
              {reminderLabel(m, t)}
              <button
                type="button"
                aria-label={`${t.common.remove} ${reminderLabel(m, t)}`}
                className="flex size-8 items-center justify-center rounded-full hover:bg-surface-3"
                onClick={() => onChange(value.filter((x) => x !== m))}
              >
                <CloseIcon size={14} />
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-end gap-2">
        <TextField
          label={t.admin.reminderValue}
          inputMode="numeric"
          dir="ltr"
          className="w-24"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
        />
        <div className="flex-1">
          <Segmented<'minutes' | 'hours'>
            label={t.admin.reminderValue}
            value={unit}
            onChange={setUnit}
            options={[
              { value: 'hours', label: t.admin.unitHours },
              { value: 'minutes', label: t.admin.unitMinutes },
            ]}
          />
        </div>
        <IconButton
          label={t.admin.addReminder}
          className="bg-primary text-on-primary hover:bg-primary"
          onClick={add}
        >
          <PlusIcon />
        </IconButton>
      </div>
      {(localError ?? error) && <InlineError>{localError ?? error}</InlineError>}
    </div>
  );
}

// ---------- captain battle editor ----------

// ---------- captain battle editor ----------

interface BattleRowDraft {
  uid: number;
  label: string;
  kind: 'community' | 'custom';
  source: 'player' | 'entry';
  playerId: FplPlayerId | null;
  /** Raw Team ID text for linked rows. */
  entryId: string;
}

let uidCounter = 0;
const nextUid = () => ++uidCounter;

/** The client's default battle (used to prefill the editor when nothing is configured yet). */
function defaultRows(t: Messages): BattleRowDraft[] {
  return [
    {
      uid: nextUid(),
      label: t.admin.defaultDor,
      kind: 'custom',
      source: 'entry',
      playerId: null,
      entryId: CLIENT_HOSTS.dor.fplEntryId,
    },
    {
      uid: nextUid(),
      label: t.admin.defaultItay,
      kind: 'custom',
      source: 'entry',
      playerId: null,
      entryId: CLIENT_HOSTS.itay.fplEntryId,
    },
    {
      uid: nextUid(),
      label: t.admin.defaultCommunity,
      kind: 'community',
      source: 'player',
      playerId: null,
      entryId: '',
    },
  ];
}

function toDraft(e: CaptainBattleEntryInput): BattleRowDraft {
  return e.source === 'player'
    ? { uid: nextUid(), label: e.label, kind: e.kind, source: 'player', playerId: e.playerId, entryId: '' }
    : {
        uid: nextUid(),
        label: e.label,
        kind: e.kind,
        source: 'entry',
        playerId: null,
        entryId: String(e.entryId),
      };
}

function CaptainBattleEditor() {
  const { t } = useI18n();
  const battle = useAdminCaptainBattle(true);
  const fpl = useFplIndex();
  if (battle.isPending || fpl.isPending) return <Skeleton className="h-64" />;
  if (battle.isError) return <ErrorState error={battle.error} onRetry={() => battle.refetch()} />;
  if (fpl.isError || !fpl.index) return <ErrorState error={fpl.error} onRetry={() => fpl.refetch()} />;
  const b = fpl.index.bootstrap;
  // Default GW: the one in progress (until it is finished), otherwise the next one.
  const currentInfo = b.events.find((e) => e.id === b.currentEvent);
  const defaultEvent =
    battle.data?.event ??
    (b.currentEvent !== null && currentInfo && !currentInfo.finished
      ? b.currentEvent
      : (b.nextEvent ?? b.currentEvent));
  return (
    <BattleForm
      index={fpl.index}
      initialEvent={defaultEvent}
      initialRows={battle.data ? battle.data.entries.map(toDraft) : defaultRows(t)}
      isDefault={!battle.data}
    />
  );
}

function BattleForm({
  index,
  initialEvent,
  initialRows,
  isDefault,
}: {
  index: FplIndex;
  initialEvent: Gameweek | null;
  initialRows: BattleRowDraft[];
  isDefault: boolean;
}) {
  const { t } = useI18n();
  const save = useSaveAdminCaptainBattle();
  const [flash, triggerFlash] = useFlash();
  const [event, setEvent] = useState(initialEvent === null ? '' : String(initialEvent));
  const [rows, setRows] = useState<BattleRowDraft[]>(initialRows);
  const [picking, setPicking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const update = (uid: number, patch: Partial<BattleRowDraft>) =>
    setRows((rs) => rs.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const next = [...rs];
      const a = next[i];
      const b = next[i + d];
      if (!a || !b) return rs;
      next[i] = b;
      next[i + d] = a;
      return next;
    });

  function submit(e: FormEvent) {
    e.preventDefault();
    const ev = GameweekSchema.safeParse(event);
    if (!ev.success) {
      setError(t.admin.battleEvent);
      return;
    }
    const parsed = CaptainBattleConfigSchema.safeParse({
      event: ev.data,
      entries: rows.map((r) =>
        r.source === 'player'
          ? { source: 'player', label: r.label, kind: r.kind, playerId: r.playerId ?? undefined }
          : {
              source: 'entry',
              label: r.label,
              kind: r.kind,
              entryId: /^\d+$/.test(r.entryId) ? r.entryId : undefined,
            },
      ),
    });
    if (!parsed.success) {
      setError(t.admin.battleInvalid);
      return;
    }
    setError(null);
    save.mutate(parsed.data, { onSuccess: triggerFlash });
  }

  return (
    <form onSubmit={submit} noValidate>
      <Collapsible
        id="settings.battle"
        icon={<ShirtIcon size={18} />}
        title={t.admin.battleSection}
        tone={isDefault ? 'warning' : 'success'}
        summary={
          isDefault || initialEvent === null
            ? t.adminUi.notSet
            : fmt(t.adminUi.battleGw, { gw: initialEvent })
        }
        defaultOpen={isDefault}
        saveError={saveProblem(t, save) ?? error}
      >
        {isDefault && (
          <p className="rounded-xl bg-accent px-3 py-2 text-sm text-on-accent">{t.admin.defaultsNote}</p>
        )}
        <TextField
          label={t.admin.battleEvent}
          inputMode="numeric"
          dir="ltr"
          className="w-28"
          value={event}
          onChange={(e) => setEvent(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
        />
        {rows.length === 0 && <p className="text-sm text-muted">{t.admin.battleEmpty}</p>}
        <ol className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <BattleRowEditor
              key={r.uid}
              row={r}
              position={i}
              count={rows.length}
              index={index}
              onChange={(patch) => update(r.uid, patch)}
              onMove={(d) => move(i, d)}
              onRemove={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
              onPick={() => setPicking(r.uid)}
            />
          ))}
        </ol>
        <Button
          variant="secondary"
          disabled={rows.length >= 20}
          onClick={() =>
            setRows((rs) => [
              ...rs,
              { uid: nextUid(), label: '', playerId: null, entryId: '', kind: 'custom', source: 'entry' },
            ])
          }
        >
          <PlusIcon size={18} />
          {t.admin.addCaptain}
        </Button>
        {error && <InlineError>{error}</InlineError>}
        {save.isError && (
          <InlineError>{errorMessage(t, save.error, { bad_request: t.admin.battleInvalid })}</InlineError>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {t.admin.saveBattle}
          </Button>
          <SaveFeedback ok={flash} />
        </div>
      </Collapsible>
      <PlayerPicker
        open={picking !== null}
        index={index}
        onClose={() => setPicking(null)}
        onPick={(id) => {
          if (picking !== null) update(picking, { playerId: id });
          setPicking(null);
        }}
      />
    </form>
  );
}

function BattleRowEditor({
  row: r,
  position: i,
  count,
  index,
  onChange,
  onMove,
  onRemove,
  onPick,
}: {
  row: BattleRowDraft;
  position: number;
  count: number;
  index: FplIndex;
  onChange(patch: Partial<BattleRowDraft>): void;
  onMove(d: -1 | 1): void;
  onRemove(): void;
  onPick(): void;
}) {
  const { t } = useI18n();
  const player = r.playerId ? index.players.get(r.playerId) : undefined;
  const team = player ? index.teams.get(player.teamId) : undefined;
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex items-center gap-1">
        <span className="me-1 text-sm font-bold text-muted tabular">{i + 1}</span>
        <input
          aria-label={t.admin.label}
          placeholder={t.admin.labelPlaceholder}
          maxLength={40}
          dir="auto"
          value={r.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-start text-base text-ink focus:border-primary focus:outline-none"
        />
        <IconButton label={t.admin.moveUp} disabled={i === 0} onClick={() => onMove(-1)}>
          <ArrowUpIcon size={18} />
        </IconButton>
        <IconButton label={t.admin.moveDown} disabled={i === count - 1} onClick={() => onMove(1)}>
          <ArrowDownIcon size={18} />
        </IconButton>
        <IconButton label={t.common.remove} className="text-live" onClick={onRemove}>
          <TrashIcon size={18} />
        </IconButton>
      </div>
      <Segmented<'entry' | 'player'>
        label={t.admin.rowSource}
        value={r.source}
        onChange={(source) => onChange({ source })}
        options={[
          { value: 'entry', label: t.admin.sourceEntry },
          { value: 'player', label: t.admin.sourcePlayer },
        ]}
      />
      {r.source === 'entry' ? (
        <LinkedEntryField value={r.entryId} onChange={(entryId) => onChange({ entryId })} />
      ) : (
        <button
          type="button"
          onClick={onPick}
          className={cx(
            'flex min-h-11 items-center gap-2 rounded-lg border bg-surface px-3 text-start',
            player ? 'border-line text-ink' : 'border-dashed border-primary text-primary',
          )}
        >
          <SearchIcon size={18} />
          <span dir="auto" className="name-start flex-1 truncate font-semibold">
            {player ? player.webName : t.admin.pickPlayer}
          </span>
          {player && (
            <span className="text-xs text-muted">
              {team?.shortName} · {t.positions[player.position]}
            </span>
          )}
        </button>
      )}
      <Segmented<'community' | 'custom'>
        label={t.admin.kind}
        value={r.kind}
        onChange={(kind) => onChange({ kind })}
        options={[
          { value: 'community', label: t.liveAction.kindCommunity },
          { value: 'custom', label: t.liveAction.kindCustom },
        ]}
      />
    </li>
  );
}

/** Team ID input with a live preview of the team (GET /v1/fpl/entries/:id). */
function LinkedEntryField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const { t } = useI18n();
  const parsed = FplEntryIdSchema.safeParse(/^\d+$/.test(value) ? value : undefined);
  const [debounced, setDebounced] = useState<FplEntryId | null>(parsed.success ? parsed.data : null);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(parsed.success ? parsed.data : null), 400);
    return () => window.clearTimeout(id);
  }, [parsed.success, parsed.data]);
  const entry = useEntry(debounced);
  return (
    <div className="flex flex-col gap-1">
      <TextField
        label={t.admin.entryIdLabel}
        hint={t.admin.entryHelp}
        inputMode="numeric"
        dir="ltr"
        placeholder="1234567"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 8))}
      />
      {debounced !== null && (
        <p className="flex min-w-0 items-center gap-1.5 text-sm" aria-live="polite">
          {entry.isPending ? (
            <span className="text-muted">{t.admin.entryChecking}</span>
          ) : entry.isError ? (
            <span className="text-live">
              {errorMessage(t, entry.error, { not_found: t.admin.entryNotFound })}
            </span>
          ) : (
            <>
              <CheckIcon size={16} className="shrink-0 text-success" />
              <bdi dir="auto" className="name-start truncate font-semibold text-ink">
                {entry.data.teamName}
              </bdi>
              <span className="shrink-0 text-muted">·</span>
              <bdi dir="auto" className="name-start truncate text-muted">
                {entry.data.managerName}
              </bdi>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function PlayerPicker({
  open,
  index,
  onClose,
  onPick,
}: {
  open: boolean;
  index: FplIndex;
  onClose(): void;
  onPick(id: FplPlayerId): void;
}) {
  const { t, f } = useI18n();
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const needle = normalize(q.trim());
    const all = index.bootstrap.players;
    const list = needle
      ? all.filter((p) => normalize(`${p.webName} ${p.firstName} ${p.secondName}`).includes(needle))
      : [...all].sort((a, b) => b.selectedByPercent - a.selectedByPercent);
    return list.slice(0, 40);
  }, [q, index]);

  return (
    <BottomSheet open={open} onClose={onClose} title={t.admin.pickPlayer}>
      <div className="sticky top-0 z-10 bg-surface pb-2">
        <TextField
          label={t.admin.searchPlayers}
          type="search"
          autoFocus
          dir="ltr"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {results.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t.admin.noPlayers}</p>
      ) : (
        <ul className="divide-y divide-line">
          {results.map((p) => {
            const team = index.teams.get(p.teamId);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p.id)}
                  className="flex min-h-14 w-full items-center gap-3 py-2 text-start hover:bg-surface-2"
                >
                  <ImageWithFallback
                    src={fplImage.photo(p.photoCode)}
                    name={p.webName}
                    className="h-11 w-9 shrink-0 rounded-md bg-surface-2 object-cover object-top"
                    fallbackClassName="size-9 text-xs"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto" className="name-start truncate font-semibold text-ink">
                      {p.webName}
                    </span>
                    <span className="truncate text-xs text-muted">
                      {p.firstName} {p.secondName}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <Badge>{team?.shortName ?? '?'}</Badge>
                    <span className="text-xs text-muted">
                      {t.positions[p.position]} · {f.price(p.nowCost)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </BottomSheet>
  );
}

// ---------- admin accounts ----------

function AdminsSection() {
  const { t } = useI18n();
  const admins = useAdmins(true);
  const create = useCreateAdmin();
  const [flash, triggerFlash] = useFlash();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateAdminBodySchema.safeParse({ name, username, password });
    if (!parsed.success) {
      const labels: Record<string, string> = {
        name: t.admin.adminName,
        username: t.admin.username,
        password: `${t.admin.password} (${t.admin.passwordHint})`,
      };
      const fields = [
        ...new Set(parsed.error.issues.map((i) => labels[String(i.path[0])] ?? String(i.path[0]))),
      ];
      setError(fmt(t.admin.validation, { msg: fields.join(', ') }));
      return;
    }
    setError(null);
    create.mutate(parsed.data, {
      onSuccess: () => {
        setName('');
        setUsername('');
        setPassword('');
        triggerFlash();
      },
    });
  }

  let list: ReactNode;
  if (admins.isPending) list = <Skeleton className="h-24" />;
  else if (admins.isError)
    list = null; // shown by the card header (also while collapsed)
  else
    list = (
      <ul className="divide-y divide-line rounded-xl border border-line">
        {admins.data.map((a) => (
          <li key={a.userId} className="flex min-h-12 items-center justify-between gap-2 px-3">
            <span dir="auto" className="name-start min-w-0 truncate font-semibold text-ink">
              {a.name}
            </span>
            {a.username !== null ? (
              <span dir="ltr" className="text-sm text-muted">
                @{a.username}
              </span>
            ) : (
              <Badge tone="neutral">{t.invites.viaInvite}</Badge>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <Collapsible
      id="settings.admins"
      icon={<ShieldIcon size={18} />}
      title={t.admin.adminsSection}
      tone={admins.isError ? 'live' : 'neutral'}
      summary={admins.data ? plural(admins.data.length, t.adminUi.adminOne, t.adminUi.admins) : undefined}
      error={loadProblem(t, admins)}
      saveError={saveProblem(t, create)}
    >
      {list}
      <details className="group border-t border-line pt-1">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold text-muted [&::-webkit-details-marker]:hidden">
          <span className="flex-1">{t.invites.passwordAdmins}</span>
          <ChevronDownIcon size={18} className="transition-transform group-open:rotate-180" />
        </summary>
        <form onSubmit={submit} className="flex flex-col gap-3 pt-3" noValidate>
          <MoreInfo>{t.invites.passwordAdminsHint}</MoreInfo>
          <TextField label={t.admin.adminName} value={name} onChange={(e) => setName(e.target.value)} />
          <TextField
            label={t.admin.username}
            dir="ltr"
            autoCapitalize="none"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <TextField
            label={t.admin.password}
            type="password"
            dir="ltr"
            autoComplete="new-password"
            hint={t.admin.passwordHint}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <InlineError>{error}</InlineError>}
          {create.isError && (
            <InlineError>
              {isApiError(create.error, 'conflict') ? t.admin.usernameTaken : errorMessage(t, create.error)}
            </InlineError>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" disabled={create.isPending}>
              {create.isPending && <Spinner />}
              {t.admin.createAdmin}
            </Button>
            {flash && (
              <span role="status" className="flex items-center gap-1 text-sm font-semibold text-success">
                <CheckIcon size={16} />
                {t.admin.adminCreated}
              </span>
            )}
          </div>
        </form>
      </details>
    </Collapsible>
  );
}
