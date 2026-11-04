'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { LeagueJoin } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { openExternal } from '@/lib/external';
import { flash } from '@/lib/flash';
import { useConfig, useLeaguePosition, useMe } from '@/lib/queries';
import { onResume } from '@/lib/resume';
import { useSession } from '@/lib/session';
import { CopyIcon, TableIcon } from './icons';
import { cx } from './ui';

/**
 * Who is asked to join the podcast's FPL league: guests, and signed-in fans whose team isn't in it
 * (`GET /v1/league/position` → `member: false`, with or without a Team ID). Never admins, never once the
 * league has no invite code (`config.leagueJoin` null). Coming back to the app (after joining in the FPL app)
 * re-checks membership, so the invitation goes away as soon as FPL counts the new entry.
 */
export function useJoinLeague(): LeagueJoin | null {
  const { status } = useSession();
  const config = useConfig();
  const join = config.data?.leagueJoin ?? null;
  const me = useMe(status === 'signedIn');
  const fan = status === 'signedIn' && me.data !== undefined && me.data.role !== 'admin';
  const position = useLeaguePosition(fan && join !== null);
  const { refetch } = position;
  const notMember = position.data?.member === false;

  useEffect(() => {
    if (!fan || !notMember) return;
    return onResume(() => void refetch());
  }, [fan, notMember, refetch]);

  if (!join) return null;
  if (status === 'guest') return join;
  return fan && notMember ? join : null;
}

/** The FPL invite link as a real link (long-press / new tab work); a tap goes through the app's external opener. */
export function JoinLink({
  join,
  className,
  children,
  ...data
}: {
  join: LeagueJoin;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <a
      href={join.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        openExternal(join.url);
      }}
      className={className}
      {...data}
    >
      {children}
    </a>
  );
}

/**
 * The constant "Join our league — code …" strip at the very top of every tab, inside the sticky header (so it pushes
 * content down and every sticky offset follows `--join-bar`, globals.css). Not dismissible, by design.
 */
export function JoinLeagueBar() {
  const { t } = useI18n();
  const join = useJoinLeague();
  const shown = join !== null;

  useEffect(() => {
    document.documentElement.toggleAttribute('data-join-bar', shown);
    return () => document.documentElement.removeAttribute('data-join-bar');
  }, [shown]);

  if (!join) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(join.code);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = join.code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    flash(t.join.copied);
  };

  return (
    <div className="bg-primary text-on-primary" data-testid="join-bar">
      <div className="mx-auto flex h-11 max-w-xl items-center gap-1 ps-2 pe-1">
        <JoinLink
          join={join}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-sm font-bold"
          data-testid="join-bar-link"
        >
          <TableIcon width={18} height={18} className="shrink-0" />
          <span className="truncate">{fmt(t.join.bar, { code: `⁦${join.code}⁩` })}</span>
        </JoinLink>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t.join.copyCode}
          title={t.join.copyCode}
          data-testid="join-copy"
          className={cx(
            'flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-on-primary/10',
          )}
        >
          <CopyIcon size={18} />
        </button>
      </div>
    </div>
  );
}
