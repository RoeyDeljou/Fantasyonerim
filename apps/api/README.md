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
src/routes/               auth, me, fpl proxy, league, captain battle, config/health, admin
```

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

See [`.env.example`](./.env.example). In production `SECRETS_KEY` is required and `CORS_ORIGINS` may not be `*`.
