# BNJI.NET — admin system: DB-backed token, live stats, live view pill

Consolidation of the admin surface onto **one** module (`src/server/admin.ts`),
one credential stored as a **hash in D1**, a site-wide **statistics** panel built
only from data that actually exists, and a **live** view pill replacing the
hand-entered Ayo counter.

---

## ⚠️ Read this first: the seeded token is not a secret

The initial access token was supplied in the original build request rather than
generated into a secret store, and it was published in the handover notes — so
**anyone who read them could sign in to `/admin`.**

- It is the value hashed by `migrations/0005_admin_credentials.sql` and seeded
  into `admin_credentials`.
- **Its plaintext is deliberately not written down here.** This document used to
  name it, which is self-defeating: the file is in the repository, so the one
  thing the no-secrets rule exists to prevent was the rule's own example. Only
  the SHA-256 digest is stored, and the seed comment in the migration says the
  same.
- If you need the current token, it is not recoverable from the database — only
  its hash is there. Ask whoever holds the handover notes, or reseed it.
- **Change it at your first login**: `/admin` → *Settings* → *Access token*.
  The panel shows *"seeded, never rotated"* until you do.

**Rotation is one-way.** Only the hash is stored, so the current token cannot be
read back. If it is lost, reseed by hand:

```sql
UPDATE admin_credentials SET token_hash = '<hex(sha256(newtoken))>', updated_at = <epoch_ms> WHERE id = 1;
```

---

## 1. What was reused rather than rebuilt

The admin surface was **not** greenfield. Inspected and absorbed:

| Existing | Kept for |
| --- | --- |
| `src/config/access.config.ts` | The `/admin` + `/api/admin` rule declarations; the module reads the rule rather than hardcoding a pattern. |
| `src/middleware.ts` | Route enforcement. **Now delegates admin rules to `isAdminRequest()`.** |
| `src/server/access.ts` | Generic HMAC primitives, reused for signing/verifying. |
| `scripts/verify-access.mjs` | Build-time proof that no protected page is prerendered. |
| `profile_views` / `getViewStats()` | The one definition of a "view". Now feeds both the public pill and the dashboard. |
| `boardStore.summarize()`, `securityStore.summarize()` | Board and security figures, unmodified. |

**Superseded:** plaintext `ACCESS_TOKEN` for admin. `ACCESS_SECRET` is still the
session-signing key. `ACCESS_TOKEN` remains supported by the generic path in
`src/server/access.ts` for any non-admin `auth: 'token'` rule — verified: the
stale `.dev.vars` value gets `401` from `/api/admin/stats`.

---

## 2. One module, one guard

`src/server/admin.ts` owns the token check, login exchange, session issuance,
rotation, and the uniform `401` / `503` responses. `isAdminRequest()` is the
single source of truth, and it is applied uniformly:

- **Middleware** delegates any `sessionPattern === '/admin'` rule to it, so a
  protected page and its API cannot disagree.
- **Every API route** calls it directly.
- **`/board`** reuses it to decide whether to render moderation controls.

### The credential

`migrations/0005_admin_credentials.sql` — one table, one row, enforced by
`CHECK (id = 1)` so a second admin is impossible at the storage layer, not just
by application discipline. No roles, no OAuth, no accounts.

| Column | Contents |
| --- | --- |
| `token_hash` | `hex(sha256(token))`. Never the token. |
| `updated_at` | Epoch ms of last rotation; `0` = still the seed. |

> SHA-256 is fast, which is normally wrong for passwords. It is right here:
> this is a single shared secret for one operator, not a per-user table, and
> the threat model is "someone copies the database" — against which a fast hash
> still means a stolen dump yields no plaintext. The real defence against
> guessing remains the login rate limit.

### Sessions

`bnji_session`, 8 h, **`HttpOnly; Secure; SameSite=Strict`**, `Max-Age` cleared
on logout. Format:

```
<pattern>:<expiry>[:<credentialFingerprint>].<HMAC-SHA256>
```

HttpOnly is why the token can simply be discarded after the exchange: the
dashboard's JavaScript never holds it. A bearer header is still accepted so curl
and scripts work.

**Rotation invalidates sessions immediately** because the payload carries a
16-hex-char fingerprint of the token hash. Rotating the token changes the
fingerprint, so every outstanding session stops verifying on its next request —
rather than lingering for up to eight more hours.

### Login throttle

10 failed attempts / 15 min / IP, KV-backed, **charged on failure only**. A
budget spent by *successful* sign-ins would lock the owner out of their own
site, which is the wrong thing for a throttle to do.

---

## 3. Statistics — every number is real

`GET /api/admin/stats` reads through the same store methods the public features
call, so a dashboard figure cannot drift from the visitor-visible number.
Rendered in `/admin` → *Statistics*.

| Group | Source | Meaning of "total" |
| --- | --- | --- |
| Traffic | `profile_views` via `getViewStats()` | `COUNT(*)` over **distinct `(session_key, day_key)`** — one view per session per day |
| Engagement | `profile_reactions`, `profile_link_clicks` | Per-reaction and per-link counts; labels resolved from profile data ("Reddit", not `reddit`) |
| Message board | `boardStore.summarize()` | `total`, `byStatus`, `postedLast24h`, `reportedLast24h` |
| Security | `securityStore.summarize()` | `total`, `last24h`, `uniqueIps`, `uniqueDevices`, `enriched`, `bySurface`, `byEndpoint`, `retentionDays` |
| Credential | `admin_credentials.updated_at` | `0` = seeded, never rotated |
| Game usage | `GET /api/admin/games` | Private per-game aggregates and up to 100 recent run details (active time, IP/UA/device classes, validated score counts); bounded by configured retention and omits guest/player/run identifiers |

Rules the endpoint holds to:

- **No invented metrics.** A group whose store is unavailable returns `null` and
  the panel prints an explanation rather than a convincing `0`.
- **No "recent posts" total** — an early draft of the panel had one; the store
  does not aggregate it, so it was removed rather than faked.
- **Security telemetry stays separate**, keeps its own table and the shared
  configurable raw-tracking retention (default 60 days, 1–365), and never
  contributes to a public or traffic figure.

---

## 4. The live view pill

The `🔥1950 · from Ayo` pill and the line *"…is the original Ayo counter ·
BNJI views start from zero"* are **gone**. The pill now shows the live total.

- `ProfilePage.astro` takes an optional `viewCount` prop; when supplied it
  replaces the static `counter` block. The two are mutually exclusive, so there
  is exactly one pill from exactly one source.
- `/gizlyy/` passes `viewStats.total` — the same `getViewStats()` value the
  page's own stat block and the dashboard show.
- The explanatory note line under the stats was removed; a note only appears
  when the counts are unavailable.

**Location note:** this content was on **`/gizlyy/`**, not `/about/`.
`/about/` never contained it.

**Views are recorded by a client-side beacon** (`POST /api/profile/view`), not
during SSR — so `curl`ing the page does not increment anything. Exercise it by
posting to the endpoint with a `bnji_ps` cookie.

---

## 5. Verification

`npm run check` (build + `verify-access.mjs` + `tsc` + `wrangler deploy --dry-run`)
passes. Live against `wrangler dev` — **22/22**:

| Check | Result |
| --- | --- |
| `/admin` unauthenticated | `302` → login |
| `/admin/login` | `200` (public by design) |
| `/api/admin/{stats,board,security,config}` unauthenticated | `401` each |
| Login: wrong token / too-short token | `401` each |
| Login: seeded token | `200` + `HttpOnly; Secure; SameSite=Strict` cookie |
| All admin routes with a session | `200` |
| Logout | `204` + `Max-Age=0`; next request `401`, `/admin` → `302` |
| **Rotation: wrong current token** | `403` |
| **Rotation: new token < 8 chars** | `422` |
| **Rotation: no session** | `401` |
| **Rotation: old session afterwards** | **`401` — dead immediately** |
| **Rotation: old token afterwards** | **`401`** |
| Session forgery (bad HMAC / stale expiry) | `401` |
| Bearer auth | `200` |
| Login throttle | 10 failures → `429` |
| Stale `.dev.vars` `ACCESS_TOKEN` | `401` |
| `/gizlyy/` — `1950` / `Ayo` | **0 occurrences** |
| Public pill == dashboard total | both `8` |
| Dedup: 5 posts, 1 session | `+1` |
| Dedup: 2 posts, 2 sessions | `+2` |
| Admin leakage in 8 public pages + JS chunks | none |
| Board moderation (unauth / authed / restore) | `401` / `200` / `200` |

### Two things worth knowing

- **`astro check` was not run.** It requires installing `@astrojs/check`, which
  would add a dependency. The constraint was no new npm packages, so the frozen
  toolchain (`astro build` + `tsc`) was used instead. `package.json` changed only
  in its `scripts` block; the lockfile is untouched.
- **No browser engine is installed**, so all QA above is HTTP-level. The panel's
  rendered layout and the pill's visual appearance have **not** been confirmed in
  a real browser.

### Two pre-existing behaviours found while testing (not changed)

- Astro's CSRF `checkOrigin` returns `403 "Cross-site DELETE form submissions are
  forbidden"` when a `DELETE` arrives **without** an `Origin` header. Browsers
  always send one, so the real logout works; bare `curl` must pass
  `-H "Origin: http://127.0.0.1:8788"`.
- `GET /api/profile/link/<id>` requires `?slug=`; without it, `400` by design.

---

## 6. Setup

```bash
npx wrangler d1 migrations apply bnji-board --remote
wrangler secret put ACCESS_SECRET
```

Without the migration or without `ACCESS_SECRET` the guard **fails closed** with
`503 admin_not_configured` rather than serving. Then sign in at `/admin` and
**change the seeded token immediately**.

The panel is also one click away from the public site: Settings (the header
gear) carries an *Admin* link to `/admin/`. It is a plain anchor with no
client-side check of its own, so the route below behaves exactly as it does
for anyone who types the URL — unauthenticated visitors are still sent to
`/admin/login` by the guard, never let through by the link.

The playlist panel needs the same migration — `0008_music_playlist.sql` adds
`music_playlist_items` and `music_playlist_state` to the existing `BOARD_DB`
binding. There is no second database and no in-memory fallback: with no binding
every playlist route answers `503 storage_unconfigured` rather than pretending a
playlist was saved or, worse, that it was emptied. The optional provider
credentials (`YOUTUBE_API_KEY`, and the `SPOTIFY_CLIENT_ID` /
`SPOTIFY_CLIENT_SECRET` pair) are declared in the env schema in
`astro.config.mjs`, looked up lazily, and only improve autofill — without them
the importer falls back to each provider's public oEmbed endpoint and manual
entry, so the panel is never blocked. The Spotify pair is a Client Credentials
pair: the token it buys is server-only and never reaches a browser. Neither
credential is needed to seed a Spotify track by hand, which uses no lookup at
all.

---

## 7. Panel UI

- Styles live in `src/styles/admin.css` (global, `admin__`-prefixed) because
  most panel markup is built at runtime by `admin-dashboard.ts`, which scoped
  Astro styles cannot reach.
- Every clickable control is a site `.glass-button` capsule; sections, filters
  and tables sit on `data-glass` surfaces; hints are glass text plates.
- Tab switching uses a "sling" indicator: its leading edge moves on
  `--dur-base`, its trailing edge on `--dur-slow` with `--ease-spring`. It
  follows the Settings store: performance mode drops the spring, reduced
  effects / OS reduced motion remove the travel.
- The Security panel also shows the admin-only Paint activity trail: accepted
  publish timestamps, revisions, action counts and an opaque ephemeral session
  ID. It is not an account or person identifier; local drafts, pointer paths
  and sticker images are never logged. Retention uses the shared admin setting
  (60 days by default, 1–365), with a 5,000-row cap.

### Planned admin surfaces (not implemented)

The chat system plan ([`CHAT-SYSTEM-PLAN.md`](./CHAT-SYSTEM-PLAN.md)) adds a
**Chat** tab and a moderation queue. Nothing below exists yet; it is recorded
here so the admin docs and the plan cannot drift apart:

- **Active rooms** — a bounded `room_registry` row per room lets an
  administrator list unexpired rooms and open a room's live chat through a
  service-authenticated Durable Object endpoint. Rooms expire in ≤2 hours and
  are deleted with their transcript.
- **Moderation actions** — delete a message, kick or mute a member, and
  temporarily ban a principal; every action writes to a moderation audit log.
- **Reports** — the board's proven flow (report → distinct-reporter count →
  triage) applied to room chat, with the reported message snapshotted at report
  time so evidence survives the room's expiry.
- **Private messaging** — admin visibility is a configured mode (metadata only,
  content on report, or full logging; see the collection policy and plan §3 D10
  and §15 Q1). Whichever mode is configured must be disclosed to users in the
  messaging UI; the admin panel must never show content the configured mode
  says is not collected.

All of these follow the existing rules: admin-guard authenticated,
`cache-control: no-store`, no internal IDs in public responses, and an entry in
the `docs/DATA.md` §11 collection register before the surface ships.

---

## 8. The playlist panel

`/admin` → *Playlist* edits the live queue that `GET /api/playlist` serves to
the player. `MUSIC_SOURCE.tracks` is the seed and the offline fallback, never
the live queue: the stored playlist is copied in from it exactly once, and after
that only this panel changes what plays.

- **Every mutation checks the credential itself** and answers `503` — not
  `401` — when no credential row exists or no D1 binding is present. A panel
  that cannot write must not look like a panel that wrote nothing.
- **Nothing is silently dropped.** A partial `reorder` list returns `409`
  together with the full stored order, so a stale panel recovers without a
  second request; duplicates and unknown ids are `409` too. The error
  vocabulary is a closed set (`invalid_json`, `invalid_link`,
  `title_required`, `playlist_full`, `invalid_id`, `not_found`,
  `invalid_order`, `invalid_direction`, `query_failed`,
  `storage_unconfigured`) and the panel renders the reason.
- **Links are normalised server-side**, never stored as pasted: a canonical
  YouTube link becomes `https://youtube.com/watch?v=…`, and `http://` /
  `youtu.be` / Shorts / live / embed inputs are accepted and rewritten to it.
  A playlist, channel or any non-YouTube link is refused with a reason rather
  than stored as something the player cannot advance from. The submitted URL
  itself is never fetched — requests go only to the fixed provider endpoints in
  `MUSIC_PROVIDER_URLS`, built from an id `parseMusicLink()` already validated.
- **Only YouTube can be imported here.** `parseMusicLink()` also accepts a
  Spotify track link, because the player does play Spotify tracks — but those
  are seeded by hand from `src/config/music.config.ts` and have no admin UI.
  Both `/api/admin/playlist` and `/api/admin/playlist/resolve` therefore refuse
  anything that is not `IMPORTABLE_PROVIDER` with `400 invalid_link`. This is
  enforced, not assumed: the panel's copy, its date label and its error message
  all describe YouTube, and the save path carries only `publishedAt`, so a
  Spotify row would silently lose the `releaseDate` the player actually reads
  for that provider.
- **There is one date field per provider.** A YouTube video has one date worth
  storing, its upload date, stored as `publishedAt`; the panel labels the input
  **Publication date** and the player shows "Published …". A hand-seeded
  Spotify track carries `releaseDate` instead and the player shows
  "Released …" — `musicDateField(provider)` picks the right one, so the two
  never share a column or a verb. `sourceId` is stored for re-resolution;
  `durationSeconds` and `thumbnailUrl` stay display-only and are never
  persisted.
- **Providers this build does not play are skipped, not deleted.**
  `ACTIVE_PROVIDERS` in `src/server/music-store.ts` is
  `['file', 'spotify', 'youtube']`, and the storage `CHECK` constraint in
  `0008_music_playlist.sql` is exactly the same three — the two agree, so a
  valid row never fails a constraint this code does not itself violate.
  `rowToItem()` still returns `null` for anything outside that set, which makes
  a row from a *future* build that adds a fourth provider inert in every read
  path (public endpoint, admin list, move, reorder, remove) without touching
  your data. Nothing today falls in that gap, so there is normally nothing to
  delete. If a future provider is ever retired and you do want the rows gone,
  run this yourself — it is your data, and it is the only destructive statement
  in this feature:

  ```sql
  -- Substitute the providers the CURRENT build plays. Listing a provider that
  -- is still live here deletes every track using it.
  DELETE FROM music_playlist_items WHERE provider NOT IN ('file', 'spotify', 'youtube');
  ```

  Back up the database first (`wrangler d1 export bnji-board --remote`), and
  note that a `reorder` afterwards must list exactly the rows that remain, or it
  is refused with `409`.

  **Spotify is the one to be careful with.** It is live in the player but has no
  admin UI: a Spotify track is added by hand in `src/config/music.config.ts`
  and seeded into D1 from there. The statement above lists it, so it is safe as
  written — but a copy that drops `'spotify'` from the `NOT IN` list would
  silently delete every hand-seeded Spotify track. Check the list against
  `ACTIVE_PROVIDERS` before running it.
- **The panel never touches dashboard DOM.** `startAdminPlaylist(root, host)`
  returns actions and receives exactly two writers (`say`, `fail`), the same
  contract the rest of the dashboard uses.

`npm test` covers the store (seed-once, dense positions, the UNIQUE
constraint, the retired-provider skip), link normalisation, the provider
lookups, the player's provider switching and every route's refusal, against
real SQLite through a D1-shaped adapter.
