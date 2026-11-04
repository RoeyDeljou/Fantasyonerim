'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { ROUTES } from '@/lib/session';
import { BottomSheet } from './BottomSheet';
import { KeyIcon } from './icons';
import { Card } from './ui';

/** Onboarding straight at the sign-up form, prefilled with what the guest typed before (lib/guest.ts). */
export const SIGN_UP_HREF = `${ROUTES.onboarding}?signup=1`;

/** "You need an account for this" — what a guest sees instead of an account-only feature. */
export function SignUpPrompt({ title, body }: { title?: string; body?: string }) {
  const { t } = useI18n();
  return (
    <Card className="flex flex-col items-center gap-3 py-6 text-center" data-testid="signup-prompt">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary-soft text-on-primary-soft">
        <KeyIcon size={22} />
      </span>
      <h2 className="text-lg font-bold text-ink">{title ?? t.guest.promptTitle}</h2>
      <p className="max-w-xs text-sm leading-relaxed text-muted">{body ?? t.guest.promptBody}</p>
      <Link
        href={SIGN_UP_HREF}
        data-testid="signup-link"
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 text-sm font-bold text-on-primary"
      >
        {t.guest.signUp}
      </Link>
    </Card>
  );
}

/** For account-only taps (like, report…): `gate(fn)` runs `fn` for a member, or opens the sign-up sheet. */
export function useSignUpGate(guest: boolean): { gate(fn: () => void): () => void; sheet: ReactNode } {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return {
    gate: (fn) => () => (guest ? setOpen(true) : fn()),
    sheet: guest ? (
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t.guest.promptTitle}>
        <SignUpPrompt />
      </BottomSheet>
    ) : null,
  };
}
