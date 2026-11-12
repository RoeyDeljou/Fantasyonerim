/**
 * The shared person avatar (photo, or the initials circle). It lives in AppShell.tsx — the header's own circle uses
 * it, so it ships in the shell chunk every tab already loads instead of a chunk of its own.
 */
export { UserAvatar } from './AppShell';
