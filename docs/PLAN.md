# Fantasyonerim — delivery plan

Each phase ends with `npm run typecheck && npm run lint && npm run test` green and a `qa-verifier` `VERDICT: PASS`.
A criterion that cannot be verified in the build sandbox (e.g. a host blocked by the network policy) is marked
**[needs-live]** and is verified against recorded payloads plus once on the deployed app.

## Phase 0 — Foundation ✅

- [x] npm workspaces monorepo; strict TS; ESLint + Prettier; Vitest; CI workflow.
- [x] `packages/shared` API contract (ids + Zod DTOs) and `FplService` interface in `packages/fpl`.
- [x] CLAUDE.md, five subagents in `.claude/agents/`, this plan.

## Phase 1 — FPL core: accounts, My Team, Table, Live Action, Captain Battle ✅

_Passed `qa-verifier` on 2026-10-26 at fc713c3 (third gate; two earlier FAILs fixed). Verified against live FPL
and the client's league 4611._

**packages/fpl**

1. `createFplService(options)` implements every `FplService` method against the real FPL endpoints, returning
   `@fant/shared` DTOs (parsed with their schemas in tests).
2. Live-points engine is a pure function covered by tests for: normal GW, DGW, blank GW, captain 0 min → vice,
   captain + vice 0 min, TC, BB, auto-subs incl. formation minimums and bench GK, provisional bonus with BPS ties,
   bonus already confirmed (no double count), transfer hits.
3. TTL cache + in-flight dedupe; 503/429 → `FplUnavailableError`; 404 → `FplNotFoundError`.

**apps/api** 4. Fastify app with `/health`, `/v1/*`, Zod-validated env, CORS, rate limits, uniform `ApiError` responses. 5. Prisma/Postgres schema + migrations: User, Session, AdminCredential, AppSettings, CaptainBattle(+entries). 6. `POST /v1/auth/register` (name + Team ID, verified against FPL, 409 if team already registered),
`POST /v1/auth/recover`, `POST /v1/auth/admin-login`, `POST /v1/auth/logout`, `GET/PATCH /v1/me`,
`GET /v1/me/recovery-code`. Tokens hashed at rest; sliding 1-year expiry. 7. FPL proxy routes: bootstrap, fixtures, entry summary, picks, live — served from FplService cache. 8. `GET /v1/config`, `GET /v1/league/standings`, `GET /v1/league/live`, `GET /v1/captain-battle` (admin-chosen
captains + the viewer's own captain, sorted by live captain points). 9. Admin: `GET/PUT /v1/admin/settings` (league ID, reminder offsets, social links),
`GET/PUT /v1/admin/captain-battle`, `GET/POST /v1/admin/admins`. Non-admins get 403. 10. First admin bootstrapped from `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`.

**apps/web** 11. Static-export Next.js PWA: manifest + icons from the logo, service worker registered, installable. 12. Onboarding: name + Team ID (with "where do I find my Team ID?" help), Team preview before confirming,
stays signed in across reloads/app restarts; recovery-code sign-in on a new device. 13. Bottom tab bar: News · Community · My Team · Table · Live Action (News/Community show "coming in the next
update" empty states only in this phase). 14. My Team: pitch view of the XI + bench, captain/vice badges, active chip, chips used/available, GW points, bank,
value, transfers/hits, rank; GW selector. **Live** sub-tab: live points per player, auto-subs, provisional
bonus, players played / yet to play, auto-refresh while matches are live. 15. Table: admin's league standings with pagination; tapping a row opens a sheet with that manager's team. 16. Live Action: live league table (live GW points, re-ranked, captain, chip) + PL fixtures with live scores;
**Captain Battle** sub-tab with the admin captains + "my captain" row. 17. Admin console (`/admin`, admin-only): login, settings (league ID, socials, reminders), captain battle editor
with player search, admin accounts. 18. Hebrew RTL default + English toggle; light/dark from the logo, system default + toggle; phone viewport has no
horizontal scroll; every screen has loading, empty and error states.

## Phase 2 — Automatic News feed + push notifications ✅

_Passed `qa-verifier` on 2026-10-26 at 8b10e86 (second gate). Verified against the client's real RSS (62 episodes,
all Apple links correct). Client decisions applied: Instagram-style profile circle + story ring instead of a stories
bar; no in-app audio — Listen hands off to Spotify/Apple (docs/CLIENT_ACCOUNTS.md)._

1. `packages/integrations` sources: Podcast RSS, Spotify show episodes, Apple Podcasts lookup (merged into one
   episode item with all links), Instagram posts + stories, X timeline. Recorded-payload tests for each.
2. Admin "Integrations" screen: connect Instagram (OAuth), set RSS URL / Spotify show / Apple podcast ID / X
   account, status per source (connected, last sync, last error), "sync now". X shows "paid feature — contact
   creator" note.
3. Scheduler: polls every source (stories every 5 min, others every 10 min), idempotent by dedupe key, one source's
   failure never blocks others; Instagram token auto-refresh; external cron tick endpoint for sleeping hosts.
4. Media re-hosting (Instagram CDN URLs expire) behind a `MediaStore` interface (S3-compatible in prod, local disk
   in dev). Stories expire from the feed after 24 h.
5. News tab: stories bar + unified feed (episode cards with Spotify/Apple buttons + audio, Instagram
   images/carousels/videos, X posts), infinite scroll, no user comments/uploads.
6. Web push: VAPID keys, subscribe/unsubscribe, per-user preferences (news, deadlines, live updates, community),
   push on every new News item, FPL deadline reminders at the admin-configured offsets, admin manual push.
   Each notification sent once per user per item. Dead subscriptions pruned.

## Phase 3 — Community ✅

_Passed `qa-verifier` on 2026-10-27 at ef1cc73 (second gate; the first failed on deleted-post photos staying
public — fixed)._

1. Posts (text ≤ 1000 chars, optional image upload, optional "share my team" snapshot of a GW), likes,
   threaded-flat comments, delete own post/comment, report.
2. Admin moderation: report queue, delete any post/comment, ban/unban user (banned users can read, not write).
3. Rate limits and basic content validation; infinite scroll; optional push on replies to your post.

## Phase 4 — Live broadcasts, deployment, native readiness ✅

_Passed `qa-verifier` on 2026-10-27 at 111352a (incl. App Store prerequisites: account deletion, user blocking,
community rules page). Production deployment is being brought up on Render + Vercel + Neon + Backblaze B2._

1. ~~WhatsApp linking~~ — **deferred by the client** (see docs/CLIENT_ACCOUNTS.md → WhatsApp). Not built now.
2. Broadcast composer (e.g. goal alert): text + optional image → News feed item, push, X post — each target
   toggleable, per-target result shown; targets are `Publisher`s so a WhatsApp target can be added later.
3. Deployment: `render.yaml` (api on Render free, Frankfurt; Neon Postgres; Backblaze B2 media), Vercel config for web, GitHub Actions cron hitting the
   tick endpoint, `docs/DEPLOY.md` + `docs/INTEGRATIONS.md` (step-by-step key setup for the client).
4. Native readiness: Capacitor config + `docs/NATIVE.md` (iOS/Android build steps, FCM/APNs provider plan).
