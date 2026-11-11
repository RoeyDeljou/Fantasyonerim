'use client';

import { useEffect, useState } from 'react';
import type { AdminCommunityCaptain, FplPlayerId, Gameweek } from '@fant/shared';
import { GameweekSchema } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import type { Formatters } from '@/i18n';
import { adminCaptainVote } from '@/i18n/sections/adminCaptainVote';
import { useSection } from '@/i18n/section';
import { useAdminCaptainVote, useResolveCaptainVote } from '@/lib/captainVoteApi';
import { writeCardOpen } from '@/lib/localState';
import { useFplIndex } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { useQueryParam } from '@/lib/useQueryParam';
import { Collapsible, loadProblem } from '@/components/Collapsible';
import type { SummaryTone } from '@/components/Collapsible';
import { ImageWithFallback, fplImage } from '@/components/FplImages';
import {
  ShareIcon,
  ChevronEndIcon,
  ChevronStartIcon,
  ClockIcon,
  CrownIcon,
  SearchIcon,
} from '@/components/icons';
import { Badge, Button, IconButton, InlineError, Skeleton, Spinner, errorMessage, cx } from '@/components/ui';
import { PlayerPicker } from './PlayerPicker';
import { ShareCaptainsSheet } from './ShareSheetLazy';

/** "1 vote" / "5 votes". */
function votesText(n: number, s: Readonly<Record<'votesOne' | 'votesMany', string>>, f: Formatters): string {
  return n === 1 ? s.votesOne : fmt(s.votesMany, { n: f.num(n) });
}

/** The result that needs an admin: a tie, or nobody voted. */
function needsAdmin(d: AdminCommunityCaptain | undefined): boolean {
  return d?.status === 'locked' && (d.result?.status === 'tied' || d.result?.status === 'no_votes');
}

/**
 * Admin → Settings → "Community captain vote" (`/admin/?card=vote`, optionally `&event=N`): the vote of the next
 * gameweek — status, deadline, the live tally, the stored result and which community player the captain battle
 * currently has. A tie (or no votes) opens the card by itself and lets the admin pick the tie-breaker in one tap or
 * search any player; the same action works as a manual override afterwards. Strings: i18n/sections/adminCaptainVote.ts.
 */
export function CommunityCaptainCard() {
  const s = useSection(adminCaptainVote);
  const { t, f } = useI18n();
  const fpl = useFplIndex();
  const [cardParam] = useQueryParam('card');
  const [eventParam] = useQueryParam('event');
  // The GW being looked at: null = the one the server is running (the next deadline); the arrows pick another.
  const [viewEvent, setViewEvent] = useState<Gameweek | null>(() => {
    const p = GameweekSchema.safeParse(eventParam);
    return p.success ? p.data : null;
  });
  const query = useAdminCaptainVote(viewEvent);
  const data = query.data;
  const eventNow = data?.event ?? null;

  // Right after the deadline the "default" GW moves on, so the previous one is checked too: a tie there must not hide.
  const prevEvent =
    viewEvent === null && eventNow !== null && eventNow > 1 ? ((eventNow - 1) as Gameweek) : null;
  const prev = useAdminCaptainVote(prevEvent === null ? 'skip' : prevEvent);
  useEffect(() => {
    if (viewEvent === null && prevEvent !== null && needsAdmin(prev.data) && !needsAdmin(data))
      setViewEvent(prevEvent);
  }, [viewEvent, prevEvent, prev.data, data]);

  // `/admin/?card=vote`: open this card and bring it into view (same pattern as ?card=battle).
  useState(() => {
    if (cardParam === 'vote') writeCardOpen('settings.vote', true);
  });
  useEffect(() => {
    if (cardParam !== 'vote') return;
    document.querySelector('[data-card="settings.vote"]')?.scrollIntoView({ block: 'start' });
  }, [cardParam, data === undefined]);

  const attention = needsAdmin(data);
  const resolve = useResolveCaptainVote();
  const [picking, setPicking] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  let summary: string | undefined;
  let tone: SummaryTone = 'neutral';
  if (data) {
    if (data.result?.status === 'tied') [summary, tone] = [s.summaryTied, 'live'];
    else if (data.result?.status === 'no_votes') [summary, tone] = [s.summaryNoVotes, 'warning'];
    else if (data.result?.status === 'decided') [summary, tone] = [s.summaryDecided, 'success'];
    else if (data.status === 'open') [summary, tone] = [s.summaryOpen, 'primary'];
    else if (data.status === 'locked') [summary, tone] = [s.summaryLocked, 'neutral'];
    else [summary, tone] = [s.summaryNotOpen, 'neutral'];
  }

  const index = fpl.index;
  function pick(playerId: FplPlayerId) {
    if (eventNow === null) return;
    setDone(null);
    resolve.mutate(
      { event: eventNow, playerId },
      { onSuccess: () => setDone(fmt(s.resolved, { name: index?.players.get(playerId)?.webName ?? '' })) },
    );
  }

  const step = (d: -1 | 1) => {
    if (eventNow === null) return;
    const next = eventNow + d;
    if (next < 1 || next > 38) return;
    setViewEvent(next as Gameweek);
    setDone(null);
    resolve.reset();
  };

  return (
    <>
      <Collapsible
        id="settings.vote"
        icon={<CrownIcon size={18} />}
        title={s.title}
        tone={tone}
        summary={summary}
        defaultOpen={attention}
        error={loadProblem(t, query)}
        testId="admin-card"
        saveError={resolve.isError ? s.resolveFailed : null}
        alert={
          attention && (
            <p
              role="alert"
              className="rounded-xl bg-live-soft px-3 py-2 text-sm font-semibold text-live"
              data-testid="vote-banner"
            >
              {data?.result?.status === 'tied' ? s.bannerTied : s.bannerNoVotes}
            </p>
          )
        }
      >
        {query.isPending || fpl.isPending ? (
          <Skeleton className="h-40" />
        ) : data && index ? (
          <div
            className="flex flex-col gap-3"
            data-testid="vote-card"
            data-status={data.status}
            data-result={data.result?.status ?? ''}
          >
            <div className="flex items-center gap-1">
              <IconButton
                label={s.prevGw}
                disabled={eventNow === null || eventNow <= 1}
                onClick={() => step(-1)}
                data-testid="vote-prev"
              >
                <ChevronStartIcon size={18} />
              </IconButton>
              <p className="min-w-0 flex-1 text-center text-base font-bold text-ink" data-testid="vote-gw">
                {eventNow === null ? '—' : fmt(s.gw, { gw: f.num(eventNow) })}
              </p>
              <IconButton
                label={s.nextGw}
                disabled={eventNow === null || eventNow >= 38}
                onClick={() => step(1)}
                data-testid="vote-next"
              >
                <ChevronEndIcon size={18} />
              </IconButton>
            </div>
            <VoteSummary data={data} index={index} />
            <Tally data={data} index={index} onPick={pick} pending={resolve.isPending} />
            {resolve.isError && (
              <InlineError>{errorMessage(t, resolve.error, { bad_request: s.resolveFailed })}</InlineError>
            )}
            {done && (
              <p
                role="status"
                className="rounded-xl bg-success-soft px-3 py-2 text-sm font-semibold text-success"
                data-testid="vote-done"
              >
                {done}
              </p>
            )}
            {data.status === 'open' && (
              <Button variant="primary" onClick={() => setInviting(true)} data-testid="vote-invite">
                <ShareIcon size={18} />
                {s.shareVoteInvite}
              </Button>
            )}
            <Button
              variant={attention ? 'primary' : 'secondary'}
              disabled={eventNow === null || resolve.isPending}
              onClick={() => setPicking(true)}
              data-testid="vote-pick-hand"
            >
              {resolve.isPending ? <Spinner /> : <SearchIcon size={18} />}
              {data.result?.status === 'decided' || data.battlePlayerId !== null
                ? s.pickByHandOverride
                : s.pickByHand}
            </Button>
          </div>
        ) : null}
      </Collapsible>
      {index && (
        <ShareCaptainsSheet
          open={inviting}
          onClose={() => setInviting(false)}
          index={index}
          startMode="vote"
        />
      )}
      {index && (
        <PlayerPicker
          open={picking}
          index={index}
          onClose={() => setPicking(false)}
          onPick={(id) => {
            setPicking(false);
            pick(id);
          }}
        />
      )}
    </>
  );
}

function VoteSummary({ data, index }: { data: AdminCommunityCaptain; index: FplIndex }) {
  const s = useSection(adminCaptainVote);
  const { f } = useI18n();
  const name = (id: FplPlayerId | null) => (id === null ? '' : (index.players.get(id)?.webName ?? '?'));
  const r = data.result;
  const status =
    data.status === 'open' ? s.statusOpen : data.status === 'locked' ? s.statusLocked : s.statusNotOpen;
  let result: string;
  if (data.status !== 'locked' || r === null) result = s.resultNone;
  else if (r.status === 'pending') result = s.resultPending;
  else if (r.status === 'tied') result = s.resultTied;
  else if (r.status === 'no_votes') result = s.resultNoVotes;
  else
    result = fmt(r.source === 'admin' ? s.resultDecidedAdmin : s.resultDecidedVotes, {
      name: name(r.winnerPlayerId),
    });
  return (
    <dl className="grid gap-1.5 rounded-xl bg-surface-2 p-3 text-sm" data-testid="vote-summary">
      <div className="flex items-center gap-2">
        <Badge tone={data.status === 'open' ? 'primary' : 'neutral'}>{status}</Badge>
        {data.deadline && (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <ClockIcon size={14} className="shrink-0" />
            {fmt(s.deadline, { when: f.dateTime(data.deadline) })}
          </span>
        )}
      </div>
      <div className="font-semibold text-ink" data-testid="vote-total">
        {fmt(s.totalVotes, { n: f.num(data.totalVotes) })}
      </div>
      <div className="text-ink" data-testid="vote-result">
        <span className="font-semibold text-muted">{s.resultTitle}: </span>
        {result}
      </div>
      <div className="text-ink" data-testid="vote-battle">
        {data.battlePlayerId === null ? s.inBattleNone : fmt(s.inBattle, { name: name(data.battlePlayerId) })}
      </div>
    </dl>
  );
}

function Tally({
  data,
  index,
  onPick,
  pending,
}: {
  data: AdminCommunityCaptain;
  index: FplIndex;
  onPick(id: FplPlayerId): void;
  pending: boolean;
}) {
  const s = useSection(adminCaptainVote);
  const { f } = useI18n();
  if (data.tally.length === 0) {
    return <p className="text-sm text-muted">{s.noVotesYet}</p>;
  }
  const tied = new Set(data.result?.status === 'tied' ? data.result.tiedPlayerIds : []);
  const max = Math.max(1, ...data.tally.map((r) => r.votes));
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-bold text-muted">{data.status === 'open' ? s.tallyOpen : s.tallyFinal}</h3>
      <ol className="flex flex-col gap-1.5" data-testid="vote-tally">
        {data.tally.map((row) => {
          const p = index.players.get(row.playerId);
          const isTied = tied.has(row.playerId);
          return (
            <li
              key={row.playerId}
              data-player={row.playerId}
              data-tied={isTied ? 'true' : undefined}
              className={cx(
                'flex flex-col gap-1 rounded-xl border p-2',
                isTied ? 'border-live/40 bg-live-soft/40' : 'border-line',
              )}
            >
              <span className="flex items-center gap-2">
                <ImageWithFallback
                  src={p ? fplImage.photo(p.photoCode) : null}
                  name={p?.webName ?? '?'}
                  className="h-10 w-8 shrink-0 rounded bg-surface-2 object-cover object-top"
                  fallbackClassName="size-8 text-[10px]"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span dir="auto" className="name-start truncate text-sm font-semibold text-ink">
                    {p?.webName ?? '?'}
                  </span>
                  <span className="text-xs text-muted">
                    <bdi dir="ltr">{votesText(row.votes, s, f)}</bdi>
                    {isTied && <span className="font-semibold text-live"> · {s.tiedMark}</span>}
                  </span>
                </span>
                {isTied && (
                  <Button
                    className="min-h-11 shrink-0 px-3 text-sm"
                    disabled={pending}
                    onClick={() => onPick(row.playerId)}
                    data-testid="vote-pick"
                  >
                    {s.pickThis}
                  </Button>
                )}
              </span>
              <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(4, (row.votes / max) * 100)}%` }}
                />
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
