/**
 * The client's own accounts (docs/CLIENT_ACCOUNTS.md). Ids live here, never inline at a call site.
 */
export { CLIENT_HOSTS } from '@fant/shared';

/** Contact for community questions, ban appeals and deletion requests (shown on /terms/). */
export const CONTACT_EMAIL = 'ashalim.fantasy@gmail.com';

/**
 * Optional photos for the hosts' avatars on the season Captain Battle (screens/SeasonCaptains.tsx). `null` = initials.
 * To add one, drop the image in `apps/web/public/brand/stars/` (square-ish, ~200x200 is plenty) and set its path here,
 * e.g. `dor: '/brand/stars/dor.jpg'`. If the file fails to load the avatar falls back to initials.
 */
export const STAR_PHOTOS: Record<'dor' | 'itay', string | null> = { dor: null, itay: null };
