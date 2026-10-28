# @fant/integrations

Every external content platform, normalized into `NewsItemDraft`s (see `src/types.ts`). This package never
reads env vars, the database or disk: credentials, `fetch` and the clock come in through the arguments and
an `IntegrationContext` (`{ fetch, now }`).

- Inbound sources implement `ContentSource.fetchLatest(cursor) → SourceResult` (`items`, `skipped`,
  `warnings`, `accountLabel`, `cursor`, `notModified`). Persist `cursor` and pass it back on the next poll.
  Upsert by `dedupeKey`; re-polling is idempotent. A bad item lands in `skipped`, never thrown.
- Failures are typed: `IntegrationAuthError` (reconnect / re-enter keys), `IntegrationRateLimitError`
  (`retryAfterSec`), `IntegrationUnavailableError` (platform down, retry later), `IntegrationConfigError`
  (settings are wrong).
- Media `sourceUrl`s are platform CDN URLs (Instagram's expire): apps/api must re-host them.

| Integration   | Factory                                                                                                        | Settings (non-secret)            | Secrets                                                    | Dedupe key                               |
| ------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `podcast_rss` | `createPodcastSource({ rssUrl, resolvers })` (or `createPodcastRssSource`)                                     | `rssUrl`                         | —                                                          | `podcast:<rss guid>`                     |
| `apple`       | `createAppleLinkResolver({ podcastId })`                                                                       | `podcastId` (number or show URL) | —                                                          | (links only)                             |
| `spotify`     | `createSpotifyLinkResolver({ showId, clientId, clientSecret })`                                                | `showId` (show URL or id)        | `clientId`, `clientSecret`                                 | (links only)                             |
| `instagram`   | `createInstagramPostsSource` / `createInstagramStoriesSource({ igUserId, accessToken, username })`             | `igUserId`, `username`, `pageId` | `accessToken` (Page token from `completeInstagramConnect`) | `instagram:<id>`, `instagram_story:<id>` |
| `x` (read)    | `createXSource({ bearerToken, userId, username })`, `resolveXUser` once to get `userId`                        | `username`, `userId`             | `bearerToken`                                              | `x:<post id>`                            |
| `x` (publish) | `createXPublisher({ apiKey, apiSecret, accessToken, accessSecret, username })`                                 | `username`                       | `apiKey`, `apiSecret`, `accessToken`, `accessSecret`       | —                                        |
| `youtube`     | `createYouTubeSource({ channelId })`, `createYouTubeLinkResolver({ channelId })`; `resolveYouTubeChannel` once | `channel` (→ `channelId`)        | —                                                          | `youtube:<video id>`                     |

Podcast episodes: RSS is the source of truth; Spotify/Apple resolvers only add links (matched by GUID →
normalized title → episode number + date → unambiguous date). Spotify/Apple can list an episode hours after the
RSS, so apps/api should periodically call `resolveEpisodeLinks(recentRefs, resolvers)` +
`mergePodcastLinks` for recent episodes still missing a link (refs via `episodeRefFromDraft`).

Episode thumbnails: the Spotify Web API, RSS and Apple only expose the square show cover. For video episodes,
`fetchSpotifyEpisodeThumbnail(spotifyEpisodeUrl, ctx)` reads Spotify's public oEmbed (no auth) and returns the
per-episode 16:9 `{ url, width, height }`, or null (not an open.spotify.com episode URL — no fetch; 404; no https
thumbnail; or `type !== "video"` with a square thumbnail = the show cover). 429 → `IntegrationRateLimitError`,
5xx/network/bad body → `IntegrationUnavailableError`. The URL is a Spotify CDN image: re-host it like other media.

Instagram uses Facebook Login for Business on `graph.facebook.com` (`GRAPH_API_VERSION`): connect with
`buildInstagramConnectUrl` → callback → `completeInstagramConnect` (returns the connectable accounts; Page tokens
do not expire).

X is pay-per-use: reading uses `since_id` + small `max_results`; posting enforces the 280 weighted-char limit
(`XPostTooLongError`). Images go through `POST /2/media/upload` (images only, ≤ 5 MB).

YouTube (no API key, no quota): `resolveYouTubeChannel(channel, ctx)` turns the admin's input (`@handle`,
`youtube.com/@handle`, `m.youtube.com/@handle?ra=m`, `youtube.com/channel/UC…`, `UC…`) into `channelId` — a
handle costs one channel-page GET (canonical link → `itemprop` meta → `"externalId"`/`"channelId"`); a
consent.youtube.com redirect (EU/UK servers) is an `IntegrationUnavailableError` asking for the UC… id.
`createYouTubeSource` reads the public Atom feed (**newest 15 uploads only**) and emits `youtube_short` /
`youtube_video` drafts. Short vs regular: the feed's `/shorts/` link, else `HEAD /shorts/<id>` (200 = Short, 303 →
`/watch` = regular), cached in memory and in the cursor, so an unchanged feed costs 0 probes; a failed probe →
regular + a warning, re-checked next poll (same dedupe key, so the upsert must update `source`). Thumbnails:
Shorts `oar2.jpg` 1080×1920, videos `hq720.jpg` 1280×720 — neither is generated for every upload (hq720 is 404 for
the channel's current episodes), so each media carries `fallback` = `hqdefault.jpg` 480×360, which always exists.
Short titles lose their trailing hashtags (kept in `text`). `createYouTubeLinkResolver` (platform `youtube`) adds
`links.youtube` to podcast episodes: title (never across different episode numbers) → "פרק NN" + ≤ 7 days → title
containment; never date alone, never a Short. `isEpisodeVideo(video, episodes)` tells apps/api to skip a
`youtube_video` draft that is an episode's video. Without an API key only the newest 15 uploads can be linked;
older episodes keep no YouTube link (accepted).

Client-facing setup steps: see `docs/INTEGRATIONS.md`. Tests: `npx vitest run packages/integrations` (offline,
recorded payloads in `src/__fixtures__/`).
