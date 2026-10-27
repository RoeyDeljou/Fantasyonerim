# Deploying Fantasyonerim

| Piece                                      | Host                                                | Config                            |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------- |
| API (`apps/api`)                           | Render web service, Frankfurt                       | `render.yaml` (Blueprint)         |
| Database                                   | **Neon free tier** (persistent Postgres, Frankfurt) | `DATABASE_URL`                    |
| Media (Instagram copies, community photos) | Cloudflare R2 (S3-compatible, 10 GB free)           | `S3_*`                            |
| Web app (`apps/web`, static export)        | Vercel                                              | `vercel.json`                     |
| Scheduler wake-up                          | GitHub Actions every 5 min                          | `.github/workflows/jobs-tick.yml` |

Both build commands were tested from a clean checkout (Vercel: `npm ci -w @fant/web --include-workspace-root` +
build; Render: `npm ci` + `tsc -b` + `prisma migrate deploy`, then a production boot with every required env var).

## 1. Database — Neon (free, persistent)

Chosen by the owner: Neon's free tier keeps data indefinitely (Render's free Postgres is deleted after 30 days).

1. neon.tech → sign up → New project `fantasyonerim`, Postgres 16, region **Europe Central (Frankfurt)** — same
   region as the API.
2. Dashboard → Connection details → choose **Pooled connection** → copy the string
   (`postgresql://…-pooler.…neon.tech/neondb?sslmode=require`). That's `DATABASE_URL`.
3. Free-tier limits that matter here: 0.5 GB storage (years of posts/news for this app — media lives in R2, not
   the DB) and compute that suspends when idle (the first query after a pause takes ~1 s).

## 2. Media bucket (Cloudflare R2)

1. Cloudflare dashboard → R2 → Create bucket `fantasyonerim-media`.
2. Bucket → Settings → Public access → enable the `r2.dev` URL (or connect a custom domain such as
   `media.fantasyonerim.app`). That URL is `S3_PUBLIC_BASE_URL`.
3. R2 → Manage API tokens → Create token with _Object Read & Write_ on that bucket → note the Access Key ID,
   Secret Access Key and the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

## 3. API on Render

1. Render → New → Blueprint → connect this GitHub repo → it reads `render.yaml`.
2. Fill the `sync: false` variables:

| Variable                                                                                     | Value                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                               | from step 1                                                                                                                                                   |
| `API_PUBLIC_URL`                                                                             | the service URL, e.g. `https://fantasyonerim-api.onrender.com`                                                                                                |
| `WEB_APP_URL`                                                                                | the Vercel URL from step 4 (set after it exists, then redeploy)                                                                                               |
| `CORS_ORIGINS`                                                                               | same as `WEB_APP_URL` (comma-separate if you add a custom domain)                                                                                             |
| `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`                                      | the first admin login (≥ 8-char password). Change it after first login.                                                                                       |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`                                                     | run `npm run vapid -w @fant/api` locally once; **never change them later** (it would silently break every existing push subscription)                         |
| `VAPID_SUBJECT`                                                                              | `mailto:ashalim.fantasy@gmail.com`                                                                                                                            |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` | from step 2                                                                                                                                                   |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`                                                | the owner-approved Spotify app keys — seeded encrypted into the Spotify integration on first boot, so every episode gets its Spotify link with no manual step |
| `META_APP_ID` / `META_APP_SECRET`                                                            | from the Meta app (only needed to connect Instagram; can be added later)                                                                                      |

`SECRETS_KEY` and `CRON_SECRET` are generated by Render. Don't rotate `SECRETS_KEY` — it encrypts the stored
Spotify/X/Instagram credentials (rotating means re-entering them in the admin console).

3. Deploy. Check `https://<api>/health` returns `{"ok":true}`.

**Plan:** `render.yaml` uses `plan: free`. Free services sleep after 15 minutes idle; the first request after that
takes ~50 s, which users feel when opening the app. For launch, switch to `starter` (always on, ~$7/month) — no
other change needed.

## 4. Web app on Vercel

1. Vercel → Add New Project → import this repo. Leave _Root Directory_ as the repo root (`vercel.json` sets the
   install/build commands and `apps/web/out` as the output).
2. Environment variable: `NEXT_PUBLIC_API_URL` = the API URL from step 3 (no trailing slash). It's baked in at
   build time — redeploy after changing it.
3. Deploy, then put the Vercel URL into the API's `WEB_APP_URL` and `CORS_ORIGINS` and redeploy the API.

## 5. Scheduler wake-up (GitHub Actions)

Repo → Settings → Secrets and variables → Actions → add:

- `API_URL` = the API URL
- `CRON_SECRET` = the value Render generated (Render → service → Environment → reveal `CRON_SECRET`)

The workflow runs every 5 minutes and is safe to run more often or late (jobs are idempotent and lease-guarded).
Trigger it once by hand (Actions → Jobs tick → Run workflow) and check it returns `{"ran":[…]}`.

## 6. First-run checklist

1. Open the web app → Profile → admin console (or `/admin/login/`) → sign in with the bootstrap admin.
2. **League:** set league ID `4611`.
3. **Integrations:**
   - Podcast RSS + Apple are on by default — within 5 minutes News shows all episodes.
   - Spotify: nothing to do — configured from `SPOTIFY_CLIENT_*` on first boot (check its card says connected).
   - Instagram: "Connect with Facebook" (needs `META_APP_ID`/`META_APP_SECRET` and the Facebook Page access).
   - X: paid feature — only if the client adds X API keys.
4. **Captain Battle:** fill Dor's and Itay's Team IDs and pick the community captain.
5. **Push:** on your phone, install the app to the Home Screen (iOS needs this for notifications) → Profile →
   enable notifications → admin console → "send a push to everyone" with a test message.
6. Create the real admin accounts for Dor and Itay (admin console → Admins).

## Local development

```bash
service postgresql start            # or any local Postgres
cp apps/api/.env.example apps/api/.env
npm install
npm run dev                         # api on :4000, web on :3000
```
