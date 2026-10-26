'use client';

import { useState } from 'react';
import { initials } from '@/lib/text';
import { cx } from './ui';

/** FPL / PL image CDNs (public, CORS-free <img> loads). The browser never calls the FPL *API*. */
export const fplImage = {
  shirt: (teamCode: number, goalkeeper: boolean) =>
    `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${teamCode}${goalkeeper ? '_1' : ''}-66.png`,
  badge: (teamCode: number) => `https://resources.premierleague.com/premierleague/badges/70/t${teamCode}.png`,
  photo: (photoCode: string) =>
    `https://resources.premierleague.com/premierleague/photos/players/110x140/p${photoCode.replace(/\.(png|jpg)$/i, '')}.png`,
};

/** <img> that degrades to a coloured initials circle when the CDN fails or is blocked. */
export function ImageWithFallback({
  src,
  name,
  className,
  fallbackClassName,
  fallbackText,
}: {
  src: string | null;
  name: string;
  /** Shown instead of initials, e.g. a club short name ("LIV"). */
  fallbackText?: string | undefined;
  className?: string;
  fallbackClassName?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src === null || failed === src) {
    return (
      <span
        aria-hidden="true"
        className={cx(
          'inline-flex shrink-0 items-center justify-center rounded-full bg-primary font-bold text-on-primary',
          fallbackClassName ?? className,
        )}
      >
        {fallbackText ?? initials(name, { pairFromOneWord: true })}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(src)}
      className={cx('object-contain', className)}
    />
  );
}
