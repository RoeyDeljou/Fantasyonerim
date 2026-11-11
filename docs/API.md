# REST API (v1)

Base URL: `NEXT_PUBLIC_API_URL` (e.g. `https://fantasyonerim-api.onrender.com`). All routes under `/v1`.
Auth: `Authorization: Bearer <token>`. Errors: `ApiError` `{ error: { code, message } }`.
All schemas live in `packages/shared/src/api.ts` and `packages/shared/src/fpl.ts`.

Legend: 🌐 public · 👤 signed-in user · 🛡 admin

## Phase 1

| Method  | Path                             | Auth                    | Body / query                            | Response                                                                                      |
| ------- | -------------------------------- | ----------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET     | `/health`                        | 🌐                      | –                                       | `{ ok: true, fpl?: 'ok'\|'degraded'\|'updating' }` (no error details)                         |
| GET     | `/v1/config`                     | 🌐                      | –                                       | `PublicConfig`                                                                                |
| POST    | `/v1/auth/register`              | 🌐                      | `RegisterBody` (incl. `email`)          | `AuthResponse` (201) · 404 unknown Team ID · 409 team already registered / email already used |
| POST    | `/v1/auth/email-login`           | 🌐                      | `EmailLoginBody`                        | `AuthResponse` · 401 "Email or Team ID is incorrect" (same for every miss)                    |
| POST    | `/v1/auth/admin-login`           | 🌐                      | `AdminLoginBody`                        | `AuthResponse` · 401                                                                          |
| POST    | `/v1/auth/logout`                | 👤                      | –                                       | 204                                                                                           |
| GET     | `/v1/me`                         | 👤                      | –                                       | `Me`                                                                                          |
| PATCH   | `/v1/me`                         | 👤                      | `UpdateMeBody`                          | `Me` · 409 email already used by another account                                              |
| GET     | `/v1/fpl/bootstrap`              | 🌐                      | –                                       | `Bootstrap`                                                                                   |
| GET     | `/v1/fpl/fixtures`               | 🌐                      | `?event=`                               | `Fixture[]`                                                                                   |
| GET     | `/v1/fpl/fixtures/:fixtureId`    | 🌐                      | –                                       | `FixtureDetail` (match sheet) · 404 unknown fixture · 400 invalid id                          |
| GET     | `/v1/fpl/entries/:entryId`       | 🌐                      | –                                       | `EntrySummary`                                                                                |
| GET     | `/v1/fpl/entries/:entryId/picks` | 🌐                      | `?event=` (default current)             | `EntryPicks`                                                                                  |
| GET     | `/v1/fpl/entries/:entryId/live`  | 🌐                      | `?event=` (default current)             | `EntryLive`                                                                                   |
| GET     | `/v1/league/standings`           | 🌐                      | `?page=`                                | `LeagueStandings` · 404 when no league configured                                             |
| GET     | `/v1/league/live`                | 🌐                      | `?page=`                                | `LiveLeague`                                                                                  |
| GET     | `/v1/league/position`            | 👤                      | –                                       | `LeaguePosition` (find my team, below) · 404 when no league set                               |
| GET     | `/v1/captain-battle`             | 🌐 (👤 adds "mine" row) | –                                       | `CaptainBattle`                                                                               |
| GET     | `/v1/league/season-captains`     | 🌐                      | –                                       | `SeasonCaptains` (season Captain Battle leaderboard, below)                                   |
| GET     | `/v1/league/roundup`             | 🌐 (👤 adds "mine" row) | `?event=` (default: latest official GW) | `GameweekRoundup` (Gameweek Roundup, below) · 400 event outside 1…current GW                  |
| GET/PUT | `/v1/admin/settings`             | 🛡                       | `AdminSettings`                         | `AdminSettings`                                                                               |
| GET/PUT | `/v1/admin/captain-battle`       | 🛡                       | `CaptainBattleConfig`                   | `CaptainBattleConfig` (GET → null when unset)                                                 |
| GET     | `/v1/admin/admins`               | 🛡                       | –                                       | `AdminAccount[]`                                                                              |
| POST    | `/v1/admin/admins`               | 🛡                       | `CreateAdminBody`                       | `AdminAccount` (201)                                                                          |

Upstream FPL failures map to `503 upstream_unavailable`.

`/v1/fpl/fixtures/:fixtureId` sets `Cache-Control` by fixture state: `public, max-age=15, stale-while-revalidate=15`
while `live` or `finished_provisional`, `public, max-age=60, stale-while-revalidate=30` before kick-off,
`public, max-age=600, stale-while-revalidate=600` once `finished`.

`/v1/captain-battle` follows FPL's current GW (or the next one before the season's first deadline), not the GW the
battle was last saved for: team-linked rows (`source: 'entry'`) read that GW's captain with no admin action. A battle
saved for a later GW is shown for that GW. Hand-picked rows (`source: 'player'`) saved for an earlier GW come back
with `playerId: null`, `live: null` ("not picked yet for GW n", sorted last) until the admin picks again.

**Permanent captains and tags.** `community` and `fpl_lad` are the two permanent special captains: one row each per
battle (`CaptainBattleConfig` refuses duplicates). Every row has `kind` (`community` | `fpl_lad` | `custom`, plus
`mine` for the viewer) and an admin-chosen `tag` (badge text, trimmed, ≤ 24 chars; empty = `null` = the client's
default for the kind/source). `GET /v1/captain-battle` always lists both permanent captains: when the latest saved
battle has none (it predates them, or the admin deleted the row) a virtual row is added (`key` = the kind,
default label `קפטן הקהילה` / `הקפטן של FPL Lad`, `playerId: null`, `live: null`, sorted last). The viewer's `mine` row
has `tag: null`. Saving (`PUT /v1/admin/captain-battle`) stores any missing permanent captain first, with the default label and
`playerId: null` ("not picked yet"; the DB check allows a player-less PLAYER row only for `COMMUNITY` / `FPL_LAD`, a
`custom` player row needs a player). `GET /v1/admin/captain-battle` always lists both permanent rows first, even for a
battle saved before they existed (still `null` when no battle was ever saved). A stored unpicked row behaves like the
virtual one in the live battle and the roundup (`playerId: null`, 0 points). The previous release null-checks
`playerId` in the live battle and roundup, but its admin GET rejects such a row until the new release is serving.
With no battle saved at all the public board stays empty.

**Boot-time upgrade** (`upgradeCaptainKinds`, `src/league/captains.ts`, runs after the server listens): in every saved
battle an entry labelled like `/fpl\s*-?\s*lad/i` whose kind isn't `FPL_LAD` becomes `FPL_LAD` (production had it as
`COMMUNITY`), and of duplicates of a permanent kind the first by `order` stays, the rest become `CUSTOM`. Idempotent.
It is code, not a migration, because a migration adds the `FPL_LAD` enum value in a transaction that cannot use it, and
the previous release (still serving during a Render deploy) cannot read that value: nothing writes it until the new
release is up.

**Find my team** (`/v1/league/position`). `page` is the standings page (50 per page) that holds the team, and the
same `page` works for `/v1/league/live`: FplService builds live page N from the managers of standings page N and
re-ranks them **within** that page only (live ranks are numbered from `(N − 1) × 50 + 1`), so no manager moves
between pages in the live table. Only the order inside the page and `liveRank` can differ from the standings.
The API keeps one entry → page/rank index per league, filled page by page (stopping at the first page with the
team, at most 40 pages) and rebuilt after the standings TTL (2 min) or an admin settings change, so 150 users
asking cost one scan. A user without a team gets all three null; a team not in the league gets `page`/`rank` null.
Per user: `private, no-cache` with an ETag.

**Membership** (`member` on `/v1/league/position`): true when the team is in the standings **or** among the
league's _new entries_ (joined since FPL's last update; FPL ranks them only after the next GW update, so those have
`page`/`rank` null). One shared, cached read of the new entries per league (2 min). FPL failing there gives `false`
for an unranked team, not an error. No team → `false`.

**Join our league** (`PublicConfig.leagueJoin`, `AdminSettings.leagueCode`): `{ code, url }` with FPL's invite link
`https://fantasy.premierleague.com/leagues/auto-join/<code>`, or `null` without a league or a code. The stored code
wins; when none is stored, the league's default from `apps/api/src/league/config.ts` applies (the client league
4611 → `KJJGKB`). `PUT /v1/admin/settings`: `leagueCode` omitted keeps the stored code, `null` clears it (back to the
default), a 6-character code is stored upper-cased. Registration never checks membership: any FPL team can sign up.

**Guests** (no account): every public read works without a token — config, news (+ item, stories, filters), league
standings and live table, captain battle (no "mine" row), fixtures and match sheet, bootstrap, an entry and its
picks/live, community posts, a post and its comments (nothing `mine`/`likedByMe`). Per-user routes (`/v1/me*`,
`/v1/league/position`, writes) answer 401.

## Phase 2 — News feed, push, integrations

Schemas: `packages/shared/src/news.ts`.

| Method  | Path                                           | Auth                          | Body / query                                | Response                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------- | ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET     | `/v1/news`                                     | 🌐                            | `NewsPageQuery` (`?cursor=&limit=&filter=`) | `NewsPage` — newest first, stories and hidden items excluded. `filter` (episodes · shorts · videos · instagram · x · updates) keeps only `NEWS_FILTER_SOURCES[filter]`; a cursor works only with the filter it was issued for (400 otherwise); unknown filter → 400 |
| GET     | `/v1/news/filters`                             | 🌐                            | –                                           | `NewsFilters` — the filters with ≥ 1 visible item, in display order (`Cache-Control: public, max-age=60`)                                                                                                                                                           |
| GET     | `/v1/news/stories`                             | 🌐                            | –                                           | `Stories` — unexpired stories, oldest first                                                                                                                                                                                                                         |
| GET     | `/v1/news/:id`                                 | 🌐                            | –                                           | `NewsItem` (deep link from a push) · 404                                                                                                                                                                                                                            |
| GET     | `/v1/push/vapid-public-key`                    | 🌐                            | –                                           | `{ publicKey }` · 503 when VAPID isn't configured                                                                                                                                                                                                                   |
| POST    | `/v1/push/subscriptions`                       | 👤                            | `WebPushSubscriptionBody`                   | 204 — upsert by endpoint (re-binds the endpoint to this user)                                                                                                                                                                                                       |
| DELETE  | `/v1/push/subscriptions`                       | 👤                            | `{ endpoint }`                              | 204                                                                                                                                                                                                                                                                 |
| POST    | `/v1/push/devices`                             | 👤                            | `NativePushDeviceBody`                      | 204 — stored for the future native apps (no sender yet)                                                                                                                                                                                                             |
| GET/PUT | `/v1/me/notification-prefs`                    | 👤                            | `NotificationPrefs`                         | `NotificationPrefs` (defaults: all true). `league` / `captain` are optional on PUT: when omitted the stored values are kept                                                                                                                                         |
| GET     | `/v1/admin/integrations`                       | 🛡                             | –                                           | `IntegrationList` — one row per `IntegrationId`, secrets never returned                                                                                                                                                                                             |
| PUT     | `/v1/admin/integrations/:id`                   | 🛡                             | `IntegrationUpdateBody`                     | `IntegrationStatus` · 400 with a field-specific message                                                                                                                                                                                                             |
| POST    | `/v1/admin/integrations/:id/sync`              | 🛡                             | –                                           | `IntegrationStatus` after running that source now                                                                                                                                                                                                                   |
| GET     | `/v1/admin/integrations/instagram/connect-url` | 🛡                             | –                                           | `{ url }` (Meta OAuth dialog, signed `state`) · 503 when META_APP_ID unset                                                                                                                                                                                          |
| GET     | `/v1/integrations/instagram/callback`          | 🌐 (state-verified)           | `?code=&state=`                             | 302 → `${WEB_APP_URL}/admin/?instagram=connected` or `?instagram=error&reason=`                                                                                                                                                                                     |
| DELETE  | `/v1/admin/integrations/instagram`             | 🛡                             | –                                           | 204 — forget token + account                                                                                                                                                                                                                                        |
| POST    | `/v1/admin/news`                               | 🛡                             | `AdminNewsBody`                             | `NewsItem` (201) — manual fallback post, source `admin_update`                                                                                                                                                                                                      |
| DELETE  | `/v1/admin/news/:id`                           | 🛡                             | –                                           | 204 — hides the item from the feed (kept for dedupe)                                                                                                                                                                                                                |
| POST    | `/v1/admin/push`                               | 🛡                             | `AdminPushBody`                             | `AdminPushResult`                                                                                                                                                                                                                                                   |
| POST    | `/internal/jobs/tick`                          | `x-cron-secret: $CRON_SECRET` | –                                           | `{ ran: string[] }` — runs every due job; 401 on a bad secret                                                                                                                                                                                                       |
| GET     | `/media/*`                                     | 🌐                            | –                                           | re-hosted media bytes (local MediaStore only; S3/R2 serves its own public URL)                                                                                                                                                                                      |

## Phase 3 — Community

Schemas: `packages/shared/src/community.ts`. Banned users get 403 on every write.

| Method      | Path                                  | Auth                         | Body / query                                  | Response                                                                                                        |
| ----------- | ------------------------------------- | ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| GET         | `/v1/community/posts`                 | 🌐 (👤 fills likedByMe/mine) | `CommunityPageQuery`                          | `CommunityPage` — newest first, removed posts excluded                                                          |
| GET         | `/v1/community/posts/:id`             | 🌐                           | –                                             | `CommunityPost` · 404                                                                                           |
| POST        | `/v1/community/posts`                 | 👤                           | `CreatePostBody`                              | `CommunityPost` (201) · 400 · 429 (10 posts/hour)                                                               |
| DELETE      | `/v1/community/posts/:id`             | 👤 own / 🛡 any               | –                                             | 204 (soft delete)                                                                                               |
| PUT/DELETE  | `/v1/community/posts/:id/like`        | 👤                           | –                                             | `LikeResult` (idempotent)                                                                                       |
| GET         | `/v1/community/posts/:id/comments`    | 🌐                           | `?cursor=`                                    | `CommentPage` — oldest first                                                                                    |
| POST        | `/v1/community/posts/:id/comments`    | 👤                           | `CreateCommentBody`                           | `Comment` (201) · 429 (60/hour) — pushes the post author (prefs.community), once per comment, never to yourself |
| DELETE      | `/v1/community/comments/:id`          | 👤 own / 🛡 any               | –                                             | 204                                                                                                             |
| POST        | `/v1/community/posts/:id/report`      | 👤                           | `ReportBody`                                  | 204 (idempotent per user/target)                                                                                |
| POST        | `/v1/community/comments/:id/report`   | 👤                           | `ReportBody`                                  | 204                                                                                                             |
| POST        | `/v1/uploads`                         | 👤                           | multipart `file` (jpeg/png/webp/heic ≤ 10 MB) | `UploadResponse` (201) — re-encoded to webp/jpeg ≤ 2048 px, EXIF stripped · 413 / 415                           |
| GET         | `/v1/admin/reports`                   | 🛡                            | `?status=open`                                | `ReportList`                                                                                                    |
| POST        | `/v1/admin/reports/:targetId/resolve` | 🛡                            | `ResolveReportBody`                           | 204                                                                                                             |
| GET         | `/v1/admin/users`                     | 🛡                            | `?query=` (name / team / Team ID / email)     | `AdminUserList`                                                                                                 |
| PUT         | `/v1/admin/users/:id/email`           | 🛡                            | `AdminUserEmailBody` (`null` clears)          | `AdminUser` (200) · 404 unknown user · 409 email already used by another account                                |
| POST/DELETE | `/v1/admin/users/:id/ban`             | 🛡                            | `BanBody` (POST)                              | 204 — admins can't be banned                                                                                    |
| GET         | `/v1/admin/news/hidden`               | 🛡                            | –                                             | `HiddenNewsList`                                                                                                |
| POST        | `/v1/admin/news/:id/restore`          | 🛡                            | –                                             | 204 — un-hides a News item                                                                                      |

## Phase 4 — Live broadcasts, admin security

Schemas: `packages/shared/src/broadcast.ts`.

| Method     | Path                           | Auth | Body / query                                    | Response                                                                                 |
| ---------- | ------------------------------ | ---- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET        | `/v1/admin/broadcast/targets`  | 🛡    | –                                               | `BroadcastTargetsStatus`                                                                 |
| POST       | `/v1/admin/broadcast`          | 🛡    | `BroadcastBody`                                 | `BroadcastResult` (201) — per-target results; one target failing never blocks the others |
| GET        | `/v1/admin/broadcasts`         | 🛡    | –                                               | `BroadcastHistory`                                                                       |
| POST       | `/v1/admin/me/password`        | 🛡    | `ChangePasswordBody`                            | 204 · 401 wrong current password — signs out the admin's other sessions                  |
| GET        | `/v1/community/blocks`         | 👤   | –                                               | `BlockList`                                                                              |
| PUT/DELETE | `/v1/community/blocks/:userId` | 👤   | –                                               | 204 — idempotent; 400 for yourself or an admin                                           |
| DELETE     | `/v1/me`                       | 👤   | `DeleteAccountBody` (`{ "confirm": "DELETE" }`) | 204 — deletes everything about the account · 409 last admin                              |

## Admin invites

| Method | Path                        | Auth | Body / query                          | Response                                                                                                                                                       |
| ------ | --------------------------- | ---- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/admin/invites`         | 🛡    | `CreateAdminInviteBody`               | `AdminInviteCreated` (201) — the only response containing the link; `url` = `${WEB_APP_URL}/onboarding/#invite=<token>` (fragment: never reaches a server log) |
| GET    | `/v1/admin/invites`         | 🛡    | –                                     | `AdminInviteList`                                                                                                                                              |
| DELETE | `/v1/admin/invites/:id`     | 🛡    | –                                     | 204 — revoke (pending only; 409 otherwise)                                                                                                                     |
| POST   | `/v1/admin-invites/preview` | 🌐   | `RedeemAdminInviteBody` (`{ token }`) | `AdminInvitePreview` · 404 invalid/used/expired/revoked/malformed (generic) — token in the body, never in a URL                                                |
| POST   | `/v1/auth/register`         | 🌐   | `RegisterBody` + `inviteToken`        | as before, the account is created with role admin when the token is valid; 400 "This invite link is no longer valid" otherwise (nothing created)               |
| POST   | `/v1/me/admin-invite`       | 👤   | `RedeemAdminInviteBody`               | `Me` (role admin) · 400 invalid · 409 already an admin                                                                                                         |

## Notifications sent by jobs

| Job                | Pref(s)               | Dedupe key (per user)                        | What                                                                                                                                                                                                       |
| ------------------ | --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gameweek_summary` | `fpl` and/or `league` | `gw_summary:<gw>`                            | One push per finished GW: league moments (top scorer, first place, climbed 3+, into top 3 / top 10; ≤ 2, never negative) + the GW points / overall rank line. URL `/table/` with moments, else `/my-team/` |
| `live_alerts`      | `captain`             | `live:<gw>:cap:<playerId>:g<n>` / `:a<n>`    | Your effective captain scored / assisted (every new goal or assist observed between two runs)                                                                                                              |
| `live_alerts`      | `league`              | `live:<gw>:first:<n>` · `live:<gw>:jump:<n>` | Moved into first place of the live league (≤ 1/h) · jumped 5+ places vs the GW baseline / last alert (≤ 1 per 2 h, ≤ 3 per GW). ≤ 6 live alerts per user per GW in total                                   |

| `community_captain` | none (kind `admin`) | `community_captain:<gw>:tied` / `:no_votes` | To every ADMIN user with a push subscription: the Community Captain vote for GW N ended in a tie (names up to 4 tied players) or nobody voted. URL `/admin/?card=vote` |

`live_alerts` runs every 2 minutes while a fixture of the current GW is live (plus one pass after the last one ends);
its first run of a GW only records a baseline. Pushes: urgency high, TTL 1 h, a unique tag per alert.

## Gameweek Roundup (סיכום מחזור)

`GET /v1/league/roundup?event=<gw>` serves the podcast league's stored, final results of one GW (`GameweekRoundup`).

- **`status`**: `unavailable` when no league is configured (or a stored row no longer parses); `pending` when the GW
  isn't `finished && dataChecked` yet ("Come back at the end of the game week!"); `building` when it is, but the job
  hasn't stored its roundup for the configured league yet; `ready` otherwise. Every section other than `ready` is
  empty (`league`, `participants`, … null, `table`/`captains` `[]`, `builtAt` null).
- **`event`** defaults to the latest official GW; before any GW is official, FPL's current GW (the next one before the
  season starts) with `pending`. **`events`** = 1 … current GW. `event` must be an integer in that range (400).
- **Captains**: that GW's captain battle with final points, stored when the roundup was built, sorted by
  `captainPoints` desc. The battle used is the one saved for the latest GW ≤ `event` (as the live battle showed it):
  team-linked rows read that team's picks (the captain, or the vice who got the armband, × the team's multiplier);
  hand-picked rows count only when the battle was saved for exactly that GW (base points × 2). No battle → `[]`.
- **`mine`** (`key: "me"`, `label: "mine"`, the client shows its own i18n text): a signed-in fan with a Team ID gets
  their own captain that GW, on `ready` GWs only, even without a battle — from their stored table row when they're a
  league member (no FPL call), else from their picks + the GW's points. A team with no picks that GW (404) or FPL
  failing → no row, never an error.
- **Caching**: without a token `public, max-age=60, stale-while-revalidate=120` + `Vary: Authorization` (the shared
  body is computed once per 30 s for everybody and dropped as soon as a roundup is stored); with a token
  `private, no-cache`.
- **Storage**: `GameweekRoundup` rows are keyed by `(leagueId, event)`, so changing the league in admin settings
  never serves the previous league's roundups (the new league's are built by the job, previous ones are kept).

**Job `gameweek_roundup`** (every 5 min, lease 15 min, also via `/internal/jobs/tick`). Builds every official GW
without a stored roundup for the configured league, newest first, then back-fills older ones. The newest official GW
is built only 5 minutes (`FPL_CACHE_TTL.history`) after the job first saw it official; older GWs right away. Every FPL read behind a stored roundup is
`{ fresh: true }` (never a cached copy, e.g. live-GW picks from before auto-subs, and never stale-if-error data); the
cached bootstrap only decides whether there is work and is re-read fresh right before building. Per run:
league info + all standings pages, then history + transfers once per member (reused for every GW of the run), then
per GW one `event/{gw}/live/` and one picks request per member, all at concurrency 4 (`ROUNDUP_FETCH_CONCURRENCY`).
The run is bounded by a budget of 1,000 FPL requests: `max(1, ⌊(1000 − 2N) / (N + 1)⌋)` GWs for N members, i.e. 3 GWs
for 171 members (~860 requests, ~1 minute). A full back-fill of 10 GWs therefore takes 4 runs, ~15–20 minutes. A GW
is stored only when complete: an `FplUnavailableError` aborts the run (lastError on the job lease), nothing partial
is stored and the next run retries; while FplService is backing off (`getHealth().retryAt`) the run makes no FPL call.
A member's 404 (history or picks) leaves that member, or that data, blank. GWs before the league's `startEvent`
are stored with blank sections (captain rows still computed). Members are the league's current standings (FPL has no
historical member list).

**Ranks and totals**: official FPL standings for the newest GW at build time; older GWs reconstructed from each
team's history. When the job builds the newest official GW, `rank`, `lastRank` (FPL `last_rank` 0 = joined since the
last update → null) and `total` come from FPL's classic standings (read fresh), the table is ordered by official rank,
and biggest climb / drop are recomputed from them (places, then higher GW points, then table order). Guards: the
official table is used only while the fresh bootstrap's current GW is the GW being built, and only when at least 90%
of the official totals equal the reconstructed ones; otherwise FPL's table has moved on to a newer GW and the
reconstructed values are kept. Back-filled GWs (FPL keeps no historical league tables) are always reconstructed:
total = Σ (GW points − hits) from the league's `startEvent`, ranked by total then fewer transfers. `eventPoints` and
the league average are net of hits in both cases.

**Builder version** (`GameweekRoundup.buildVersion`, `ROUNDUP_BUILD_VERSION` in `apps/api/src/league/roundup.ts`,
currently 3; rows stored before the column existed are 1). A stored row of an older version counts as needing a
rebuild for any GW, exactly like a missing one: newest first, within the same per-run budget. The rebuilt row
replaces the old one atomically (delete of the older-version row + create, in one transaction; a current-version row
is never replaced) and the route's cached copy of that GW is dropped. Version 3 = captain rows carry `tag` and the
`fpl_lad` kind; older rows have no `tag` key (parsed as `null`) and the FPL Lad captain as `community`. Until then the old row keeps being served (no
`building` gap). Code from before versioning never deletes or overwrites a row, so anything it writes during a
deploy (as version 1) is healed by the next run. **Changing a roundup rule that must reach stored roundups = bump
`ROUNDUP_BUILD_VERSION`.**

## Season Captain Battle (קרב קפטנים עונתי)

`GET /v1/league/season-captains` (public) ranks the configured league's teams **and** the two permanent special
captains (community, FPL Lad) by **total captain points** over the season, not by GW wins. Computed only from the
stored `GameweekRoundup` rows of the configured league (no FPL calls); rows of another league are ignored, rows that no
longer parse are skipped.

- A team's GW captain points = base points of its table row's `captainPlayerId` (the stored `captainPoints` map) × 3
  when `chip === '3xc'`, else × 2. A row without a captain adds 0 and that GW is not in `gameweeks`.
- `community` / `fpl_lad`: the sum of `captainPoints` of the stored captain rows of that kind (`name` / `tag` = the
  latest label / tag; `gameweeks` = GWs where the row had a player; left out when that is 0). Hand-picked rows only
  count in the GW the battle was saved for (see Gameweek Roundup), so a captain nobody picked for a GW scores 0 there.
- `host`: `'dor' | 'itay' | null` on `manager` rows whose `entryId` is a podcast host's team (`CLIENT_HOSTS` in `@fant/shared`); null for everyone else and for the special captains. It changes neither rank nor points.
- **Start of the competition**: only stored roundups with `event >= SEASON_CAPTAINS_FROM_EVENT` (10, in `src/league/seasonCaptains.ts`; client decision, Nov 2026: the community and FPL Lad captains only have data from GW10) count, for teams and special captains alike, so `points`, `gameweeks` and `throughEvent` all start there. `fromEvent` in the response is that GW (null only when `unavailable`). Only earlier GWs stored → `building`, `rows` empty, `fromEvent` still set.
- `rank`: competition ranking over `points` desc, then `name` (1, 2, 2, 4). `throughEvent` = highest GW included.
- `status`: `unavailable` (no league), `building` (no usable stored roundup yet), else `ready`.
- Rows still at an older builder version are used as-is until the job replaces them. Version 1–2 rows keep the FPL
  Lad captain as a `community` row: those are read as `fpl_lad` when the label matches `/fpl\s*-?\s*lad/i`; their tags
  are `null` until rebuilt.
- Caching: one shared body per minute (hot cache, also dropped when the job stores a roundup or the league changes),
  `public, max-age=60, stale-while-revalidate=120`, `Vary: Accept-Encoding`, ETag. Nothing viewer-specific.

## My Community Captain (קפטן הקהילה שלי)

Fans vote for the community captain of the next GW; at the deadline the most-voted player becomes the community row of
the captain battle. Contract: `packages/shared/src/communityCaptain.ts`.

| Method | Path                                  | Auth                  | Body                               | Response                                                                                          |
| ------ | ------------------------------------- | --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/v1/community-captain`               | 🌐 (👤 adds `myPick`) | –                                  | `CommunityCaptainState`                                                                           |
| PUT    | `/v1/community-captain`               | 👤                    | `CommunityCaptainVoteBody`         | `CommunityCaptainState` · 400 wrong GW / unknown player · 403 banned · 409 closed or not open yet |
| GET    | `/v1/admin/community-captain?event=`  | 🛡                     | –                                  | `AdminCommunityCaptain` (default GW = the one the fan GET shows) · 404 unknown GW                 |
| POST   | `/v1/admin/community-captain/resolve` | 🛡                     | `AdminCommunityCaptainResolveBody` | `AdminCommunityCaptain` · 400 unknown player / GW not resolvable                                  |

- **Which GW the GET shows.** The GW in progress (deadline passed, not `finished`) is shown as `locked`, with its
  `result` (`pending` until the job has tallied, then `decided` / `tied` / `no_votes`), `voters` and the viewer's
  `myPick`. Otherwise it is the next GW whose deadline is ahead: `open` when GW N-1 is `finished` (always for GW 1),
  else `not_open`. Per GW N: open (N-1 finished … deadline N) → locked (deadline N … N finished) → the view moves on to
  N+1. The web shows "voting for N+1 opens when N ends" itself. Season over (nothing in progress, no deadline ahead)
  → `event: null`, `locked`.
- **PUT**: one vote per fan per GW (upsert, no delete). `event` must be the next GW whose deadline is ahead (the open target), the window `open` and the
  player in the bootstrap. A vote at or after the deadline (server clock vs the bootstrap deadline) is 409 "closed";
  another future GW is 400. Signed in and not banned (same 403 as other community writes); write rate limit.
- **GET** caching: guests get a shared body recomputed every ~15 s (hot cache) with
  `public, max-age=15, stale-while-revalidate=30` and `Vary: Accept-Encoding, authorization`; a signed-in viewer gets
  `private, no-cache`, `Vary: authorization` (carries their `myPick`). `voters` may lag ~15 s for guests. The tally is
  never in the fan response: `result` (top 5) only when `locked`, `status: 'pending'` until the job has run.
- **Admin view**: the live tally (up to 20), the stored result, and `battlePlayerId` (the community player set in the
  battle saved for exactly that GW).
- **Resolve** is allowed for the target GW or a GW whose deadline passed within the last 3 days. After the deadline it
  stores `decided` with `decidedById`, `source: 'votes'` when the chosen player is among the top-count players, else
  `'admin'`, and overwrites the battle's community player (an explicit admin choice). Before the deadline it only sets
  the battle (a manual pick) and stores no result; the job then records it as `decided`/`admin`.
- **Job `community_captain`** (every 2 min, also via `/internal/jobs/tick`): for GWs whose deadline passed within the
  last 24 h (and at least 10 s ago) with no `CommunityCaptainResult` row (no back-fill of older GWs), in one
  transaction (the result row, inserted with `skipDuplicates`, is the lock; the apply also takes a per-GW advisory
  lock): a community captain already set by hand for that GW wins (`decided`, `source: 'admin'`, winner = that
  player, vote untouched); else one clear winner is `decided`/`votes` and written to the captain battle; a tie is
  `tied` (+ `tiedPlayerIds`) and zero votes `no_votes`, both pushing the admins (see "Notifications sent by jobs";
  retried next run if the push failed, never re-sent). If no battle exists for N it is created from the latest earlier
  battle (same rows, labels, tags, team-linked rows; the FPL Lad player is cleared as in the live rollover; hand-picked
  custom rows keep their player because the DB check requires one), then the community row is set. The hot caches
  (live battle, config, season captains, the vote state) are invalidated.
