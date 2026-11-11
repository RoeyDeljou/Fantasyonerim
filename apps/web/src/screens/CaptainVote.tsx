'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { CommunityCaptainResult, CommunityCaptainState, FplPlayerId, Player } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Formatters } from '@/i18n';
import { captainVote } from '@/i18n/sections/captainVote';
import { useSection } from '@/i18n/section';
import { isApiError } from '@/lib/api';
import { useBanned } from '@/lib/banned';
import { useIsGuest } from '@/lib/guest';
import { CAPTAIN_VOTE_SCOPE, useCaptainVote, useSaveCaptainVote } from '@/lib/captainVoteApi';
import { opponentText, opponentsOf, timeLeft, voteMode } from '@/lib/captainVote';
import { useFixtures, useFplIndex } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { useRefresh } from '@/lib/refresh';
import { PullToRefresh, RefreshDone } from '@/components/RefreshControl';
import { SignUpPrompt } from '@/components/SignUpPrompt';
import { ImageWithFallback, fplImage } from '@/components/FplImages';
import { BannedNotice } from '@/components/community/parts';
import { PlayerCombobox } from '@/components/captainVote/PlayerCombobox';
import { PickCard } from '@/components/captainVote/PickCard';
import { CheckIcon, ClockIcon, CrownIcon, RefreshIcon, ShieldIcon } from '@/components/icons';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  InlineError,
  Skeleton,
  Spinner,
  errorMessage,
  cx,
} from '@/components/ui';

/**
 * Community → "My Community Captain" (`/community/?view=captain`): fans pick the community captain of the next
 * gameweek. A lazy chunk of its own (components of the feed never load it) with its own lazy strings
 * (i18n/sections/captainVote.ts). The server is the authority on every rule — window, lock, tally; this screen only
 * renders `CommunityCaptainState` and sends the vote (the mode logic is lib/captainVote.ts `voteMode`).
 */
export function CaptainVoteView({ active }: { active: boolean }) {
  // Mounted (and its chunk fetched) from the feed already; it only renders — and only fetches data — when selected.
  return active ? <CaptainVote /> : null;
}

const REFRESH_SCOPE = [...CAPTAIN_VOTE_SCOPE, ['fpl', 'fixtures']] as const;

/** `Date.now()` re-read every `ms` while the tab is visible. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ms]);
  return now;
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

function CaptainVote() {
  const s = useSection(captainVote);
  const { t, f } = useI18n();
  const guest = useIsGuest();
  const banned = useBanned();
  const fpl = useFplIndex();
  const { query, viewer } = useCaptainVote();
  const state = query.data;
  const event = state?.event ?? null;
  const fixtures = useFixtures(event);
  const refresh = useRefresh(REFRESH_SCOPE);
  const save = useSaveCaptainVote(viewer);
  const now = useNow(30_000);
  const online = useOnline();
  const [draft, setDraft] = useState<FplPlayerId | null>(null);
  const [changing, setChanging] = useState(false);

  // The deadline passes while the screen is open: ask the server (it is the authority) instead of guessing.
  const deadline = state?.deadline ?? null;
  const status = state?.status;
  const { refetch } = query;
  useEffect(() => {
    if (status !== 'open' || deadline === null) return;
    const ms = Date.parse(deadline) - Date.now();
    if (ms > 2 ** 31 - 1) return;
    const id = window.setTimeout(() => void refetch(), Math.max(ms, 0) + 1_500);
    return () => window.clearTimeout(id);
  }, [status, deadline, refetch]);

  // A new gameweek (or a locked vote) invalidates whatever was being edited.
  useEffect(() => {
    setDraft(null);
    setChanging(false);
  }, [event, status]);

  const describe = useDescribe(fpl.index, fixtures);

  if (query.isPending || fpl.isPending || viewer === null) return <VoteSkeleton />;
  if (!state) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!fpl.index) return <ErrorState error={fpl.error} onRetry={() => void fpl.refetch()} />;
  const index = fpl.index;

  const mode = voteMode({ state, guest, banned, draft, changing });
  const playerOf = (id: FplPlayerId | null): Player | undefined =>
    id === null ? undefined : index.players.get(id);
  const mine = playerOf(state.myPick);
  const chosen = playerOf(draft);

  function confirm() {
    if (state === undefined || state.event === null || draft === null) return;
    save.mutate(
      { event: state.event, playerId: draft },
      {
        onSuccess: () => {
          setDraft(null);
          setChanging(false);
        },
      },
    );
  }
  const startOver = () => {
    save.reset();
    setDraft(null);
    setChanging(true);
  };

  let body: ReactNode;
  switch (mode) {
    case 'no_event':
      body = (
        <EmptyState icon={<CrownIcon width={32} height={32} />} title={s.noEventTitle} body={s.noEventBody} />
      );
      break;
    case 'not_open':
      body = <NotOpen state={state} />;
      break;
    case 'locked':
      body = (
        <>
          <p className="text-sm text-muted" data-testid="cv-locked">
            <strong className="text-ink">{s.lockedTitle}.</strong>{' '}
            {fmt(s.lockedBody, { gw: state.event ?? '' })}
          </p>
          {mine ? (
            <PickCard
              player={mine}
              team={index.teams.get(mine.teamId)}
              opponent={describe(mine).opponent}
              confirmed
              label={s.youVoted}
            />
          ) : (
            <p
              className="rounded-2xl border border-dashed border-line px-4 py-4 text-center text-sm text-muted"
              data-testid="cv-no-pick"
            >
              {s.noPick}
            </p>
          )}
          <ResultCard result={state.result} index={index} gw={state.event} />
          {state.event !== null && state.event < 38 && (
            <p className="text-center text-sm text-muted" data-testid="cv-next-opens">
              {fmt(s.nextOpens, { next: f.num(state.event + 1), gw: f.num(state.event) })}
            </p>
          )}
        </>
      );
      break;
    case 'guest':
      body = <SignUpPrompt />;
      break;
    case 'banned':
      body = (
        <>
          <BannedNotice />
          {mine && (
            <PickCard
              player={mine}
              team={index.teams.get(mine.teamId)}
              opponent={describe(mine).opponent}
              confirmed
              note={s.banned}
            />
          )}
        </>
      );
      break;
    case 'draft':
      body = chosen ? (
        <PickCard
          player={chosen}
          team={index.teams.get(chosen.teamId)}
          opponent={describe(chosen).opponent}
          confirmed={false}
          note={s.draftNote}
        >
          {save.isError && (
            <InlineError>
              {isApiError(save.error, 'conflict') || isApiError(save.error, 'bad_request')
                ? s.voteFailed
                : errorMessage(t, save.error)}
            </InlineError>
          )}
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={save.isPending || !online}
              onClick={confirm}
              aria-busy={save.isPending}
              data-testid="cv-confirm"
            >
              {save.isPending ? <Spinner /> : <CheckIcon size={18} />}
              {save.isPending ? s.saving : s.confirm}
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              disabled={save.isPending}
              onClick={startOver}
              data-testid="cv-change"
            >
              {s.changePick}
            </Button>
          </div>
          {!online && <OfflineNote />}
        </PickCard>
      ) : null;
      break;
    case 'confirmed':
      body = mine ? (
        <PickCard
          player={mine}
          team={index.teams.get(mine.teamId)}
          opponent={describe(mine).opponent}
          confirmed
          note={s.confirmedNote}
        >
          <Button variant="secondary" block onClick={startOver} data-testid="cv-change">
            {s.changePick}
          </Button>
        </PickCard>
      ) : null;
      break;
    case 'search':
      body = (
        <Card className="p-4">
          <PlayerCombobox
            index={index}
            describe={describe}
            autoFocus={changing}
            event={state.event ?? 0}
            onPick={(p) => {
              save.reset();
              setDraft(p.id);
            }}
            onCancel={state.myPick !== null ? () => setChanging(false) : undefined}
          />
        </Card>
      );
      break;
  }

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="captain-vote"
      data-mode={mode}
      data-status={state.status}
    >
      <PullToRefresh refreshing={refresh.refreshing} onRefresh={() => void refresh.refresh()} />
      <RefreshDone state={refresh.state} />
      {mode !== 'no_event' && (
        <StateHeader
          state={state}
          now={now}
          refreshing={refresh.refreshing}
          onRefresh={() => void refresh.refresh()}
        />
      )}
      {body}
    </div>
  );
}

/** "1 hour" / "5 hours" (the singular has no number in it). */
function count(n: number, one: string, many: string, f: Formatters): string {
  return n === 1 ? one : fmt(many, { n: f.num(n) });
}

function OfflineNote() {
  const { t } = useI18n();
  return (
    <p role="status" className="text-sm font-medium text-live" data-testid="cv-offline">
      {t.errors.network}
    </p>
  );
}

/** "מול ARS (בית)" for a player, from the target gameweek's fixtures. */
function useDescribe(index: FplIndex | undefined, fixtures: ReturnType<typeof useFixtures>) {
  const s = useSection(captainVote);
  const { t } = useI18n();
  const fx = fixtures.data;
  const failed = fixtures.isError;
  return useCallback(
    (p: Player) => {
      const team = index?.teams.get(p.teamId);
      const name = (id: number) => index?.teams.get(id as Player['teamId'])?.shortName ?? '?';
      const opponent =
        fx === undefined
          ? failed
            ? '—'
            : '…'
          : opponentText(opponentsOf(p.teamId, fx), name, {
              vs: s.vs,
              home: s.home,
              away: s.away,
              none: s.noFixture,
            });
      return { club: team?.shortName ?? '?', position: t.positions[p.position], opponent };
    },
    [index, fx, failed, s, t],
  );
}

// ---------- state header ----------

function StateHeader({
  state,
  now,
  refreshing,
  onRefresh,
}: {
  state: CommunityCaptainState;
  now: number;
  refreshing: boolean;
  onRefresh(): void;
}) {
  const s = useSection(captainVote);
  const { f, t } = useI18n();
  const left = state.status === 'open' && state.deadline ? timeLeft(state.deadline, now) : null;
  const leftText = left
    ? fmt(s.left, {
        time:
          left.unit === 'days'
            ? count(left.n, s.dayOne, s.dayMany, f)
            : left.unit === 'hours'
              ? count(left.n, s.hourOne, s.hourMany, f)
              : count(left.n, s.minOne, s.minMany, f),
      })
    : null;
  const voters = state.voters === 0 ? s.votersNone : count(state.voters, s.votersOne, s.votersMany, f);
  return (
    <header className="flex items-start gap-2" data-testid="cv-header">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 className="text-xl font-extrabold text-ink">{fmt(s.heading, { gw: f.num(state.event ?? 0) })}</h1>
        {state.deadline && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="inline-flex items-center gap-1.5" data-testid="cv-deadline">
              <ClockIcon size={16} className="shrink-0" />
              {fmt(s.deadline, { when: f.dateTime(state.deadline) })}
            </span>
            {leftText && (
              <Badge tone="primary" className="px-2.5 py-1">
                <span data-testid="cv-left">{leftText}</span>
              </Badge>
            )}
          </p>
        )}
        {state.status !== 'not_open' && (
          <p className="text-sm font-semibold text-ink" data-testid="cv-voters">
            {voters}
          </p>
        )}
      </div>
      <IconButton
        label={t.refresh.button}
        onClick={onRefresh}
        aria-busy={refreshing}
        data-testid="cv-refresh"
      >
        <RefreshIcon size={20} className={cx(refreshing && 'animate-spin')} />
      </IconButton>
    </header>
  );
}

function NotOpen({ state }: { state: CommunityCaptainState }) {
  const s = useSection(captainVote);
  const { f } = useI18n();
  return (
    <Card className="flex flex-col items-center gap-3 py-6 text-center" data-testid="cv-not-open">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary-soft text-on-primary-soft">
        <ClockIcon size={22} />
      </span>
      <h2 className="text-lg font-bold text-ink">{s.notOpenTitle}</h2>
      <p className="max-w-xs text-sm leading-relaxed text-muted">
        {fmt(s.notOpenBody, { gw: f.num(state.event ?? 0), prev: f.num(state.opensAfterEvent ?? 0) })}
        {state.deadline && ` ${fmt(s.notOpenDeadline, { when: f.dateTime(state.deadline) })}`}
      </p>
    </Card>
  );
}

// ---------- the result of a locked vote ----------

function ResultCard({
  result,
  index,
  gw,
}: {
  result: CommunityCaptainResult | null;
  index: FplIndex;
  gw: number | null;
}) {
  const s = useSection(captainVote);
  const { f } = useI18n();
  if (result === null || result.status === 'pending') {
    return (
      <Card className="flex items-center gap-3" data-testid="cv-result" data-result="pending">
        <Spinner className="shrink-0 text-primary" />
        <div role="status">
          <h2 className="text-base font-bold text-ink">{s.resultPendingTitle}</h2>
          <p className="text-sm text-muted">{s.resultPendingBody}</p>
        </div>
      </Card>
    );
  }
  const winner = result.winnerPlayerId ? index.players.get(result.winnerPlayerId) : undefined;
  const topList = result.top.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-bold text-muted">{s.topVotes}</h3>
      <ol className="flex flex-col gap-1.5" data-testid="cv-top">
        {result.top.map((row) => {
          const p = index.players.get(row.playerId);
          const share = result.totalVotes > 0 ? (row.votes / result.totalVotes) * 100 : 0;
          return (
            <li key={row.playerId} className="flex flex-col gap-1" data-player={row.playerId}>
              <span className="flex items-center gap-2">
                <ImageWithFallback
                  src={p ? fplImage.photo(p.photoCode) : null}
                  name={p?.webName ?? '?'}
                  className="h-8 w-6 shrink-0 rounded bg-surface-2 object-cover object-top"
                  fallbackClassName="size-7 text-[10px]"
                />
                <span
                  dir="auto"
                  className="name-start min-w-0 flex-1 truncate text-sm font-semibold text-ink"
                >
                  {p?.webName ?? '?'}
                </span>
                <span className="text-sm text-muted">
                  <bdi dir="ltr">{count(row.votes, s.votesOne, s.votesMany, f)}</bdi>
                </span>
              </span>
              <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(share, 3)}%` }}
                />
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">{fmt(s.totalVotes, { n: f.num(result.totalVotes) })}</p>
    </div>
  );

  if (result.status === 'decided') {
    return (
      <Card className="flex flex-col gap-4 border-primary" data-testid="cv-result" data-result="decided">
        <div className="flex items-center gap-4">
          <ImageWithFallback
            src={winner ? fplImage.photo(winner.photoCode) : null}
            name={winner?.webName ?? '?'}
            className="h-20 w-16 shrink-0 rounded-xl bg-surface-2 object-cover object-top"
            fallbackClassName="size-16 text-lg"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-muted">
              <CrownIcon size={16} className="shrink-0 text-primary" />
              {fmt(s.resultDecidedTitle, { gw: f.num(gw ?? 0) })}
            </h2>
            <p
              dir="auto"
              className="name-start truncate text-2xl leading-tight font-extrabold text-ink"
              data-testid="cv-winner"
            >
              {winner?.webName ?? '?'}
            </p>
            <span
              className="flex items-center gap-1.5 text-sm text-muted"
              data-testid="cv-source"
              data-source={result.source ?? ''}
            >
              {result.source === 'admin' && <ShieldIcon size={14} className="shrink-0" />}
              {result.source === 'admin' ? s.sourceAdmin : s.sourceVotes}
            </span>
          </div>
        </div>
        {topList}
      </Card>
    );
  }
  if (result.status === 'tied') {
    return (
      <Card className="flex flex-col gap-3" data-testid="cv-result" data-result="tied">
        <div role="status" className="flex flex-col gap-0.5">
          <h2 className="text-base font-bold text-ink">{s.resultTiedTitle}</h2>
          <p className="text-sm text-muted">{s.resultTiedBody}</p>
        </div>
        {topList}
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-0.5" data-testid="cv-result" data-result="no_votes">
      <h2 className="text-base font-bold text-ink">{s.resultNoVotesTitle}</h2>
      <p className="text-sm text-muted">{s.resultNoVotesBody}</p>
    </Card>
  );
}

function VoteSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-busy="true" data-testid="cv-skeleton">
      <Skeleton className="h-16" />
      <Skeleton className="h-40 rounded-3xl" />
    </div>
  );
}
