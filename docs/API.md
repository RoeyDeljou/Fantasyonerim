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
