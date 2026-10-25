# Integrations — draft setup notes for the client (input for docs/INTEGRATIONS.md)

Everything below is done **once**. After that, the app picks up every new episode, post, story and tweet
automatically.

## 1. Podcast RSS (Spotify for Creators) — nothing to create

- Setting `podcast_rss.settings.rssUrl` = `https://anchor.fm/s/105778688/podcast/rss` (already known).
- Where to find it if it ever changes: Spotify for Creators → Settings → Availability / Distribution → "RSS
  feed".
- This feed is the source of truth for episodes (title, description, audio, artwork, number, duration).

## 2. Apple Podcasts — nothing to create

- Setting `apple.settings.podcastId` = `1819558192` (the number after `/id` in the Apple Podcasts show
  URL; pasting the whole show URL also works).
- No account, key or permission needed (the iTunes lookup API is public).

## 3. Spotify (episode links) — free developer app

Needed only so each episode card can open the episode directly in Spotify.

1. Go to https://developer.spotify.com/dashboard and log in with any Spotify account.
   Note (Spotify policy since Feb 2026): the account that owns a Development-mode app must have **Spotify
   Premium**. Our app only uses public show data via client credentials, so no users ever log in to it.
2. "Create app": name "Fantasyonerim app", description anything, Redirect URI `https://example.com/callback`
   (required by the form, unused), API: tick **Web API**. Accept the terms.
3. Open the app → Settings → copy **Client ID** and **Client secret**.
4. In our admin console → Integrations → Spotify:
   - `spotify.settings.showId`: paste the show link — Spotify app → the podcast → ⋯ → Share → Copy link
     (`https://open.spotify.com/show/<id>`).
   - secrets `clientId`, `clientSecret`.

If Spotify is not configured, episodes still appear (with Apple + in-app audio), just without the Spotify button.

## 4. Instagram (posts + stories) — Meta app, no App Review needed

Requirements on the Instagram side:

1. The Instagram account (e.g. `@pod_fantasyonerim`) must be a **professional account** (Business or
   Creator): Instagram app → Settings → Account type and tools → Switch to professional account.
2. It must be **linked to a Facebook Page** that the connecting person manages: Instagram → Settings →
   Accounts Center / "Page" → connect / create a Facebook Page. (Or from the Page: Settings → Linked accounts
   → Instagram.)

Create the Meta app (one time, by the person who will press "Connect"):

1. https://developers.facebook.com → My Apps → **Create app**. Use case: "Other" → type **Business**
   (or the use case "Manage everything on your Page" / "Instagram — Facebook Login for Business" depending on
   the current wizard). Name: "Fantasyonerim app".
2. Add the product **Facebook Login for Business** (or "Facebook Login"). In its Settings add the **Valid
   OAuth Redirect URI** that our admin console shows (e.g. `https://<api-host>/v1/admin/integrations/instagram/callback`).
3. App settings → Basic: copy **App ID** and **App secret** (these go into the server config, not the
   console — the developer sets them). Fill Privacy Policy URL with the app's privacy page.
4. **Keep the app in Development mode.** In Development mode the app works for people who have a role on
   the app — so make sure the person connecting Instagram is the app **Admin** (they are if they created it)
   or add them under App roles → Roles → Add people (Administrator / Developer / Tester; they accept the
   invite at developers.facebook.com/requests). No App Review / Business verification is needed because the
   app only reads the account of someone with a role on it.
5. Permissions requested at connect time (all available in Development mode for app roles):
   `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `business_management`.

Connect: admin console → Integrations → Instagram → **Connect Instagram** → log in with Facebook → select the
Page that is linked to the Instagram account (and the Instagram account) → allow. The console then shows
`@username`. Stored: `instagram.settings.igUserId`, `instagram.settings.username`, `instagram.settings.pageId`,
secret `accessToken` (a Page token that does not expire). Reconnect only if the console says the connection
was revoked/expired (e.g. Facebook password change, permissions removed, or Meta's 90-day data-access
re-consent — the console shows the date).

## 5. X / Twitter (read posts + optional posting) — paid, pay-per-use

The X API is billed per request/post read, so this is a **paid feature**: it switches on purely by adding keys.

1. https://developer.x.com → sign in **with the podcast's X account** (`@Fantasyonerim`) → sign up for the
   developer portal and choose the **pay-per-use** plan; buy credits (a small top-up is enough: we read at
   most ~10 posts per poll and only new ones).
2. Create a Project + App. In the app's **User authentication settings**: App permissions **Read and
   write**, type "Web App, Automated App or Bot", Callback URL `https://example.com/callback`, Website URL the
   app site. Save.
3. Keys and tokens tab:
   - **Bearer Token** → secret `bearerToken` (reading the timeline).
   - **API Key** and **API Key Secret** → secrets `apiKey`, `apiSecret`.
   - **Access Token and Secret** (generate _after_ setting Read and write, so they carry write permission)
     → secrets `accessToken`, `accessSecret`. Needed only for posting live broadcasts to X.
4. Admin console → Integrations → X: `x.settings.username` = `Fantasyonerim` (the console resolves and
   stores `x.settings.userId`), paste the secrets.

If X returns "403 / plan or credits missing", the credits ran out or the plan doesn't include the endpoint.

## Summary of keys (admin settings names)

| Integration | settings                                 | secrets                                                             |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------- |
| podcast_rss | `rssUrl`                                 | —                                                                   |
| apple       | `podcastId`                              | —                                                                   |
| spotify     | `showId`                                 | `clientId`, `clientSecret`                                          |
| instagram   | `igUserId`, `username`, `pageId` (OAuth) | `accessToken` (OAuth); server config: Meta `appId`, `appSecret`     |
| x           | `username`, `userId`                     | `bearerToken`, `apiKey`, `apiSecret`, `accessToken`, `accessSecret` |
