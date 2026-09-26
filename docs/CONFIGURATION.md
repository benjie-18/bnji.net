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

## 3. Background music — PUBLIC source identifiers

| Value | Location | Notes |
| --- | --- | --- |
| `MUSIC_SOURCE.provider` | `src/config/music.config.ts` | `'none' \| 'youtube' \| 'spotify' \| 'file'`. **Enter your source here.** |
| `MUSIC_SOURCE.youtube.videoId` | same | The `?v=` id of a YouTube video. The IFrame API loads at page start for the autoplay attempt; a refused attempt is probed once (getPlayerState) and surfaces as the pill's tap-to-play affordance. |
| `MUSIC_SOURCE.spotify.id` / `.type` | same | Spotify track/album/playlist id. The embed mounts VISIBLE above the pill on play (Spotify exposes no transport API — the embed's own UI is the control surface and its internal play button is the blocked-autoplay affordance). Volume/mute are disabled for this provider. |
| `MUSIC_SOURCE.file.url` / `.title` | same | Direct audio URL (same-origin or CORS-enabled). Full transport + loading/error states; blocked autoplay detected precisely via `NotAllowedError`. |
| `MUSIC_SOURCE.defaultVolume` | same | 0..1 — SEEDS the settings store's `volume`; the live value is the store's (Settings overlay → Audio → Volume). |
| Autoplay policy | `src/scripts/music.ts` | Playback is attempted on page load for every configured provider. Browser refusals are never worked around: file/YouTube fall into `data-state="blocked"` (pulsing play button, "Tap to play"); Spotify shows its own play button inside the embed. Muted autoplay (store `muted: true`) is generally allowed and usually succeeds. |

Autoplay is impossible by construction: nothing plays or loads before a click.

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
| `BOARD_DB` D1 binding | **INFRA** | `wrangler.json` + `migrations/` | One-time setup: `npx wrangler d1 create bnji-board`, paste the printed `database_id` into `wrangler.json` (the committed placeholder is a nil UUID so `wrangler dev` works locally but a deploy fails loudly until replaced), then `npx wrangler d1 migrations apply bnji-board --remote`. Local dev: `--local` instead. Schema: `migrations/0001_board_messages.sql`. |
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

**Moderation groundwork**: every message row carries `status`
(`visible | hidden | reported | deleted`). The public feed selects
`status IN ('visible','reported')` in SQL, so hidden/deleted messages can
never reach a public response, and the status field itself is stripped from
API payloads. Flipping status is a server-side `UPDATE` (`setStatus`) — no
moderation UI ships yet, by design.

UI (`src/components/MessageBoard.astro`) ↔ API (`src/pages/api/board.ts`) ↔
store (`src/server/board-store.ts`): swapping persistence never touches UI.

**Pagination**: `GET /api/board?limit=N&cursor=C` is keyset-paginated — the
response's `nextCursor` (opaque base64 of `[createdAt, id]`) fetches the next
page of *older* messages; `null` means exhausted. Page numbers are never used,
so concurrent inserts can't shift or duplicate entries between pages.
Legacy `?all=1` still works (archive first page + cursor walking).

## 6. Access control / future auth — rules PUBLIC, credentials SECRET

| Value | Kind | Location | Notes |
| --- | --- | --- | --- |
| `ACCESS_RULES` | PUBLIC | `src/config/access.config.ts` | Declare protected route prefixes + auth kind. **Empty by default: everything current stays public.** |
| `ACCESS_TOKEN` | **SECRET** | Worker env | Bearer token for `auth: 'token'` rules. |
| `ACCESS_PASSWORD_SHA` | **SECRET** | Worker env | sha256(hex) of the password for `auth: 'password'` rules. Store the hash, never the password. |
| `ACCESS_SECRET` | **SECRET** | Worker env | HMAC key signing the session cookie. |

Honest limitations (also in `src/middleware.ts`): prerendered static pages
cannot be protected — a private route must set `export const prerender = false;`
so requests run the middleware. Client-side hiding is never used as security.
With no secrets configured, rules fail **closed**.

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
