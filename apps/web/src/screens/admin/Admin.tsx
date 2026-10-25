'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  AdminSettingsSchema,
  CaptainBattleConfigSchema,
  CreateAdminBodySchema,
  FplLeagueIdSchema,
} from '@fant/shared';
import type { AdminSettings, FplPlayerId, Gameweek, PublicConfig } from '@fant/shared';
import { GameweekSchema } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Messages } from '@/i18n';
import { isApiError } from '@/lib/api';
import {
  useAdminCaptainBattle,
  useAdminSettings,
  useAdmins,
  useConfig,
  useCreateAdmin,
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
  CloseIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from '@/components/icons';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  IconButton,
  InlineError,
  SectionTitle,
  Segmented,
  Skeleton,
  Spinner,
  TextField,
  cx,
  errorMessage,
} from '@/components/ui';
import { AdminFrame, AdminGuard } from './AdminShell';

export function AdminScreen() {
  const { t } = useI18n();
  return (
    <AdminFrame title={t.admin.title}>
      <AdminGuard>
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-extrabold text-ink">{t.admin.title}</h1>
          <SettingsSection />
          <CaptainBattleEditor />
          <AdminsSection />
        </div>
      </AdminGuard>
    </AdminFrame>
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

function isSocialKey(v: unknown): v is SocialKey {
  return SOCIAL_FIELDS.some((f) => f.key === v);
}

interface SettingsDraft {
  leagueId: string;
  reminders: number[];
  socials: Record<SocialKey, string>;
}

function toDraft(s: AdminSettings): SettingsDraft {
  return {
    leagueId: s.leagueId === null ? '' : String(s.leagueId),
    reminders: [...s.deadlineReminderMinutes],
    socials: {
      spotifyUrl: s.socials.spotifyUrl ?? '',
      appleUrl: s.socials.appleUrl ?? '',
      instagramUrl: s.socials.instagramUrl ?? '',
      xUrl: s.socials.xUrl ?? '',
      whatsappUrl: s.socials.whatsappUrl ?? '',
    },
  };
}

function SettingsSection() {
  const { t } = useI18n();
  const settings = useAdminSettings(true);
  if (settings.isPending) {
    return (
      <>
        <Skeleton className="h-40" />
        <Skeleton className="h-72" />
      </>
    );
  }
  if (settings.isError) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  // Not keyed on the data: a save updates the cache and must not remount (and reset) the form.
  return <SettingsForm initial={settings.data} t={t} />;
}

function SettingsForm({ initial, t }: { initial: AdminSettings; t: Messages }) {
  const config = useConfig();
  const save = useSaveAdminSettings();
  const [flash, triggerFlash] = useFlash();
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(initial));
  const [errors, setErrors] = useState<Partial<Record<'leagueId' | SocialKey | 'reminders', string>>>({});

  function submit(e: FormEvent) {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    const leagueTrim = draft.leagueId.trim();
    let leagueId: AdminSettings['leagueId'] = null;
    if (leagueTrim) {
      const parsed = FplLeagueIdSchema.safeParse(leagueTrim);
      if (parsed.success && /^\d+$/.test(leagueTrim)) leagueId = parsed.data;
      else nextErrors.leagueId = t.onboarding.teamIdInvalid;
    }
    const candidate = {
      leagueId,
      deadlineReminderMinutes: draft.reminders,
      socials: Object.fromEntries(
        SOCIAL_FIELDS.map(({ key }) => [
          key,
          draft.socials[key].trim() === '' ? null : draft.socials[key].trim(),
        ]),
      ),
    };
    const parsed = AdminSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const [first, second] = issue.path;
        if (first === 'socials' && isSocialKey(second)) nextErrors[second] = t.admin.urlInvalid;
        else if (first === 'deadlineReminderMinutes') nextErrors.reminders = t.admin.reminderRange;
        else if (first === 'leagueId') nextErrors.leagueId = t.onboarding.teamIdInvalid;
      }
    }
    setErrors(nextErrors);
    if (!parsed.success || Object.keys(nextErrors).length > 0) return;
    save.mutate(parsed.data, { onSuccess: triggerFlash });
  }

  const leagueName = config.data?.league?.name;
  const footer = (
    <div className="flex items-center gap-3 pt-1">
      <Button type="submit" disabled={save.isPending}>
        {save.isPending && <Spinner />}
        {t.admin.saveSettings}
      </Button>
      <SaveFeedback ok={flash} />
    </div>
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <Card className="flex flex-col gap-3">
        <SectionTitle>{t.admin.leagueSection}</SectionTitle>
        <TextField
          label={t.admin.leagueId}
          hint={t.admin.leagueHelp}
          inputMode="numeric"
          dir="ltr"
          value={draft.leagueId}
          error={errors.leagueId}
          onChange={(e) => setDraft({ ...draft, leagueId: e.target.value.replace(/[^\d]/g, '') })}
        />
        <p className="text-sm text-muted">
          {config.data?.league
            ? fmt(t.admin.leagueCurrent, { name: leagueName ?? `#${config.data.league.id}` })
            : t.admin.leagueNone}
        </p>
        {save.isError && <InlineError>{errorMessage(t, save.error)}</InlineError>}
        {footer}
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>{t.admin.socialsSection}</SectionTitle>
        {SOCIAL_FIELDS.map(({ key, label }) => (
          <TextField
            key={key}
            label={t.admin[label]}
            type="url"
            inputMode="url"
            dir="ltr"
            placeholder="https://"
            value={draft.socials[key]}
            error={errors[key]}
            onChange={(e) => setDraft({ ...draft, socials: { ...draft.socials, [key]: e.target.value } })}
          />
        ))}
        {footer}
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionTitle>{t.admin.remindersSection}</SectionTitle>
        <p className="text-sm text-muted">{t.admin.remindersHelp}</p>
        <RemindersEditor
          value={draft.reminders}
          onChange={(reminders) => setDraft({ ...draft, reminders })}
          error={errors.reminders}
        />
        {footer}
      </Card>
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

interface BattleRowDraft {
  uid: number;
  label: string;
  playerId: FplPlayerId | null;
  kind: 'community' | 'custom';
}

let uidCounter = 0;
const nextUid = () => ++uidCounter;

function CaptainBattleEditor() {
  const { t } = useI18n();
  const battle = useAdminCaptainBattle(true);
  const fpl = useFplIndex();
  if (battle.isPending || fpl.isPending) return <Skeleton className="h-64" />;
  if (battle.isError) return <ErrorState error={battle.error} onRetry={() => battle.refetch()} />;
  if (fpl.isError || !fpl.index) return <ErrorState error={fpl.error} onRetry={() => fpl.refetch()} />;
  const b = fpl.index.bootstrap;
  // Default: the GW in progress (until it is finished), otherwise the next one.
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
      initialRows={(battle.data?.entries ?? []).map((e) => ({ uid: nextUid(), ...e }))}
      t={t}
    />
  );
}

function BattleForm({
  index,
  initialEvent,
  initialRows,
  t,
}: {
  index: FplIndex;
  initialEvent: Gameweek | null;
  initialRows: BattleRowDraft[];
  t: Messages;
}) {
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
      const j = i + d;
      const a = next[i];
      const b = next[j];
      if (!a || !b) return rs;
      next[i] = b;
      next[j] = a;
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
      entries: rows.map((r) => ({ label: r.label, playerId: r.playerId ?? undefined, kind: r.kind })),
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
      <Card className="flex flex-col gap-3">
        <SectionTitle>{t.admin.battleSection}</SectionTitle>
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
          {rows.map((r, i) => {
            const player = r.playerId ? index.players.get(r.playerId) : undefined;
            const team = player ? index.teams.get(player.teamId) : undefined;
            return (
              <li key={r.uid} className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3">
                <div className="flex items-center gap-1">
                  <span className="me-1 text-sm font-bold text-muted tabular">{i + 1}</span>
                  <input
                    aria-label={t.admin.label}
                    placeholder={t.admin.labelPlaceholder}
                    maxLength={40}
                    value={r.label}
                    onChange={(e) => update(r.uid, { label: e.target.value })}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-base text-ink focus:border-primary focus:outline-none"
                  />
                  <IconButton label={t.admin.moveUp} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUpIcon size={18} />
                  </IconButton>
                  <IconButton
                    label={t.admin.moveDown}
                    disabled={i === rows.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDownIcon size={18} />
                  </IconButton>
                  <IconButton
                    label={t.common.remove}
                    className="text-live"
                    onClick={() => setRows((rs) => rs.filter((x) => x.uid !== r.uid))}
                  >
                    <TrashIcon size={18} />
                  </IconButton>
                </div>
                <button
                  type="button"
                  onClick={() => setPicking(r.uid)}
                  className={cx(
                    'flex min-h-11 items-center gap-2 rounded-lg border bg-surface px-3 text-start',
                    player ? 'border-line text-ink' : 'border-dashed border-primary text-primary',
                  )}
                >
                  <SearchIcon size={18} />
                  <span className="flex-1 truncate font-semibold">
                    {player ? player.webName : t.admin.pickPlayer}
                  </span>
                  {player && (
                    <span className="text-xs text-muted">
                      {team?.shortName} · {t.positions[player.position]}
                    </span>
                  )}
                </button>
                <Segmented<'community' | 'custom'>
                  label={t.admin.kind}
                  value={r.kind}
                  onChange={(kind) => update(r.uid, { kind })}
                  options={[
                    { value: 'community', label: t.liveAction.kindCommunity },
                    { value: 'custom', label: t.liveAction.kindCustom },
                  ]}
                />
              </li>
            );
          })}
        </ol>
        <Button
          variant="secondary"
          disabled={rows.length >= 20}
          onClick={() =>
            setRows((rs) => [...rs, { uid: nextUid(), label: '', playerId: null, kind: 'custom' }])
          }
        >
          <PlusIcon size={18} />
          {t.admin.addCaptain}
        </Button>
        {error && <InlineError>{error}</InlineError>}
        {save.isError && <InlineError>{errorMessage(t, save.error)}</InlineError>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Spinner />}
            {t.admin.saveBattle}
          </Button>
          <SaveFeedback ok={flash} />
        </div>
      </Card>
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
                    <span className="truncate font-semibold text-ink">{p.webName}</span>
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
  else if (admins.isError) list = <ErrorState error={admins.error} onRetry={() => admins.refetch()} />;
  else
    list = (
      <ul className="divide-y divide-line rounded-xl border border-line">
        {admins.data.map((a) => (
          <li key={a.userId} className="flex min-h-12 items-center justify-between gap-2 px-3">
            <span className="font-semibold text-ink">{a.name}</span>
            <span dir="ltr" className="text-sm text-muted">
              @{a.username}
            </span>
          </li>
        ))}
      </ul>
    );

  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle>{t.admin.adminsSection}</SectionTitle>
      {list}
      <form onSubmit={submit} className="flex flex-col gap-3 border-t border-line pt-3" noValidate>
        <h3 className="font-bold text-ink">{t.admin.createAdmin}</h3>
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
          <Button type="submit" disabled={create.isPending}>
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
    </Card>
  );
}
