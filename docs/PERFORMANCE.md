# Performance: 150 users on a live Saturday

Goal (owner): every one of the 100+ league members uses the app, and it stays fluent — no delays, lags or long
waits. Production is small on purpose: **Render free, 0.1 CPU / 512 MB, one instance (Frankfurt)**, **Neon free
(pooled, Frankfurt)**, the web app as a static Vercel export.

## Results

Same load test, same seeded data, same machine; the API process under a **0.1-CPU cgroup quota**
(`cpu.cfs_quota_us=10000/100000`, i.e. what a container CPU limit does) and a 512 MB memory limit. _Before_ is
the code at `ed1294e` (original `apps/api` + original `packages/fpl`), _after_ is this change plus the
`packages/fpl` caching work done in parallel.

### Peak mix — 150 users, 4 minutes, 0.1 CPU

| Metric                                   | Target       |                  Before |               After |
| ---------------------------------------- | ------------ | ----------------------: | ------------------: |
| Errors                                   | 0            |                       0 |                   0 |
| CPU per request (whole process, jobs in) | —            |                 3.98 ms |             2.78 ms |
| CPU used, kick-off ramp (first 30 s)     | —            | 105 % of 0.1 CPU (sat.) |     73 % of 0.1 CPU |
| CPU used, steady state                   | —            |         64 % of 0.1 CPU |     45 % of 0.1 CPU |
| RSS max                                  | < 350 MB     |                  240 MB |              218 MB |
| Event-loop delay p50 / p99 / max         | p99 < 100 ms |   5.2 / 99.6 / 1,192 ms | 5.2 / 14.5 / 707 ms |
| Bytes, `/v1/fpl/bootstrap`               | —            |                  206 KB |      10 KB (brotli) |
| Bytes, `/v1/league/live` page            | —            |                   12 KB |              1.7 KB |
| Fixture polls answered `304`             | —            |                     0 % |                88 % |

Latency per endpoint (ms, measured at the client, all 150 users):

| Endpoint                           | Kind        | Before p50 / p95 / p99 | After p50 / p95 / p99 |
| ---------------------------------- | ----------- | ---------------------: | --------------------: |
| `GET /v1/fpl/fixtures?event`       | shared      |          3 / 195 / 981 |          2 / 67 / 443 |
| `GET /v1/league/live`              | shared      |       81 / 479 / 1,199 |          2 / 96 / 444 |
| `GET /v1/fpl/fixtures/:id`         | shared      |        5 / 205 / 1,071 |          4 / 89 / 716 |
| `GET /v1/captain-battle`           | shared + me |       58 / 595 / 1,838 |         4 / 128 / 640 |
| `GET /v1/fpl/bootstrap`            | shared      |  3,194 / 6,898 / 7,298 |         6 / 193 / 493 |
| `GET /v1/config`                   | shared      |  3,193 / 6,897 / 7,402 |         7 / 198 / 398 |
| `GET /v1/news` (page 1/2)          | shared      |      107 / 779 / 1,795 |         2 / 147 / 567 |
| `GET /v1/news/stories`             | shared      |      121 / 751 / 2,635 |         3 / 293 / 947 |
| `GET /v1/news/filters`             | shared      |       45 / 378 / 1,795 |         3 / 195 / 750 |
| `GET /v1/fpl/entries/:id/live`     | per user    |          4 / 209 / 981 |         5 / 143 / 792 |
| `GET /v1/me`                       | per user    |  2,492 / 6,891 / 7,398 |          6 / 97 / 396 |
| `GET /v1/fpl/entries/:id(/picks)`  | per user    |         98 / 301 / 995 |          4 / 98 / 300 |
| `GET /v1/community/posts`          | per user    |    302 / 1,101 / 1,194 |        47 / 398 / 755 |
| `PUT /v1/community/posts/:id/like` | write       |    290 / 1,104 / 1,104 |       102 / 304 / 304 |

**Targets at 0.1 CPU, this run: all met.** Every shared endpoint has p95 < 300 ms (the slowest, `news/stories`,
is at 293 ms, a cold-key read during the kick-off ramp). User-specific endpoints are < 800 ms (worst: community at
398 ms). Errors 0, RSS 218 MB, event-loop p99 14.5 ms. Across runs, though, the app-open requests during the
kick-off ramp are not reliably under 300 ms (see [variance](#run-to-run-variance-10-minute-run-05-cpu)).
_Before_, everybody opening the app at kick-off waited **3–7 s** for config/bootstrap/me, because the 0.1 CPU was
saturated for the first 30 s.

The p99/max tail (400–900 ms) comes from single CPU bursts that the 0.1-CPU quota stretches 10×: FplService
re-parsing bootstrap (~30 ms CPU every ~4 min → ~300 ms stall) and the live feed (~15–20 ms every ~25 s), both
inside `packages/fpl` (synchronous `JSON.parse` + Zod), plus the 2-minute `live_alerts` pass (now yields every
10 managers).

### CPU per request, endpoint by endpoint (profile phase)

One endpoint at a time, 300 requests (60 for bootstrap) over 4 connections, CPU = the API process's own CPU time
(all threads, incl. Prisma's query engine) ÷ requests. "Max/s at 0.1 CPU" = 100 ms ÷ CPU-ms.

| Endpoint                               | Before CPU-ms | After CPU-ms | Max/s at 0.1 CPU (after) |
| -------------------------------------- | ------------: | -----------: | -----------------------: |
| `GET /health`                          |          0.53 |         0.49 |                      204 |
| `GET /v1/config`                       |          3.37 |         0.56 |                      179 |
| `GET /v1/me`                           |          1.67 |         1.17 |                       85 |
| `GET /v1/fpl/bootstrap`                |          4.61 |         1.02 |                       98 |
| `GET /v1/fpl/fixtures?event`           |          0.85 |         0.70 |                      143 |
| `GET /v1/fpl/fixtures/:id`             |          0.90 |         0.66 |                      152 |
| `GET /v1/fpl/entries/:id/live`         |          1.21 |         2.26 |                       44 |
| `GET /v1/fpl/entries/:id/picks`        |          0.78 |         1.20 |                       83 |
| `GET /v1/fpl/entries/:id`              |          0.49 |         0.57 |                      175 |
| `GET /v1/league/live`                  |          4.80 |         0.80 |                      125 |
| `GET /v1/league/standings`             |          3.75 |         0.77 |                      130 |
| `GET /v1/captain-battle` (signed in)   |          3.07 |         1.23 |                       81 |
| `GET /v1/news`                         |          6.66 |         0.41 |                      244 |
| `GET /v1/news/stories`                 |          3.36 |         0.42 |                      238 |
| `GET /v1/news/filters`                 |          1.07 |         0.26 |                      385 |
| `GET /v1/community/posts`              |          5.77 |         6.08 |                       16 |
| `GET /v1/community/posts/:id/comments` |          4.01 |         3.43 |                       29 |

Per-entry routes (`entries/:id/live`, `picks`) now pay for compressing their ~5 KB body (brotli/gzip ≥ 1 KB,
~0.5–1 ms) — a good trade at 0.1 CPU for phones on mobile data, and most `picks`/`entry` polls end as a `304`
anyway. Community stays ~6 ms (4 queries + per-viewer likes); it's polled once a minute, only on that tab.

### Capacity at 0.1 CPU

From the mix: steady state costs **0.30 ms of CPU per second per active user** after (0.43 before). Keeping the
average at ≤ 70 % of the quota (headroom for the bursts above):

- **after: ≈ 230 users polling live screens at once**, and a kick-off ramp of 150 users in 30 s uses 73 %;
- before: ≈ 160 users steady, and the 150-user ramp already saturated the CPU (the 3–7 s waits).

### Run-to-run variance, 10-minute run, 0.5 CPU

The kick-off ramp (150 users opening the app within 30 s) is where 0.1 CPU is tight. The endpoints only fetched
at app open varied between three otherwise identical _after_ runs:

| p95 at 0.1 CPU (ms)            | run 1 | run 2 | 10-min run | Starter (0.5 CPU) |
| ------------------------------ | ----: | ----: | ---------: | ----------------: |
| `GET /v1/fpl/bootstrap`        |   193 |   399 |        586 |                 8 |
| `GET /v1/config`               |   198 |   404 |        389 |                 9 |
| `GET /v1/league/live`          |    96 |    87 |         85 |                 5 |
| `GET /v1/fpl/entries/:id/live` |   143 |   100 |        164 |                 8 |
| event-loop p99                 |  14.5 |   9.1 |       11.0 |               7.1 |

So at 0.1 CPU the polled live screens are comfortably inside the targets, but **the < 300 ms target for
app-open requests during a full kick-off stampede is not reliable** (1 run of 3). Everything else holds in every
run.

**10 minutes, no leak**: 9,950 requests, 0 errors; heap oscillates between 52 and 76 MB with no upward trend
(per-minute max 72 → 72 → 72 → 72 → 72 → 73 → 76 → 76 → 69 → 74 MB); RSS plateaus at ~220 MB (max 226 MB, end
218 MB) — well under 512 MB.

**Starter (0.5 CPU, same mix)**: every endpoint p95 ≤ 9 ms (community 30 ms), p99 ≤ 52 ms, event-loop p99
7.1 ms / max 109 ms, CPU peak 23 % of the quota.

## Plan recommendation

**Render free (0.1 CPU) now carries 150 users**: 0 errors, every live screen p95 < 170 ms, RSS ~220 MB,
event-loop p99 ~10–15 ms, ~45 % of the CPU in steady state. The one target it does not hold reliably is p95 <
300 ms for the app-open requests (bootstrap/config) when all 150 users open the app within the same 30 seconds
(193–586 ms across runs). **Minimum plan that meets every target in every run: Starter ($7/month, 0.5 CPU /
512 MB)** — p95 under 10 ms everywhere.

> **Owner decision (2026-11-02): stay on the free tier for now** — the 0.1 CPU results are good enough. The
> UptimeRobot 5-minute `/health` monitor must stay on (it is what keeps the free service from sleeping).
> Revisit Starter if kickoff-time opens feel slow or the active league grows past ~200 users.

Original recommendation: **Starter for launch**, because:

1. **Cold starts, not CPU.** Free services sleep after 15 minutes without traffic, and the first request after
   that takes ~50 s. The external 5-minute `/health` ping prevents it — but it is the only thing preventing it,
   and a missed ping (GitHub Actions cron is best-effort and often runs late) means a 50 s first open.
   Starter never sleeps.
2. **Headroom.** At 0.1 CPU the tail (p99 400–900 ms) is set by FPL refresh bursts stretched 10× by the quota.
   Starter's 5× CPU turns those into ~30–100 ms and leaves room for the league to grow past 230 active users,
   a second league page set, or more polling screens, with no code change (`plan: starter` in `render.yaml`).
3. **Kick-off stampede.** The < 300 ms target at the moment everyone opens the app is only reliably met there.

Staying on free is acceptable if $0 matters more: the app is fluent while matches run; the cost is a 0.2–0.6 s
first screen for some users at kick-off and the sleep risk above.

## What changed

**Shared, precomputed hot responses** (`apps/api/src/perf/hotCache.ts`, `hotData.ts`). The live league pages,
standings, fixtures, match sheets, bootstrap, captain battle, config and news (pages, filters, stories, items)
are computed **once per TTL for everybody**: concurrent misses share one in-flight load; after the fresh window
the stored body is served at once while one background refresh runs (stale-while-revalidate), so no user request
waits for a recomputation once a key is warm; a failed refresh keeps serving the last good copy for a while. The
JSON is **serialized once**, hashed once (weak ETag) and **compressed once per encoding** (brotli q5 / gzip 6, in
libuv's threadpool, never per request). When FplService returns the very same object (its caches now return shared
objects), the body is kept without re-validating or re-serializing it. Bounded: 1,000 keys / 48 MB, LRU.

| Data                                                         | Fresh | Then served stale while refreshing | Cache-Control                                                                              |
| ------------------------------------------------------------ | ----: | ---------------------------------: | ------------------------------------------------------------------------------------------ |
| live league, fixtures, match sheet, battle                   |  10 s |                               60 s | `public, max-age=10, stale-while-revalidate=20` (match sheet: by fixture state, unchanged) |
| standings                                                    |  30 s |                              120 s | `public, max-age=30, stale-while-revalidate=60`                                            |
| bootstrap                                                    |  30 s |                             10 min | `public, max-age=60, stale-while-revalidate=300`                                           |
| config                                                       |  30 s |                               60 s | `public, max-age=30, stale-while-revalidate=60`                                            |
| news pages / stories / item                                  |  15 s |                               45 s | `public, max-age=15, stale-while-revalidate=45` (filters: `public, max-age=60`, unchanged) |
| per-user (`/v1/me`, captain battle with your row, community) |     — |                                  — | `private, no-cache` + ETag                                                                 |
| My Team live, an entry, picks                                |     — |                                  — | `public, max-age=10/30, …` + ETag                                                          |

There is no CDN in front of the API (the Vercel CDN only serves the web app and `/media`), so these headers steer
browsers: within `max-age` a poll never leaves the phone; after it the browser revalidates with `If-None-Match`
and usually gets a bodiless **304** (88 % of fixture polls in the test).

Invalidation: any successful admin write (`/v1/admin/*`, `/v1/integrations/*`) drops config/league/battle/news
before its response is sent; content jobs (podcast, YouTube, Instagram, X, cleanup) drop the news pages when they
finish. Everything else expires by TTL.

**Pre-warming** (`HotData.warm`, every 30 s, `PREWARM_ENABLED`): while a fixture of the current GW is live it
recomputes every live league page, the captain battle and the fixtures, so user requests always find warm data.
Outside live matches it costs two cached FPL reads.

**User-specific parts stay cheap.** The captain battle is shared; a signed-in viewer's own row is added per
request from FplService's cached picks (reused from the shared row when the viewer is one of the battle's teams).
My Team live is FplService's shared GW context + the entry's cached picks.

**ETag + 304 for every JSON GET** (`perf/http.ts`, an `onSend` hook before compression) and **`@fastify/compress`**
(br/gzip, ≥ 1 KB) for dynamic responses; hot bodies arrive precompressed and pass through. Brotli cost was
checked at 0.1 CPU: precompressing once makes its CPU irrelevant for shared data; per-request bodies are ~1–5 KB.

**Sessions** (`auth/session.ts`): GET/HEAD requests reuse a resolved session for 5 minutes (bounded LRU, one DB
lookup per token in flight). Logout, ban/unban, profile and role changes and account deletion evict it at once;
writes and admin routes always re-read the user from the database. This matters most: on 0.1 CPU the real cost of
a request is its Prisma round-trips (Prisma's query engine runs on its own threads and counts against the quota —
in a CPU profile the JS thread was only about a third of the process's CPU).

**Rate limits** (`app.ts`): the global limit is per signed-in **user** (600/min) when the request carries a valid
token, and per IP only for anonymous requests (1,200/min). Mobile carriers (CGNAT) and a pub's Wi-Fi put many
users behind one IP; a full live screen is ~10–15 requests/min per user. Writes keep their per-user limits.

**Database.** Every hot query was EXPLAINed on the seeded data (`scripts/loadtest` DB, + 60 k notification-log
rows): all use their indexes or are tiny-table scans the planner is right to choose, except live alerts counting
`NotificationLog` rows with `key LIKE 'live:<gw>:%'` (a full scan of the season-long dedupe log, every 2 minutes
during matches). Fix: additive migration `20261102120000_notification_log_created_at_index`
(`CREATE INDEX … ("createdAt")`) and the query bounded by the GW's deadline — 1.7 ms instead of 5.0 ms at 60 k
rows, and flat as the log grows. (A `text_pattern_ops` index on `key` would also work but Prisma can't round-trip
that operator class: every later `migrate dev` would try to recreate it.) Settings are memoized for 15 s (the old
`getSettings` was an upsert — a write — on every league request); the job scheduler reads all leases in one query
and skips jobs that aren't due (one query per idle tick instead of two per job); community and news serializers
select only the columns they show (no full `User` row per post). No N+1: likes and blocks are
one query per page each.

**Prisma pool**: `connection_limit` defaults to `DB_POOL_SIZE` = 5 (Prisma's default is 2 × the host's CPUs + 1,
and on a shared host that's the machine's CPUs, not the container's 0.1). An explicit `connection_limit` in
`DATABASE_URL` wins.

**Event loop.** Measured inside the process with `perf_hooks.monitorEventLoopDelay` (load test) and logged every
5 minutes in production (`perf/runtime.ts`: RSS, heap, CPU %, event-loop p50/p99/max, hot-cache size; a warning
above p99 100 ms). `live_alerts` yields to the event loop every 10 managers. The bootstrap/live re-parse bursts
are synchronous inside `packages/fpl`.

**Memory**: every cache is bounded — hot responses (1,000 keys / 48 MB), sessions (5,000), FplService (≈ 6 MB /
300 entries, `packages/fpl`), the rate-limit store (5,000 keys).

## Neon: keep-alive and compute hours

Neon suspends its compute after ~5 idle minutes; the next query then waits ~1 s while it starts. `GET /health`
(Render's health check, the external 5-minute ping and the web app's warm-up ping on every resume) now also runs
`SELECT 1` — at most once a minute, never awaited by the health response — so the database stays awake while
people use the app.

But **the API already kept Neon awake 24/7**: the in-process scheduler runs every 30 s and touched the database on
every tick (two queries per job), and the external cron tick every 5 minutes did the same. So the maths:

- Neon free: **191.9 compute-hours/month** at the minimum 0.25 CU (figure from the brief — check the current
  number on the Neon dashboard → Billing; Neon has changed free-plan allowances before).
- **Always on**: 744 h × 0.25 CU = **186 CU-h = 97 %** of the allowance. Fits, with 5.9 CU-h to spare — any
  autoscaling above 0.25 CU, or a 31-day month with extra activity, eats that.
- **Quiet hours 02:00–07:00 Israel time** (`DB_QUIET_HOURS=02-07`, the default): 19 h × 31 = 589 h awake; at
  night `/health` doesn't ping and jobs run at most every 30 minutes (scheduler and cron tick alike), so Neon is
  up ~5–6 min per half hour ≈ 31 h over the 155 night hours. ≈ 620 h × 0.25 = **155 CU-h = 81 %**, ~37 CU-h of
  headroom.

**Decision: quiet hours 02:00–07:00 Israel time.** Nothing time-critical happens then: Premier League matches end
by ~00:30 Israel time (the final live-alert pass included), and deadlines (and their 24 h / 2 h reminders) fall in
the daytime. A podcast/Instagram post published at night shows up within 30 minutes instead of 5, and the first app
open at night waits ~1 s for Neon. `DB_QUIET_HOURS=off` restores always-on.

## Knobs

| Env var           | Default | What                                                                                               |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `DB_POOL_SIZE`    | `5`     | Prisma `connection_limit` (unless set in `DATABASE_URL`)                                           |
| `DB_QUIET_HOURS`  | `02-07` | Israel-time hours when Neon may sleep (no keep-alive ping, jobs ≤ every 30 min); `off` = always on |
| `PREWARM_ENABLED` | `true`  | Recompute live hot data every 30 s while a fixture is live                                         |
| `LOG_LEVEL`       | `info`  | Request logging costs ~0.1 ms/request — measured, not worth turning off                            |

In code: `HOT_POLICY` (TTLs, `perf/hotData.ts`), `CACHE_CONTROL` (`perf/http.ts`), `SESSION_CACHE_TTL_MS`
(`auth/session.ts`), rate limits (`DEFAULT_RATE_LIMIT`, `app.ts`), `BROTLI_QUALITY` / `COMPRESS_THRESHOLD_BYTES`
(`perf/hotCache.ts`).

## Running the load test

```bash
# Local Postgres; the script wipes this database (it refuses anything not local and named *loadtest*).
createdb fantasyonerim_loadtest            # once (or: CREATE DATABASE fantasyonerim_loadtest)
npx tsc -b tsconfig.build.json             # build api + packages
npm run loadtest -- --label mine           # profile + 4-minute mix at 0.1 CPU / 512 MB
npm run loadtest -- --phases mix --duration 600 --label leak   # 10-minute memory check
npm run loadtest -- --phases mix --cpu 0.5                     # Render Starter
```

`LT_DATABASE_URL` overrides the database; `LT_ENV_<NAME>=value` passes `NAME=value` to the API process (e.g.
`LT_ENV_DB_POOL_SIZE=10`); `LT_CPU_PROF=<dir>` writes a V8 CPU profile of the API. Results land in
`scripts/loadtest/results/<label>-<time>.{md,json}` (git-ignored), with a per-second timeline of CPU, RSS and
event-loop delay in the JSON.

What it does (`scripts/loadtest/`):

- **Data**: the deterministic demo FPL dataset (GW9: one match live at 62', two provisional, three to come)
  scaled to production size — **150 managers** in the league (3 standings pages), ~780 players with real-world
  field counts (bootstrap ≈ 1.4 MB, live ≈ 0.5 MB) — served through the real `FplService` (replay fetch → JSON
  parse → Zod → live engine). Content jobs read the client's recorded podcast RSS (62 episodes), YouTube and Apple
  feeds offline. The DB gets 150 registered users with real session tokens (100 with push subscriptions), the
  league and captain battle, ~200 news items with media + live stories, 120 community posts with likes/comments.
- **Server**: the production entry (`apps/api/dist/boot.js`, `NODE_ENV=production`, jobs + scheduler + pre-warmer
  on, `info` logs) in a child process placed in a **cgroup with a CPU quota** (v1 `cpu.cfs_quota_us`, or v2
  `cpu.max`) and a memory limit. If no cgroup is writable it warns and runs unlimited. One cron tick runs first, as
  in production where the feeds are already ingested.
- **Profile phase**: each endpoint alone with `autocannon` (pinned devDependency) → CPU-ms per request.
- **Mix phase**: 150 virtual users ramp in over 30 s (everyone opening at kick-off), each with its own bearer
  token and a browser-like HTTP cache (honours `max-age`, revalidates with `If-None-Match`, sends
  `Accept-Encoding: gzip, deflate, br`). 45 % sit on Live → league (a third scrolled to all 3 pages), 15 % on Live →
  captain battle, 40 % on My Team; 20 % also have the live match sheet open. Every 30 s they poll their screen +
  the GW's fixtures; every ~4 min they resume the app (config, me, bootstrap if stale); every ~4 min they open
  News (page 1, filters, stories; a quarter scroll to page 2), and 30 % of those visit Community (20 % like a
  post). A third of the users share 4 carrier/Wi-Fi IPs.

Not simulated: TLS and the network to Neon (~1–2 ms per query from Render Frankfurt; local Postgres here), the
real FPL API's latency (FplService refreshes ahead of expiry, so users don't wait on it), and the browser's own
work.

## Smaller image copies (srcset)

Every image the API re-hosts gets **WebP copies 320 and 640 px wide** (quality 75, auto-rotated, all metadata
stripped; widths ≥ the original are skipped, nothing is upscaled). They are stored next to the original as
`<key>.w320.webp` / `<key>.w640.webp`, so the existing `/media` CDN rules apply unchanged: immutable (30 days CDN /
1 year browser) for Instagram, YouTube and Spotify copies, 5 minutes for `uploads/` (the takedown delay). The rows
keep them (`NewsMedia.variants`, `Upload.variants`, additive migration `20261103090000_image_variants`;
`NULL` = not generated yet, `[]` = nothing smaller worth making) and the API serves them as `variants` (smallest
first, through the same public-URL mapping as the original). Videos have none (the contract says so); their
posters are not given copies.

**Where the CPU goes** (sharp/libvips, one image at a time process-wide, one libvips thread, yields between
widths; median of 5):

| Work                                          |        CPU | Wall at 0.1 CPU | Where                                 |
| --------------------------------------------- | ---------: | --------------: | ------------------------------------- |
| Instagram 1080×1350 JPEG → 320 + 640          |      95 ms |           1.0 s | ingest job (bytes already in hand)    |
| Community upload (2048 px WebP) → 320 + 640   | 170–190 ms |           1.9 s | after the upload response             |
| YouTube 480×360 thumbnail → 320               |      14 ms |           0.1 s | ingest job                            |
| _existing_ upload re-encode, 12 MP phone JPEG |     480 ms |           4.9 s | the upload request itself (unchanged) |

- Jobs (Instagram/YouTube ingest, Spotify episode thumbnails) generate variants right after storing the original,
  from the bytes they already downloaded. Never in a user's request.
- **Uploads**: the response waits at most 300 ms (`UPLOAD_VARIANTS_BUDGET_MS`) for the variants; on 0.1 CPU they
  take ~2 s, so in production the response goes out first and the variants are saved on the Upload row when ready
  (a post shows them from then on). Admin broadcasts copy the upload's variants onto their News item.
- Worth knowing: the upload request itself was already ~5 s of wall time for a 12 MP photo at 0.1 CPU (decode +
  re-encode to 2048 px WebP); Starter (0.5 CPU) makes it ~1 s.

**Backfill** (`image_variants` job, every 10 min, `jobs/imageVariants.ts`): 10 images per run, newest first, only
outside a live fixture and outside quiet hours. Each image is downloaded once through its public URL (the Vercel
`/media` CDN, else the bucket), its copies are written and the row updated — idempotent (deterministic keys) and
resumable (the rows are the queue). A gone file (4xx) is marked `[]` and never retried; a network error stops the
batch until the next run. Uploads younger than 5 minutes are left to the upload route.

**B2 free tier stays free** (10 GB stored, ~2,500 Class B downloads/day, Class A free):

- **Storage.** A 320 copy is ~10–20 KB, a 640 copy ~30–60 KB: ≤ ~80 KB per image (the synthetic, noise-heavy test
  photo gave 12 + 59 KB). Generous season volume: ~1,500 Instagram images (posts + carousel slides), ~400 YouTube
  thumbnails, ~70 episode thumbnails, ~7,500 community photos (150 fans × 50) ≈ 9,500 images × 80 KB ≈ **0.75 GB**
  worst case, typically 0.3–0.5 GB — under 10 % of the 10 GB. Deleted posts and expired stories delete their copies
  with the original.
- **Transactions.** Uploads (originals and copies, incl. the backfill's) and deletes are Class A: free. The backfill
  reads each existing image once, at most 10 per 10 minutes (≤ ~1,100/day, usually through the CDN cache, so
  fewer B2 reads), and only until the existing media is done. Clients load one size per image, so CDN
  misses (Class B) stay ~one object per image per region per CDN TTL, as before — just smaller ones.
- The `$0` caps in [DEPLOY.md → Keep B2 free](DEPLOY.md#keep-b2-free) remain the hard stop.

## Web

The PWA as fans use it: an iPhone on mobile data, mostly reopening an installed app. Measured on the production
static export (`next build`, brotli, `vercel.json` headers) served locally with the demo API (`FPL_MODE=demo`),
seeded with 60 News items (realistic 50–190 KB JPEGs), 3 stories, 30 Community posts and the 60-manager demo league
(widened to 150 rows for the scroll test). _Before_ is `ed1294e`, _after_ is this change. One machine
(Lighthouse `benchmarkIndex` 1712), so absolute numbers are a mid-range Android, not an iPhone (recent iPhones are
roughly desktop-class CPUs, so TBT and scroll there are well below these).

- **Lighthouse 13.6.0** (pinned), mobile, default simulated throttling: 150 ms RTT, 1.6 Mbps, **4× CPU**. Median of
  3 runs. _Cold_ = no HTTP cache, no service worker, no persisted query cache (signed in). _Warm_ = the next open:
  HTTP + service-worker cache and the persisted query cache (`lib/persist.ts`) in place.
- **Time to content** (Playwright, applied throttling: 150 ms latency, 1.6 Mbps / 750 kbps, 4× CPU): from
  navigation to the tab's first real row/card on screen. Median of 3.
- **Scroll**: Chrome performance trace while scrolling the whole list top to bottom (synthetic scroll gestures,
  4× CPU, phone viewport); longest main-thread task and tasks over 100 ms. News and Community load their next
  pages while scrolling.

### Lighthouse, per tab

| Tab       | LCP cold (before → after) |      LCP warm |     TBT cold |     TBT warm | CLS (worst run) | JS transferred |
| --------- | ------------------------: | ------------: | -----------: | -----------: | --------------: | -------------: |
| News      |       5.74 s → **4.75 s** | 1.59 → 1.65 s | 643 → 731 ms | 452 → 540 ms |  0.034 → 0.054¹ |   218 → 210 KB |
| Live      |       5.04 s → **4.46 s** | 1.24 → 1.67 s | 835 → 333 ms | 364 → 360 ms |   0.027 → 0.006 |   216 → 204 KB |
| My Team   |       4.95 s → **4.54 s** | 1.25 → 1.60 s | 712 → 557 ms | 327 → 259 ms |   0.006 → 0.006 |   213 → 206 KB |
| Table     |       4.82 s → **4.68 s** | 1.23 → 1.25 s | 494 → 362 ms | 365 → 276 ms |   0.000 → 0.000 |   211 → 201 KB |
| Community |       4.38 s → **4.33 s** | 1.16 → 1.17 s | 726 → 478 ms | 862 → 554 ms |   0.076 → 0.000 |   235 → 208 KB |

FCP on every tab: 0.90 s → 0.75 s. ¹ one of three runs (the median is 0.000); before, the push prompt popped in
above the feed on every run that showed it.

### Time to content (applied throttling) and scroll

| Tab       | Cold (before → after) | Warm (before → after) | Scroll: longest task, tasks > 100 ms (before → after) |
| --------- | --------------------: | --------------------: | ----------------------------------------------------: |
| News      |        3.52 → 4.31 s² |         1.53 → 1.53 s |                                158 ms, 6 → 128 ms, 2³ |
| Live      |         4.11 → 3.41 s |         1.41 → 1.62 s |                                 57 ms, 0 → 166 ms, 1⁴ |
| My Team   |         3.68 → 3.60 s |         1.42 → 1.70 s |                                                     — |
| Table     |         3.49 → 3.20 s |         1.29 → 1.39 s |                        13 ms, 0 → 29 ms, 0 (150 rows) |
| Community |         3.31 → 3.51 s |         1.39 → 1.56 s |                                  114 ms, 2 → 37 ms, 0 |

² run-to-run spread on this shared machine is ±0.5 s (News cold: 4.26 / 4.31 / 5.11 s after; an earlier run of the
same build measured 3.22 / 3.45 / 3.54 s). ³ the remaining > 100 ms tasks on News are major GCs while 60 cards
with full-size photos are decoded. ⁴ a single style recalculation (one run); the earlier run of this build had
none.

### First-load JS (gzip, `scripts/perf-budget.mjs`)

| Route                          | Before | After |
| ------------------------------ | -----: | ----: |
| /news/                         |  248.4 | 236.8 |
| /live/                         |  246.4 | 230.9 |
| /my-team/                      |  243.0 | 232.2 |
| /table/                        |  241.3 | 227.2 |
| /community/                    |  248.0 | 235.3 |
| /admin/ (never loaded by fans) |  259.0 | 249.0 |

### Targets

| Target                                  | Status                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------- |
| LCP < 2.5 s cold                        | **Not met** in the Lighthouse slow-4G model (4.3–4.7 s, from 4.4–5.7 s)     |
| LCP < 1 s warm                          | **Not met** (1.2–1.7 s; FCP 0.75 s)                                         |
| TBT < 200 ms                            | **Not met** (259–731 ms at 4× CPU; Community and Live down by a third)      |
| CLS < 0.05                              | Met on the median run of every tab (one News run 0.054)                     |
| Fan first-load JS ≤ 200 KB gzip         | **Not met**: 227–237 KB (was 241–248)                                       |
| No task > 100 ms scrolling table / feed | Met for the table (150 rows) and Community; News 2 GC tasks, Live 1 (noise) |

What blocks the remaining gap, in order of size:

1. **Zod in the first load (~30 KB gzip, ~250 ms of script evaluation at 4× CPU).** Every fan route parses API
   responses with the `@fant/shared` schemas, which use classic `zod` (not tree-shakeable; JSON-schema code and
   locales come along). Moving `packages/shared` to `zod/mini` (same schemas, functional API) is the one change that
   brings fan routes under 200 KB and removes the biggest single long task. It's a `packages/shared` change, owned
   by the orchestrator. Deferring Zod in the web app alone would only move the bytes, not remove them.
2. **The framework floor**: React DOM + the Next.js app router are ~133 KB gzip of the ~230 KB. Hydrating the shell
   is most of the remaining TBT.
3. **The LCP element is a feed photo**, which can't start before the feed data arrives. The early fetch below
   starts that request ~450 ms sooner (unthrottled timeline). The image itself is the full 1080 px re-hosted
   original. Serving a resized rendition (Vercel image optimisation on `/media/*`, or re-hosting a 640 px copy at
   sync time in apps/api) is the next LCP win on mobile data.

### What changed (apps/web)

- **No request waterfalls.** `lib/earlyFetch.ts`: an inline `<head>` script starts the tab's first GETs (me + the
  feed / config / bootstrap) while the bundle downloads; `lib/api.ts` adopts the in-flight response (same path, same
  token, ≤ 15 s old, once). It never requests the league (404 on a fresh install). `lib/prefetch.ts`: the shell
  starts all of a tab's queries at once (the live league no longer waits for bootstrap to render; picks don't wait
  for the pitch), using the same query-option builders as the hooks (`lib/queries.ts`). In the cold News trace the
  API calls now start at 87 ms instead of 538 ms; on Live the live league starts at 413 ms instead of 836 ms.
- **Adjacent tabs prefetched when idle** (`lib/idle.ts`): after `load` + 2.5 s + `requestIdleCallback`, only
  online, no Data Saver, not 2G. News warms Community, Table warms My Team and Live, and so on.
- **Code splitting** (`components/lazy.tsx`, `components/lazySheets.tsx`): the manager / match / player sheets, the
  composer, the photo viewer, the story viewer and the Community thread are their own chunks, fetched the first
  time they open (or when idle). The English dictionary is fetched only by people who chose English (and early,
  from the stored preference). The error screen uses a 5-string dictionary (`i18n/fatal.ts`) instead of both full
  dictionaries. The admin console was already its own route; `perf-budget.mjs` now fails the build if its marker
  (`data-admin-console`) appears in any fan route's JS.
- **CLS**: the push prompt is decided synchronously before the feed's first paint (`guessPushState()` + a layout
  effect) instead of popping in above it.
- **Images**: the first card of a feed gets `loading="eager"` + `fetchpriority="high"`; everything else is lazy and
  `decoding="async"`. Previously the first slide of every Instagram carousel in the feed loaded eagerly. All feed
  media already sits in aspect-ratio boxes (no CLS). YouTube cards use the re-hosted `oar2` / `hq720` thumbnail;
  `srcset` with `mqdefault` / `hqdefault` was not added: the cards are full-width (≥ 1000 device px on a 3× iPhone),
  so the browser would pick the large one anyway, and pointing at `i.ytimg.com` adds a third-party connection.
  Team badges and player kits are the PL CDN's, served with long cache headers.
- **Fonts**: only the Hebrew, Latin and Latin Extended subsets of Rubik (variable), self-hosted under
  `public/fonts/` with versioned names, `font-display: swap`, immutable caching (`vercel.json` + cache-first in the
  service worker). The Hebrew file (9 KB) is preloaded.
- **Rendering**: feed rows, standings rows and live-league rows are memoized, so a poll or a next page re-renders
  only changed rows. Feed updates render through `useDeferredValue` (interruptible; this removed the 100–200 ms
  task when a page is appended while scrolling). One `Intl.Segmenter` for the app (initials used to build one per
  author per render, most of Community's first-render cost) and cached `Intl.NumberFormat`s.
- **Long lists**: `content-visibility: auto` with `contain-intrinsic-size: auto` on table rows and feed cards
  (`.table-row`, `.feed-item` in globals.css). Rows stay in the DOM and the accessibility tree, so RTL, VoiceOver and
  find-in-page are unchanged. A 150-row table already scrolled with a 13 ms longest task before this change, and
  29 ms after (no task over 50 ms), so virtualization isn't worth its accessibility cost. It was not built.
- **Persisted cache writes** (`lib/persist.ts`): the stock persister re-stringified the whole cache (bootstrap
  included) on every change, which was the 100–150 ms "TimerFire" task in the scroll traces. It now stringifies only
  queries whose data object changed (structural sharing keeps the rest identical), skips the write when nothing
  persisted changed, and runs in `requestIdleCallback` (1 s throttle, flushed on hide as before).
- **Caching**: `_next/static/*` and `/fonts/*` are immutable. HTML stays `max-age=0, must-revalidate`: the service
  worker serves navigations network-first with a 4 s fallback to the cached shell, and the update flow
  (`lib/updates.ts`) depends on a reload fetching fresh HTML, so HTML gets no longer browser cache. The service
  worker precache is the nine fan pages' HTML, the manifest and two icons (no admin, no media, no fonts).
- **Polling** pauses when hidden (`refetchIntervalInBackground: false` on every interval query, verified), and TanStack
  Query's structural sharing means an unchanged poll result doesn't re-render. Pull-to-refresh only animates
  `transform`.

### Reproducing

```bash
npm run build -w @fant/web             # postbuild prints the first-load table and enforces the budget
npm run perf:budget -w @fant/web -- out --json
```

The budget (`scripts/perf-budget.mjs`, default 240 KB) is a regression guard set just above today's figure. Lower
it to the 200 KB target once Zod leaves the first load.

## Web — first load

Goal (owner): make the first open faster without spending money. Same setup as "Web" above: Lighthouse 13.6.0
mobile (simulated slow 4G, 4× CPU, median of 3), Playwright time to content (applied 4G + 4× CPU, median of 3),
the static export served with brotli and `vercel.json` headers, and the demo API. The seed now carries 320/640 WebP
`variants` for every image, as the API generates them. _Before_ = the previous Web build, _after_ = this change.
Both were measured back to back on the same machine, because this shared box drifts ±30 % between hours: its TBT
and LCP are higher than in the "Web" section above for both builds.

| Tab       | LCP cold (before → after) |      LCP warm |   TBT cold |    TBT warm |      CLS cold | First-load JS (gzip) | Time to content cold | Time to content warm |
| --------- | ------------------------: | ------------: | ---------: | ----------: | ------------: | -------------------: | -------------------: | -------------------: |
| News      |             4.74 → 4.32 s | 1.44 → 1.49 s | 1010 → 640 | 529 → 1032¹ | 0.127 → 0.006 |     236.8 → 223.3 KB |    5.56 → **3.63 s** |        2.32 → 2.15 s |
| Live      |             4.24 → 4.24 s | 1.35 → 1.26 s |  760 → 661 |   477 → 651 | 0.006 → 0.027 |     230.9 → 219.1 KB |        4.06 → 3.63 s |        2.30 → 1.78 s |
| My Team   |             4.50 → 4.19 s | 1.27 → 1.20 s |  551 → 577 |   605 → 265 | 0.007 → 0.006 |     232.4 → 219.5 KB |        3.77 → 3.27 s |        2.15 → 1.61 s |
| Table     |             4.34 → 4.28 s | 1.59 → 1.14 s |  604 → 584 |   608 → 216 | 0.000 → 0.000 |     228.2 → 215.3 KB |        3.77 → 3.44 s |        1.86 → 1.68 s |
| Community |             4.27 → 4.32 s | 1.45 → 1.21 s | 1058 → 619 |   964 → 686 | 0.072 → 0.000 |     235.5 → 223.0 KB |    4.75 → **3.38 s** |        2.35 → 1.85 s |

FCP 0.75–0.85 s → 0.75–0.81 s. ¹ One slow run out of three (540 / 1032 / 1080 ms); the machine is noisy.

### Targets

| Target (best effort, free)      | Result                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| Cold LCP ≤ 3 s (Lighthouse)     | **Not met**: 4.2–4.3 s. Applied-throttling time to content is 3.3–3.6 s, from 3.8–5.6 s |
| Warm LCP ≤ 1 s                  | **Not met**: 1.1–1.5 s, from 1.3–1.6 s                                                  |
| Fan first-load JS ≤ 200 KB gzip | **Not met**: 215–223 KB, from 228–237 KB. Budget now fails the build above 228 KB       |
| CLS                             | Every tab ≤ 0.03; News and Community were 0.13 and 0.07                                 |

### What changed

- **`@fant/shared` moved to `zod/mini`** (Zod 4's functional, tree-shakeable API): same schemas, same inferred
  types, same runtime checks (`.check(z.minLength…)`, `z.optional()`, `z._default()`, `z.extend()`, … one for one).
  The contract's Zod runtime in the first load fell from ~34 KB to ~18 KB of module code, about 13 KB gzip per tab.
  apps/api keeps classic Zod for its own schemas; both interoperate as Zod 4 core types. `apps/api/src/validate.ts`
  now sets the English locale explicitly (mini loads none, so a 400 would otherwise only say "Invalid input").
  All 661 tests pass.
- **The LCP image starts with the data, not after React.** The inline early-fetch script (`lib/earlyFetch.ts`) reads
  the first feed page as soon as it arrives and inserts `<link rel=preload as=image fetchpriority=high>` with the
  same `imagesrcset` / `imagesizes` the first card's `<img>` will use (unit-tested against `lib/images.ts`). In the
  cold News trace the cover request moved from 667 ms to 326 ms.
- **`srcset` + `sizes` from the API `variants`** (320/640 WebP) on feed photos, carousels, X grids (half width),
  podcast covers (96 px tile or full width), YouTube / Shorts thumbnails, community photos and stories. Falls back
  to `url` when variants are absent. The 96 px covers and 2-up grid tiles now download a 320 px WebP instead of the
  original. Full-width images on a ≥ 2× phone still need more than 640 px, so they keep the original. A 960 or
  1080 px WebP variant would be the next byte saving there (API side).
- **The static HTML is shaped like each tab**: News (profile header, chips, two cards), Community (composer, two
  posts), Table / Live (title and rows). It replaces the generic block skeleton.
  `preconnect` + `dns-prefetch` to the API origin. `/media` is same-origin (Vercel rewrite), so it needs none.
- **CLS**:
  - The feed's deferred rendering now shows the first rows immediately. Before, it rendered an empty list for a
    frame, so the end-of-feed marker jumped.
  - The profile header reserves the story ring's 8 px whether or not stories exist.
- **Fonts**: already `swap` with only the 9 KB Hebrew subset preloaded. In the observed (unthrottled) trace it is done by ~40 ms, well
  before LCP, so it stays: the system-font fallback paints first anyway.
- **Not done**:
  - Painting cached News titles from localStorage before hydration. It only helps the text, while the warm LCP is
    the first card's image. And it needs DOM outside React's tree, which isn't "safe and simple".
  - Splitting admin-only strings out of the Hebrew dictionary (~6 KB gzip, but it weakens the dictionary's type
    safety).

### What still separates us from the targets

1. **Framework floor**: React DOM + the Next.js app router are ~133 KB gzip of ~220 KB, and their parse + hydrate
   time at 4× CPU is most of the remaining cold time.
2. The Hebrew dictionary (~12 KB gzip) and TanStack Query (~13 KB) are needed by every tab.
3. Lighthouse's slow-4G model puts ~220 KB of JS at ~1.2 s of transfer before anything can render the feed. Without
   dropping the framework there's no free path to 3 s in that model. On a real 4G/5G connection, with an iPhone
   CPU, the applied-throttling time to content (3.3–3.6 s cold, 1.6–2.2 s warm at 4× CPU) is the closer guide.
