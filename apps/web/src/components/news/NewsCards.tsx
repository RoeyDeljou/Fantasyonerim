'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { NewsItem } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { openExternal } from '@/lib/external';
import { setListenPref, useListenPref } from '@/lib/localState';
import { episodeTitle, formatDuration, relativeParts } from '@/lib/newsFormat';
import { useHideNews } from '@/lib/queries';
import { BottomSheet } from '@/components/BottomSheet';
import { Logo } from '@/components/AppShell';
import {
  ApplePodcastsIcon,
  CameraIcon,
  ChevronEndIcon,
  ClockIcon,
  EyeOffIcon,
  HeadphonesIcon,
  MegaphoneIcon,
  MicIcon,
  SpotifyIcon,
  XBrandIcon,
  ExternalIcon,
} from '@/components/icons';
import { Badge, Button, IconButton, InlineError, Spinner, cx, errorMessage } from '@/components/ui';
import { MediaCarousel, MediaGrid } from './Media';
import { ExpandableText, ExternalButton, MediaImage, RelativeTime, useNow } from './parts';

type FeedSource = Exclude<NewsItem['source'], 'instagram_story'>;

const SOURCE_ICON: Record<FeedSource, ReactNode> = {
  podcast: <MicIcon size={12} strokeWidth={2.4} />,
  instagram_post: <CameraIcon size={12} strokeWidth={2.4} />,
  x_post: <XBrandIcon size={11} />,
  admin_update: <MegaphoneIcon size={12} strokeWidth={2.4} />,
};

function CardHeader({ item, isAdmin }: { item: NewsItem; isAdmin: boolean }) {
  const { t } = useI18n();
  const source: FeedSource = item.source === 'instagram_story' ? 'instagram_post' : item.source;
  const label = {
    podcast: t.news.sourcePodcast,
    instagram_post: t.news.sourceInstagram,
    x_post: t.news.sourceX,
    admin_update: t.news.sourceAdmin,
  }[source];
  return (
    <header className="flex items-center gap-2.5">
      <span className="relative shrink-0">
        <Logo size={40} />
        <span
          className="absolute -end-1 -bottom-1 flex size-5 items-center justify-center rounded-full border-2 border-surface bg-primary text-on-primary"
          aria-hidden="true"
        >
          {SOURCE_ICON[source]}
        </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[15px] font-bold text-ink">{t.app.name}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
          <span className="truncate">{label}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime iso={item.publishedAt} className="shrink-0" />
        </span>
      </div>
      {isAdmin && <HideAction item={item} />}
    </header>
  );
}

function HideAction({ item }: { item: NewsItem }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hide = useHideNews();
  return (
    <>
      <IconButton label={t.news.hide} onClick={() => setOpen(true)} className="-me-2 text-muted">
        <EyeOffIcon size={20} />
      </IconButton>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t.news.hideConfirmTitle}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t.news.hideConfirmBody}</p>
          {(item.title ?? item.text) && (
            <p dir="auto" className="line-clamp-2 rounded-xl bg-surface-2 p-3 text-sm text-ink">
              {item.title ?? item.text}
            </p>
          )}
          {hide.isError && <InlineError>{errorMessage(t, hide.error)}</InlineError>}
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              disabled={hide.isPending}
              onClick={() => hide.mutate(item.id, { onSuccess: () => setOpen(false) })}
            >
              {hide.isPending ? <Spinner /> : <EyeOffIcon size={18} />}
              {t.news.hideConfirm}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}

function CardFrame({
  item,
  highlighted,
  children,
  className,
}: {
  item: NewsItem;
  highlighted: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article
      id={`news-${item.id}`}
      data-testid="news-card"
      data-source={item.source}
      className={cx(
        'flex flex-col gap-3 overflow-hidden rounded-3xl border border-line bg-surface p-4 shadow-card',
        highlighted && 'news-highlight',
        className,
      )}
    >
      {children}
    </article>
  );
}

// ---------- podcast ----------

type Platform = 'spotify' | 'apple';

/**
 * No in-app audio (owner decision): every listen happens on Spotify / Apple so it counts in their creator
 * stats. "Listen" opens the only available platform directly, the remembered one, or a chooser sheet.
 */
function PodcastCard({ item, isAdmin, highlighted }: CardProps) {
  const { t, f } = useI18n();
  const pref = useListenPref();
  const [choosing, setChoosing] = useState(false);
  const cover = item.media.find((m) => m.kind === 'image')?.url ?? item.media[0]?.posterUrl ?? null;
  const n = item.podcast?.episodeNumber ?? null;
  const duration = item.podcast?.durationSec ?? null;
  const title = episodeTitle(item.title ?? item.text ?? '', n);
  const links: Array<{ platform: Platform; url: string }> = [];
  if (item.links.spotify) links.push({ platform: 'spotify', url: item.links.spotify });
  if (item.links.apple) links.push({ platform: 'apple', url: item.links.apple });

  const listen = () => {
    const only = links.length === 1 ? links[0] : undefined;
    const preferred = links.find((l) => l.platform === pref);
    const direct = only ?? preferred;
    if (direct) openExternal(direct.url);
    else if (links.length > 1) setChoosing(true);
  };
  const canListen = links.length > 0;
  // Older than a week, the header's relative time already *is* the date — don't repeat it in the meta line.
  const now = useNow();
  const headerShowsDate = now === 0 || relativeParts(item.publishedAt, now) === null;
  const showDuration = duration !== null && duration > 0;

  const coverEl = (
    <div className="relative size-24 shrink-0 overflow-hidden rounded-2xl bg-accent shadow-card">
      {cover ? (
        <MediaImage
          src={cover}
          alt={t.news.cover}
          className="size-full object-cover"
          fallback={<img src="/brand/logo-320.png" alt="" className="size-full object-cover" />}
        />
      ) : (
        <img src="/brand/logo-320.png" alt="" className="size-full object-cover" />
      )}
    </div>
  );

  return (
    <CardFrame item={item} highlighted={highlighted}>
      <CardHeader item={item} isAdmin={isAdmin} />
      <div className="flex gap-3">
        {canListen ? (
          <button
            type="button"
            onClick={listen}
            aria-label={`${t.listen.listen}: ${title}`}
            className="rounded-2xl"
          >
            {coverEl}
          </button>
        ) : (
          coverEl
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {n !== null && (
            <Badge tone="accent" className="self-start">
              {fmt(t.news.episode, { n })}
            </Badge>
          )}
          <h2 dir="auto" className="name-start line-clamp-3 text-base leading-snug font-bold text-ink">
            {canListen ? (
              <button type="button" onClick={listen} className="text-start hover:underline">
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          {(!headerShowsDate || showDuration) && (
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              {!headerShowsDate && <time dateTime={item.publishedAt}>{f.date(item.publishedAt)}</time>}
              {!headerShowsDate && showDuration && <span aria-hidden="true">·</span>}
              {showDuration && (
                <bdi dir="ltr" className="tabular" data-testid="episode-duration">
                  {formatDuration(duration)}
                </bdi>
              )}
            </p>
          )}
        </div>
      </div>
      {item.text && item.title && <ExpandableText text={item.text} platform="none" lines={3} />}
      {canListen ? (
        <>
          <Button block onClick={listen} data-testid="listen-button">
            <HeadphonesIcon size={20} />
            {t.listen.listen}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            {links.map((l) => (
              <ExternalButton
                key={l.platform}
                href={l.url}
                icon={l.platform === 'spotify' ? <SpotifyIcon size={18} /> : <ApplePodcastsIcon size={18} />}
                className={links.length === 1 ? 'col-span-2' : undefined}
              >
                {l.platform === 'spotify' ? t.socials.spotify : t.socials.apple}
              </ExternalButton>
            ))}
          </div>
        </>
      ) : (
        <p
          className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted"
          data-testid="listen-soon"
        >
          <ClockIcon size={18} className="shrink-0" />
          {t.listen.soon}
        </p>
      )}
      <ListenSheet open={choosing} onClose={() => setChoosing(false)} links={links} title={title} />
    </CardFrame>
  );
}

function ListenSheet({
  open,
  onClose,
  links,
  title,
}: {
  open: boolean;
  onClose(): void;
  links: ReadonlyArray<{ platform: Platform; url: string }>;
  title: string;
}) {
  const { t } = useI18n();
  const [remember, setRemember] = useState(false);
  return (
    <BottomSheet open={open} onClose={onClose} title={t.listen.whereTitle}>
      <div className="flex flex-col gap-3" data-testid="listen-sheet">
        <p dir="auto" className="line-clamp-2 text-sm font-semibold text-ink">
          {title}
        </p>
        <p className="-mt-2 text-xs text-muted">{t.listen.whereBody}</p>
        {links.map((l) => (
          <a
            key={l.platform}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            data-platform={l.platform}
            onClick={(e) => {
              e.preventDefault();
              if (remember) setListenPref(l.platform);
              openExternal(l.url);
              onClose();
            }}
            className="flex min-h-16 items-center gap-3 rounded-2xl border border-line bg-surface-2 px-4 text-base font-bold text-ink hover:bg-surface-3"
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-primary text-on-primary">
              {l.platform === 'spotify' ? <SpotifyIcon size={22} /> : <ApplePodcastsIcon size={22} />}
            </span>
            <span className="flex-1">{l.platform === 'spotify' ? t.socials.spotify : t.socials.apple}</span>
            <ChevronEndIcon className="text-muted" />
          </a>
        ))}
        <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-5 accent-[var(--primary)]"
          />
          <span className="flex flex-col">
            <span className="font-medium">{t.listen.remember}</span>
            <span className="text-xs text-muted">{t.listen.rememberHint}</span>
          </span>
        </label>
      </div>
    </BottomSheet>
  );
}

// ---------- instagram ----------

function InstagramCard({ item, isAdmin, highlighted }: CardProps) {
  const { t } = useI18n();
  return (
    <CardFrame item={item} highlighted={highlighted}>
      <CardHeader item={item} isAdmin={isAdmin} />
      {item.media.length > 0 && <MediaCarousel media={item.media} alt={item.text?.slice(0, 120) ?? ''} />}
      {item.text && <ExpandableText text={item.text} platform="instagram" lines={3} />}
      {item.links.instagram && (
        <ExternalButton href={item.links.instagram} icon={<CameraIcon size={18} />} tone="outline">
          {t.news.viewOnInstagram}
        </ExternalButton>
      )}
    </CardFrame>
  );
}

// ---------- x ----------

function XCard({ item, isAdmin, highlighted }: CardProps) {
  const { t } = useI18n();
  return (
    <CardFrame item={item} highlighted={highlighted}>
      <CardHeader item={item} isAdmin={isAdmin} />
      {item.text && <ExpandableText text={item.text} platform="x" lines={6} />}
      {item.media.length > 0 && <MediaGrid media={item.media} alt={item.text?.slice(0, 120) ?? ''} />}
      {item.links.x && (
        <ExternalButton href={item.links.x} icon={<XBrandIcon size={16} />} tone="outline">
          {t.news.viewOnX}
        </ExternalButton>
      )}
    </CardFrame>
  );
}

// ---------- admin update ----------

function AdminUpdateCard({ item, isAdmin, highlighted }: CardProps) {
  const { t } = useI18n();
  const links: Array<{ href: string; label: string; icon: ReactNode }> = [];
  if (item.links.spotify)
    links.push({ href: item.links.spotify, label: t.socials.spotify, icon: <SpotifyIcon size={18} /> });
  if (item.links.apple)
    links.push({ href: item.links.apple, label: t.socials.apple, icon: <ApplePodcastsIcon size={18} /> });
  if (item.links.instagram)
    links.push({ href: item.links.instagram, label: t.socials.instagram, icon: <CameraIcon size={18} /> });
  if (item.links.x) links.push({ href: item.links.x, label: t.socials.x, icon: <XBrandIcon size={16} /> });
  if (item.links.web)
    links.push({ href: item.links.web, label: t.socials.web, icon: <ExternalIcon size={16} /> });
  return (
    <CardFrame item={item} highlighted={highlighted} className="border-primary/40 bg-primary-soft">
      <CardHeader item={item} isAdmin={isAdmin} />
      <div className="flex items-start gap-3 rounded-2xl bg-surface p-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary">
          <MegaphoneIcon size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs font-bold tracking-wide text-primary uppercase">
            {t.news.announcement}
          </span>
          {item.title && (
            <h2 dir="auto" className="name-start text-base font-bold text-ink">
              {item.title}
            </h2>
          )}
          {item.text && <ExpandableText text={item.text} platform="none" lines={6} />}
        </div>
      </div>
      {links.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {links.map((l) => (
            <ExternalButton key={l.href} href={l.href} icon={l.icon} className="flex-1">
              {l.label}
            </ExternalButton>
          ))}
        </div>
      )}
    </CardFrame>
  );
}

interface CardProps {
  item: NewsItem;
  isAdmin: boolean;
  highlighted: boolean;
}

/** One card component per source. Stories never reach the feed (they live in the profile header). */
export function NewsCard({
  item,
  isAdmin,
  highlighted = false,
}: {
  item: NewsItem;
  isAdmin: boolean;
  highlighted?: boolean;
}) {
  const props = { item, isAdmin, highlighted };
  switch (item.source) {
    case 'podcast':
      return <PodcastCard {...props} />;
    case 'instagram_post':
    case 'instagram_story':
      return <InstagramCard {...props} />;
    case 'x_post':
      return <XCard {...props} />;
    case 'admin_update':
      return <AdminUpdateCard {...props} />;
  }
}

export function NewsCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-line bg-surface p-4" aria-hidden="true">
      <div className="flex items-center gap-2.5">
        <div className="skeleton size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="skeleton h-3.5 w-28 rounded-md" />
          <div className="skeleton h-3 w-20 rounded-md" />
        </div>
      </div>
      <div className="flex gap-3">
        <div className="skeleton size-24 rounded-2xl" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="skeleton h-5 w-16 rounded-full" />
          <div className="skeleton h-4 w-full rounded-md" />
          <div className="skeleton h-4 w-3/4 rounded-md" />
        </div>
      </div>
      <div className="skeleton h-16 rounded-2xl" />
    </div>
  );
}
