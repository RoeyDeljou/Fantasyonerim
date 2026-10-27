/**
 * The single place external links are opened from code. On the web a normal new-tab navigation lets iOS/Android
 * universal links / app links hand `open.spotify.com` and `podcasts.apple.com` URLs to the installed app (with
 * the web player as fallback). The Capacitor shell swaps this for the system browser / App Launcher
 * (docs/NATIVE.md).
 */
export type ExternalOpener = (url: string) => void;

/** `mailto:` / `tel:` hand off to the OS — a new tab would just stay blank. */
const OS_SCHEME = /^(mailto|tel|sms):/i;

let opener: ExternalOpener = (url) => {
  if (OS_SCHEME.test(url)) window.location.assign(url);
  else window.open(url, '_blank', 'noopener');
};

export function openExternal(url: string): void {
  opener(url);
}

export function setExternalOpener(fn: ExternalOpener): void {
  opener = fn;
}

/**
 * Leaving the app in the same window for a flow that comes back to us by redirect (the admin's Instagram OAuth).
 * On the web that is a plain navigation; the native shell swaps in an in-app browser + deep-link return.
 */
let navigator_: ExternalOpener = (url) => window.location.assign(url);

export function navigateExternal(url: string): void {
  navigator_(url);
}

export function setExternalNavigator(fn: ExternalOpener): void {
  navigator_ = fn;
}
