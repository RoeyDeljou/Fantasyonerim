# Fantasyonerim — project guide

The official app of **Fantasyonerim (פנטזיונרים)**, an Israeli Fantasy Premier League (FPL) podcast. It is:

1. a **News** feed that mirrors everything the creators publish — podcast episodes (Spotify + Apple Podcasts),
   Instagram posts and stories, X posts — **automatically, with zero manual work**. This is the client's #1 priority:
   if a creator has to re-post by hand, they will not use the app;
2. a **Community** feed where fans post, share their FPL team and comment on each other;
3. an FPL companion: **My Team** (+ Live), the podcast's mini-league **Table**, **Live Action** (live league + live
   scores) and **Captain Battle**;
4. an admin console: league ID, captain battle, integrations, WhatsApp/X live broadcasts, push notifications.

It ships first as a mobile-first **installable PWA** (home screen + web push), and later as App Store / Google Play
apps by wrapping the same web build in Capacitor. Every decision must keep that path open.

## Repository layout

```
packages/shared        Zod API contract + branded ids shared by api and web (the single source of truth)
packages/fpl           FPL API client, normalization, live-points engine (auto-subs, provisional bonus)
packages/integrations  Content sources (podcast RSS, Spotify, Apple, Instagram, X) + outbound (X post, WhatsApp)
apps/api               Fastify REST + Prisma/Postgres: auth, news ingestion jobs, community, admin, push
apps/web               Next.js (static export) + Tailwind PWA, Hebrew (RTL) + English
docs/                  PLAN.md (phases + acceptance criteria), ARCHITECTURE.md, API.md, INTEGRATIONS.md
```

npm workspaces, run everything from the repo root:

```bash
npm install
npm run dev          # api + web together
npm run typecheck
npm run lint
npm run test         # needs Postgres: see apps/api/.env.example (TEST_DATABASE_URL)
```

## Non-negotiable invariants

1. **News is automatic.** Every News item comes from a polled/connected source. Manual admin posts are a fallback,
   never the main path. A source failing must never block the others; failures surface in the admin dashboard.
2. **The contract lives in `packages/shared`.** Every REST body/response is a Zod schema there. api validates with
   it, web parses with it. Never hand-write a DTO type in an app.
3. **FPL access goes through `FplService`** (`packages/fpl`). No other code calls fantasy.premierleague.com or
   knows raw FPL field names. The browser never calls FPL directly (CORS) — it calls apps/api, which caches.
4. **`packages/shared` and `packages/fpl` are platform-agnostic**: no Node built-ins, no React/Next/Fastify/Prisma.
   `fetch` and the clock are injected so tests replay recorded FPL JSON deterministically.
5. **Native-ready.** Auth is a bearer token (no cookies), the web app is a static export (no server components
   that need a Node server), push goes through a `PushProvider` interface (web-push now, FCM/APNs later), and
   API base URL is config. Nothing may assume it is running on a website.
6. **Accounts = name + FPL Team ID.** No email, no password for fans. Sessions are long-lived (sliding 1 year) so
   users register once and stay signed in. A recovery code (Profile screen) moves an account to a new device.
7. **Secrets never reach the client.** Social tokens (Instagram, X, Spotify, WhatsApp session) are stored
   encrypted at rest (`SECRETS_KEY`) and never returned by any endpoint.
8. **No half-finished work.** A phase is complete only when every acceptance criterion in `docs/PLAN.md` passes
   and `qa-verifier` returns `VERDICT: PASS`.

## Brand

Colors come from the logo (`apps/web/public/brand/logo.png`): purple `#3D185B`, mint `#C7EFD5`, off-white
`#F6F4F5`. Light mode = mint/off-white surfaces with purple as the primary; dark mode = purple surfaces with mint as
the primary. All colors are CSS variables in one theme file — never hard-code a hex in a component.

## Subagents — use them for every task

Defined in `.claude/agents/`. Route work by ownership; run independent agents in parallel, then gate with `qa-verifier`.

| Agent                           | Owns                    | Use it for                                                                                     |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `fpl-data-engineer`             | `packages/fpl`          | FPL endpoints, normalization, live points, auto-subs, bonus, caching, deadline math            |
| `content-integrations-engineer` | `packages/integrations` | Podcast RSS / Spotify / Apple / Instagram / X ingestion, X posting, WhatsApp linking + sending |
| `backend-engineer`              | `apps/api`              | REST routes, Prisma schema, auth, jobs/scheduler, push notifications, admin, community         |
| `pwa-ux-engineer`               | `apps/web`              | Screens, tabs, theming, RTL/i18n, service worker, push subscription, install flow              |
| `qa-verifier`                   | nothing (read-only)     | Phase gates and any "is this actually done?" question                                          |

`packages/shared` is co-owned: changes to it are made by the orchestrator (or one agent at a time, announced) because
both api and web compile against it.

Rules of engagement: give an agent the phase's acceptance criteria verbatim, never let two agents write the same
package in parallel, and never accept an agent's "done" without a `qa-verifier` pass.

## Conventions

- TypeScript strict everywhere; no `any` (`unknown` + narrowing instead).
- Zod validates every boundary: REST bodies, provider responses (FPL, Instagram, X, RSS), env, admin settings.
- Vitest for unit/integration tests (api tests hit a real Postgres test DB); Playwright for web end-to-end.
- Domain ids are branded types (`UserId`, `FplEntryId`, `FplPlayerId`, `Gameweek`) — never bare across a boundary.
- All user-visible strings go through the i18n dictionaries (`apps/web/src/i18n/{he,en}.ts`); Hebrew is the default.
- Layout uses logical CSS properties (`ms-`, `me-`, `ps-`, `start-`, `end-`) so RTL and LTR both work.
