# Quick load assessment — 2026-11-04

**Setup (tested):** local API build from `8b5808a`, demo FPL data scaled to production payload sizes, local
Postgres, API held to **0.1 CPU / 512 MB by cgroup quota** to match Render free. Each virtual user runs the real
session: open the app (`/v1/me`, `/v1/config`, `/v1/fpl/bootstrap`), then poll live data every 30 s (live table,
fixtures, my-team live, match sheet, captain battle). Production was not touched. Raw output:
`scripts/loadtest/results/quick/`.

## Results (all tested)

| Test                              |   Req | Errors | CPU avg / peak (of a core; quota = 10%) | RSS max | Event loop p99 | App open p50 / p95 / p99 (`/v1/me`·config·bootstrap) | Live table p50 / p95 / p99 | My-team live p95 |
| --------------------------------- | ----: | -----: | --------------------------------------- | ------: | -------------: | ---------------------------------------------------- | -------------------------- | ---------------: |
| 50 users, 30 s                    |   316 |      0 | 3.3% / 9.6%                             |  197 MB |           7 ms | 7 / 287 / 388 ms                                     | 2 / 101 / 494 ms           |           204 ms |
| 150 users, 60 s                   | 1,318 |      0 | 4.8% / 9.6%                             |  204 MB |          11 ms | 5 / 183 / 785 ms                                     | 2 / 10 / 103 ms            |            78 ms |
| 300 users, 60 s                   | 2,629 |      0 | 7.2% / 10.3%                            |  216 MB |          95 ms | 86 / 891 / 991 ms                                    | 2 / 102 / 203 ms           |           201 ms |
| 500 users, 60 s                   | 4,186 |      0 | 8.3% / 11.2%                            |  239 MB |         197 ms | **4.3 s / 7.0 s / 7.8 s**                            | 4 / 499 / 808 ms           |           999 ms |
| Spike: 500 users open within 15 s | 3,164 |      0 | 9.9% / 11.1%                            |  223 MB |         299 ms | **11.9 s / 24 s / 29 s**                             | 6 / 202 / 395 ms           |           406 ms |

- **No errors or timeouts in any test** (the harness timeout is 30 s; the spike's slowest app-open was 30.2 s, at
  the edge).
- 1,000 users was **not run**: at 500 the CPU quota was already saturated (peak ≈ 11% = the full 0.1 CPU), so 1,000
  would only show a longer queue.
- News and Community were not reached inside the 60-s windows (their steps come later in the session).
  Earlier 4-minute runs (docs/PERFORMANCE.md) measured them at p95 147 ms (news) and 398 ms (community) for 150
  users.
- **Frontend (measured 2026-11-03, not re-run):** cold time-to-content 3.3–3.6 s on Lighthouse slow-4G, warm 1.6–2.2 s,
  fan JS 218–225 KB gzip.
- **Database:** no DB errors or pool exhaustion in any run. DB time isn't separately instrumented.

## Findings

- **Max verified capacity (0 errors, live data p95 ≤ 0.5 s, app-open p95 < 1 s): 300 simultaneous users** on the
  free plan.
- **First thing to degrade: app open** (`/v1/me` + config + bootstrap together) once the 0.1 CPU is saturated: p50
  4.3 s at 500 users, and ~12 s median when 500 open at once. Live screens stay usable (p95 ≤ 0.5 s at 500).
- **Biggest bottleneck: CPU (0.1 core).** The first request of each new session does an uncached session lookup
  through Prisma, whose query engine runs on its own threads and counts against the same quota. The three app-open
  calls queue together behind it.
- **Recommended safe capacity (estimate):** ~250 simultaneously active users with headroom; spikes of ~150–200
  opening within a minute. The league is ~150 managers, so the free plan covers it; a kickoff-time spike of everyone
  opening at once is the risk.

## Improvements, ranked by impact

1. **Render Starter ($7, 0.5 CPU)** — 5× the CPU; earlier test: every p95 < 10 ms at 150 users. (Owner chose to
   stay free.)
2. **Make app-open cheaper (free):** answer `/v1/config` and `/v1/fpl/bootstrap` without resolving the session at
   all (they're public), and serve `/v1/me` from the persisted client cache on warm starts so a resume makes no auth
   call. Expected: app-open stops queueing behind session lookups.
3. **Batch first-time session lookups (free):** coalesce concurrent session reads into one query per tick, or use a
   signed session token that skips the DB on reads, re-checking only writes.
4. **Stagger client polling (free):** add ±5 s jitter to the 30 s poll so live refreshes don't arrive in waves
   after a mass resume.
5. **CDN-cache public JSON (free):** route `/v1/config` and `/v1/fpl/bootstrap` through the Vercel CDN (as with
   `/media`) with `s-maxage`, so they never reach the API during spikes.

## After free fixes — 2026-11-04

Same harness and commands, same machine, API at **0.1 CPU / 512 MB** (cgroup quota), local Postgres:
`node scripts/loadtest/run.mjs --cpu 0.1 --memory 512 --phases mix --users 500 --duration 60 --ramp 30` and
`… --users 500 --duration 30 --ramp 15` (the spike). App open = `/v1/me` + `/v1/config` + `/v1/fpl/bootstrap`.

What changed (apps/api + vercel.json):

- **A. Public routes never resolve the session.** The global rate-limit key now reads only the in-memory session
  cache (no DB): config, bootstrap, fixtures, match sheet, news, standings and the live table make **zero**
  session queries. Community read and the captain battle still resolve the viewer (`mine`, `likedByMe`, "my row").
- **B. First-time session lookups are batched**: one `findMany` per 10 ms or 50 tokens (0.06 ms CPU per session
  instead of 0.3–1.2 ms for single lookups). Same-token dedupe, the 5-minute read cache, immediate invalidation
  (logout, ban, role change, deletion) and the DB re-check on writes and admin routes are unchanged.
- **C. Config and bootstrap are CDN-cacheable**: `Cache-Control: public, max-age=30, s-maxage=30,
stale-while-revalidate=60` (config) / `public, max-age=60, s-maxage=60, stale-while-revalidate=300` (bootstrap),
  identical for every viewer (tested: guest, fan and admin get the same bytes and ETag). `vercel.json` rewrites
  `/cdn/v1/config/` and `/cdn/v1/fpl/bootstrap/` (with or without the trailing slash; the site uses
  `trailingSlash: true`, so request the slash form to skip a redirect) to `https://fantasyonerim-api.onrender.com`
  with `x-vercel-enable-rewrite-caching` + `CDN-Cache-Control`, as for `/media`.

### Results

The harness talks to the API directly, so C is **modelled** with `--cdn`: config and bootstrap are answered by "the
CDN" and never reach the API (in production the CDN refetches each from the API about once per 30 / 60 s per
region). Rows marked _(C modelled)_ are an estimate of production with the web app on the `/cdn/…` paths.

| Test                   | Build                      | Req to API | Errors | CPU avg / peak | Event loop p99 | App open p50 / p95 / p99 | `/v1/me` p50 / p95  | Live table p50 / p95 |
| ---------------------- | -------------------------- | ---------: | -----: | -------------- | -------------: | ------------------------ | ------------------- | -------------------- |
| 500 users, 60 s        | before                     |      4,273 |      0 | 7.8% / 10.5%   |         105 ms | 2.7 s / 3.6 s / 3.7 s    | 2.7 s / 3.6 s       | 2 / 301 ms           |
| 500 users, 60 s        | A + B (run 1)              |      4,126 |      0 | 8.3% / 10.5%   |         108 ms | 5.4 s / 9.5 s / 10.3 s   | 5.5 s / 9.6 s       | 4 / 292 ms           |
| 500 users, 60 s        | A + B (run 2)              |      4,261 |      0 | 7.7% / 10.9%   |         102 ms | 2.7 s / 4.0 s / 4.4 s    | 2.9 s / 4.1 s       | 3 / 191 ms           |
| 500 users, 60 s        | **A + B + C (C modelled)** |      3,393 |      0 | 7.8% / 10.7%   |         100 ms | **`/v1/me` only**        | **240 ms / 622 ms** | 2 / 300 ms           |
| Spike: 500 within 15 s | before                     |      3,163 |      0 | 9.8% / 10.9%   |         297 ms | 11.1 s / 22.1 s / 25.6 s | 11.1 s / 22.1 s     | 4 / 292 ms           |
| Spike: 500 within 15 s | A + B                      |      3,169 |      0 | 9.9% / 10.8%   |         201 ms | 10.4 s / 20.9 s / 23.3 s | 10.5 s / 21.1 s     | 91 / 197 ms          |
| Spike: 500 within 15 s | **A + B + C (C modelled)** |      2,173 |      0 | 8.3% / 10.8%   |         104 ms | **`/v1/me` only**        | **2.6 s / 5.4 s**   | 1.5 s / 5.1 s        |

(The first section's 500-user run, from another session, gave app open 4.3 s / 7.0 s for the same "before" build:
this scenario varies by ~2× between runs.)

### What the numbers say

- **The suspected cause was wrong.** Session lookups are not what makes app open slow: with A + B, config and
  bootstrap make no session query at all, yet they stay exactly as slow as `/v1/me`. A CPU profile of the spike shows
  no hotspot: each request costs ~1 ms of CPU spread over Node/Fastify plumbing (HTTP parsing, socket and log
  writes, routing, validation) and Prisma's engine threads. **0.1 CPU serves ~90 requests/s**; 500 users opening in
  15 s ask for ~100 app-open requests/s plus their first polls, so a queue builds for the whole ramp and every
  request in it waits, whatever its own cost.
- **A + B: no measurable latency change** (within the run-to-run spread above). What they do remove: every session
  query from public reads (config, bootstrap, live data now never touch the database for the session), and
  lookups that arrive within 10 ms of each other share one query (tested: 20 concurrent new tokens → 1 query, 120 →
  3). How much batching saves in a real wave depends on how bunched the arrivals are; it wasn't measured separately.
- **C is the fix that moves the needle**, by taking 2 of the 3 app-open calls off the API: at 500 users over 60 s,
  `/v1/me` drops to **p50 240 ms / p95 622 ms** (from 2.7–5.5 s), with live screens unchanged. In the 15-s spike
  `/v1/me` improves 4× (p50 11.1 → 2.6 s, p95 22 → 5.4 s), but the API is still saturated during the ramp: the live
  polls that now start sooner wait instead (live table p95 5.1 s while the spike lasts).
- **Remaining for spikes, free:** don't call `/v1/me` on a warm resume (serve it from the persisted cache and
  revalidate later, which the web agent is adding) and jitter the first poll after a resume. Both cut the requests
  that arrive in the first seconds. Beyond that, the spike is a CPU-capacity problem: Render Starter (0.5 CPU)
  removes it.
