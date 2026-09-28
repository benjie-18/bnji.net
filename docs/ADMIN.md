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

Rules the endpoint holds to:

- **No invented metrics.** A group whose store is unavailable returns `null` and
  the panel prints an explanation rather than a convincing `0`.
- **No "recent posts" total** — an early draft of the panel had one; the store
  does not aggregate it, so it was removed rather than faked.
- **Security telemetry stays separate**, keeps its own table and 60-day
  retention, and never contributes to a public or traffic figure.

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

The playlist panel needs the same migration — `0008_music_playlist.sql` adds
`music_playlist_items` and `music_playlist_state` to the existing `BOARD_DB`
binding. There is no second database and no in-memory fallback: with no binding
every playlist route answers `503 storage_unconfigured` rather than pretending a
playlist was saved or, worse, that it was emptied. The optional provider
credentials (`YOUTUBE_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`)
are looked up lazily and only improve the importer's autofill — without them it
falls back to public oEmbed and manual entry, so the panel is never blocked.

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
  and sticker images are never logged. Retention is 60 days, capped at 5,000.

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
- **Links are normalised server-side**, never stored as pasted: canonical
  YouTube links become `https://youtube.com/watch?v=…` and `http://` /
  `youtu.be` inputs are accepted and rewritten; Spotify query strings (`?si=`)
  are stripped. Only single Spotify tracks are accepted — albums and playlists
  are refused with a reason rather than embedded as something the player cannot
  advance from.
- **The date field is provider-dependent.** `musicDateField()` maps
  youtube → `publishedAt` and spotify → `releaseDate`; the panel relabels the
  input and its hint per provider so a YouTube upload date is never typed into
  the Spotify release-date field. `sourceId` is stored for re-resolution;
  `durationSeconds` stays display-only and is never persisted.
- **The panel never touches dashboard DOM.** `startAdminPlaylist(root, host)`
  returns actions and receives exactly two writers (`say`, `fail`), the same
  contract the rest of the dashboard uses.

`npm test` covers the store (seed-once, dense positions, the UNIQUE
constraint), link normalisation, the provider lookups and every route's
refusal, against real SQLite through a D1-shaped adapter.
