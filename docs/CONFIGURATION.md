# BNJI.NET — configuration guide

Every configurable value in the project, in one place. For each: what it does,
whether it is **PUBLIC** (ships to browsers) or **SECRET** (server environment
only), where it lives, and how to replace it safely.

> Golden rule: **no real secret ever lands in a file in this repository.**
> Secrets live in the deployment environment. Locally, use `.dev.vars`
> (git-ignored); in production, `npx wrangler secret put <NAME>`.

---

## 1. Site identity & canonical origin — PUBLIC

| Value | Location | Notes |
| --- | --- | --- |
| `SITE.url` | `src/data/site.ts` | Canonical origin (`https://bnji.net`). `astro.config.mjs` imports it for `site:`, so sitemap/RSS/OG/canonical cannot drift. Never point it at a dev host. |
| `SITE.name`, `fullName`, `title`, `description` | `src/data/site.ts` | Wordmark + metadata defaults. |
| `SITE.author.*` | `src/data/site.ts` | **Placeholder identity (lorem ipsum).** This project intentionally carries no personal biography; replace only with other placeholders unless the owner decides otherwise. |
| `SITE.email`, `SITE.github` | `src/data/site.ts` | Placeholder contact targets; single source for every mailto/profile link. |
| Navigation | `src/data/navigation.ts` | `PRIMARY_NAV` (pill nav) and `FUTURE_NAV` (footer "soon" chips). |

## 2. Theme configuration — PUBLIC

| Value | Location | Notes |
| --- | --- | --- |
| `THEME_CONFIG.defaultTheme` | `src/config/access.config.ts` | First-paint theme when nothing is stored — SEEDS the settings store's `theme` field (`dark` = primary space theme). |
| Settings store | `src/scripts/settings.ts` | The single per-visitor source of truth (theme, intro, audio, UI scale, effects). Persisted as ONE object under localStorage `bnji-settings-v1`, controlled from the Settings overlay (header gear), mirrored onto `<html>` data attributes pre-paint by an inline script in `BaseHead.astro` (no flash). |
| Settings: two controls that are NOT settings | `src/scripts/settings-codes.ts`, `src/components/SettingsOverlay.astro` | The overlay's masked *Secret codes* field and its *Admin* link hold no store field, so neither is ever persisted under `bnji-settings-v1`. A submitted code is read, dispatched and wiped in the same turn and wiped again when the panel closes; it is never written to storage, cookies, the URL or the console. `CODE_HANDLERS` is an empty typed registry — the one place a future code effect belongs, and the only place a code is ever read. Because anything client-side is readable by the visitor, that registry is a convenience for harmless UI effects only and is NOT authentication: a feature needing genuinely secret codes must validate them server-side. The Admin link is a plain anchor to `/admin/` and performs no client-side check; the server decides who may stay. |
| `THEME_CONFIG.storageKey` | `src/config/access.config.ts` | LEGACY standalone key (`bnji-theme`) — read once as a migration source for the settings store, then superseded by `bnji-settings-v1`. |
| Palette / glass / motion tokens | `src/styles/tokens.css` | `:root` = dark theme, `[data-theme='light']` = Frutiger Aero light theme. Re-skin by editing tokens only. |
| Aero environment (sky, clouds, orbs, meadow, bokeh) | `src/styles/aero.css`, `src/components/AeroSky.astro` | Painted-scene palette lives in the `--aero-*` block of `tokens.css`; cluster/orb placement arrays live in the component; visuals in CSS. |

## 3. Background music — PUBLIC ordered playlist

| Value | Location | Notes |
| --- | --- | --- |
| `MUSIC_SOURCE.tracks` | `src/config/music.config.ts` | **The SEED playlist and the offline fallback — not the live queue.** The first time the playlist is read from D1 this array is copied into `music_playlist_items` once (`migrations/0008_music_playlist.sql` + `src/server/music-store.ts`); after that the stored playlist *is* the playlist and editing this file changes nothing on a deployment that has already been seeded. If D1 is unconfigured or the read fails the player falls back to this array, so the site never goes silent. Array order is playback order; each entry has a unique `id`, display `title`, `provider` and `url`, plus optional `artist`, `album` and `publishedAt` (the video's upload date). Non-empty metadata appears in smaller text after the title; missing fields are omitted for that track, not shown as a placeholder. Set `tracks: []` to ship with music off until the panel is used. |
| `track.provider: 'file'` | same | Put audio files in `public/music/` and use a root-relative path such as `/music/song.mp3`. The existing `/music/the feeling.mp3` is configured as the first entry. File tracks expose progress and automatically advance at the end. Direct same-origin/CORS-enabled audio URLs are also supported. |
| `track.provider: 'youtube'` | same | Paste a YouTube watch, `youtu.be`, Shorts, live, or embed URL. The player extracts the video ID; the IFrame API provides progress and end events for automatic advance. |
| `track.provider: 'spotify'` | same | Paste an `open.spotify.com/track/<id>` URL, or the equivalent `spotify:track:<id>` URI — both are resolved client-side by `parseSpotifyTarget()` in `src/scripts/music.ts`. **Seeded by hand, not imported**: there is no admin UI for it, so an entry here is the only way a Spotify track enters the queue. Albums, playlists, artists, episodes and shows are refused — a single track is all the embed can play. `releaseDate` is the album's release date and is shown as "Released …"; there is no upload date to report. |
| `MUSIC_SOURCE.defaultVolume` | same | 0..1 — seeds the settings store's `volume`; live volume and mute remain in Settings → Audio. The pill's second control is now the playlist button. |
| Live playlist editing | `/admin` → Playlist | **The editing surface.** `GET/POST/DELETE /api/admin/playlist`, `POST /api/admin/playlist/resolve` (link → editable draft) and `PATCH /api/admin/playlist/order` (a single `{ id, direction: 'up' | 'down' }` move, or a whole new `{ order: string[] }`) — same single-token credential as the rest of the panel, `503 storage_unconfigured` rather than an empty playlist when D1 is missing. Paste a YouTube video link and the server fills the title/artist/date from the provider; a playlist or channel link is refused. Limits (100 items, field lengths) are enforced server-side and mirrored in the panel — see `MUSIC_PLAYLIST` in the config. |
| Public read | `GET /api/playlist` | `{ initialized, count, tracks }` with `cache-control: no-store`; `sourceId`, `position` and timestamps are never serialised. The player fetches it with a 4s abort; any failure leaves the prerendered static playlist in place. An empty stored playlist is served empty and never re-seeded. |
| Playlist storage | D1 (`BOARD_DB`) | `music_playlist_items` + `music_playlist_state` (`migrations/0008_music_playlist.sql`). `position` is explicit and unique and reads are `ORDER BY position`, so order is a stored fact rather than an insertion-time artefact; `music_playlist_state.seeded` distinguishes "never seeded" from "the operator emptied it". No second database, no in-memory fallback. |
| Provider credentials (optional) | Worker env | `YOUTUBE_API_KEY` and the `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` pair — **SECRET**, declared in the env schema in `astro.config.mjs`, read only inside `src/server/music-metadata.ts` and never serialised to a browser. Without them the importer falls back to each provider's public oEmbed endpoint (title, and for YouTube the channel name as a suggested artist) and manual entry always works. The Spotify pair is a Client Credentials pair: the access token it buys is server-only and never reaches a browser. Neither credential is needed to seed a Spotify track by hand. |
| Autoplay policy | `src/scripts/music.ts` | Playback is attempted on page load on `/gizlyy` only — everywhere else the player boots with the first track selected but silent until the visitor presses play. If blocked on `/gizlyy`, a first trusted page input outside the player triggers one additional attempt without cancelling the input; browser policy is still respected. File and YouTube tracks expose a tap-to-play state and a real transport, so the pill's progress bar and the toggle's progress ring are always meaningful for them. A Spotify track is an embed with no supported music-track progress or end event, so its progress region is hidden with a note saying why (and the ring stays empty); advancing (Skip) still works because that is this player's own decision, not an event. Skip always starts the next song immediately, wraps to the beginning at the end of the queue, and restarts the one track in a single-track queue. |

This is a best-effort use of the visitor's first real input, not a browser-policy bypass. The first input is never cancelled or replayed. Every file and YouTube track exposes progress and an end event, so the queue advances in order and stops at the end; a Spotify track neither advances on its own nor reports progress, and the player says so rather than pretending otherwise.

The queue a visitor hears and the queue a screen reader announces are the same
queue: the prerendered markup in `MusicPlayer.astro` and the runtime rebuild in
`src/scripts/music.ts` both call `musicTrackAriaLabel()` and
`getMusicTrackDateLabel()` from `src/config/music.config.ts`, so a track's
accessible name and its date line cannot drift between the two paths — including
which verb it uses, since `musicDateField(provider)` is what decides between
"Published …" (a YouTube upload date) and "Released …" (a Spotify release
date). An empty stored playlist renders its own
`.music-player__empty` message rather than pointing back at the config file.

`npm test` runs the playlist suite (`tests/music-*.test.ts`,
`tests/admin-playlist-api.test.ts`, `tests/admin-playlist-panel.test.ts`)
against real SQLite through a D1-shaped
adapter, including the real migration files.

## 4. Private direct messages (Discord / desktop notification) — provider PUBLIC, credentials SECRET

| Value | Kind | Location | Notes |
| --- | --- | --- | --- |
| `DM_INTEGRATION.provider` | PUBLIC | `src/config/integrations.config.ts` | `'none' \| 'discord' \| 'ntfy'`. **Choose here.** |
| `DM_INTEGRATION.maxLength`, `cooldownSeconds` | PUBLIC | same | Validation + cooldown policy (server enforces). |
| `DISCORD_WEBHOOK_URL` | **SECRET** | Worker env | Full Discord webhook URL (contains its token). `npx wrangler secret put DISCORD_WEBHOOK_URL`. |
| `NTFY_URL` | **SECRET** | Worker env | ntfy.sh or self-hosted topic URL. `npx wrangler secret put NTFY_URL`. |

Read server-side only, via `getSecret()` (`astro:env/server`) in
`src/server/env.ts` → used by `src/pages/api/dm.ts`. The form asks
`GET /api/dm` whether delivery is enabled and renders an explained disabled
state otherwise.

> **Planned, separate feature (not implemented):** account-to-account live
> private messaging with images is specified in
> [`CHAT-SYSTEM-PLAN.md`](./CHAT-SYSTEM-PLAN.md) Phase D. It is a different
> product from this contact-form relay and will get its own config file
> (`src/config/dm.config.ts`) for retention, attachment limits and the admin
> visibility mode. It does not replace the Discord/ntfy relay, which stays the
> "contact the owner" path.

## 5. Public message board — policy PUBLIC, storage INFRA, credentials SECRET

Storage is **Cloudflare D1** (`BOARD_DB` binding). Why D1 over KV: the board's
query pattern is relational — filter by moderation status, order newest-first,
page with a keyset cursor over `(created_at, id)`, and later flip a single
row's status. D1 serves that with one indexed table and atomic single-row
writes. KV would need a hand-rolled secondary index rebuilt on every write
(read-modify-write races = lost messages) and per-key `get`s to filter status.
Write volume is low (rate-limited humans), so D1's latency profile is
irrelevant here.

| Value | Kind | Location | Notes |
| --- | --- | --- | --- |
| `BOARD_CONFIG.provider` | PUBLIC | `src/config/board.config.ts` | `'d1' \| 'rest'` preference. **No in-memory production fallback**: an unconfigured store returns an honest `503 storage_unconfigured` instead of silently losing messages. |
| `maxTextLength: 250` | PUBLIC | same | Enforced server-side in `/api/board` with **422 `text_too_long`** — long posts are rejected, never truncated. |
| other limits (`maxImageBytes`, `allowedImageTypes`, `postCooldownSeconds`, `hourlyPostLimit`, `pollIntervalMs`, visible-count range) | PUBLIC | same | Abuse/size policy; the server re-validates everything. |
| `BOARD_DB` D1 binding | **INFRA** | `wrangler.json` + `migrations/` | The existing `bnji-board` database ID and binding are already configured; do not create/replace it for Games. Owner-operated deployments should review pending migrations and apply them with `npx wrangler d1 migrations apply bnji-board --remote`. Local development uses `--local`. Schema: the sixteen files in `migrations/`, applied in order — see the table below and DEPLOY.md. |
| `BOARD_KV` KV binding | **INFRA** | `wrangler.json` | Shared rate limiting (see below). `npx wrangler kv namespace create BOARD_KV`, paste the id (same placeholder rule). |
| `BOARD_REST_URL`, `BOARD_REST_TOKEN` | **SECRET** | Worker env | Optional external JSON API provider (`provider: 'rest'`). |

**Rate limiting** (`src/server/ratelimit.ts`): fixed-window counters in KV with
per-window TTLs (`rl:<scope>:<client>:<window>`), so limits are shared across
Worker isolates — different isolates can no longer hand out independent
allowances. Accepted trade-off: two concurrent same-window hits can
under-count by one (KV has no atomic increment); that bounds enforcement at
"limit + concurrency", fine for throttling humans. A Durable Object would be
exact but adds deployment infra for no practical gain here. If KV is missing
entirely, rate limiting **fails open** with a console warning — it is an abuse
throttle, not authentication.

### 5.1 D1 schema — sixteen migrations, one database

There is **one** D1 database (`bnji-board`, bound twice: see the note below). The
migrations are cumulative and tracked by D1 in its own `d1_migrations` table, so
`migrations apply` only runs what has not run yet. Applying them again is safe
and is the normal way to move an existing database forward.

| # | File | Adds |
| --- | --- | --- |
| 0001 | `board_messages.sql` | `board_messages` + `idx_board_public`. The public feed's only table. |
| 0002 | `profiles.sql` | `profile_views` (per-session daily dedup), `profile_link_clicks`, `profile_reactions`. Powers `/gizlyy/`. |
| 0003 | `security_events.sql` | `security_events` + 4 indexes. Abuse telemetry, shared configurable raw-tracking retention (60-day default), admin-only, never public. |
| 0004 | `board_moderation.sql` | 4 columns on `board_messages` (`report_count`, `reported_at`, `status_note`, `moderated_at`), `board_reports`, 2 indexes. Makes the `status` column reachable from a real report flow. |
| 0005 | `admin_credentials.sql` | `admin_credentials` (one row, `id = 1` enforced by CHECK). Holds `hex(sha256(token))` — the hashed admin token, rotated from the panel. |
| 0006 | `board_paint.sql` | One versioned shared canvas snapshot plus a bounded set of recent publish IDs for safe retries. Independent of `board_messages`. |
| 0007 | `paint_stickers_activity.sql` | Editable bounded sticker state plus a private Paint publish-summary trail (configurable tracking retention, 5,000-row cap). |
| 0008 | `music_playlist.sql` | Ordered live playlist and seed-state tables. |
| 0009 | `site_settings.sql` | Admin-editable runtime site settings, including tracking retention. |
| 0010 | `secret_code_uses.sql` | Private bounded admin code-use metrics. |
| 0011 | `games.sql` | Private per-game session runs and server-validated leaderboard rows. |
| 0012 | `game_players_saves.sql` | Optional player identities, digested sessions, hashed-IP auth-attempt buckets, and bounded revisioned saves. |
| 0013 | `names.sql` | Chat plan Phase A: `guest_profiles` (display name keyed by SHA-256 of the session id, fixed 30-day sweep) plus nullable unique `handle` / `handle_changed_at` columns on `game_players`. Additive; existing rows untouched, multiple NULL handles allowed. |
| 0014 | `chat_moderation.sql` | Chat plan Phase C: `room_registry` (code/game/owner-hash/expiry — the owner-approved §6.1 trade), `chat_reports` (UNIQUE `(room_code, message_n)`, snapshot + status + note), `chat_reporters` (distinct-reporter PK), `chat_moderation_log` (admin audit), `chat_bans` (principal hash + reason + expiry). All additive; swept by the hourly retention Cron (budget 14 → 19 DELETE statements). |
| 0015 | `dm.sql` | Chat plan Phase D: `dm_conversations`, `dm_messages`, `dm_attachments` (D1 base64 image bytes, the owner-approved plan D6 path), `dm_reports`, `dm_reporters`. 60-day message retention swept by the hourly Cron (budget → 19 DELETE statements). Additive. |
| 0016 | `friends.sql` | Chat plan Phase E: `player_friends` (canonical pair `player_a < player_b`, state pending/accepted/declined, `requested_by` for mutual auto-accept) + `player_blocks`. Additive; rows cascade with account deletion (§9.5). |

⚠️ 0004 uses `ALTER TABLE … ADD COLUMN`, so it must run after 0001. The filename
order D1 applies them in guarantees this — do not run the files by hand or
rename them.

⚠️ 0005 **seeds the admin credential with the token from the build request**,
which is published. Run it, then rotate on first login (see below).

The shared Paint state (0006/0007) uses the existing D1 `BOARD_DB` binding and
is enabled only when `BOARD_CONFIG.provider` is `d1`. Migration 0007 adds
bounded editable stickers and an admin-only publish-summary trail; it adds no
binding or deployment infrastructure. With the board's `rest` provider, Paint
remains visibly unavailable and its API returns `503 paint_requires_d1_board`;
the external REST contract is not assumed to support canvas storage. See
[`DATA.md`](./DATA.md) §10 for synchronization, audit privacy and size bounds.

### 5.2 `BOARD_DB` is bound once (the duplicate is gone)

`wrangler.json` used to bind the same `database_id` twice — `BOARD_DB` plus a
`bnji_board` copy with `"remote": true`. Nothing ever read `bnji_board`, and
the remote flag broke local development (`wrangler dev` demanded a
`CLOUDFLARE_API_TOKEN` and every build needed the flag stripped by hand).
**Resolved 2026-10-01:** the `bnji_board` block is deleted — the documented
fix all along — so `wrangler dev` is plain-local with no flags, and
`npm run preview` chains the pending-only local migration apply before it
starts. Codes that matter: only `BOARD_DB`.

### 5.3 Secrets

| Name | Required? | Notes |
| --- | --- | --- |
| `ACCESS_SECRET` | **Yes, for `/admin`** | Signs admin session cookies **and** derives the Phase C room-admin service token (`sha256('bnji-room-admin:v1:' + secret)`, header `x-bnji-room-admin`) that the DO verifies before `/admin/read` and `/admin/action` — one secret, two uses, both fail closed without it (`503 admin_service_unconfigured` at the gateway, `403 service_unauthorized` at the DO). `wrangler secret put ACCESS_SECRET`. A random 32+ byte value is fine; rotating it invalidates live admin sessions and immediately re-keys the service token (no other action needed). |
| `ACCESS_TOKEN` | No | Legacy generic gate for `ACCESS_RULES`. The admin surface ignores it in favour of the DB-backed credential; keep it only if a non-admin `ACCESS_RULES` prefix needs it. |
| `ACCESS_PASSWORD_SHA` | No | Same — generic HMAC rule support. |
| `DISCORD_WEBHOOK_URL` / `NTFY_URL` | No | `/api/dm` delivery. Unset means the contact form returns `503` and says so. |
| `BOARD_REST_URL` / `BOARD_REST_TOKEN` | No | External board store instead of D1. |

**Moderation groundwork**: every message row carries `status`
(`visible | hidden | reported | deleted`). The public feed selects
`status IN ('visible','reported')` in SQL, so hidden/deleted messages can
never reach a public response, and the status field itself is stripped from
API payloads. Flipping status is a server-side `UPDATE` (`setStatus`).
The admin panel exposes it: delete and restore from the board moderation
list, delete-only by design. Moderation requires the admin session, and no
moderation capability is present in unauthenticated HTML, CSS or JS.

UI (`src/components/MessageBoard.astro`) ↔ API (`src/pages/api/board.ts`) ↔
store (`src/server/board-store.ts`): swapping persistence never touches UI.

**Pagination**: `GET /api/board?limit=N&cursor=C` is keyset-paginated — the
response's `nextCursor` (opaque base64 of `[createdAt, id]`) fetches the next
page of *older* messages; `null` means exhausted. Page numbers are never used,
so concurrent inserts can't shift or duplicate entries between pages.
Legacy `?all=1` still works (the full list's data source: first page at
`archivePageSize` + cursor walking). It returns **visible messages only**, so
a removed message is never listed to a visitor; the admin API
(`/api/admin/board`) is the view that includes hidden and deleted ones.

## 6. Access control / future auth — rules PUBLIC, credentials SECRET

| Value | Kind | Location | Notes |
| --- | --- | --- | --- |
| `ACCESS_RULES` | PUBLIC | `src/config/access.config.ts` | Declare protected route prefixes + auth kind. **Empty by default: everything current stays public.** |
| `ACCESS_TOKEN` | **SECRET** | Worker env | Bearer token for generic `auth: 'token'` rules. **Not** the admin token — see below. |
| `ACCESS_PASSWORD_SHA` | **SECRET** | Worker env | sha256(hex) of the password for `auth: 'password'` rules. Store the hash, never the password. |
| `ACCESS_SECRET` | **SECRET** | Worker env | HMAC key signing the session cookie; also the input to the DO admin service token (Phase C). Required for admin sessions and admin room transcripts. |

Honest limitations (also in `src/middleware.ts`): prerendered static pages
cannot be protected — a private route must set `export const prerender = false;`
so requests run the middleware. Client-side hiding is never used as security.
With no secrets configured, rules fail **closed**.

### 6a. The admin access token — in D1, not in the environment

The admin surface (`/admin`, `/api/admin`) has its own credential, owned end to
end by `src/server/admin.ts`. `ACCESS_TOKEN` is **not** consulted for it — the
generic env path still exists for any other `auth: 'token'` rule, but an admin
request is answered by one guard that reads the database.

| Value | Kind | Location | Notes |
| --- | --- | --- | --- |
| `admin_credentials.token_hash` | **SECRET** | `BOARD_DB`, `migrations/0005_admin_credentials.sql` | `hex(sha256(token))` for a single row (`id = 1`). The plaintext is never stored and never appears anywhere in the repository. |
| `admin_credentials.updated_at` | PUBLIC | same | Epoch ms of the last rotation; `0` means the seeded value is still in place, which the panel surfaces as a prompt to change it. |

- **Setup:** apply the migration (`npx wrangler d1 migrations apply bnji-board --remote`)
  and set `ACCESS_SECRET` (`wrangler secret put ACCESS_SECRET`). Missing either,
  the guard fails **closed** with `503 admin_not_configured` rather than serving.
- **Rotation:** *Settings → Access token* in `/admin`. Requires the **current**
  token in addition to a valid session, stores only the new hash, and needs
  8+ characters. Because sessions are bound to a fingerprint of the token they
  were minted under, rotating **invalidates every existing session immediately**.
- **Sessions:** `bnji_session`, 8h, `HttpOnly; Secure; SameSite=Strict`. Set
  only by `POST /api/admin/session` after the token is verified. `Authorization:
  Bearer <token>` is still accepted for curl and scripts.
- **Login throttle:** 10 failed attempts / 15 min / IP, KV-backed, charged on
  failure only so a burst of *successful* sign-ins cannot lock the owner out.
- **No accounts.** One operator, one token, no roles, no OAuth, no second admin —
  enforced by the `CHECK (id = 1)` constraint, not just by application discipline.
- **Rotation drill:** if the token is lost it cannot be recovered (only its hash
  is stored). Reseed the row by hand: compute `hex(sha256(<new token>))` and
  `UPDATE admin_credentials SET token_hash = '…' WHERE id = 1`.

`POST /api/admin/session` with `newToken` performs the rotation; without it, the
body is a login. Both paths live on the one route because they are the one
concern: the credential and the sessions derived from it.

### 6b. Private tracking retention — ADMIN SETTING

`/admin` → **Configuration** exposes `trackingRetentionDays` (default **60**,
allowed range **1–365**). It controls private `security_events`, Games
`game_sessions`/`game_scores`, and Paint publish activity. It does not change
public profile analytics, game-score ranking caps, session-cookie lifetime, or
board-report deduplication.

The hourly Worker Cron deletes at most 60 expired rows per tracking table per
invocation (a 50-row primary batch plus a 10-row catch-up only when the primary
batch is full). Private admin-read recovery deletes at most 50 per table.
Public/admin queries filter at the configured cutoff immediately, but physical
deletion can take multiple sweeps plus scheduler jitter when a backlog exists. This is a retention control, not
a legal-compliance guarantee; choose a period that matches the actual purpose
and applicable obligations. See [`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md)
for the data inventory, quotas, local testing, and rollback guidance.

## 7. Intro sequence — PUBLIC

| Value | Location | Notes |
| --- | --- | --- |
| `INTRO_CONFIG.enabled` | `src/config/access.config.ts` | Site-wide kill switch AND the settings-store default for `introEnabled`. `false` removes the intro markup at build time; the per-visitor on/off switch lives in the settings store and the Settings overlay (the former Skip button + per-session flag were removed with that move). |
| `INTRO_CONFIG.scrollHeights` | same | Scroll distance in viewport heights. |
| Reduced motion | — | `prefers-reduced-motion` always bypasses the intro (pre-paint `html[data-intro="off"]`), regardless of the setting. |

## 8. Blog & content — PUBLIC

| Value | Location | Notes |
| --- | --- | --- |
| Posts | `src/content/blog/*.md` | Drop-in workflow; schema in `src/content.config.ts` (markdown only — MDX was removed with its workflow). |
| Post helpers | `src/data/blog.ts` | The only read path for collections. |
| Lab experiments | `src/data/lab.ts` + `src/components/lab/*` + the static map in `src/pages/lab.astro` | Add a game = component + data entry + one map line. |
| Fluid Sandbox tuning | `src/components/lab/fluid/config.ts` | Defaults, slider ranges, tools, scenes list, palette, quality tiers, solver + render constants. The UI is generated from it. Scenes live in `fluid/scenes.ts`. |
| Shared board paint | `src/config/paint.config.ts` | Logical canvas size, PNG/request caps, polling and publish limits. The current D1 snapshot is independent from message rows; see [`DATA.md`](./DATA.md) §10. |
| Browser tools (`/tools/`) | `src/config/tools.config.ts` | Output formats (PNG/JPEG/WebP), which of them honour a quality slider, the accepted input types, and the client-side size/pixel limits. PUBLIC. Both tools run in the visitor's browser, so these are guards against an enormous file, not upload quotas — nothing is uploaded. |

## 8a. Display names & handles — PUBLIC (chat plan Phase A)

`src/config/names.config.ts` (`NAMES_CONFIG`) holds the complete naming
policy; the shared validator in `src/server/display-name.ts` and every
name/handle route read it. Names are labels, not identity: they grant no
access.

| Value | Location | Notes |
| --- | --- | --- |
| `displayName.minLength` / `maxLength` | `src/config/names.config.ts` | 1–24 **code points** after NFKC, control/format-character stripping and whitespace collapse. Charset: letters, marks, numbers, space, `_ - .` only. Storage `CHECK`s on `game_players.display_name` remain 48 for historical reasons; the API edge has always enforced 24 and now does so through the one shared module. |
| `displayName.reserved` | same | `admin`, `moderator`, `bnji`, `system` — refused after case-fold, so fullwidth/ligature spellings are refused too. Also applied to handles (deliberate tightening: an `@admin` handle would defeat a reserved display name). |
| `handle.minLength` / `maxLength` | same | 3–20 of `[a-z0-9_]`. One global handle per account, NULL until claimed, unique via migration `0013`. Exact-match lookup only — no directory, no prefix search; `GET /api/players?handle=` returns just handle + display name, never a player ID. |
| `handle.changeCooldownDays` | same | 30 days between changes; first claim is free and an idempotent re-submit of the owned handle neither fails nor resets the clock. |
| `guestProfiles.retentionDays` | same | 30 days after the last change. `guest_profiles` rows are keyed by `sha256(session id)` (the raw `bnji_ps` value is never stored) and swept hourly by the cron job on this fixed window, independent of `trackingRetentionDays`. |
| `limits.nameChangeWindowMs` / `nameChangeMax` | same | `POST /api/profile/name`: 5 per 10 minutes per IP, counted in KV (`BOARD_KV`) — profile naming is not chat/DM/presence/friend activity, so the KV rule allows it. |
| `limits.handleAttemptWindowMs` / `handleAttemptMax` | same | Handle claim and lookup: 8 per 15 minutes per hashed IP, counted in D1 `game_auth_attempts` under distinguishable prefixes (`bnji-handle-claim:` / `bnji-handle-search:`). |

Changing any value takes effect on the next Worker start; no migration is
needed unless you widen `displayName.maxLength` or the handle bounds past
their storage `CHECK`s.

## 8b. Room chat — PUBLIC (chat plan Phase B)

`src/config/chat.config.ts` (`CHAT_CONFIG`, exported from `src/config/index.ts`)
holds the complete room-chat policy. The chat panel reads it for input
attributes and visibility, the `GameRoom` Durable Object reads it for
enforcement, and it is the plan §14 kill switch.

| Value | Location | Notes |
| --- | --- | --- |
| `enabled` | `src/config/chat.config.ts` | Master switch, default `true`. `false` = chat frames refused server-side with `chat_rejected chat_disabled` and the panel hides itself server-side (the markup is wrapped in `{CHAT_CONFIG.enabled && …}`) — rollback without touching the rest of the room protocol. |
| `maxTextLength` | same | 250 code points after sanitising (NFKC, whitespace control → space, other `Cc`/`Cf` stripped, collapse, trim — shared pipeline with display names, but no charset limit: punctuation and emoji are plain text). Over-cap or blank messages get `chat_rejected invalid_text`. |
| `maxStoredMessages` | same | 200 messages per room; oldest rows are trimmed on insert (DO SQLite `game_room_chat`, AUTOINCREMENT sequence). |
| `historyChunkMessages` | same | 25 messages per `chat_history` frame, additionally byte-packed so no frame exceeds the 4,096-byte outbound guard the client enforces (`ROOM_MAX_OUTBOUND_FRAME_BYTES`). Sent after the snapshot on every accept. |
| `rate.burst` / `rate.refillMs` | same | Per-member token bucket in the socket attachment: burst 5, then ~1 token per 4,000 ms (≈15/min sustained). Breaches get `chat_rejected rate_limited` with `retryAfterMs` — the socket stays open. Never written to KV (plan §5.4). |
| `rate.globalPerSecond` | same | Pre-parse abuse ceiling: 8 frames/sec across **all** frame types per connection; the 9th closes the socket with 1013 before any parsing or SQL. |
| `filter.enabled` | same (Phase C) | Master switch for the §6.3 filter blocks, default `true`. `false` = blocklist inert, display strips off. |
| `filter.blocklist` | same (Phase C) | Lowercase phrases matched case-insensitively against sanitised message text before broadcast; a hit is a soft `chat_rejected blocked` (socket stays open). **Triage aid, not a guarantee** — the empty default is deliberate and the docs say so. |
| `filter.stripUrlsForAdmin` | same (Phase C) | Admin transcript view only: raw text is stored raw, and the DO's `/admin/read` replaces `http(s)://…` and `www.…` runs with `[link]` so a click cannot leak the operator's IP. Off = admins read exact text. |
| `moderation.reportWindowMs` / `reportMaxPerWindow` | same (Phase C) | Chat-report HTTP limit: `reportMaxPerWindow` (10) reports per `reportWindowMs` (10 min) per hashed IP, counted in D1 (`reserveAuthAttempt`, prefix `bnji-chat-report:`) — never KV. Breach → `429 rate_limited`. |
| `moderation.defaultBanMinutes` / `maxBanMinutes` | same (Phase C) | Escalate action default 60 min, hard clamp `maxBanMinutes` (7 days = 10,080). Bans live in `chat_bans` and are enforced at `/ws` join time (`403 chat_banned`). |

## 8c. Direct messages — PUBLIC (chat plan Phase D)

`src/config/dm.config.ts` (`DM_CONFIG`, exported from `src/config/index.ts`)
holds the complete private-messaging policy. The /messages/ page reads it for
input bounds and the disclosure line, the `/api/dm/*` routes read it for
enforcement, and it is the plan §14 rollback switch — independent of room
chat. The `DMConversation` class binding (`DM_CONVERSATIONS`, Wrangler
migration `dm-conversations-v1`) is infrastructure, documented in
[`DEPLOY.md`](./DEPLOY.md).

| Value | Location | Notes |
| --- | --- | --- |
| `enabled` | `src/config/dm.config.ts` | Master switch, default `true`. `false` = every `/api/dm/*` route refuses with `dm_disabled` and the UI hides itself — rollback without touching room chat. |
| `maxTextLength` | same | 2,000 code points after the shared sanitizer (NFKC, control/format stripping, collapse, trim — plan §12.2). Over-cap → `422 message_too_long`; blank without an image → `422 empty_message`. |
| `historyPage` | same | 50 messages per REST history page (default newest page; `after` serves reconnect catch-up, `before` serves scrollback — plan §7.3). |
| `retentionDays` | same | **60 days** (owner answer 2026-09-30, plan §15 Q2). The hourly cron purges `dm_messages` older than the window; DM report snapshots follow the shared `trackingRetentionDays` sweep instead (plan §9.1). |
| `rate.sendPerMinute` | same | 30 sends/min per account, D1 counter prefix `bnji-dm-send:` (never KV — plan §11). Breach → `429 rate_limited` with `retryAfter` seconds. |
| `rate.uploadsPerHour` | same | 20 image uploads/hour per account, prefix `bnji-dm-image:` (plan §7.5). |
| `rate.reportsPerWindow` / `reportWindowMs` | same | 10 DM reports per 10 min per account, prefix `bnji-dm-report:` (mirrors the Phase C room-report budget). |
| `rate.connectsPerMinute` | same | 12 socket connects/min per account, prefix `bnji-dm-ws:`. |
| `images.enabled` | same | Independent image kill switch (plan §14: images toggle separately from text). `false` → `403 images_disabled` on attachment routes; text keeps working. |
| `images.maxDecodedBytes` | same | 1,400,000 bytes decoded — the board's documented D1 base64 ceiling under D1's 2 MB row limit (plan D6; R2 stays unprovisioned per the owner's answer). Checked before AND after decode. |
| `images.maxEdge` | same | 1,600 px — the bound the CLIENT normalises to through `<canvas>` before upload (also strips EXIF/GPS, plan §7.4 step 1). |
| `images.allowedTypes` | same | `image/png`, `image/jpeg`, `image/webp` after server-side magic-byte sniffing. **No SVG** (script vector) and never the client's declared MIME. |

## 8d. Friends, presence & notifications — PUBLIC (chat plan Phase E)

`src/config/friends.config.ts` (`FRIENDS_CONFIG`, re-exported from
`src/config/index.ts`) holds the whole Phase E policy: the §14 rollback
switch for the feature, the §8.1 caps, and the D1 rate budgets that back
friend requests, decisions and presence connects (never KV — plan §11). The
`Presence` class binding (`PRESENCE`, Wrangler migration `presence-v1`) is
infrastructure, documented in [`DEPLOY.md`](./DEPLOY.md); the DO stores
nothing durable, so it has no config of its own. The in-app badge on every
page polls `GET /api/notifications` at `notificationsPollMs` — counts only,
in-app only (push/email are deferred by plan §8.3).

| Value | Location | Notes |
| --- | --- | --- |
| `enabled` | `src/config/friends.config.ts` | Master switch, default `true`. `false` = every `/api/friends`, `/api/presence` and badge poll answers `friends_disabled`, and **the DM friendship gate releases** (`/api/dm/*` returns to Phase D's open behaviour) — plan §14's rollback for E without touching room chat or DM itself. |
| `maxFriends` | same | 500 accepted friends (plan §8.1). Over → `409 friends_limit` at request time. |
| `maxPendingOutgoing` | same | 100 unanswered outgoing requests (§8.1). Over → `409 pending_limit`. |
| `requestsPerMinute` | same | 20 friend-request POSTs/min per account, D1 counter prefix `bnji-friend-request:` (never KV). Breach → `429 rate_limited` + `retry-after`. |
| `decisionsPerMinute` | same | 60 accept/decline/block/remove/unblock/min per account, prefix `bnji-friend-decision:`. |
| `presenceConnectsPerMinute` | same | 30 presence socket connects/min per account, prefix `bnji-presence-ws:`. Breach → `429 rate_limited`. |
| `notificationsPollMs` | same | 60,000 ms — the header badge's poll interval while a page is visible (§8.3). Client-side only; the server never pushes badge counts. |

The DM routes read `FRIENDS_CONFIG.enabled` too: with it on, `POST
/api/dm/conversations`, `POST /api/dm/messages` and `POST
/api/dm/attachments` answer `403 not_friends` (or `403 blocked`) unless the
pair are accepted friends and unblocked — owner answer D7, enforced from
Phase E. Reads, media and the conversation socket stay membership-gated.

## 9. Deployment — INFRA (change deliberately, never silently)

| Value | Location | Notes |
| --- | --- | --- |
| Worker name/compat/assets | `wrangler.json` | Static assets from `./dist`. |
| Adapter options | `astro.config.mjs` | `prerenderEnvironment: "node"`. |
| Env schema (secrets list) | `astro.config.mjs` (`env.schema`) | Declares which secrets exist; all optional so builds work unconfigured. |
| D1 migrations, DO classes, bindings, R2 | `wrangler.json`, `migrations/` | **Allowed when planned and documented** (`docs/DEPLOY.md` + this file + `docs/DEPENDENCY-POLICY.md` §6). Each change is its own reviewed commit, and never weakens the `.gitignore` build-output exclusions. |

**Config files status (chat plan).** `src/config/chat.config.ts` is
implemented (Phases B + C: chat caps, message length, per-member budget,
filter, moderation limits — §8b above), and `src/config/dm.config.ts` is
implemented (Phase D: retention window, send/upload/report/connect budgets,
attachment limits — §8c above). Still planned: `src/config/friends.config.ts`
(friend caps, discovery mode, presence visibility). They follow the existing
rules: public policy only, limits in config rather than hard-coded, documented
here when they land. See [`CHAT-SYSTEM-PLAN.md`](./CHAT-SYSTEM-PLAN.md) §9.

## 10. Replacing things safely — checklist

1. Public value → edit the single config file above; grep for duplicates.
2. Secret → set it in the environment (`wrangler secret put` / `.dev.vars`);
   add it to `env.schema` in `astro.config.mjs` and to `secretEnv()` in
   `src/server/env.ts`; document it here.
3. Storage provider → change `BOARD_CONFIG.provider` and/or add the binding;
   UI stays untouched.
4. After any change: `npm run build && npx tsc --noEmit`, then grep `dist/`
   for the secret's *name* (should appear only in server bundles, never in
   `dist/client/**`).
