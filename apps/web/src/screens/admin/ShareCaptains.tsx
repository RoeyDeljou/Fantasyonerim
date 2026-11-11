'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CaptainBattleRow } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { adminCaptainVote } from '@/i18n/sections/adminCaptainVote';
import { useSection } from '@/i18n/section';
import { captainBadge } from '@/lib/captains';
import { opponentText, opponentsOf } from '@/lib/captainVote';
import { useCaptainVote } from '@/lib/captainVoteApi';
import { effectiveShareMode, shareModeInfo, voteCaption } from '@/lib/shareMode';
import type { ShareMode } from '@/lib/shareMode';
import { IDLE_POLL_MS, useCaptainBattle, useFixtures } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import {
  SHARE_MAX_ROWS,
  captainVoteLink,
  proxiedPhotoUrls,
  renderShareImage,
  siteOrigin,
} from '@/lib/shareCaptains';
import type { ShareImageData, ShareImageRow } from '@/lib/shareCaptains';
import { initials } from '@/lib/text';
import { BottomSheet } from '@/components/BottomSheet';
import { CheckIcon, CopyIcon, DownloadIcon, ShareIcon, ShirtIcon } from '@/components/icons';
import { Button, EmptyState, ErrorState, InlineError, Skeleton, cx } from '@/components/ui';

/**
 * Admin → Captain Battle → "Share": previews the 1080×1350 picture of the saved selection (lib/shareCaptains.ts) and
 * shares it (system share sheet with the PNG), downloads it, or copies the link. A lazy chunk: the canvas code and the
 * QR library only load once an admin opens the sheet.
 */
export function ShareCaptainsSheet({
  open,
  onClose,
  index,
  startMode,
}: {
  open: boolean;
  onClose(): void;
  index: FplIndex;
  /** The mode the entry point wants (the vote card: 'vote'); without it the sheet picks by the vote's status. */
  startMode?: ShareMode;
}) {
  const s = useSection(adminCaptainVote);
  return (
    <BottomSheet open={open} onClose={onClose} title={s.shareSheetTitle}>
      <ShareBody index={index} startMode={startMode} />
    </BottomSheet>
  );
}

type Made = { url: string; blob: Blob } | { error: true } | null;

function ShareBody({ index, startMode }: { index: FplIndex; startMode: ShareMode | undefined }) {
  const s = useSection(adminCaptainVote);
  const { t, f, locale } = useI18n();
  const battle = useCaptainBattle(IDLE_POLL_MS);
  const event = battle.data?.event ?? null;
  const fixtures = useFixtures(event);
  const [made, setMade] = useState<Made>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const link = useMemo(() => captainVoteLink(siteOrigin()), []);
  const voteQuery = useCaptainVote().query;
  const voteState = voteQuery.data;
  const info = useMemo(() => shareModeInfo(voteState), [voteState]);
  const [picked, setPicked] = useState<ShareMode | null>(null);
  // Until the vote state is known, a sheet that was asked for the vote waits instead of flashing the battle.
  const modePending = voteQuery.isPending && picked === null && startMode === 'vote';
  const mode = effectiveShareMode(info, picked, startMode);

  // Rows of the picture: the saved selection, minus the viewer's own "mine" row.
  const battleData = useMemo<ShareImageData | null>(() => {
    if (mode !== 'battle' || !battle.data || event === null || fixtures.isPending) return null;
    const rows = battle.data.rows.filter((r) => r.kind !== 'mine').slice(0, SHARE_MAX_ROWS);
    if (rows.length === 0) return null;
    const shareRow = (r: CaptainBattleRow): ShareImageRow => {
      const player = r.playerId ? index.players.get(r.playerId) : undefined;
      const team = player ? index.teams.get(player.teamId) : undefined;
      const badge = captainBadge(r, {
        mine: t.liveAction.mine,
        community: t.liveAction.kindCommunity,
        linkedTeam: t.liveAction.linkedTeam,
      });
      return {
        label: r.label,
        name: player ? player.webName : null,
        initials: player ? initials(player.webName, { pairFromOneWord: true }) : '?',
        photos: player ? proxiedPhotoUrls(player.photoCode) : [],
        club: team?.shortName ?? null,
        opponent: player
          ? opponentText(
              opponentsOf(player.teamId, fixtures.data, event),
              (id) => index.teams.get(id)?.shortName ?? '?',
              { vs: s.imgVs, home: s.imgHome, away: s.imgAway, none: s.imgNoFixture },
            )
          : null,
        tag: badge.text,
        fplLad: badge.logo,
      };
    };
    return {
      rtl: locale === 'he',
      brand: t.app.name,
      title: s.imgTitle,
      gw: fmt(s.imgGw, { gw: f.num(event) }),
      revealText: s.imgReveal,
      ctaText: s.imgCta,
      shortUrl: link.short,
      deepLink: link.link,
      logoSrc: '/brand/logo-320.png',
      fplLadSrc: '/brand/fpl-lad.png',
      rows: rows.map(shareRow),
    };
  }, [mode, battle.data, event, fixtures.isPending, fixtures.data, index, locale, link, s, t, f]);

  // The vote invitation: the public vote state only, no captains.
  const voteEvent = voteState?.event ?? null;
  const voteWhen = useMemo(
    () =>
      voteState?.deadline
        ? {
            date: f.date(voteState.deadline),
            time: f.time(voteState.deadline),
          }
        : null,
    [voteState?.deadline, f],
  );
  const voteData = useMemo<ShareImageData | null>(() => {
    if (mode !== 'vote' || !voteState || voteEvent === null) return null;
    const voters = voteState.voters;
    return {
      rtl: locale === 'he',
      brand: t.app.name,
      title: s.imgVoteTitle,
      gw: fmt(s.imgVoteGw, { gw: f.num(voteEvent) }),
      revealText: '',
      ctaText: s.imgVoteCta,
      shortUrl: link.short,
      deepLink: link.link,
      logoSrc: '/brand/logo-320.png',
      fplLadSrc: '/brand/fpl-lad.png',
      rows: [],
      vote: {
        tagline: s.imgVoteTagline,
        deadline: voteWhen ? fmt(s.voteCloses, voteWhen) : null,
        voters:
          voters > 0 ? (voters === 1 ? s.voteVotersOne : fmt(s.voteVotersMany, { n: f.num(voters) })) : null,
      },
    };
  }, [mode, voteState, voteEvent, voteWhen, locale, link, s, t, f]);
  const data = mode === 'vote' ? voteData : battleData;

  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let url: string | null = null;
    setMade(null);
    renderShareImage(data).then(
      (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setMade({ url, blob });
      },
      () => {
        if (!cancelled) setMade({ error: true });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [data]);

  const gwForFile = mode === 'vote' ? voteEvent : event;
  const ready = made !== null && 'blob' in made ? made : null;
  const fileName =
    gwForFile === null
      ? 'captain.png'
      : fmt(mode === 'vote' ? s.voteFileName : s.shareFileName, { gw: gwForFile });
  const whenText = voteWhen ? fmt(s.voteWhen, voteWhen) : null;
  const shareTitle =
    mode === 'vote'
      ? fmt(s.voteShareTitle, { gw: f.num(voteEvent ?? 0) })
      : `${s.imgTitle} · ${data?.gw ?? ''}`;
  const caption =
    mode === 'vote'
      ? voteCaption(
          { withDeadline: s.voteCaptionWithDeadline, withoutDeadline: s.voteCaptionNoDeadline },
          voteEvent ?? 0,
          whenText,
        )
      : fmt(s.shareText, { title: `${s.imgTitle} · ${data?.gw ?? ''}`, cta: s.imgCta });

  async function share() {
    if (!ready) return;
    const file = new File([ready.blob], fileName, { type: 'image/png' });
    const payload: ShareData = { title: shareTitle, text: caption, url: link.link };
    try {
      if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
        await navigator.share({ ...payload, files: [file] });
      } else {
        await navigator.share(payload);
      }
      setNotice({ text: s.shareDone, ok: true });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setNotice({ text: s.shareFailed, ok: false });
    }
  }

  function download() {
    if (!ready) return;
    const a = document.createElement('a');
    a.href = ready.url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link.link);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = link.link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setNotice({ text: s.shareLinkCopied, ok: true });
  }

  let blocked: ReactNode = null;
  if (mode === 'battle') {
    if (battle.isError) blocked = <ErrorState error={battle.error} onRetry={() => void battle.refetch()} />;
    else if (!battle.isPending && (!data || event === null)) {
      blocked = <EmptyState icon={<ShirtIcon width={32} height={32} />} title={s.shareNoBattle} />;
    }
  }
  const showSkeleton = modePending || (mode === 'battle' && battle.isPending);

  return (
    <div className="flex flex-col gap-3 pb-2" data-testid="share-sheet" data-mode={mode}>
      <ModeTabs mode={mode} info={info} onPick={setPicked} />
      {blocked ? (
        blocked
      ) : showSkeleton ? (
        <Skeleton className="aspect-[1080/1350] w-full" />
      ) : (
        <>
          <div
            className="relative aspect-[1080/1350] w-full overflow-hidden rounded-2xl border border-line bg-surface-2"
            data-testid="share-preview"
            data-state={made === null ? 'making' : 'error' in made ? 'error' : 'ready'}
          >
            {ready ? (
              // The picture is a generated blob: next/image has nothing to optimize.
              <img
                src={ready.url}
                alt={s.sharePreviewAlt}
                width={1080}
                height={1350}
                className="size-full object-contain"
                data-testid="share-image"
              />
            ) : made !== null ? (
              <div className="flex size-full items-center justify-center p-4">
                <InlineError>{s.shareFailed}</InlineError>
              </div>
            ) : (
              <div className="flex size-full items-center justify-center" role="status">
                <Skeleton className="absolute inset-0 rounded-none" />
                <span className="relative text-sm font-semibold text-muted">{s.shareMaking}</span>
              </div>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted">
            {mode === 'vote'
              ? fmt(s.voteBasedOn, { gw: f.num(voteEvent ?? 0) })
              : fmt(s.shareBasedOn, { gw: f.num(event ?? 0) })}
          </p>
          <p
            className="rounded-xl bg-surface-2 px-3 py-2 text-sm leading-relaxed text-ink"
            data-testid="share-honest"
          >
            {s.shareHonest}
          </p>
          <p dir="ltr" className="truncate text-start text-xs text-muted" aria-label={s.shareLinkLabel}>
            {link.link}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {typeof navigator.share === 'function' && (
              <Button
                className="col-span-2"
                disabled={!ready}
                onClick={() => void share()}
                data-testid="share-native"
              >
                <ShareIcon size={18} />
                {s.shareAction}
              </Button>
            )}
            <Button variant="secondary" disabled={!ready} onClick={download} data-testid="share-download">
              <DownloadIcon size={18} />
              {s.shareDownload}
            </Button>
            <Button variant="secondary" onClick={() => void copyLink()} data-testid="share-copy">
              <CopyIcon size={18} />
              {s.shareCopyLink}
            </Button>
          </div>
        </>
      )}
      {notice && (
        <p
          role="status"
          className={cx(
            'flex items-center gap-1.5 text-sm font-semibold',
            notice.ok ? 'text-success' : 'text-live',
          )}
          data-testid="share-notice"
        >
          {notice.ok && <CheckIcon size={16} />}
          {notice.text}
        </p>
      )}
    </div>
  );
}

/** "Captain Battle" / "Vote": the vote tab is disabled, with a one-line reason, while the vote isn't open. */
function ModeTabs({
  mode,
  info,
  onPick,
}: {
  mode: ShareMode;
  info: ReturnType<typeof shareModeInfo>;
  onPick(m: ShareMode): void;
}) {
  const s = useSection(adminCaptainVote);
  const { f } = useI18n();
  const block = info.voteBlocked;
  let reason: string | null = null;
  if (block?.kind === 'not_open') reason = fmt(s.voteNotOpen, { gw: f.num(block.gw ?? 0) });
  else if (block?.kind === 'locked') reason = fmt(s.voteLocked, { gw: f.num(block.gw ?? 0) });
  else if (block?.kind === 'no_event') reason = s.voteNoEvent;
  else if (block?.kind === 'unavailable') reason = s.voteUnavailable;
  const tabs: ReadonlyArray<{ value: ShareMode; label: string; disabled: boolean }> = [
    { value: 'battle', label: s.modeBattle, disabled: false },
    { value: 'vote', label: s.modeVote, disabled: block !== null },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <div role="tablist" aria-label={s.modesLabel} className="flex gap-1 rounded-2xl bg-surface-2 p-1">
        {tabs.map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={mode === o.value}
            disabled={o.disabled}
            onClick={() => onPick(o.value)}
            data-testid={`share-mode-${o.value}`}
            className={cx(
              'min-h-11 min-w-0 flex-1 rounded-xl px-2 text-center text-sm leading-tight font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              mode === o.value ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {reason && (
        <p className="text-xs text-muted" data-testid="share-vote-reason">
          {reason}
        </p>
      )}
    </div>
  );
}
