'use client';

import type { NewsFilter, NewsSource } from '@fant/shared';
import type { Messages } from '@/i18n';
import { CameraIcon, MegaphoneIcon, MicIcon, XBrandIcon, YouTubeIcon } from '@/components/icons';
import { cx } from '@/components/ui';

/** The colour family of a source (theme.css `--src-*`, styled by `.src-badge` / `.src-label` in globals.css). */
export type SourceKind = 'podcast' | 'youtube' | 'instagram' | 'x' | 'admin';

const KIND: Record<NewsSource, SourceKind> = {
  podcast: 'podcast',
  youtube_short: 'youtube',
  youtube_video: 'youtube',
  instagram_post: 'instagram',
  instagram_story: 'instagram',
  x_post: 'x',
  admin_update: 'admin',
};

const FILTER_KIND: Record<NewsFilter, SourceKind> = {
  episodes: 'podcast',
  shorts: 'youtube',
  videos: 'youtube',
  instagram: 'instagram',
  x: 'x',
  updates: 'admin',
};

export const sourceKind = (s: NewsSource): SourceKind => KIND[s];
export const filterKind = (f: NewsFilter): SourceKind => FILTER_KIND[f];

export function sourceLabel(t: Messages, s: NewsSource): string {
  return {
    podcast: t.news.sourcePodcast,
    instagram_post: t.news.sourceInstagram,
    instagram_story: t.news.sourceInstagram,
    x_post: t.news.sourceX,
    admin_update: t.news.sourceAdmin,
    youtube_short: t.news.sourceYoutube,
    youtube_video: t.news.sourceYoutube,
  }[s];
}

function Glyph({ kind, size }: { kind: SourceKind; size: number }) {
  switch (kind) {
    case 'podcast':
      return <MicIcon size={size} strokeWidth={2.4} />;
    case 'youtube':
      return <YouTubeIcon size={size} strokeWidth={2.4} />;
    case 'instagram':
      return <CameraIcon size={size} strokeWidth={2.4} />;
    case 'x':
      return <XBrandIcon size={size - 1} />;
    case 'admin':
      return <MegaphoneIcon size={size} strokeWidth={2.4} />;
  }
}

/** The small coloured circle with the platform glyph (decorative; the label carries the meaning). */
export function SourceBadge({
  kind,
  size = 20,
  className,
}: {
  kind: SourceKind;
  /** Circle diameter in px (the glyph is ~60 % of it). */
  size?: 16 | 20 | 24;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="source-badge"
      data-src={kind}
      className={cx(
        'src-badge flex shrink-0 items-center justify-center rounded-full',
        { 16: 'size-4', 20: 'size-5', 24: 'size-6' }[size],
        className,
      )}
    >
      <Glyph kind={kind} size={size === 16 ? 10 : size === 20 ? 12 : 14} />
    </span>
  );
}

/** The source name next to the badge, in the source's colour. */
export function SourceLabel({ kind, children }: { kind: SourceKind; children: string }) {
  return (
    <span data-src={kind} className="src-label truncate font-semibold">
      {children}
    </span>
  );
}
