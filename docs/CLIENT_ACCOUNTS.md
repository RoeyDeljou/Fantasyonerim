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
