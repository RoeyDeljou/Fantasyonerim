'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { CommunityAuthor, UserId } from '@fant/shared';
import { useI18n } from '@/i18n';
import { initials } from '@/lib/text';
import { Logo } from '@/components/AppShell';
import { BanIcon } from '@/components/icons';
import { RelativeTime } from '@/components/news/parts';
import { Toast, cx } from '@/components/ui';

/** Initials avatar (grapheme-safe: emoji / Hebrew never split). Fantasyonerim admins get the logo. */
export function AuthorAvatar({ author, size = 40 }: { author: CommunityAuthor; size?: 32 | 40 }) {
  if (author.role === 'admin') {
    return (
      <span className="shrink-0 self-start">
        <Logo size={size} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex shrink-0 items-center self-start justify-center rounded-full bg-accent font-bold text-on-accent',
        size === 40 ? 'size-10 text-sm' : 'size-8 text-xs',
      )}
    >
      <bdi dir="auto">{initials(author.name) || '·'}</bdi>
    </span>
  );
}

export function AdminBadge() {
  const { t } = useI18n();
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full bg-primary px-1.5 py-px text-[10px] leading-4 font-bold text-on-primary"
      data-testid="admin-badge"
    >
      {t.community.adminBadge}
    </span>
  );
}

/** "Name [badge] · Team name · 5 min ago" — every user-supplied string isolated with dir="auto". */
export function AuthorLine({
  author,
  createdAt,
  compact = false,
}: {
  author: CommunityAuthor;
  createdAt: string;
  compact?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col leading-tight">
      <span className="flex min-w-0 items-center gap-1.5">
        <bdi
          dir="auto"
          className={cx('truncate font-bold text-ink', compact ? 'text-sm' : 'text-[15px]')}
          data-testid="author-name"
        >
          {author.name}
        </bdi>
        {author.role === 'admin' && <AdminBadge />}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
        {author.teamName && (
          <>
            <bdi dir="auto" className="min-w-0 truncate">
              {author.teamName}
            </bdi>
            <span aria-hidden="true">·</span>
          </>
        )}
        <RelativeTime iso={createdAt} className="shrink-0" />
      </span>
    </div>
  );
}

/** Banned users can still read: a permanent (non-dismissable) notice at the top of Community. */
export function BannedNotice() {
  const { t } = useI18n();
  return (
    <section
      role="status"
      data-testid="banned-notice"
      className="flex items-start gap-3 rounded-2xl border border-live/30 bg-live-soft p-4 text-live"
    >
      <BanIcon size={22} className="mt-0.5 shrink-0" />
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[15px] font-bold">{t.community.banned}</h2>
        <p className="text-sm text-ink">{t.community.bannedBody}</p>
      </div>
    </section>
  );
}

// ---------- one toast for the whole Community screen ----------

type Tone = 'neutral' | 'success' | 'error';
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => undefined);

export function CommunityToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: Tone; key: number } | null>(null);
  const notify = useCallback(
    (message: string, tone: Tone = 'success') => setToast({ message, tone, key: Date.now() }),
    [],
  );
  const done = useCallback(() => setToast(null), []);
  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toast
        key={toast?.key}
        message={toast?.message ?? null}
        tone={toast?.tone ?? 'success'}
        onDone={done}
      />
    </ToastContext.Provider>
  );
}

export function useNotify() {
  return useContext(ToastContext);
}

/** "Block user" applies to other fans only — never yourself, never an admin (the API answers 400). */
export function canBlock(author: CommunityAuthor, mine: boolean, meId: UserId | undefined): boolean {
  return !mine && author.role !== 'admin' && meId !== undefined && author.id !== meId;
}
