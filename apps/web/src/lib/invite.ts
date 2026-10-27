'use client';

/**
 * The admin-invite token from `/onboarding/#invite=<token>` (or the older `?invite=<token>`). It is a credential, so it is read once, dropped from
 * the address bar (history.replaceState — it never stays in history, bookmarks or a shared screenshot of the URL)
 * and kept only in sessionStorage (survives a reload of this tab, gone when the tab closes) until it's used or
 * found invalid. Never logged.
 */
const KEY = 'fant.adminInvite';
let memory: string | null = null;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Picks the token up from the URL (and cleans the URL), else whatever this tab kept. Links carry it in the
 * fragment (`/onboarding/#invite=<token>` — never sent to the static host, so never in its access logs); the
 * older `?invite=<token>` form is still accepted for links already sent. Both are stripped.
 */
export function takeInviteToken(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const fromHash = hash.get('invite');
  const fromQuery = url.searchParams.get('invite');
  if (fromHash !== null || fromQuery !== null) {
    url.searchParams.delete('invite');
    hash.delete('invite');
    const rest = hash.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${rest ? `#${rest}` : ''}`,
    );
    const token = (fromHash ?? fromQuery ?? '').trim();
    if (token) {
      memory = token;
      try {
        store()?.setItem(KEY, token);
      } catch {
        // private mode — memory only
      }
    }
  }
  if (memory) return memory;
  return store()?.getItem(KEY) ?? null;
}

export function clearInviteToken(): void {
  memory = null;
  try {
    store()?.removeItem(KEY);
  } catch {
    // ignore
  }
}
