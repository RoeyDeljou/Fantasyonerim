# @fant/web

The Fantasyonerim PWA: Next.js App Router as a **static export** (`out/`, also wrapped later by Capacitor), Tailwind 4,
TanStack Query, Hebrew (RTL, default) + English, light/dark themes from the logo.

```bash
npm run dev -w @fant/web        # http://localhost:3000 (API from NEXT_PUBLIC_API_URL, default http://localhost:4000)
npm run build -w @fant/web      # static export → apps/web/out
npm run typecheck -w @fant/web
npm run icons -w @fant/web      # regenerate PWA icons from public/brand/logo.png (outputs are committed)
npm run e2e -w @fant/web        # end-to-end suite (below)
```

## Layout

```
src/app/            routes (thin pages), root layout, theme.css (the only place colours live), providers
src/screens/        one component per screen: Onboarding, MyTeam, Table, LiveAction, Profile, admin/*
src/components/     AppShell (top bar + tab bar), ui primitives, BottomSheet, icons, team/* (Pitch, sheets…)
src/lib/            api.ts (typed client, every response parsed with @fant/shared), queries.ts (TanStack hooks,
                    live polling), tokenStore.ts (swappable token storage), session, theme, pwa
src/i18n/           he.ts (defines the keys) + en.ts (type-checked against he) + useT()/useI18n()
public/             manifest.webmanifest, sw.js (offline shell + push), icons/
e2e/run.mjs         Playwright end-to-end suite
```

## News, push, integrations (Phase 2)

- **News** (`screens/News.tsx`, `components/news/*`): Instagram-profile-style header (logo + story ring:
  gradient = unseen stories, thin muted = all seen, none = no unexpired stories; seen ids in localStorage) →
  full-screen `StoryViewer` · push prompt card · deep-linked item (`/news/?item=<id>`, highlighted, not repeated)
  · infinite feed (cursor, IntersectionObserver) with one card per source and a "new posts" pill (2-min poll
  while visible). Admins get a "hide" action per card.
- **No in-app audio** (owner decision — listens must count in Spotify/Apple creator stats): "Listen" opens the
  only available platform, the remembered one (Profile → Podcast app), or a chooser sheet. Every external link
  goes through `lib/external.ts` `openExternal()` so the Capacitor shell can swap in the App Launcher.
- **Push** (`lib/push.ts`, `components/NotificationsCard.tsx`, `public/sw.js`): support / iOS-needs-install /
  blocked / off / on states, VAPID subscribe → `POST /v1/push/subscriptions`, re-sync on every signed-in start
  (covers `pushsubscriptionchange`), per-account preferences.
- **Admin → Integrations** (`/admin/?view=integrations`, `screens/admin/Integrations.tsx`): five source cards
  (status, last sync/success, items, last error, sync now, enable, settings + write-only secrets), Instagram
  OAuth connect/return (`/admin/?instagram=connected|error`), X paid-feature note, manual post + push-to-all.

Detail views and sub-tabs live in query params (`/my-team/?view=live&gw=7`, `/table/?entry=123`,
`/live/?view=captains`) because a static export has no dynamic route segments.

## End-to-end suite

`npm run e2e -w @fant/web` runs the real API against a throwaway database and drives the real static build:

1. drops and recreates the Postgres database `fantasyonerim_e2e` (via `sudo -u postgres`, falling back to
   `createdb` as user `fant`) and runs `prisma migrate deploy`;
2. builds the static export into `apps/web/out/.e2e` with `NEXT_PUBLIC_API_URL=http://localhost:4100`
   (your normal `.next/` and `out/` are not touched);
3. starts `apps/api` on :4100 with `FPL_MODE=demo` (offline, deterministic FPL data; GW9 is "live"), its own
   bootstrap admin and `CORS_ORIGINS=http://localhost:5100`, and serves the export on :5100;
4. runs these journeys in Chromium at 390×844 and fails on any unexpected console error or horizontal scroll:
   register with demo Team ID 1000003 → reload stays signed in → My Team shows the Triple Captain chip and the
   pitch → Live sub-view → Table/Live show "league not set" without calling `/v1/league/*` → non-admin is
   blocked from `/admin` → admin signs in, sets league 314159 and saves the default captain battle (two linked
   teams + a hand-picked community player) → Table shows the league and opens a manager's team → Captain Battle
   shows the rows plus "my captain" → sign out → recover with the recovery code → admin sign-in on the fan's
   device keeps the fan session and restores it on admin sign-out. Phase 2 adds: News shows the seeded podcast
   cards (badge, de-duplicated title, duration, no `<audio>`), the Listen sheet has the exact Spotify/Apple hrefs
   and a single-platform episode opens directly, the story ring goes unseen → seen through the viewer, the
   `?item=` deep link (and a missing item), notification state + a preference toggle that persists across a
   reload, admin Integrations with all five cards and the X paid note, the Instagram OAuth error return, and a
   manual post that appears in News and is hidden again by the admin.

The content jobs are disabled in e2e (`JOBS_ENABLED=false`, no network): three episodes and one story are seeded
into the throwaway database, and a throwaway VAPID pair is generated. Headless Chromium contexts are incognito,
where `pushManager.subscribe()` is unsupported, so enabling push is asserted to fail gracefully (or succeed).

Requirements: Postgres on localhost:5432 with the `fant`/`fant` role (see `apps/api/.env.example`), ports 4100 and
5100 free, and Playwright with Chromium available to Node (`require('playwright')`; it is not a repo dependency).

Env overrides: `E2E_DATABASE_URL`, `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_SKIP_BUILD=1` (reuse `out/.e2e`),
`E2E_SKIP_DB_RESET=1`, `E2E_HEADED=1`.
