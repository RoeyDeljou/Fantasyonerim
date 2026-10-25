'use client';

import type { ComponentType, ReactNode, SVGProps } from 'react';
import type { PublicConfig } from '@fant/shared';
import { useT } from '@/i18n';
import { useConfig } from '@/lib/queries';
import { AppShell } from '@/components/AppShell';
import { CameraIcon, ChatIcon, CommunityIcon, HeadphonesIcon, MicIcon, XLogoIcon } from '@/components/icons';
import { Badge } from '@/components/ui';

type SocialKey = keyof PublicConfig['socials'];

const SOCIALS: ReadonlyArray<{
  key: SocialKey;
  label: 'spotify' | 'apple' | 'instagram' | 'x' | 'whatsapp';
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}> = [
  { key: 'spotifyUrl', label: 'spotify', Icon: HeadphonesIcon },
  { key: 'appleUrl', label: 'apple', Icon: MicIcon },
  { key: 'instagramUrl', label: 'instagram', Icon: CameraIcon },
  { key: 'xUrl', label: 'x', Icon: XLogoIcon },
  { key: 'whatsappUrl', label: 'whatsapp', Icon: ChatIcon },
];

function Socials() {
  const t = useT();
  const config = useConfig();
  const links = SOCIALS.flatMap((s) => {
    const url = config.data?.socials[s.key];
    return url ? [{ ...s, url }] : [];
  });
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm font-semibold text-muted">{t.comingSoon.meanwhile}</p>
      <ul className="flex flex-wrap justify-center gap-2">
        {links.map(({ key, label, url, Icon }) => (
          <li key={key}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-2"
            >
              <Icon width={18} height={18} />
              {t.socials[label]}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Decorative brand illustration: a mic on mint with orbiting content bubbles. Colours from theme vars. */
function Illustration({ children }: { children: ReactNode }) {
  return (
    <div className="relative mx-auto flex size-48 items-center justify-center" aria-hidden="true">
      <div className="absolute inset-0 rounded-full bg-accent" />
      <div className="absolute inset-6 rounded-full border-2 border-dashed border-primary/30" />
      <span className="absolute top-3 start-6 size-6 rounded-full bg-primary/80" />
      <span className="absolute bottom-6 end-4 size-4 rounded-full bg-primary/50" />
      <span className="absolute top-10 end-2 h-3 w-8 rounded-full bg-surface" />
      <div className="relative flex size-24 items-center justify-center rounded-3xl bg-primary text-on-primary shadow-card">
        {children}
      </div>
    </div>
  );
}

function ComingSoon({ title, body, icon }: { title: string; body: string; icon: ReactNode }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-6 py-6 text-center">
      <Illustration>{icon}</Illustration>
      <Badge tone="accent" className="text-sm">
        {t.comingSoon.badge}
      </Badge>
      <h1 className="max-w-xs text-2xl font-extrabold text-ink">{title}</h1>
      <p className="max-w-sm text-base leading-relaxed text-muted">{body}</p>
      <Socials />
    </div>
  );
}

export function NewsScreen() {
  const t = useT();
  return (
    <AppShell title={t.tabs.news}>
      <ComingSoon
        title={t.comingSoon.newsTitle}
        body={t.comingSoon.newsBody}
        icon={<MicIcon width={48} height={48} />}
      />
    </AppShell>
  );
}

export function CommunityScreen() {
  const t = useT();
  return (
    <AppShell title={t.tabs.community}>
      <ComingSoon
        title={t.comingSoon.communityTitle}
        body={t.comingSoon.communityBody}
        icon={<CommunityIcon width={48} height={48} />}
      />
    </AppShell>
  );
}
