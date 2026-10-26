# @fant/api

Fastify REST API (`/v1`) + Prisma/Postgres for Fantasyonerim. Route table: [`docs/API.md`](../../docs/API.md);
every request/response is validated with the Zod contract in `@fant/shared`, and all FPL data comes from the
`FplService` interface in `@fant/fpl`.

## Run locally

```bash
cp apps/api/.env.example apps/api/.env       # then edit
npm run prisma:migrate -w @fant/api          # create/upgrade the dev DB (prisma migrate dev)
npm run dev -w @fant/api                     # http://localhost:4000 (node --watch + tsx, loads .env)
FPL_MODE=demo npm run dev -w @fant/api       # offline demo data instead of fantasy.premierleague.com
```

Production: `npm run build -w @fant/api && npm run prisma:deploy -w @fant/api && npm run start -w @fant/api`.

## Tests

`npm run test` from the repo root. API tests boot the real app with `app.inject` against a real Postgres test DB
(`TEST_DATABASE_URL`, default `postgresql://fant:fant@localhost:5432/fantasyonerim_test`) and a fake in-memory
`FplService` (`tests/fakeFpl.ts`). Each test file runs `prisma migrate deploy` once and every test starts from
`TRUNCATE`d tables. `npm run db:test:reset -w @fant/api` drops and re-applies all migrations on the test DB.

## Layout

```
prisma/schema.prisma      User, Session, AdminCredential, AppSettings (singleton), CaptainBattle(+Entry)
src/server.ts             entry: env → Prisma + FplService → buildApp → bootstrap admin → listen
src/app.ts                buildApp(deps): CORS, rate limits, uniform ApiError handler, routes (deps injected)
src/env.ts                Zod-validated environment
src/fpl.ts                the only place choosing FplService (FPL_MODE=live|demo)
src/secrets.ts            AES-256-GCM encryption at rest (SECRETS_KEY)
src/auth/                 sessions (opaque token, SHA-256 at rest, sliding 1 year), argon2id, admin bootstrap
src/routes/               auth, me, fpl proxy, league, captain battle, config/health, admin,
                          news, push, integrations (+ Instagram OAuth), adminNews, internal (tick, /media)
src/integrations/         config map with the client's defaults, encrypted settings store, OAuth state, factories
src/jobs/                 job registry, JobLease runner + in-process scheduler, podcast/instagram/x/FPL/cleanup jobs
src/news/                 draft upsert (idempotent by dedupeKey, media re-hosting), serializer, new-item push
src/media/                MediaStore (LocalDisk for dev, S3/R2 for prod) + size/type-limited downloader
src/push/                 PushProvider (WebPushProvider / VAPID), notify() with dedupe + prefs, he/en copy
src/community/            image pipeline (sniff + sharp), plain-text rules, ban guard, serializers, moderation
src/routes/community.ts   posts, likes, comments, reports · uploads.ts · adminCommunity.ts (reports, users, bans)
```

## News, jobs and push (Phase 2)

- **Integrations** (`IntegrationConfig`, one row per source) are created on boot with the client's accounts
  (`src/integrations/config.ts`): podcast RSS + Apple are enabled out of the box, so the feed fills on the first
  deploy. Spotify activates once Client ID/Secret are saved, X needs a bearer token (paid), Instagram needs
  "Connect Instagram" (Meta OAuth). Secrets are AES-256-GCM encrypted and never returned (`hasSecret` only).
- **Jobs** (`src/jobs/index.ts`): `podcast` 5 min (+ link re-resolution every 30 min), `instagram_stories` 5 min,
  `instagram_posts` 10 min, `x` 10 min, `deadline_reminders` 5 min, `gameweek_summary` 30 min, `cleanup` hourly.
  Each run takes a `JobLease` row atomically, so ticks/instances never overlap. They run from the in-process
  scheduler (`JOBS_ENABLED`, every 30 s while awake) **and** from `POST /internal/jobs/tick`
  (`x-cron-secret: $CRON_SECRET`) for sleeping hosts. A failing source only sets its own `lastError`.
- **Push**: first sync of a source is silent (backfill); afterwards every new item (published < 12 h ago) is
  pushed once per user (`NotificationLog`), several items from one source in one run become one notification.
  404/410 subscriptions are deleted, other failures are counted (deleted after 5). Native FCM/APNs tokens
  (`POST /v1/push/devices`) are only stored for now — a native `PushProvider` will send to them later.
- **Media**: Instagram media is downloaded (15 MB image / 100 MB video cap, type allow-list) and re-hosted under
  deterministic keys `instagram/<mediaId>/<n>.<ext>`. `MEDIA_STORE=s3` (R2) is mandatory in production.
- `npm run vapid -w @fant/api` prints a fresh VAPID key pair.

## Community (Phase 3)

- **Posts** (`CommunityPost`): text ≤ 1000, optional image (`uploadId`) and/or a frozen `TeamSnapshot` of a
  started GW (`shareTeamEvent` ≤ FPL's current GW; picks + names copied at creation, later FPL changes don't
  touch it). Soft-deleted (`deletedAt`/`deletedBy`); deleted posts and everything under them 404.
  `likeCount`/`commentCount` are denormalized and updated in the same transaction as the like/comment row.
- **Pagination**: opaque keyset cursor `base64url(JSON [createdAt ISO, id])` — posts newest first,
  comments oldest first (`?cursor=&limit=`, limit 1..50, default 20).
- **Uploads** (`POST /v1/uploads`, multipart field `file`, ≤ 10 MB → 413): the format is sniffed from magic
  bytes (JPEG / PNG / WebP / HEIC-family; anything else or undecodable → 415, the filename and declared type
  are ignored), then sharp auto-rotates by EXIF orientation, drops **all** metadata (EXIF, GPS, XMP, ICC),
  fits it inside 2048×2048 and writes webp q82 to `uploads/<userId>/<uploadId>.webp`. An upload can be
  attached once, only by its owner; unused uploads older than 24 h are deleted by the hourly `cleanup` job.
  HEIC decoding depends on the libvips build: the prebuilt sharp binaries ship without an HEVC decoder, so
  most iPhone HEICs get a 415 asking for a JPEG (Safari normally converts HEIC to JPEG on upload anyway).
- **Text** is plain text: `\r\n` → `\n`, tabs/newlines kept, any other control character → 400.
- **Push**: a comment notifies the post author (pref `community`, never yourself), once per comment
  (`NotificationLog` key `comment:<commentId>`), url `/community/?post=<postId>`.
- **Reports** (`Report`): one open report per reporter + target (unique index over
  `targetKind, targetId, reporterId, isOpen` where `isOpen` is `true` while open and `NULL` once resolved),
  so repeats are no-ops and a dismissed target can be reported again. Reporting your own content is 400.
  Deleting content (by its author, an admin, or with its post) closes its open reports (`resolution =
deleted | removed`).
- **Moderation target ids** (`GET /v1/admin/reports`, `POST /v1/admin/reports/:targetId/resolve`):
  `post:<postId>` or `comment:<commentId>` (URL-encode the colon if your client requires it).
  `remove` soft-deletes the target and closes all its reports; `dismiss` only closes them. No open reports → 404. Groups are sorted most-reported first, then oldest.
- **Bans**: `POST /v1/admin/users/:id/ban { reason }` sets `bannedAt` (kept on re-ban) + `banReason`;
  banned users get 403 `forbidden` "Your account can't post right now" on every community write (create /
  delete posts and comments, likes, reports, uploads) but can read. Admins can't be banned (400).
- **Rate limits** (per signed-in user, not per IP): 10 posts/hour, 60 comments/hour, 30 uploads/hour; likes,
  reports and deletes share the per-minute write limit.
- **Hidden news**: `GET /v1/admin/news/hidden` (newest hidden first, expired stories excluded) and
  `POST /v1/admin/news/:id/restore` (idempotent, no re-push).

## Auth

- **Fans**: `POST /v1/auth/register` with name + FPL Team ID (verified via `FplService.getEntry`). One account
  per Team ID (409 otherwise). A recovery code `XXXX-XXXX` is generated, stored argon2id-hashed (for
  verification) and AES-256-GCM-encrypted (so Profile can show it via `GET /v1/me/recovery-code`).
  `POST /v1/auth/recover` with Team ID + code signs in on a new device.
- **Sessions**: 32-byte random bearer tokens, only the SHA-256 is stored. Each authenticated request slides
  expiry to now + 365 days (DB write throttled to once per hour per session).
- **Admins**: username + argon2id password (`POST /v1/auth/admin-login`). The first admin comes from
  `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`. Every `/v1/admin/*` route re-checks the role.
- Register / recover / admin-login are limited to 10 requests per minute per IP; everything else 600/min.

## Environment

See [`.env.example`](./.env.example). In production `SECRETS_KEY`, `CRON_SECRET`, `VAPID_*`, `API_PUBLIC_URL`,
`WEB_APP_URL` and `MEDIA_STORE=s3` + `S3_*` are required, and `CORS_ORIGINS` may not be `*`.
