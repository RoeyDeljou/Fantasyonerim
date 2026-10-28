# Connecting the content sources — setup guide

Everything here is done **once**. After that the app mirrors every new episode, Instagram post and story, and X
post into News automatically — nobody re-posts anything by hand. If a source stops working, the admin console →
Integrations card shows what went wrong and what to do; the other sources keep working.

| Source                | What you need to do                   | Cost             |
| --------------------- | ------------------------------------- | ---------------- |
| Podcast RSS           | Nothing                               | Free             |
| Apple Podcasts        | Nothing                               | Free             |
| Spotify               | Nothing (set up by the developer)     | Free             |
| YouTube               | Nothing (already connected)           | Free             |
| Instagram             | One-time Meta app + "Connect" (below) | Free             |
| X (read + live posts) | Optional — only if you want it        | Paid (X charges) |
| WhatsApp              | Deferred — not part of this release   | —                |

The accounts the app follows are listed in [CLIENT_ACCOUNTS.md](CLIENT_ACCOUNTS.md).

## 1. Podcast RSS — automatic, nothing to do

- The feed `https://anchor.fm/s/105778688/podcast/rss` is preset. Every episode (title, description, artwork,
  number, duration) comes from it; it is the source of truth for episodes.
- If it ever changes: Spotify for Creators → Settings → Availability / Distribution → "RSS feed" → paste the new
  URL in admin console → Integrations → Podcast RSS.

## 2. Apple Podcasts — automatic, nothing to do

- Show id `1819558192` is preset (the number after `/id` in the Apple Podcasts show URL; pasting the whole show
  URL also works). No account or key is needed — Apple's lookup is public.
- Each episode card gets its "Listen on Apple Podcasts" button, usually within a few hours of the RSS episode.

## 3. Spotify (episode links) — automatic, nothing to do

- The developer's Spotify app keys are set on the server as `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`
  (docs/DEPLOY.md). On first boot they are stored encrypted in the Spotify integration, so every episode gets
  its "Listen on Spotify" button. Show `4sYY0tpz7M8gflimZAglHi` is preset.
- No Spotify user ever logs in to this app: it only reads public show data.
- If Spotify isn't configured, episodes still appear (with the Apple button), just without the Spotify button.

**Rotating the keys** (e.g. the Spotify app was deleted or its secret was reset):

1. https://developer.spotify.com/dashboard → the app → Settings → copy the new **Client ID** / **Client secret**
   (a new app: "Create app", any name, Redirect URI `https://example.com/callback` — required by the form, unused —
   API **Web API**). Spotify requires the account that owns a Development-mode app to have **Premium**.
2. Admin console → Integrations → Spotify → paste both into the secret fields → Save. Once keys are saved in the
   console they win over the server variables, so also update `SPOTIFY_CLIENT_*` on Render to keep them in sync
   (optional).

## 3b. YouTube (Shorts, videos, episode links) — automatic, nothing to do

Already connected to **@Fantasyonerim** (`https://www.youtube.com/@Fantasyonerim`, channel id
`UCGjQpoCQcIMtirSjDW1IfxA`). No account, key or quota is needed — the app reads the channel's public feed every
10 minutes:

- **Shorts** and **regular videos** appear in News (with a notification for new ones; the first import is silent).
- **Full-episode videos** don't get their own card: the matching podcast episode gets a "Watch on YouTube" button
  instead.
- Limits of the free feed: only the newest 15 uploads are visible, so older episodes have no YouTube button.

If the channel ever changes: admin console → Integrations → YouTube → paste `@handle`, the channel link or the
`UC…` id. If the console says it couldn't look the channel up from the server (YouTube sometimes shows servers a
consent page), paste the `UC…` id instead — it's in the channel link `youtube.com/channel/UC…` (YouTube → the
channel → About → Share channel → Copy channel ID).

## 4. Instagram (posts + stories) — one-time setup, free

The app follows **`fantasyonerimfpl`** (not `pod_fantasyonerim`). Meta's API works through a Facebook Page, so
the steps below connect the Instagram account → a Facebook Page → a small Meta app. The Meta app stays in
**Development mode**, which means **no App Review and no business verification** — it only ever reads the
account of people who have a role on the app.

### 4.1 Instagram side (the account owner)

1. `fantasyonerimfpl` is already a **Business** account — nothing to change.
2. Link it to a Facebook Page: Instagram → Settings → Accounts Center (or "Business tools" → "Connect a Facebook
   Page") → pick or create the Page. From the Page side: Page → Settings → Linked accounts → Instagram.
3. Add the developer as an **admin of that Facebook Page** (Page → Settings → Page access / "New Pages
   experience" → Add people → full control). The person who presses "Connect" later must manage the Page.

### 4.2 Meta app (the developer, once)

1. https://developers.facebook.com → My Apps → **Create app**. Pick the "Other" use case → app type **Business**
   (the wizard's wording changes; "Manage everything on your Page" is equivalent). Name: "Fantasyonerim app".
2. Add the product **Facebook Login for Business**. In its Settings add this **Valid OAuth Redirect URI**
   (exactly — the admin console shows the same value):

   ```
   ${API_PUBLIC_URL}/v1/integrations/instagram/callback
   ```

   e.g. `https://fantasyonerim-api.onrender.com/v1/integrations/instagram/callback`.

3. App settings → Basic: fill Privacy Policy URL (the app's privacy page) and copy the **App ID** and **App
   secret**. Put them on the server as `META_APP_ID` / `META_APP_SECRET` (Render → Environment) and redeploy.
   They are never entered in the console.
4. **Keep the app in Development mode.** App roles → Roles → add the **client** (Administrator or Developer);
   they accept the invite at https://developers.facebook.com/requests. The developer is already admin as the
   creator. Only people with an app role can connect — that's why no App Review is needed.
5. Permissions requested at connect time (all available in Development mode for app roles):
   `instagram_basic`, `pages_show_list`, `pages_read_engagement`, `business_management`.

### 4.3 Connect (in the app)

Admin console → Integrations → Instagram → **Connect with Facebook** → log in with Facebook → select the Page
linked to `fantasyonerimfpl` (and that Instagram account) → allow. The card then shows `@fantasyonerimfpl`; if
it shows a different username, the wrong account was picked — connect again. Posts appear in News within ~10
minutes, stories within ~5 minutes (the first import is silent: no notification flood).

**Re-consent every ~90 days.** Meta asks for the data-access permission to be renewed about every 90 days. The
Instagram card shows the date; when it's close (or the card says the connection was revoked/expired — e.g.
after a Facebook password change or removed permissions), press **Connect** again. Nothing else changes.

## 5. X — optional, paid

X charges for API use (pay-per-use credits), so X is off until you decide to pay for it. It does two things:

- **Read**: mirrors new posts from `@Fantasyonerim` into News (every 10 minutes, only new posts, at most ~10 per
  check).
- **Write**: the admin "Live update" composer can also post to X (goal alerts etc.). Without write keys the X
  toggle there says "X isn't connected — paid feature, contact the creator".

Setup (on the **@Fantasyonerim** account):

1. https://developer.x.com → sign in with `@Fantasyonerim` → sign up for the developer portal → choose
   **pay-per-use** and buy a small amount of credits.
2. Create a Project + App. App → **User authentication settings**: App permissions **Read and write**, type
   "Web App, Automated App or Bot", Callback URL `https://example.com/callback`, Website URL the app's site → Save.
3. App → **Keys and tokens**. Generate the access token _after_ step 2 so it carries write permission. Paste into
   admin console → Integrations → X:

   | X portal name          | Console field  | Used for                |
   | ---------------------- | -------------- | ----------------------- |
   | Bearer Token           | `bearerToken`  | reading posts into News |
   | API Key (Consumer Key) | `apiKey`       | posting live updates    |
   | API Key Secret         | `apiSecret`    | posting live updates    |
   | Access Token           | `accessToken`  | posting live updates    |
   | Access Token Secret    | `accessSecret` | posting live updates    |

   Username is preset to `fantasyonerim`; the console looks up the account id itself. Only the Bearer Token →
   reading only; only the four write keys → posting only.

**Costs.** You pay X per post read and per post created at the current rates on developer.x.com → Billing (check
there — X changes them). This app keeps reads small: each check asks only for posts newer than the last one it
saw. A live update costs one post (plus one image upload when it has a photo). If the credits run out, the X card
(and the live-update result) shows "403 / plan or credits missing" — top up and it resumes by itself.

Keys are stored encrypted on the server and are never shown again, in the console or anywhere else. To replace
one, paste the new value; to remove one, clear it.

## 6. WhatsApp — deferred

Not part of this release (client decision, 2026-10-27). The wanted version is an automatic WhatsApp group bot
(teams after the deadline, live goals, lineups); its constraints and costs are written up in
[CLIENT_ACCOUNTS.md → WhatsApp](CLIENT_ACCOUNTS.md#whatsapp-client-decision-2026-10-27). The live-update composer
is built so WhatsApp can be added later as one more target.

## Reference: stored settings

| Integration | Settings (shown in the console)          | Secrets (write-only, encrypted)                                     |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------- |
| podcast_rss | `rssUrl`                                 | —                                                                   |
| apple       | `podcastId`                              | —                                                                   |
| spotify     | `showId`                                 | `clientId`, `clientSecret` (seeded from `SPOTIFY_CLIENT_*`)         |
| youtube     | `channel` (→ `channelId`, resolved)      | —                                                                   |
| instagram   | `igUserId`, `username`, `pageId` (OAuth) | `accessToken` (OAuth); server env `META_APP_ID`, `META_APP_SECRET`  |
| x           | `username`, `userId`                     | `bearerToken`, `apiKey`, `apiSecret`, `accessToken`, `accessSecret` |
