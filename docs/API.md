# REST API (v1)

Base URL: `NEXT_PUBLIC_API_URL` (e.g. `https://fantasyonerim-api.onrender.com`). All routes under `/v1`.
Auth: `Authorization: Bearer <token>`. Errors: `ApiError` `{ error: { code, message } }`.
All schemas live in `packages/shared/src/api.ts` and `packages/shared/src/fpl.ts`.

Legend: 🌐 public · 👤 signed-in user · 🛡 admin

## Phase 1

| Method  | Path                             | Auth                    | Body / query                | Response                                                                 |
| ------- | -------------------------------- | ----------------------- | --------------------------- | ------------------------------------------------------------------------ |
| GET     | `/health`                        | 🌐                      | –                           | `{ ok: true }`                                                           |
| GET     | `/v1/config`                     | 🌐                      | –                           | `PublicConfig`                                                           |
| POST    | `/v1/auth/register`              | 🌐                      | `RegisterBody`              | `AuthResponse` (201) · 404 unknown Team ID · 409 team already registered |
| POST    | `/v1/auth/recover`               | 🌐                      | `RecoverBody`               | `AuthResponse` · 401 wrong code                                          |
| POST    | `/v1/auth/admin-login`           | 🌐                      | `AdminLoginBody`            | `AuthResponse` · 401                                                     |
| POST    | `/v1/auth/logout`                | 👤                      | –                           | 204                                                                      |
| GET     | `/v1/me`                         | 👤                      | –                           | `Me`                                                                     |
| PATCH   | `/v1/me`                         | 👤                      | `UpdateMeBody`              | `Me`                                                                     |
| GET     | `/v1/me/recovery-code`           | 👤                      | –                           | `{ recoveryCode }`                                                       |
| GET     | `/v1/fpl/bootstrap`              | 🌐                      | –                           | `Bootstrap`                                                              |
| GET     | `/v1/fpl/fixtures`               | 🌐                      | `?event=`                   | `Fixture[]`                                                              |
| GET     | `/v1/fpl/entries/:entryId`       | 🌐                      | –                           | `EntrySummary`                                                           |
| GET     | `/v1/fpl/entries/:entryId/picks` | 🌐                      | `?event=` (default current) | `EntryPicks`                                                             |
| GET     | `/v1/fpl/entries/:entryId/live`  | 🌐                      | `?event=` (default current) | `EntryLive`                                                              |
| GET     | `/v1/league/standings`           | 🌐                      | `?page=`                    | `LeagueStandings` · 404 when no league configured                        |
| GET     | `/v1/league/live`                | 🌐                      | `?page=`                    | `LiveLeague`                                                             |
| GET     | `/v1/captain-battle`             | 🌐 (👤 adds "mine" row) | –                           | `CaptainBattle`                                                          |
| GET/PUT | `/v1/admin/settings`             | 🛡                       | `AdminSettings`             | `AdminSettings`                                                          |
| GET/PUT | `/v1/admin/captain-battle`       | 🛡                       | `CaptainBattleConfig`       | `CaptainBattleConfig` (GET → null when unset)                            |
| GET     | `/v1/admin/admins`               | 🛡                       | –                           | `AdminAccount[]`                                                         |
| POST    | `/v1/admin/admins`               | 🛡                       | `CreateAdminBody`           | `AdminAccount` (201)                                                     |

Upstream FPL failures map to `503 upstream_unavailable`.

## Phase 2 — News feed, push, integrations

Schemas: `packages/shared/src/news.ts`.

| Method  | Path                                           | Auth                          | Body / query                        | Response                                                                        |
| ------- | ---------------------------------------------- | ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| GET     | `/v1/news`                                     | 🌐                            | `NewsPageQuery` (`?cursor=&limit=`) | `NewsPage` — newest first, stories and hidden items excluded                    |
| GET     | `/v1/news/stories`                             | 🌐                            | –                                   | `Stories` — unexpired stories, oldest first                                     |
| GET     | `/v1/news/:id`                                 | 🌐                            | –                                   | `NewsItem` (deep link from a push) · 404                                        |
| GET     | `/v1/push/vapid-public-key`                    | 🌐                            | –                                   | `{ publicKey }` · 503 when VAPID isn't configured                               |
| POST    | `/v1/push/subscriptions`                       | 👤                            | `WebPushSubscriptionBody`           | 204 — upsert by endpoint (re-binds the endpoint to this user)                   |
| DELETE  | `/v1/push/subscriptions`                       | 👤                            | `{ endpoint }`                      | 204                                                                             |
| POST    | `/v1/push/devices`                             | 👤                            | `NativePushDeviceBody`              | 204 — stored for the future native apps (no sender yet)                         |
| GET/PUT | `/v1/me/notification-prefs`                    | 👤                            | `NotificationPrefs`                 | `NotificationPrefs` (defaults: all true)                                        |
| GET     | `/v1/admin/integrations`                       | 🛡                             | –                                   | `IntegrationList` — one row per `IntegrationId`, secrets never returned         |
| PUT     | `/v1/admin/integrations/:id`                   | 🛡                             | `IntegrationUpdateBody`             | `IntegrationStatus` · 400 with a field-specific message                         |
| POST    | `/v1/admin/integrations/:id/sync`              | 🛡                             | –                                   | `IntegrationStatus` after running that source now                               |
| GET     | `/v1/admin/integrations/instagram/connect-url` | 🛡                             | –                                   | `{ url }` (Meta OAuth dialog, signed `state`) · 503 when META_APP_ID unset      |
| GET     | `/v1/integrations/instagram/callback`          | 🌐 (state-verified)           | `?code=&state=`                     | 302 → `${WEB_APP_URL}/admin/?instagram=connected` or `?instagram=error&reason=` |
| DELETE  | `/v1/admin/integrations/instagram`             | 🛡                             | –                                   | 204 — forget token + account                                                    |
| POST    | `/v1/admin/news`                               | 🛡                             | `AdminNewsBody`                     | `NewsItem` (201) — manual fallback post, source `admin_update`                  |
| DELETE  | `/v1/admin/news/:id`                           | 🛡                             | –                                   | 204 — hides the item from the feed (kept for dedupe)                            |
| POST    | `/v1/admin/push`                               | 🛡                             | `AdminPushBody`                     | `AdminPushResult`                                                               |
| POST    | `/internal/jobs/tick`                          | `x-cron-secret: $CRON_SECRET` | –                                   | `{ ran: string[] }` — runs every due job; 401 on a bad secret                   |
| GET     | `/media/*`                                     | 🌐                            | –                                   | re-hosted media bytes (local MediaStore only; S3/R2 serves its own public URL)  |

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
| GET         | `/v1/admin/users`                     | 🛡                            | `?query=`                                     | `AdminUserList`                                                                                                 |
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
