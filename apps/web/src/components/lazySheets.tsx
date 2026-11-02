'use client';

import { lazyWhenOpen } from './lazy';
import { SkeletonList } from './ui';

/**
 * Everything that opens on top of a tab — sheets, the story viewer, the composer, a community thread — is its own
 * chunk (see lazy.tsx). Screens import these, never the modules themselves, so the code stays out of first loads.
 */

/** Another manager's team (Table / Live Action rows). */
export const ManagerSheet = lazyWhenOpen(
  () => import('./team/ManagerSheet').then((m) => m.ManagerSheet),
  (p) => p.entryId !== null,
);

/** The FPL match sheet (Live Action fixtures strip). */
export const FixtureSheet = lazyWhenOpen(
  () => import('./team/FixtureSheet').then((m) => m.FixtureSheet),
  (p) => p.fixtureId !== null,
);

/** One player's points breakdown (My Team pitch / list). */
export const PlayerSheet = lazyWhenOpen(
  () => import('./team/PlayerSheet').then((m) => m.PlayerSheet),
  (p) => p.pick !== null,
);

/** The post composer (Community). */
export const ComposerSheet = lazyWhenOpen(
  () => import('./community/Composer').then((m) => m.ComposerSheet),
  (p) => p.open,
);

/** Full-screen photo of a community post. */
export const ImageViewer = lazyWhenOpen(
  () => import('./community/ImageViewer').then((m) => m.ImageViewer),
  (p) => p.open,
);

/** Instagram stories (News profile header) — only mounted while open. */
export const StoryViewer = lazyWhenOpen(
  () => import('./news/StoryViewer').then((m) => m.StoryViewer),
  () => true,
);

/** A community post with its comments (`/community/?post=`) — only mounted while open. */
export const Thread = lazyWhenOpen(
  () => import('./community/Thread').then((m) => m.Thread),
  () => true,
  <SkeletonList rows={4} />,
);
