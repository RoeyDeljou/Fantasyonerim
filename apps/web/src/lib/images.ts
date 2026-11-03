/** Responsive images for API media: `srcset` from the server's smaller `variants`, and the slots' `sizes`. */

import type { NewsSource } from '@fant/shared';

/** A smaller re-encoded copy of an image (NewsMedia / UploadedImage `variants`). */
export interface ImageVariant {
  url: string;
  width: number;
}

/** Widest a re-hosted original is assumed to be when its width is unknown (Instagram / X images are ≤ 1080). */
const ORIGINAL_WIDTH_FALLBACK = 1080;

/** `srcset` from the API's variants plus the original; undefined when there are no variants (plain `src`). */
export function srcSetOf(
  src: string,
  width: number | null | undefined,
  variants: readonly ImageVariant[] | undefined,
): string | undefined {
  if (!variants?.length) return undefined;
  const full = width ?? ORIGINAL_WIDTH_FALLBACK;
  const smaller = variants.filter((v) => v.width < full).map((v) => `${v.url} ${v.width}w`);
  return smaller.length ? [...smaller, `${src} ${full}w`].join(', ') : undefined;
}

/** `sizes` for the slots media appears in (the column is at most max-w-xl = 36rem). */
export const SIZES = {
  /** Edge to edge in the column (carousel, single photo, video thumbnail, wide cover). */
  full: '(max-width: 36rem) 100vw, 36rem',
  /** Half the column (2-up grid tiles). */
  half: '(max-width: 36rem) 50vw, 18rem',
  /** A Short's poster (max-w-72). */
  short: '(max-width: 18rem) 100vw, 18rem',
  /** The 96 px podcast cover tile. */
  cover: '6rem',
} as const;

// ---------- the first image of a News card (render + LCP preload share this) ----------

/** How a News card lays out its media. `none` = the card shows no media at all. */
export type MediaLayout = 'carousel' | 'grid' | 'podcast' | 'video' | 'none';

/**
 * Which media layout each source's card uses — the single source of truth for both the cards (NewsCards.tsx) and
 * the inline LCP preload (lib/earlyFetch.ts), so a preload can never fetch an image no card shows.
 */
export const MEDIA_LAYOUT = {
  podcast: 'podcast',
  instagram_post: 'carousel',
  instagram_story: 'none', // stories live in the profile header, never in the feed
  x_post: 'grid',
  admin_update: 'grid',
  youtube_short: 'video',
  youtube_video: 'video',
} as const satisfies Record<NewsSource, MediaLayout>;

/** The first <img> a card renders: what to preload, and exactly the srcset/sizes the card puts on it. */
export interface FirstImage {
  src: string;
  srcSet: string | null;
  sizes: string | null;
}

interface MediaLike {
  kind: string;
  url: string;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  variants?: readonly { url: string; width: number }[] | undefined;
}

/**
 * The first image a News card shows for `item` (null = none, or one the card picks at render time such as a
 * YouTube fallback thumbnail). Serialized into the inline <head> script with `toString()`: self-contained, literals
 * only — `srcSetOf` and `SIZES` above are re-implemented here and images.test.ts keeps them identical.
 */
export function firstImageOf(
  item: { source: string; media: readonly MediaLike[] },
  layouts: Readonly<Record<string, string>>,
): FirstImage | null {
  const FULL = '(max-width: 36rem) 100vw, 36rem';
  const srcset = (m: MediaLike) => {
    const v = m.variants;
    if (!v || !v.length) return null;
    const full = m.width || 1080;
    const smaller = v.filter((x) => x.width < full).map((x) => x.url + ' ' + x.width + 'w');
    return smaller.length ? smaller.concat(m.url + ' ' + full + 'w').join(', ') : null;
  };
  const image = (m: MediaLike, sizes: string): FirstImage => {
    const ss = srcset(m);
    return { src: m.url, srcSet: ss, sizes: ss ? sizes : null };
  };
  const poster = (m: MediaLike): FirstImage | null =>
    m.posterUrl ? { src: m.posterUrl, srcSet: null, sizes: null } : null;
  const layout = layouts[item.source] || 'none';
  const media = item.media;
  const first = media[0];
  if (layout === 'none' || !first) return null;
  if (layout === 'carousel') return first.kind === 'image' ? image(first, FULL) : poster(first);
  if (layout === 'grid') {
    const sizes = media.length > 1 ? '(max-width: 36rem) 50vw, 18rem' : FULL;
    return first.kind === 'image' ? image(first, sizes) : poster(first);
  }
  if (layout === 'podcast') {
    const cover = media.filter((m) => m.kind === 'image')[0];
    if (!cover) return poster(first);
    const ratio = cover.width && cover.height ? cover.width / cover.height : null;
    return image(cover, ratio !== null && ratio > 1.2 ? FULL : '6rem');
  }
  // video: the re-hosted thumbnail (or a video's poster)
  if (first.kind !== 'image') return poster(first);
  return image(first, item.source === 'youtube_short' ? '(max-width: 18rem) 100vw, 18rem' : FULL);
}
