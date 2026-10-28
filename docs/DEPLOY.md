# Deploying Fantasyonerim

| Piece                                      | Host                                                | Config                            |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------- |
| API (`apps/api`)                           | Render web service, Frankfurt                       | `render.yaml` (Blueprint)         |
| Database                                   | **Neon free tier** (persistent Postgres, Frankfurt) | `DATABASE_URL`                    |
| Media (Instagram copies, community photos) | **Backblaze B2** (S3-compatible, 10 GB free)        | `S3_*`, `MEDIA_PUBLIC_BASE_URL`   |
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
3. Free-tier limits that matter here: 0.5 GB storage (years of posts/news for this app — media lives in B2, not
   the DB) and compute that suspends when idle (the first query after a pause takes ~1 s).

## 2. Media bucket — Backblaze B2 (free 10 GB)

1. backblaze.com → B2 Cloud Storage → sign up, region **EU Central**.
2. Buckets → Create a Bucket `fantasyonerim-media`, Files in Bucket: **Public**. The bucket **must** be Public: the
   web app's `/media/*` rewrite (see [Keep B2 free](#keep-b2-free)) fetches objects anonymously. (If B2 refuses
   public buckets until the account is verified, verify it.)
3. Note the bucket's **Endpoint**, e.g. `s3.eu-central-003.backblazeb2.com`:
   - `S3_ENDPOINT` = `https://s3.eu-central-003.backblazeb2.com`
   - `S3_REGION` = `eu-central-003`
   - `S3_BUCKET` = the bucket name
   - `S3_PUBLIC_BASE_URL` = `https://f003.backblazeb2.com/file/<bucket>` (the number matches the endpoint's `003`)
4. Application Keys → Add a New Application Key → only this bucket, **Read and Write** → `S3_ACCESS_KEY_ID` =
   keyID, `S3_SECRET_ACCESS_KEY` = applicationKey (shown once).

## 3. API on Render

1. Render → New → Blueprint → connect this GitHub repo → it reads `render.yaml`.
2. Fill the `sync: false` variables:

| Variable                                                                                                  | Value                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                            | from step 1                                                                                                                                                         |
| `API_PUBLIC_URL`                                                                                          | the service URL, e.g. `https://fantasyonerim-api.onrender.com`                                                                                                      |
| `WEB_APP_URL`                                                                                             | the Vercel URL from step 4 (set after it exists, then redeploy)                                                                                                     |
| `CORS_ORIGINS`                                                                                            | same as `WEB_APP_URL` (comma-separate if you add a custom domain)                                                                                                   |
| `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD`                                                   | the first admin login (≥ 8-char password). Change it after first login (admin console → Account). It only creates an admin on an empty install, so it can stay set. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`                                                                  | run `npm run vapid -w @fant/api` locally once; **never change them later** (it would silently break every existing push subscription)                               |
| `VAPID_SUBJECT`                                                                                           | `mailto:ashalim.fantasy@gmail.com`                                                                                                                                  |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` | from step 2                                                                                                                                                         |
| `MEDIA_PUBLIC_BASE_URL`                                                                                   | `https://fantasyonerim.vercel.app/media` — clients load media through the web app's CDN instead of straight from B2 (see [Keep B2 free](#keep-b2-free))             |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`                                                             | the owner-approved Spotify app keys — seeded encrypted into the Spotify integration on first boot, so every episode gets its Spotify link with no manual step       |
| `META_APP_ID` / `META_APP_SECRET`                                                                         | from the Meta app (only needed to connect Instagram; can be added later)                                                                                            |

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

## Keep B2 free

Backblaze's free tier is 10 GB stored, 1 GB/day download and about 2,500 Class B (download) transactions/day. Fans
viewing images straight from B2 would blow through that quickly, so every media URL the API returns goes through the
Vercel CDN instead, and B2 is hit roughly once per object per Vercel region:

- **Rewrite.** `vercel.json` rewrites `/media/:path*` → `https://f003.backblazeb2.com/file/fantasyonerim-media/:path*`.
  The API serves `MEDIA_PUBLIC_BASE_URL/<key>` (= `https://fantasyonerim.vercel.app/media/<key>`). The DB keeps the
  B2 URLs it always had; they are rewritten when serialized (news media + posters, community photos, upload
  responses, push images), so old rows work with no migration. Deletes always go by storage key, never by URL.
  **Unset `MEDIA_PUBLIC_BASE_URL` = exactly the old behaviour** (direct B2 URLs), so the API can deploy first. If
  the bucket or the web domain changes, update the rewrite destination and `MEDIA_PUBLIC_BASE_URL` together.
- **CDN caching.** Vercel caches an external rewrite only when the response allows shared caching (`s-maxage`,
  `CDN-Cache-Control` or `Vercel-CDN-Cache-Control`); a plain `max-age` only reaches browsers. Both sides say so:
  - each object is uploaded with its Cache-Control (`mediaCacheControl()` in `apps/api/src/media/store.ts`), which
    B2 returns on every read: now including `s-maxage`;
  - `vercel.json` adds `CDN-Cache-Control`, a `Cache-Control` with `s-maxage`, and the
    `x-vercel-enable-rewrite-caching` opt-in on `/media/*`, which also covers objects uploaded before `s-maxage`
    was added.
- **TTLs.** Instagram/X copies and Spotify episode thumbnails (`instagram/…`, `spotify/<guid>/thumbnail.*`) never
  change: 30 days in the CDN, a year in browsers. Community photos (`uploads/…`) get **5 minutes** in the CDN and in
  browsers. A deleted or moderated post's photo is removed from B2 immediately (purge job), and then disappears from
  the CDN and browsers within about 5 minutes (10 at the very worst, CDN + browser). Don't raise the `uploads/` TTL: it is the takedown delay. The values
  live in `mediaCacheControl()` and in `vercel.json`, so change both together.
- **Check it works** after a deploy: `curl -sI https://fantasyonerim.vercel.app/media/<some key>` twice. The second
  response should say `x-vercel-cache: HIT` (an `Age` header growing). `MISS` every time means the CDN isn't caching:
  check the bucket is Public and the headers above are deployed.
- **Hard stop at $0.** Backblaze → **Caps & Alerts**: set the daily caps for Storage, Download bandwidth, Class B
  and Class C transactions to **$0**, and turn on the email (and SMS) alerts. At a $0 cap B2 refuses requests over
  the free allowance instead of billing. Images may stop loading for the rest of that day, but there is never a
  charge, and the alert email says which limit was hit.
- Vercel's side (Hobby plan) has its own generous free bandwidth/edge-request allowance; images count toward it.

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
6. Admins for Dor and Itay: admin console → Admins → create an invite link per person and send it to them. Each
   link works once, for 7 days; opening it lets them sign up with name + Team ID and they are admins from the start.

## How updates reach installed apps

Every Vercel deploy reaches phones that installed the PWA to the home screen (iOS Safari, Android Chrome) by
itself: no reinstall, no manual refresh, nothing to do on deploy. How it works (`apps/web/src/lib/updates.ts`):

1. **Each build has an id.** `next.config.ts` sets `NEXT_PUBLIC_BUILD_ID` = commit sha + build time (so a redeploy
   of the same commit counts as new). The `postbuild` step (`scripts/stamp-build.mjs`) writes `out/version.json`
   (`{ buildId, builtAt }`) and stamps the id into `out/sw.js`. The id is also on `<html data-build>` and shown in
   Profile next to the version.
2. **The app checks.** It checks on every resume (`visibilitychange`, `pageshow`, window `focus`, plus a
   heartbeat that notices a page iOS froze for days) and every 15 minutes while it is open. Each check calls
   `registration.update()` and fetches `/version.json` with `cache: 'no-store'`. `vercel.json` serves it
   `no-store`, and the service worker never intercepts it.
3. **Update policy** when the id differs:
   - just reopened, going to the background, or idle for a minute → reload now (on resume the old screen shows
     for a moment, then the new one);
   - the user is writing (a textarea with text, a focused field with content, a filled field in an open sheet)
     → a small toast, "גרסה חדשה זמינה — רענון" / "New version — refresh". The app reloads once the draft is gone
     and the user pauses for 4 s, or right away on a tap. Post, comment and live-update drafts are also kept in
     `sessionStorage` (`lib/drafts.ts`), so a reload never loses them;
   - in use but not typing (scrolling a feed) → the same toast, then a reload after a minute idle or on the next
     resume/background.
4. **No loops.** The app auto-reloads at most once per target build, and at most 3 times, in 10 minutes
   (`sessionStorage`). If `version.json` still differs after that one reload (a CDN still rolling out, or HTML
   from the offline cache), it stops and tries again after the window.
5. **The service worker updates itself.** The stamped `sw.js` is byte-different on every deploy, so the browser
   installs it. It calls `skipWaiting` on install, and the page also posts `SKIP_WAITING` to any worker left
   waiting. Chrome evaluates `skipWaiting` only once, so a new worker that arrived while the old one was busy
   could otherwise stay waiting. Then `clients.claim`. Cache names carry the build id, and activation deletes
   every other cache. HTML is network-first: a cached page is used only offline, or when the network takes
   longer than 4 s _and_ a cached copy exists. `/_next/static` is cache-first, and only 2xx responses are
   cached, so a 404 is never pinned. The page's own `fetch()` calls (Next's RSC payloads and prefetches) and
   `/version.json` are never intercepted. Every intercepted request settles as soon as the page aborts it, so a
   cancelled request can never keep the old worker busy and block the next deploy.
6. **Chunk errors after a deploy.** A page from the previous build that lazy-loads a chunk the new deploy no
   longer serves (404, `ChunkLoadError`, "Failed to fetch dynamically imported module") reloads once to the same
   URL. Three handlers catch it: window `error`/`unhandledrejection`, the `app/error.tsx` and
   `app/global-error.tsx` boundaries, and an inline `<head>` guard for failures before hydration. It reloads once
   per build, so a broken deploy shows the error screen instead of looping.
7. **Data is fresh on reopen.** TanStack Query's focus manager is fed the same resume signals, so News, stories,
   live scores, the Table, My Team and Community refetch within a second of reopening (when older than their
   15–60 s `staleTime`). Polling pauses while hidden and resumes on return.

The manifest keeps `id: "/"`, `start_url: "/"`, `scope: "/"`. **Never change `id`**: it would orphan existing
installs. All of this is off in `next dev` and in the Capacitor shell (`isNativeShell()`). Store builds ship
their bundle inside the app and update through the stores.

**Checking a deploy:** open `https://<web>/version.json`. Its `buildId` should match Profile → version on a phone
after you reopen the app.

## Local development

```bash
service postgresql start            # or any local Postgres
cp apps/api/.env.example apps/api/.env
npm install
npm run dev                         # api on :4000, web on :3000
```
