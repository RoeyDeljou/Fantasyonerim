'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useI18n } from '@/i18n';
import { isEmailTaken } from '@/lib/api';
import { useUpdateMe } from '@/lib/queries';
import { EmailField, parseEmail } from './EmailField';
import { MailIcon } from './icons';
import { Button, InlineError, Spinner, errorMessage } from './ui';

/**
 * The one-time "add your email" pop-up for accounts made before email was required (see EmailPromptGate in
 * app/providers.tsx). Blocking on purpose: no close button, Esc and the backdrop do nothing. Saving updates the
 * `me` cache (useUpdateMe), which closes it.
 */
export function EmailPrompt({ open }: { open: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const update = useUpdateMe();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const mail = parseEmail(email);
    if (!mail) {
      setError(t.onboarding.emailInvalid);
      return;
    }
    update.mutate(
      { email: mail },
      {
        onError: (err) => {
          if (isEmailTaken(err)) setError(t.onboarding.emailTaken);
        },
      },
    );
  }

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="email-prompt-title"
      data-testid="email-prompt"
      onCancel={(e) => e.preventDefault()}
      // Chrome may still close it on Esc without a prior user gesture (close watchers): put it straight back.
      onClose={() => {
        if (openRef.current) ref.current?.showModal();
      }}
    >
      {open && (
        <form
          onSubmit={submit}
          noValidate
          className="flex max-h-[88dvh] flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-on-primary-soft">
              <MailIcon size={22} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id="email-prompt-title" className="text-lg font-bold text-ink">
                {t.emailPrompt.title}
              </h2>
              <p className="text-sm leading-relaxed text-muted">{t.emailPrompt.body}</p>
            </div>
          </div>
          <EmailField
            label={t.onboarding.emailLabel}
            value={email}
            error={error}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
          {update.isError && !error && <InlineError>{errorMessage(t, update.error)}</InlineError>}
          <Button
            type="submit"
            block
            className="min-h-12"
            disabled={update.isPending}
            data-testid="email-prompt-save"
          >
            {update.isPending && <Spinner />}
            {t.emailPrompt.save}
          </Button>
        </form>
      )}
    </dialog>
  );
}
