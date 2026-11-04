# Quick load assessment — 2026-11-04

**Setup (tested):** local API build from `8b5808a`, demo FPL data scaled to production payload sizes, local
Postgres, API held to **0.1 CPU / 512 MB by cgroup quota** to match Render free. Each virtual user runs the real
session: open the app (`/v1/me`, `/v1/config`, `/v1/fpl/bootstrap`), then poll live data every 30 s (live table,
fixtures, my-team live, match sheet, captain battle). Production was not touched. Raw output:
`scripts/loadtest/results/quick/`.

## Results (all tested)

| Test | Req | Errors | CPU avg / peak (of a core; quota = 10%) | RSS max | Event loop p99 | App open p50 / p95 / p99 (`/v1/me`·config·bootstrap) | Live table p50 / p95 / p99 | My-team live p95 |
|---|--:|--:|---|--:|--:|---|---|--:|
| 50 users, 30 s | 316 | 0 | 3.3% / 9.6% | 197 MB | 7 ms | 7 / 287 / 388 ms | 2 / 101 / 494 ms | 204 ms |
| 150 users, 60 s | 1,318 | 0 | 4.8% / 9.6% | 204 MB | 11 ms | 5 / 183 / 785 ms | 2 / 10 / 103 ms | 78 ms |
| 300 users, 60 s | 2,629 | 0 | 7.2% / 10.3% | 216 MB | 95 ms | 86 / 891 / 991 ms | 2 / 102 / 203 ms | 201 ms |
| 500 users, 60 s | 4,186 | 0 | 8.3% / 11.2% | 239 MB | 197 ms | **4.3 s / 7.0 s / 7.8 s** | 4 / 499 / 808 ms | 999 ms |
| Spike: 500 users open within 15 s | 3,164 | 0 | 9.9% / 11.1% | 223 MB | 299 ms | **11.9 s / 24 s / 29 s** | 6 / 202 / 395 ms | 406 ms |

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
