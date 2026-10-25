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

| Integration   | Factory                                                                                            | Settings (non-secret)            | Secrets                                                    | Dedupe key                               |
| ------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `podcast_rss` | `createPodcastSource({ rssUrl, resolvers })` (or `createPodcastRssSource`)                         | `rssUrl`                         | —                                                          | `podcast:<rss guid>`                     |
| `apple`       | `createAppleLinkResolver({ podcastId })`                                                           | `podcastId` (number or show URL) | —                                                          | (links only)                             |
| `spotify`     | `createSpotifyLinkResolver({ showId, clientId, clientSecret })`                                    | `showId` (show URL or id)        | `clientId`, `clientSecret`                                 | (links only)                             |
| `instagram`   | `createInstagramPostsSource` / `createInstagramStoriesSource({ igUserId, accessToken, username })` | `igUserId`, `username`, `pageId` | `accessToken` (Page token from `completeInstagramConnect`) | `instagram:<id>`, `instagram_story:<id>` |
| `x` (read)    | `createXSource({ bearerToken, userId, username })`, `resolveXUser` once to get `userId`            | `username`, `userId`             | `bearerToken`                                              | `x:<post id>`                            |
| `x` (publish) | `createXPublisher({ apiKey, apiSecret, accessToken, accessSecret, username })`                     | `username`                       | `apiKey`, `apiSecret`, `accessToken`, `accessSecret`       | —                                        |

Podcast episodes: RSS is the source of truth; Spotify/Apple resolvers only add links (matched by GUID →
normalized title → episode number + date → unambiguous date). Spotify/Apple can list an episode hours after the
RSS, so apps/api should periodically call `resolveEpisodeLinks(recentRefs, resolvers)` +
`mergePodcastLinks` for recent episodes still missing a link (refs via `episodeRefFromDraft`).

Instagram uses Facebook Login for Business on `graph.facebook.com` (`GRAPH_API_VERSION`): connect with
`buildInstagramConnectUrl` → callback → `completeInstagramConnect` (returns the connectable accounts; Page tokens
do not expire).

X is pay-per-use: reading uses `since_id` + small `max_results`; posting enforces the 280 weighted-char limit
(`XPostTooLongError`). Images go through `POST /2/media/upload` (images only, ≤ 5 MB).

Client-facing setup steps: see `SETUP_NOTES.md`. Tests: `npx vitest run packages/integrations` (offline,
recorded payloads in `src/__fixtures__/`).
