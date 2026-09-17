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
| `THEME_CONFIG.defaultTheme` | `src/config/access.config.ts` | First-paint theme when no preference is stored (`dark` = primary space theme). |
| `THEME_CONFIG.storageKey` | same | localStorage key for the visitor's choice. |
| Palette / glass / motion tokens | `src/styles/tokens.css` | `:root` = dark theme, `[data-theme='light']` = Frutiger Aero light theme. Re-skin by editing tokens only. |
| Aero environment (clouds, bubbles, bokeh) | `src/styles/aero.css`, `src/components/AeroSky.astro` | Bubble field array lives in the component; visuals in CSS. |

## 3. Background music — PUBLIC source identifiers

| Value | Location | Notes |
| --- | --- | --- |
| `MUSIC_SOURCE.provider` | `src/config/music.config.ts` | `'none' \| 'youtube' \| 'spotify' \| 'file'`. **Enter your source here.** |
| `MUSIC_SOURCE.youtube.videoId` | same | The `?v=` id of a YouTube video. Player loads the IFrame API only after the first user-initiated play. |
| `MUSIC_SOURCE.spotify.id` / `.type` | same | Spotify track/album/playlist id. Volume/mute are disabled for this provider (Spotify exposes no volume API). |
| `MUSIC_SOURCE.file.url` / `.title` | same | Direct audio URL (same-origin or CORS-enabled). Full transport + loading/error states. |
| `MUSIC_SOURCE.defaultVolume` | same | 0..1, applied on first gesture-initiated play. |

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

## 5. Public message board — policy PUBLIC, storage credentials SECRET

| Value | Kind | Location | Notes |
| --- | --- | --- | --- |
| `BOARD_CONFIG.provider` | PUBLIC | `src/config/board.config.ts` | `'memory' \| 'kv' \| 'rest'` preference. |
| limits (`maxTextLength`, `maxImageBytes`, `allowedImageTypes`, `postCooldownSeconds`, `pollIntervalMs`, visible-count range) | PUBLIC | same | Abuse/size policy; server re-validates everything. |
| `BOARD_KV` binding | **INFRA** | wrangler binding | True persistence. Enable: `npx wrangler kv namespace create board`, then add a binding named `BOARD_KV` in `wrangler.json`. The store auto-detects it — no code change. Until then the board runs on the per-isolate memory provider (documented demo grade). |
| `BOARD_REST_URL`, `BOARD_REST_TOKEN` | **SECRET** | Worker env | Optional external JSON API provider. |

UI (`src/components/MessageBoard.astro`) ↔ API (`src/pages/api/board.ts`) ↔
store (`src/server/board-store.ts`): swapping persistence never touches UI.

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
| `INTRO_CONFIG.enabled` | `src/config/access.config.ts` | Master switch for the homepage scroll intro. |
| `INTRO_CONFIG.scrollHeights` | same | Scroll distance in viewport heights. |
| `INTRO_CONFIG.sessionKey` | same | sessionStorage flag so skip/completion persists per session. Reduced-motion visitors never enter it. |

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
