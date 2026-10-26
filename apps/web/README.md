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
   device keeps the fan session and restores it on admin sign-out.

Requirements: Postgres on localhost:5432 with the `fant`/`fant` role (see `apps/api/.env.example`), ports 4100 and
5100 free, and Playwright with Chromium available to Node (`require('playwright')`; it is not a repo dependency).

Env overrides: `E2E_DATABASE_URL`, `E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_SKIP_BUILD=1` (reuse `out/.e2e`),
`E2E_SKIP_DB_RESET=1`, `E2E_HEADED=1`.
