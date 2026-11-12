'use client';

import { useState } from 'react';
import { initials } from '@/lib/text';
import { cx } from './ui';

export { fplImage } from '@/lib/fplImage';

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
