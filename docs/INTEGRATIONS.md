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

- **Read**: mirrors new posts from `@Fantasyonerim` into News (twice a day by default, only new posts, at most ~10
  per check, a little more to catch up after a gap).
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
there — X changes them). This app keeps reads small:

- One server-side check serves every user — the app never calls X from a phone.
- Each check asks only for posts newer than the last one it saw (`since_id`), so every post is read (and billed)
  once.
- The search itself skips replies, reposts and the post types the admin turned off, so X never returns (or bills)
  them. Defaults: **photos on, web links off, videos off** (owner decision, Nov 2026). Quote posts are kept.
- Admin console → Integrations → X → "מה מושכים מ־X": three switches (links / photos / videos) and "תדירות בדיקה"
  (every 30 min, 1 h, 3 h, 6 h, twice a day — default — or once a day). Changes apply on the next check; "Sync now"
  checks immediately. A failed check is retried after an hour.

A live update costs one post (plus one image upload when it has a photo). If the credits run out, the X card shows
"X credits depleted" (a live update shows "403 / plan or credits missing") — top up and it resumes by itself.

Keys are stored encrypted on the server and are never shown again, in the console or anywhere else. To replace
one, paste the new value; to remove one, clear it.

## 6. WhatsApp — deferred

Not part of this release (client decision, 2026-10-27). The wanted version is an automatic WhatsApp group bot
(teams after the deadline, live goals, lineups); its constraints and costs are written up in
[CLIENT_ACCOUNTS.md → WhatsApp](CLIENT_ACCOUNTS.md#whatsapp-client-decision-2026-10-27). The live-update composer
is built so WhatsApp can be added later as one more target.

## 7. FPL Lad — Ask Alfie widget

FPL Lad's AI assistant **Alfie** ([fpl-lad.com](https://www.fpl-lad.com/)) is available on every app screen behind a
floating **"Ask Alfie"** button (FPL Lad's round badge, "Ask Alfie" underneath). The button opens their chat page,
`https://www.fpl-lad.com/chat`, in an **in-app panel (iframe)** — this is the live integration, agreed with and
confirmed by FPL Lad (Nov 2026, see "The in-app panel" below). An embed script is an optional future path: if they
ever ship one, an admin pastes its URL in Admin → Settings — **no code change and no new app version**.

### What is built (our side)

- **Launcher** (`apps/web/src/components/assistant/AskAlfie.tsx`): bottom corner on the inline-end side (left in
  Hebrew, right in English), just above the tab bar and stacked above the tables' floating "Join our league" / "My
  team" button. On all five tabs, their sub-views and Profile; never on onboarding / welcome / terms and never inside
  the admin console. Hidden while a sheet or dialog is open, while a reply is being typed, and while Alfie is open.
  Its code is its own chunk, fetched ~1.5 s after the screen has painted — nothing on first load.
- **Embed adapter** (`apps/web/src/lib/assistant/fplLad.ts`): the ONLY file that knows FPL Lad's script API. If
  their real API differs from what is expected below, that one file changes.
- **In-app panel** (`apps/web/src/components/assistant/AlfiePanel.tsx`): the live integration; used whenever no
  script is set, or when a script fails. Full-screen slide-up on phones, a 420×640 panel in the corner on wide screens; header with the FPL Lad
  logo, "Alfie · by FPL Lad", an "open in a new tab" link and close (button, Escape, Android back). It frames the
  fallback URL (no `sandbox`, so their Google popup sign-in works). If the frame hasn't loaded after ~6 seconds a
  "Not loading? Open in fpl-lad.com" line appears; once it has loaded the line never shows.
- **Staying signed in** (`apps/web/src/lib/assistant/fplLadBridge.ts`): the panel keeps FPL Lad's sign-in on the
  device and hands it back to their `/chat` frame on every open — see "Staying signed in to Alfie" below.
- **Returning visitors**: if their script reports an `identity` event with a `visitorToken`, we keep it in our own
  (first-party) storage on the device and pass it back on `init`. Safari partitions third-party storage, so this is
  what lets an iPhone visitor be remembered. The token is only ever given back to their script.
- **Admin → Settings → "Ask Alfie (FPL Lad)"**: who sees the button (Off / Admins only / Everyone), the script URL,
  the partner ID, the fallback URL, Save and a Preview button that opens Alfie right there.
- **Headers**: `vercel.json` sets no `Cross-Origin-Opener-Policy: same-origin` (it would break the Google sign-in
  popup) and no Content-Security-Policy; a unit test (`apps/web/src/lib/vercelConfig.test.ts`) keeps it that way.

### Optional future path: FPL Lad's embed script

Not needed today (the in-app panel is the agreed integration); kept so a script can be switched on without an app
release if FPL Lad ever ship one. One line, which the app injects itself on the first tap (only from `https://*.fpl-lad.com` — any other host is
rejected by the API and the client):

```html
<script async src="https://www.fpl-lad.com/embed.js" data-partner="{partnerId}"></script>
```

It should define a global `window.FPLLad` (`FplLad` / `fplLad` also accepted) with:

| Method                | Required | What we do with it                                                                       |
| --------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `init(options)`       | yes      | Called once, on the first tap (may return a promise).                                    |
| `open()`              | yes      | Called on every tap of our "Ask Alfie" button.                                           |
| `close()`             | no       | Closes their panel.                                                                      |
| `update(options)`     | no       | Called when the visitor signs in/out or switches language or theme.                      |
| `on(event, callback)` | no       | We listen to `close` (show our button again) and `identity` (`{ visitorToken }`, above). |

`options` (all set by us):

| Option         | Example                                                            | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `partner`      | `"fantasyonerim"`                                                  | Our partner ID (Admin → Settings; `fantasyonerim` until they assign one). |
| `teamId`       | `1234567`                                                          | The visitor's FPL Team ID (number), omitted when unknown.                 |
| `locale`       | `"he"` / `"en"`                                                    | The app's language (Hebrew is RTL).                                       |
| `lang`         | `"he"` / `"en"`                                                    | Same as `locale`, under the name their `/chat` page reads.                |
| `theme`        | `"light"` / `"dark"`                                               | The app's current theme.                                                  |
| `launcher`     | `false`                                                            | Don't draw your own button — we draw "Ask Alfie".                         |
| `colors`       | `{ primary: "#3d185b", onPrimary: "#ffffff", surface: "#ffffff" }` | The current theme's colours, so the widget matches the app.               |
| `zIndex`       | `60`                                                               | Stack the widget at/above this.                                           |
| `bottomOffset` | `64`                                                               | Pixels taken by our tab bar at the bottom (keep clear of it).             |
| `visitorToken` | `"…"`                                                              | The token you gave us in an earlier `identity` event, if any.             |

If the script fails to load, or `window.FPLLad` doesn't appear within 8 seconds, or `init`/`open` throws, the app
uses the in-app panel and logs one console warning (`[Ask Alfie] …`).

### The in-app panel (`/chat` in an iframe) — live, confirmed by FPL Lad

`fallbackUrl` (default `https://www.fpl-lad.com/chat`, FPL Lad's chat page) is opened with these query parameters,
in this order (after any already on the URL, which are kept; ours win on a clash):

| Parameter | Value                                                               |
| --------- | ------------------------------------------------------------------- |
| `teamId`  | the FPL Team ID, when known                                         |
| `lang`    | `he` / `en`                                                         |
| `embed`   | `1` inside the app's panel (absent on the "open in a new tab" link) |
| `partner` | the partner ID, else `fantasyonerim`                                |
| `theme`   | `light` / `dark`                                                    |

Example: `https://www.fpl-lad.com/chat?teamId=28060&lang=he&embed=1&partner=fantasyonerim&theme=light`.

FPL Lad confirmed (Nov 2026) the iframe `/chat` integration, and it was verified live on mobile and desktop:

- `teamId` and `lang` are read (`locale` is also accepted): the visitor lands straight in the chat, in their
  language, with their squad loaded.
- `embed=1` gives a compact view for the panel; `partner=fantasyonerim` is tracked on their side. `theme` is sent for
  when they support it.
- Their `Content-Security-Policy: frame-ancestors` allows our production, preview and Capacitor origins (table below).
- Guest sessions are header-based and their cookies are partitioned, so the chat works with third-party cookies
  blocked (Safari, Chrome) and the conversation survives closing and reopening the panel.
- Google sign-in runs as a popup from inside the iframe (hence no `sandbox` and no COOP on our side).

(The optional script's `init()` options above use `locale`; we also send the same value as `lang` there.)

### Staying signed in to Alfie (host bridge)

On an iPhone home-screen app, the `/chat` iframe's storage is partitioned and does not survive the app being
closed, so a fan who signed in to Alfie with Google was signed out on the next visit (a Safari tab keeps it, which
is why it "works on their phone"). FPL Lad's `/chat` page already talks to its parent window; the app now keeps
their sign-in in its own (first-party) storage and hands it back to the frame. Code:
`apps/web/src/lib/assistant/fplLadBridge.ts` (the only file that knows this protocol, unit-tested in
`fplLadBridge.test.ts`), wired by `components/assistant/useFplLadBridge.ts` while the panel's iframe exists.

| Direction   | Message                                                                 | What happens                                                                                      |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| frame → app | `{ type: "fpl-auth-complete", user: { id, … }, embedToken?, cookies? }` | Validated, then stored as received with a `savedAt` timestamp. Not echoed back.                   |
| frame → app | `{ type: "fpl-auth-signout" }` or `{ type: "fpl-signout" }`             | Clears the stored sign-in. **FPL Lad don't send this yet** — handled so it works the day they do. |
| frame → app | any other `fpl-…` message (e.g. a future `fpl-ready`)                   | The first one per frame load triggers a hand-back. **Their page sends none today.**               |
| app → frame | the stored `fpl-auth-complete` payload, exactly as received             | Posted to the frame's exact origin (never `"*"`) — see "When the sign-in is handed back" below.   |

**When the sign-in is handed back.** Today this runs on timers. FPL Lad's live `/chat` posts nothing to its parent
except `fpl-auth-complete`; its other messages (`fpl-render-height`, `fpl-popup-auth-started`, `fpl-podcast-dismissed`)
stay inside their own page. So we can't tell when their listener is attached. We measured it at ~70–610 ms after the
iframe's `load` (CPU throttling ×1–×6), so the app posts the stored payload **1.5 s and 4 s after every `load`** (the
second one covers a slow iPhone cold start). It also posts once on the first `fpl-…` message from the frame, if one ever
arrives. That is at most 3 posts per frame load; their handler tolerates repeats. A fresh `fpl-auth-complete` or a
sign-out message from the frame cancels the rest for that load. If their listener attaches later than 4 s, the sign-in
isn't restored on that open: hence the `fpl-ready` request below.

- **Accepted only from the panel's own frame**: `event.source` must be the iframe's `contentWindow`, and
  `event.origin` must be the fallback URL's origin (`https://www.fpl-lad.com`) or its apex/www twin
  (`https://fpl-lad.com`) — https on an fpl-lad.com host only. Messages from the top page, another frame or another
  origin are ignored. If an admin points the fallback URL at another site, the bridge is off.
- **Shape and size**: `user.id` a non-empty string (≤ 200 chars), `embedToken` a string if present, `cookies` at
  most 20 `{ name, value }` strings if present, the whole message under 32 KB as JSON. Anything else is dropped.
- **Storage**: `localStorage["fant.alfie.auth"]` = `{ payload, savedAt }` on the fan's device. It is never sent to our
  API or anywhere else — only back into FPL Lad's frame. A corrupt entry is deleted on read.
- **Clearing**: on signing out of the app, deleting the account, or the session ending (`lib/session.tsx` →
  `clearFplLadAuth()`), and when an admin signs in on a fan's device (the fan's session is put aside). That way a
  shared phone's next user doesn't open someone else's Alfie. Also cleared on FPL Lad's (future) sign-out message.
- The script path's returning-visitor token (`fant.alfie.visitor`, above) is separate and unchanged.

Gaps in FPL Lad's side of the protocol (to raise with them):

- **No sign-out message.** When a fan signs out inside Alfie we keep the old payload and replay it on the next open,
  signing them back in. Please post `{ type: "fpl-auth-signout" }` to the parent on sign-out (already handled here).
- **No "ready" message.** Their page posts nothing to the parent until a sign-in completes, so we hand the sign-in back
  on timers (1.5 s and 4 s after `load`). A slow device whose listener attaches after 4 s misses it. Please post
  `{ type: "fpl-ready" }` to the parent once the `message` listener is attached; we already hand back on it straight
  away.
- **Token refresh isn't reported.** If their session tokens rotate after sign-in, we only hold the first ones; a fresh
  `fpl-auth-complete` (or an `fpl-auth-refresh`) after each refresh would keep the stored copy valid.
- **Target origin `"*"`.** They post the session (cookies + embed token) to the parent with `"*"`; any site allowed
  by their `frame-ancestors` would receive it. Posting to the known parent origin (from a `partner` allow-list or
  `document.referrer`) would be safer.
- **Our sign-out can't sign the frame out.** Clearing our copy stops the replay, but a session still alive in the
  frame's own storage (e.g. in a Safari tab context) stays until they expire it; a parent → frame sign-out message
  would close that.

The launcher and the panel header use FPL Lad's round badge (`apps/web/public/brand/fpl-lad-badge.png`, supplied by
FPL Lad); the wide wordmark (`fpl-lad.png`) stays on the Captain Battle tag and share posters.

The panel relies on their site allowing our domains to frame it (no `X-Frame-Options: DENY/SAMEORIGIN`; a
`Content-Security-Policy: frame-ancestors` listing the domains below) — FPL Lad have this in place. A new origin
(e.g. a custom domain) must be sent to them before it goes live.

### Domains FPL Lad allow (`frame-ancestors`)

| Where                          | Origin                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| Production                     | `https://fantasyonerim.vercel.app`                              |
| Vercel preview deployments     | `https://fantasyonerim-*-roeydeljou1-3768s-projects.vercel.app` |
| Local development              | `http://localhost:3000`                                         |
| Future iOS app (Capacitor)     | `capacitor://localhost`                                         |
| Future Android app (Capacitor) | `https://localhost`                                             |

### Switching it on

Admin console → **Settings** → **Ask Alfie (FPL Lad)**:

1. **Who sees the button** — _Admins only_ (the default) to try it; _Everyone_ to launch; _Off_ to hide it. With the
   script URL empty (the normal setup) the card shows "Live: Alfie opens fpl-lad.com/chat in the in-app panel…".
2. Optional, only if FPL Lad ever send an embed script: paste its `src` URL into **FPL Lad's script URL** and their
   partner key into **Partner ID**, press **Preview** to check, then **Save**. Clear the script URL to go back to the
   in-app panel.

Changes reach the apps within a few minutes (the public config is cached briefly); no deploy needed.

## Reference: stored settings

| Integration | Settings (shown in the console)          | Secrets (write-only, encrypted)                                     |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------- |
| podcast_rss | `rssUrl`                                 | —                                                                   |
| apple       | `podcastId`                              | —                                                                   |
| spotify     | `showId`                                 | `clientId`, `clientSecret` (seeded from `SPOTIFY_CLIENT_*`)         |
| youtube     | `channel` (→ `channelId`, resolved)      | —                                                                   |
| instagram   | `igUserId`, `username`, `pageId` (OAuth) | `accessToken` (OAuth); server env `META_APP_ID`, `META_APP_SECRET`  |
| x           | `username`, `userId`                     | `bearerToken`, `apiKey`, `apiSecret`, `accessToken`, `accessSecret` |
