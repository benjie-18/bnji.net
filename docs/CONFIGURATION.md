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
| `THEME_CONFIG.storageKey` | `src/config/access.config.ts` | LEGACY standalone key (`bnji-theme`) — read once as a migration source for the settings store, then superseded by `bnji-settings-v1`. |
| Palette / glass / motion tokens | `src/styles/tokens.css` | `:root` = dark theme, `[data-theme='light']` = Frutiger Aero light theme. Re-skin by editing tokens only. |
| Aero environment (sky, clouds, orbs, meadow, bokeh) | `src/styles/aero.css`, `src/components/AeroSky.astro` | Painted-scene palette lives in the `--aero-*` block of `tokens.css`; cluster/orb placement arrays live in the component; visuals in CSS. |

## 3. Background music — PUBLIC ordered playlist

| Value | Location | Notes |
| --- | --- | --- |
| `MUSIC_SOURCE.tracks` | `src/config/music.config.ts` | Ordered public queue. Add an object for each song; array order is playback order. Each entry has a unique `id`, display `title`, `provider`, and `url`, with optional `artist`, `album`, and `publishedAt` metadata. Non-empty metadata appears in smaller text after the song title; missing metadata (including an unavailable publish date) is omitted for that track, not shown as a placeholder. Provider metadata is not fetched automatically. Reorder by moving entries in this array; set `tracks: []` to disable music. |
| `track.provider: 'file'` | same | Put audio files in `public/music/` and use a root-relative path such as `/music/song.mp3`. The existing `/music/the feeling.mp3` is configured as the first entry. File tracks expose progress and automatically advance at the end. Direct same-origin/CORS-enabled audio URLs are also supported. |
| `track.provider: 'youtube'` | same | Paste a YouTube watch, `youtu.be`, Shorts, live, or embed URL. The player extracts the video ID; the IFrame API provides progress and end events for automatic advance. |
| `track.provider: 'spotify'` | same | Paste an `open.spotify.com` track, album, or playlist link. Spotify remains a visible embedded player with its own controls. Spotify's current iFrame API is documented for podcast controls; it does not define a supported progress/end contract for music-track embeds. So the site cannot reliably show Spotify progress or auto-advance from a Spotify track, though manual Skip works. Use file/YouTube tracks when site-level progress and automatic progression are required. Spotify controls its own volume/mute. See [Spotify's Embed docs](https://developer.spotify.com/documentation/embeds) and [iFrame API reference](https://developer.spotify.com/documentation/embeds/references/iframe-api). |
| `MUSIC_SOURCE.defaultVolume` | same | 0..1 — seeds the settings store's `volume`; live volume and mute remain in Settings → Audio. The pill's second control is now the playlist button. |
| Admin editing / uploads | — | The existing admin config view is read-only. No playlist editor or upload endpoint was added: the simplest supported workflow is to edit this one ordered array (and add local assets under `public/music/`) before deployment. |
| Autoplay policy | `src/scripts/music.ts` | Playback is attempted on page load. If blocked, a first trusted page input outside the player triggers one additional attempt without cancelling the input; browser policy is still respected. File/YouTube expose a tap-to-play state. Spotify uses its embed's own controls because the supported Embed iFrame API contract does not expose music-track playback state to this page. |

This is a best-effort use of the visitor's first real input, not a browser-policy bypass. The first input is never cancelled or replayed. File and YouTube tracks automatically advance in order and stop at the end of the queue; Spotify music tracks can be skipped manually, but their supported embed contract does not signal track progress/end to the site.

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
| `BOARD_DB` D1 binding | **INFRA** | `wrangler.json` + `migrations/` | One-time setup: `npx wrangler d1 create bnji-board`, paste the printed `database_id` into `wrangler.json` (the committed placeholder is a nil UUID so `wrangler dev` works locally but a deploy fails loudly until replaced), then `npx wrangler d1 migrations apply bnji-board --remote`. Local dev: `npx wrangler d1 migrations apply bnji-board --local` instead. Schema: the seven files in `migrations/`, applied in order — see the table below and DEPLOY.md. |
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

### 5.1 D1 schema — seven migrations, one database

There is **one** D1 database (`bnji-board`, bound twice: see the note below). The
migrations are cumulative and tracked by D1 in its own `d1_migrations` table, so
`migrations apply` only runs what has not run yet. Applying them again is safe
and is the normal way to move an existing database forward.

| # | File | Adds |
| --- | --- | --- |
| 0001 | `board_messages.sql` | `board_messages` + `idx_board_public`. The public feed's only table. |
| 0002 | `profiles.sql` | `profile_views` (per-session daily dedup), `profile_link_clicks`, `profile_reactions`. Powers `/gizlyy/`. |
| 0003 | `security_events.sql` | `security_events` + 4 indexes. Abuse telemetry, 60-day retention, admin-only, never public. |
| 0004 | `board_moderation.sql` | 4 columns on `board_messages` (`report_count`, `reported_at`, `status_note`, `moderated_at`), `board_reports`, 2 indexes. Makes the `status` column reachable from a real report flow. |
| 0005 | `admin_credentials.sql` | `admin_credentials` (one row, `id = 1` enforced by CHECK). Holds `hex(sha256(token))` — the hashed admin token, rotated from the panel. |
| 0006 | `board_paint.sql` | One versioned shared canvas snapshot plus a bounded set of recent publish IDs for safe retries. Independent of `board_messages`. |
| 0007 | `paint_stickers_activity.sql` | Editable bounded sticker state plus a private Paint publish-summary trail (60-day retention, 5,000-row cap). |

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

### 5.2 `BOARD_DB` is bound twice — one of the two is a problem

`wrangler.json` binds the same `database_id` twice:

- `BOARD_DB` — the normal binding, used by all the code.
- `bnji_board` — identical, but `"remote": true`.

Nothing reads `bnji_board`. The duplicate is harmless in production but breaks
local development: `npx wrangler dev` tries to open a remote session, demands a
`CLOUDFLARE_API_TOKEN`, and exits. Until it is removed, run local dev as
`npx wrangler dev --local`. Deleting the `bnji_board` binding block is the fix
and touches no application code.

### 5.3 Secrets

| Name | Required? | Notes |
| --- | --- | --- |
| `ACCESS_SECRET` | **Yes, for `/admin`** | Signs admin session cookies. Without it `/admin` and every `/api/admin/*` route return `503` — they fail closed, deliberately. `wrangler secret put ACCESS_SECRET`. A random 32+ byte value is fine. |
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
| `ACCESS_SECRET` | **SECRET** | Worker env | HMAC key signing the session cookie. Required for admin sessions. |

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

## 9. Deployment — INFRA (do not change casually)

| Value | Location | Notes |
| --- | --- | --- |
| Worker name/compat/assets | `wrangler.json` | Static assets from `./dist`. |
| Adapter options | `astro.config.mjs` | `prerenderEnvironment: "node"`. |
| Env schema (secrets list) | `astro.config.mjs` (`env.schema`) | Declares which secrets exist; all optional so builds work unconfigured. |

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
