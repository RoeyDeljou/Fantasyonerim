# Native apps (App Store + Google Play) with Capacitor

The iOS and Android apps are the **same static web build** (`apps/web/out`) inside a Capacitor shell. Nothing is
rewritten: the web app already talks to the API with a bearer token, keeps every platform-specific call behind a
small seam, and uses relative URLs only. This document is the step-by-step for building the apps and the exact
list of what the native shell swaps in.

**Status:** prepared, not built. `apps/web/capacitor.config.json` exists; **no Capacitor package is installed**
(the PWA bundle stays free of them until the native work starts).

---

## 1. Prerequisites (in the client's name)

| What                                   | Why                                                         | Cost         |
| -------------------------------------- | ----------------------------------------------------------- | ------------ |
| A Mac with **Xcode** (latest stable)   | iOS builds, the simulator, uploading to App Store Connect   | —            |
| **Android Studio** (any OS)            | Android builds, the emulator, the signed `.aab`             | —            |
| **Apple Developer Program** membership | Required to publish on the App Store and to use push (APNs) | $99 / year   |
| **Google Play Console** account        | Required to publish on Google Play                          | $25 one-time |
| **Firebase** project (free)            | FCM — Android push (and optionally iOS push through FCM)    | free         |

Open both store accounts **in the client's name** (or their company's), not the developer's: the account that
publishes owns the listing, reviews and payouts, and transferring an app later is slow. Add the developer as a
team member (App Store Connect → Users and Access; Play Console → Users and permissions).

Bundle / application id: **`com.fantasyonerim.app`** (in `capacitor.config.json`). It is permanent once the app
is published — confirm it with the client before the first upload.

## 2. One-time setup

From the repo root:

```bash
cd apps/web
npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
# the plugins the swap points below need:
npm i @capacitor/preferences @capacitor/browser @capacitor/app @capacitor/app-launcher @capacitor/push-notifications @capacitor/splash-screen
npx cap add ios
npx cap add android
```

This creates `apps/web/ios/` and `apps/web/android/` (native projects — commit them). The config they read:

```jsonc
// apps/web/capacitor.config.json
{
  "appId": "com.fantasyonerim.app",
  "appName": "Fantasyonerim",
  "webDir": "out", // the static export
  "server": { "androidScheme": "https" }, // Android origin = https://localhost (secure context)
  "ios": { "contentInset": "never", "scheme": "Fantasyonerim" },
  "android": { "allowMixedContent": false },
  "plugins": {
    "SplashScreen": { … }, // brand purple, short, no spinner
    "PushNotifications": { … }, // foreground presentation (badge/sound/alert)
    "Preferences": { … }, // iOS suite name for the token store
  },
}
```

The `plugins` entries are placeholders that only take effect once the matching package is installed.

## 3. Every build

```bash
# 1) the static export, pointing at the production API
NEXT_PUBLIC_API_URL=https://fantasyonerim-api.onrender.com npm run build -w @fant/web
# 2) copy it into the native projects (+ update native plugins)
cd apps/web && npx cap sync
# 3) open, run, archive
npx cap open ios       # Xcode → Product → Archive → Distribute → App Store Connect
npx cap open android   # Android Studio → Build → Generate Signed Bundle (.aab) → Play Console
```

`NEXT_PUBLIC_API_URL` is baked in at build time (it is the only config the client needs).

**API CORS** — the app's web view has its own origin. Add both to `CORS_ORIGINS` on the API (Render):

```
capacitor://localhost,https://localhost
```

(`capacitor://localhost` is iOS, `https://localhost` is Android with `androidScheme: https`.) Auth is a bearer
header, never a cookie, so nothing else changes.

## 4. The swap points (already in the code)

Each one is a single function/module with a setter, so the native shell registers its implementation once at
boot (a small `src/lib/native.ts`, imported from `app/providers.tsx` only when `isNativeShell()` is true — use a
dynamic `import()` so the web bundle never loads Capacitor code).

| Concern               | Web implementation today                                                                           | Native swap                                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Detecting the shell   | `src/lib/platform.ts` → `isNativeShell()` reads the `window.Capacitor` global (no package import)  | nothing — already returns `true` inside the shell; it turns off the service worker, web push, the "install the app" card and the web update checker (`lib/updates.ts`, see DEPLOY.md → "How updates reach installed apps")                                                                                               |
| Session token         | `src/lib/tokenStore.ts` → `localStorageTokenStore` (async interface, two slots: `session`, `fan`)  | `setTokenStore({ get, set, clear })` backed by **`@capacitor/preferences`** (`Preferences.get/set/remove`, keys `fant.token` / `fant.token.fan`). WKWebView may evict `localStorage`; Preferences survives. Sessions are 1-year sliding, so this matters                                                                 |
| Device-local UI prefs | `src/lib/prefs.ts` / `src/lib/localState.ts` (theme, locale, seen stories, podcast app, targets)   | can stay on `localStorage` (cosmetic, losing them breaks nothing). Optionally mirror to Preferences                                                                                                                                                                                                                      |
| External links        | `src/lib/external.ts` → `openExternal(url)` = `window.open(url, '_blank')`; `mailto:` via OS       | `setExternalOpener(url => …)`: Spotify / Apple Podcasts / Instagram / X links → **`@capacitor/app-launcher`** `openUrl` (opens the installed app; falls back to **`@capacitor/browser`** `Browser.open`). Everything else → `Browser.open`. "Listen" must keep opening Spotify/Apple (owner decision: no in-app audio)   |
| Leaving for OAuth     | `src/lib/external.ts` → `navigateExternal(url)` (admin "Connect Instagram")                        | `setExternalNavigator(url => Browser.open({ url }))` + make the API's OAuth return URL a deep link (`WEB_APP_URL` → the universal link below) and close the browser on `appUrlOpen`. Admin-only; can also stay "do this on the website"                                                                                  |
| Push notifications    | `src/lib/push.ts` (VAPID web push → `POST /v1/push/subscriptions`, `public/sw.js`)                 | **`@capacitor/push-notifications`**: `requestPermissions()` → `register()` → on `registration` send the FCM/APNs token to **`POST /v1/push/devices`** (`NativePushDeviceBodySchema`, already in `packages/shared`, the API stores it). Keep `PushState`/`usePush()` as the interface so `NotificationsCard` is untouched |
| Push tap → screen     | `public/sw.js` `notificationclick` opens `payload.url` (`/news/?item=…`, `/community/?post=…`)     | `pushNotificationActionPerformed` listener → `router.push(notification.data.url)` (same relative URL in the payload)                                                                                                                                                                                                     |
| API base URL          | `NEXT_PUBLIC_API_URL` (`src/lib/api.ts`)                                                           | same variable at build time                                                                                                                                                                                                                                                                                              |
| Deep links            | query-param routes: `/news/?item=<id>`, `/community/?post=<id>`, `/table/?entry=…` (static export) | Universal Links (iOS, Associated Domains `applinks:<web domain>`) + App Links (Android intent filter). Serve `public/.well-known/apple-app-site-association` and `public/.well-known/assetlinks.json` from the web host. `@capacitor/app` `appUrlOpen` → `router.push(url.pathname + url.search)`                        |
| Android back button   | browser back                                                                                       | `App.addListener('backButton', ({ canGoBack }) => canGoBack ? history.back() : App.exitApp())`; close an open `BottomSheet` first (it is a native `<dialog>` — dispatch `cancel`)                                                                                                                                        |

Already verified in the code: every external link goes through `openExternal()` (News cards, Listen sheet, story
viewer, linkified text, broadcast results, the contact e-mail); token storage only through `tokenStore`; other
storage only through `prefs.ts` / `localState.ts`; there is no hard-coded origin — in-app links are relative
(`/news/`), API calls use `NEXT_PUBLIC_API_URL`, and the broadcast result's News link (`/news/?item=…`) is
routed inside the app, so nothing breaks under `capacitor://localhost` or `https://localhost`.

### Still to write for native push (server side)

The API has a `PushProvider` interface with a web-push implementation. Native needs an **FCM/APNs
`PushProvider`** in `apps/api` that sends to the tokens stored by `POST /v1/push/devices`:

- Android (and optionally iOS): FCM HTTP v1 with a Firebase service-account key (`FCM_SERVICE_ACCOUNT` secret).
- iOS direct: APNs with a `.p8` auth key (Key ID, Team ID, bundle id `com.fantasyonerim.app`).
- Same payload as web push (`PushPayloadSchema`: title, body, url, tag, image) so the tap handler is identical;
  prune tokens the services report as unregistered, like web push prunes 410s.

Native setup for it: Xcode → Signing & Capabilities → **Push Notifications** + **Background Modes → Remote
notifications**; Firebase → add the Android app (`com.fantasyonerim.app`) → `google-services.json` into
`android/app/`.

## 5. Icons and splash

Generate from `apps/web/public/brand/logo.png` (the same source as the PWA icons):

```bash
npm i -D @capacitor/assets
npx capacitor-assets generate --iconBackgroundColor '#C7EFD5' --iconBackgroundColorDark '#3D185B' \
  --splashBackgroundColor '#3D185B' --splashBackgroundColorDark '#3D185B'
```

It needs `apps/web/assets/icon.png` (1024×1024, the squared logo — `scripts/generate-icons.mjs` already crops the
frame; reuse its `squareLogo()`), and `assets/splash.png` (2732×2732, logo centred on purple). Brand colours:
purple `#3D185B`, mint `#C7EFD5` (from the logo; same values as `src/app/theme.css`).

## 6. Store review notes

**Sign-in for reviewers.** The app has no email/password for fans: an account is a display name + an FPL Team
ID. In App Store Connect → App Review Information, write:

> Sign-in: tap "בואו נתחיל" (Get started), enter any name and the demo FPL Team ID **`<demo Team ID>`**, confirm
> the team. No password is needed. The app is in Hebrew by default; Profile → Language → English.

Pick a real, public FPL team for the demo ID (e.g. one of the hosts' teams from `docs/CLIENT_ACCOUNTS.md`) — the
reviewer only reads it. If that team is already registered, the reviewer would hit "already registered", so use
a dedicated demo team ID that is never registered in production, or give them a recovery code for a demo account.

**User-generated content (Guideline 1.2).** Apple requires a way to report content, to block abusive users, and
to act on reports. Already built: report on every post/comment (reason + note) → admin reports queue → remove
content; admin can suspend (ban) an account, which blocks posting, commenting and liking. The community rules are
at **`/terms/`** ("Community rules & privacy"), linked from onboarding ("by continuing you agree…") and Profile.
**Blocking is built:** "⋯" → "חסימת משתמש" / "Block user" on any other fan's post or comment (not admins, not
yourself) → confirm sheet → `PUT /v1/community/blocks/:userId`; their posts and comments disappear for the
blocker immediately and server-side everywhere, no notifications from them, they aren't told. Profile → "Blocked
users" lists them with unblock. Mention both report and block in the review notes.

**Other expectations.**

- Privacy: App Store "privacy nutrition label" — data linked to the user: name, FPL Team ID (identifiers), user
  content (posts, photos), device push token. No tracking, no ads. Google Play Data safety form: the same.
- Account deletion (Apple 5.1.1(v)) **is built**: Profile → "מחיקת חשבון" / "Delete account" (bottom, danger
  zone) explains what is deleted, requires typing "מחק" / "DELETE", calls `DELETE /v1/me` (profile, sessions,
  posts, comments, likes, reports, blocks, photos, push subscriptions; the FPL team itself is untouched), then
  clears the device and returns to onboarding. Also described on `/terms/`. Point reviewers to it in the notes.
- Push: ask permission from the Notifications card only (never on launch) — already the case.
- Age rating: user-generated content → answer the UGC questions; likely 12+.
- "Minimum functionality" (4.2): the app is more than a website wrapper (live points, league, community, push),
  but make sure the native shell has push and deep links working before submitting.

## 7. Checklist

- [ ] Apple Developer ($99/yr) and Google Play ($25) accounts in the client's name; developer invited
- [ ] Confirm the bundle id `com.fantasyonerim.app`
- [ ] `npm i` the Capacitor packages, `npx cap add ios` / `android`, commit `ios/` + `android/`
- [ ] `src/lib/native.ts`: token store → Preferences, `openExternal` → App Launcher / Browser, push → native,
      deep links + back button; loaded via dynamic `import()` when `isNativeShell()`
- [ ] API: `CORS_ORIGINS` += `capacitor://localhost,https://localhost`
- [ ] API: FCM/APNs `PushProvider`; Firebase project + `google-services.json`; APNs key; Xcode push capability
- [ ] Universal Links / App Links: `.well-known` files on the web host, Associated Domains, intent filter
- [ ] Icons + splash via `@capacitor/assets` from `public/brand/logo.png`
- [ ] `NEXT_PUBLIC_API_URL=… npm run build -w @fant/web && npx cap sync`, test on a real iPhone and Android phone
      (sign-up, recovery code, Listen opens Spotify/Apple, push arrives and opens the right screen, photo upload)
- [ ] Store listings (Hebrew + English), screenshots (6.7" and 5.5" iPhone, Android phone), privacy forms
- [ ] Review notes with the demo Team ID; `/terms/` URL as the EULA / community rules link
- [x] In-app account deletion (Profile) and user-level block ("⋯" menu + Profile list) — built
