# @fant/fpl

The only code that talks to fantasy.premierleague.com. Platform-agnostic (no Node built-ins): `fetch` and the
clock are injected through `FplServiceOptions`. Every raw response is Zod-parsed in `src/raw.ts` (lenient on extra
fields) and mapped in `src/normalize.ts` to `@fant/shared` DTOs or to the server-only DTOs in `src/dto.ts`. Raw FPL
field names never leave this package.

## Caching and resilience

`createFplService` keeps a TTL cache per resource (`FPL_CACHE_TTL`), refreshes ahead of expiry, shares in-flight
requests for the same path, and serves the last good value when FPL fails (`FPL_STALE_IF_ERROR`). One circuit
(`FplBackoff`) covers the whole FPL host: after a 429 / 502 / 503 / 504 / network error, FPL is not called again
until an exponential backoff (5 s doubling up to 2 min, at least `Retry-After`) has elapsed; meanwhile calls fail
fast with `FplUnavailableError` (kind `backoff`) unless a cached value can be served.

## Gameweek Roundup (סיכום מחזור)

Data access (all cached, Zod-validated, optional on the `FplService` interface so test fakes still compile; the
real service implements all of them):

| Method                          | FPL endpoint                     | TTL   | Notes                                         |
| ------------------------------- | -------------------------------- | ----- | --------------------------------------------- |
| `getEntryHistory(entryId)`      | `entry/{id}/history/`            | 5 min | per-GW points (net + gross), transfers, chips |
| `getEntryTransfers(entryId)`    | `entry/{id}/transfers/`          | 5 min | whole season, oldest first                    |
| `getEventPoints(event)`         | `event/{gw}/live/`               | 30 s  | every player's points/minutes in ONE call     |
| `getLeagueInfo(leagueId)`       | `leagues-classic/{id}/standings` | 2 min | name + `startEvent` (shares the page-1 cache) |
| `getEntryPicks(entryId, event)` | `entry/{id}/event/{gw}/picks/`   | 12 h  | once the GW is finished + data-checked        |

`buildGameweekRoundup(input): RoundupCore` is pure (no I/O, no clock). The API fills in `status`, `events`,
`league`, `captains` and `builtAt`. The rules are documented at the top of `src/roundup.ts`. They were checked
against FPL's own standings: league 4611, GW9 and GW10, all 171 members, plus the "Second Chance" league with
`start_event` 6:

- League total = Σ (GW points − transfer cost) over GWs ≥ `start_event`.
- Rank = total desc, then fewer transfers made (Σ history `event_transfers` from `start_event`; Wildcard and Free
  Hit transfers aren't counted there). Teams equal on both share the rank. Pass `members` in FPL standings order:
  that order is the final tie-break, the same as FPL's `rank_sort`.
- FPL's `last_rank` leaves out members who joined the league after the previous standings update (they show
  `last_rank` 0). The builder can't know join dates, so it ranks every member who had a team in that GW.
- FPL standings `event_total` is the GW score BEFORE the hit. The roundup's `eventPoints` is AFTER the hit, so
  `lastTotal + eventPoints = total`. `transferCost` is on every row.
- Finished-GW picks already include auto-subs (the sub moves into the XI slot) and the vice's promotion (captain
  ×0, vice ×2/×3). Σ points × multiplier = gross GW points for every member checked.

### Back-filling a GW: request budget and concurrency

One GW for N members costs N history + N transfers + N picks requests, plus 1 live and 1 bootstrap. History and
transfers cover the whole season, so fetch them once per member and build every missing GW from the same objects
(the 5-minute TTL won't outlast a long back-fill). Picks are one request per member per GW.

Recommended: `mapWithConcurrency(members, ROUNDUP_FETCH_CONCURRENCY /* 4 */, …)`. Measured against FPL in Nov 2026
at concurrency 4: 171 histories + 171 transfer lists took about 23 s, and 171 picks about 12 s, with no 429s. A
full back-fill of GW1–10 for 171 members is about 342 + 1,710 requests, roughly 2–3 minutes. Don't go above
`LIVE_LEAGUE_CONCURRENCY` (6). The circuit is shared with live traffic, so one 429 pauses every FPL call.

When FPL fails mid-build (`FplUnavailableError`, including kind `backoff`), abort and don't store a partial
roundup. Mark the GW `building` and retry after `getHealth().retryAt`. A member whose history or picks return 404
(`FplNotFoundError`) can be passed as `history: null` / `picks: null`; the builder leaves them out, or leaves that
data blank.

Build only once the GW is `finished && dataChecked`. A history fetched just before the flag flipped can be cached
for up to 5 minutes. To be safe, build (or rebuild once) at least `FPL_CACHE_TTL.history` after the flip.
