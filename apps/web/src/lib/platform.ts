/**
 * Are we running inside the Capacitor shell (iOS / Android app)? Detected through the global the native bridge
 * injects, so the web bundle needs no Capacitor package. Inside the shell there is no service worker (WKWebView
 * doesn't run one on `capacitor://`), no web push (native push replaces it) and no "install the app" prompt.
 * See docs/NATIVE.md.
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}
