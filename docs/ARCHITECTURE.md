# Architecture

```
            ┌──────────── apps/web (Next.js static export, PWA) ────────────┐
 phone ───▶ │ tabs · admin console · service worker (push) · i18n he/en      │ ──┐ later: same bundle in
            └───────────────────────────────────────────────────────────────┘   │ Capacitor (iOS/Android)
                          │ HTTPS + Bearer token, @fant/shared schemas
            ┌──────────── apps/api (Fastify + Prisma/Postgres) ─────────────┐
            │ auth · fpl proxy+cache · league/captain battle · news · comm. │
            │ jobs: poll sources, deadline reminders, token refresh          │◀── external cron → /internal/jobs/tick
            │ PushProvider (web-push → FCM/APNs) · MediaStore (S3/R2)        │
            └──────┬──────────────────────────────┬─────────────────────────┘
                   │ FplService                    │ ContentSource / Publisher
            packages/fpl                     packages/integrations
            fantasy.premierleague.com        RSS · Spotify · Apple · Instagram · X · WhatsApp
```

- **Why a static export?** One bundle runs on Vercel, as an installed PWA, and inside Capacitor for the stores.
- **Why polling content sources?** Instagram, Spotify and Apple offer no "new post" webhook for this use; X
  webhooks need enterprise access. Polling every 5–10 minutes with idempotent dedupe keys is reliable and cheap.
- **Why an external cron?** Render's free tier sleeps after 15 min idle; a GitHub Actions schedule calling
  `/internal/jobs/tick` keeps ingestion and deadline reminders running (and wakes the service).
