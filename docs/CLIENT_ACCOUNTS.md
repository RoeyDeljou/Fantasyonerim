# Client accounts (confirmed facts)

The accounts the app mirrors into News. Integrations must target exactly these.

| Platform                                    | Account                                                                         | Source of truth                 |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| Podcast RSS (Spotify for Creators / Anchor) | https://anchor.fm/s/105778688/podcast/rss                                       | Apple Podcasts lookup `feedUrl` |
| Apple Podcasts                              | id `1819558192`                                                                 | iTunes search                   |
| Spotify show                                | `4sYY0tpz7M8gflimZAglHi` (https://open.spotify.com/show/4sYY0tpz7M8gflimZAglHi) | Client, 2026-10-26              |
| Instagram                                   | **`fantasyonerimfpl`** (the active account — NOT `pod_fantasyonerim`)           | Owner confirmed 2026-10-25      |
| X                                           | `Fantasyonerim` (https://x.com/Fantasyonerim)                                   | Linked 70× from the RSS         |
| Hosts                                       | Dor Dabush, Itay Tabka                                                          | RSS channel description         |

When the admin connects Instagram via OAuth, the connect flow must pick the IG account whose username is
`fantasyonerimfpl` if several are offered, and warn if the connected username differs.

## Captain Battle (client decision, 2026-10-26)

Default rows, in this order:

1. **הקפטן של דור** — linked to Dor's FPL Team ID (captain read from his picks each GW).
2. **הקפטן של איתי** — linked to Itay's FPL Team ID.
3. **קפטן הקהילה** — player chosen manually by an admin each GW (kind `community`).

Admins can add more rows and name them freely (either linked to a Team ID or a hand-picked player).
Dor's and Itay's Team IDs: _pending — the client will provide them with the admin accounts._

## Podcast listening (client decision, 2026-10-26)

**No in-app audio player.** The client monitors listening stats in their Spotify for Creators and Apple Podcasts
Connect business accounts, so "Listen" always hands off to Spotify or Apple Podcasts (the user picks; optional
remembered choice). The RSS audio enclosure is stored but never played in the app. If the client later wants those
stats inside the app, add them via the platforms' analytics APIs — out of scope for now.

## WhatsApp (client decision, 2026-10-27)

**Deferred.** The client prefers an automatic WhatsApp group bot (teams after the deadline, live goals/assists,
official lineups) over linking a personal WhatsApp and sending manually — but the bot is not urgent and is out of
scope for now. Known constraints for when it's picked up: WhatsApp's official Groups API is reportedly capped at 8
participants, so a bot in the existing community group needs an unofficial linked-device client on a dedicated
number (ban risk; the number's phone must stay online), an always-on host (not Render free), and a lineup source
(FPL has none — ESPN's free match summary, as used in the football-drinking-game repo). Phase 4 builds the admin
broadcast with News / push / X targets only, with WhatsApp as a pluggable `Publisher` target for later.
