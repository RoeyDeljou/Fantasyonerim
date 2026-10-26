# Client accounts (confirmed facts)

The accounts the app mirrors into News. Integrations must target exactly these.

| Platform                                    | Account                                                               | Source of truth                 |
| ------------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| Podcast RSS (Spotify for Creators / Anchor) | https://anchor.fm/s/105778688/podcast/rss                             | Apple Podcasts lookup `feedUrl` |
| Apple Podcasts                              | id `1819558192`                                                       | iTunes search                   |
| Spotify show                                | _pending — client sends `https://open.spotify.com/show/<id>`_         | –                               |
| Instagram                                   | **`fantasyonerimfpl`** (the active account — NOT `pod_fantasyonerim`) | Owner confirmed 2026-10-25      |
| X                                           | `Fantasyonerim` (https://x.com/Fantasyonerim)                         | Linked 70× from the RSS         |
| Hosts                                       | Dor Dabush, Itay Tabka                                                | RSS channel description         |

When the admin connects Instagram via OAuth, the connect flow must pick the IG account whose username is
`fantasyonerimfpl` if several are offered, and warn if the connected username differs.

## Captain Battle (client decision, 2026-10-26)

Default rows, in this order:

1. **הקפטן של דור** — linked to Dor's FPL Team ID (captain read from his picks each GW).
2. **הקפטן של איתי** — linked to Itay's FPL Team ID.
3. **קפטן הקהילה** — player chosen manually by an admin each GW (kind `community`).

Admins can add more rows and name them freely (either linked to a Team ID or a hand-picked player).
Dor's and Itay's Team IDs: _pending — the client will provide them with the admin accounts._
