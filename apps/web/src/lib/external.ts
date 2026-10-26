/**
 * The single place external links are opened from code. On the web a normal new-tab navigation lets iOS/Android
 * universal links / app links hand `open.spotify.com` and `podcasts.apple.com` URLs to the installed app (with
 * the web player as fallback). The Capacitor shell swaps this for the system browser / App Launcher.
 */
export type ExternalOpener = (url: string) => void;

let opener: ExternalOpener = (url) => {
  window.open(url, '_blank', 'noopener');
};

export function openExternal(url: string): void {
  opener(url);
}

export function setExternalOpener(fn: ExternalOpener): void {
  opener = fn;
}
