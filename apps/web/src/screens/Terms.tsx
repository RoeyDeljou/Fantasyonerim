'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { CONTACT_EMAIL } from '@/lib/clientConfig';
import { openExternal } from '@/lib/external';
import { ROUTES, useSession } from '@/lib/session';
import { TopBar } from '@/components/AppShell';
import { ChevronStartIcon, GlobeIcon } from '@/components/icons';
import { Card, IconButton } from '@/components/ui';

/**
 * `/terms/` — community rules + a short privacy note. Public (no session needed: it is linked from onboarding)
 * and also the page App Store review asks for when an app has user-generated content.
 */
export function TermsScreen() {
  const { t, locale, setLocale } = useI18n();
  const tm = t.terms;
  const router = useRouter();
  const { status } = useSession();

  const back = () => {
    if (window.history.length > 1) router.back();
    else router.replace(status === 'signedIn' ? ROUTES.home : ROUTES.onboarding);
  };

  return (
    <div className="min-h-dvh">
      <TopBar
        title={tm.title}
        end={
          <>
            <IconButton
              label={locale === 'he' ? 'English' : 'עברית'}
              onClick={() => setLocale(locale === 'he' ? 'en' : 'he')}
              data-testid="terms-locale"
            >
              <GlobeIcon />
            </IconButton>
            <button
              type="button"
              onClick={back}
              className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-semibold text-primary hover:bg-surface-2"
            >
              <ChevronStartIcon width={18} height={18} />
              {t.common.back}
            </button>
          </>
        }
      />
      <main
        id="main"
        className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 pt-4 pb-[calc(2rem+env(safe-area-inset-bottom))]"
        data-testid="terms"
      >
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-extrabold text-ink">{tm.title}</h1>
          <p className="text-xs text-muted">{tm.updated}</p>
          <p className="pt-1 text-base leading-relaxed text-ink">{tm.intro}</p>
        </header>

        <Section title={tm.rulesTitle}>
          <ul className="flex list-disc flex-col gap-2 ps-5">
            {[tm.rule1, tm.rule2, tm.rule3, tm.rule4, tm.rule5].map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Section>

        <Section title={tm.modTitle}>
          <p>{tm.mod1}</p>
          <p>{tm.mod2}</p>
        </Section>

        <Section title={tm.privacyTitle}>
          <ul className="flex list-disc flex-col gap-2 ps-5">
            {[tm.priv1, tm.priv2, tm.priv3, tm.priv4, tm.priv5].map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Section>

        <Section title={tm.contactTitle}>
          <p>{tm.contactBody}</p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            onClick={(e) => {
              e.preventDefault();
              openExternal(`mailto:${CONTACT_EMAIL}`);
            }}
            className="inline-flex min-h-11 items-center self-start font-semibold text-primary underline-offset-2 hover:underline"
            data-testid="terms-email"
          >
            <bdi dir="ltr">{CONTACT_EMAIL}</bdi>
          </a>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-2 text-[15px] leading-relaxed text-ink">
      <h2 className="text-base font-bold">{title}</h2>
      {children}
    </Card>
  );
}

/** "By continuing you agree to the {community rules & privacy note}" — onboarding. */
export function TermsAgreeLine({ className }: { className?: string }) {
  const { t } = useI18n();
  const [before, after = ''] = t.terms.agreeLine.split('{link}');
  return (
    <p className={className ?? 'text-center text-xs leading-relaxed text-muted'} data-testid="terms-line">
      {before}
      <Link href="/terms/" className="py-3 font-semibold text-primary underline underline-offset-2">
        {t.terms.agreeLink}
      </Link>
      {after}
    </p>
  );
}
