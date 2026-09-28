# BNJI.NET - Agent Context Recap

Complete top-to-bottom map of the site as of the final session state (now on GitHub `main`,
plus the owner's follow-up commit wiring real D1/KV binding IDs). Read `AGENTS.md` first -
it holds the hard rules; this document explains how everything actually works.

## 1. What the site is

Personal digital hub: Astro 7 (static-first, SSR where needed) deployed as ONE Cloudflare
Worker named `bnjibot` via `@astrojs/cloudflare`. **No UI framework** - hand-written CSS +
a small set of vanilla TypeScript client modules. JavaScript only enhances; the site must
remain readable with JS blocked (`html.js` guards in `animations.css`).

- Canonical origin: `https://bnji.net`, single-sourced in `src/data/site.ts` (`SITE.url`).
- Integrations: `@astrojs/sitemap`, `@astrojs/rss` (typed endpoint `src/pages/rss.xml.ts`).
- Blog: plain Markdown files in `src/content/blog/` (MDX removed). Schema: `src/content.config.ts`.
- Identity copy is neutral lorem-ipsum placeholder by design - never reintroduce personal data.
- Fonts: Atkinson (woff, `public/fonts/`).

## 2. Routes

| Route | Kind | Notes |
|---|---|---|
| `/` | prerendered | Home: Hero + preview sections + ProfileCard |
| `/about`, `/projects`, `/contact`, `/lab` | prerendered | Lab hosts runnable experiments |
| `/blog`, `/blog/[...slug]` | prerendered | Uses `BlogPost.astro` layout for posts |
| `/board/` | **SSR** (`prerender = false`) | Message board UI; note trailing slash in links. SSR because it reads the store for the first paint |
| `/gizlyy/` | **SSR** (`prerender = false`) | Profile page; view stats and reactions come from D1. A failed read renders an em dash, never a zero |
| `/admin` | **SSR** | Admin panel; redirects to `/admin/login` without a session |
| `/admin/login` | **SSR** | Token sign-in; login attempts are throttled per IP |
| `/404` | prerendered | |
| `/api/board` | **SSR** (`prerender = false`) | GET list (cursor pagination, weak ETag -> 304), POST create |
| `/api/paint` | **SSR** (`prerender = false`) | Public versioned D1 snapshot, editable bounded stickers, conditional publish + idempotent retries, ETag polling; accepted summaries feed the guarded admin Paint activity endpoint |
| `/api/dm` | **SSR** | POST -> Discord webhook / ntfy per config |
| `/api/admin/*` | **SSR** | All behind the shared admin guard; see docs/ADMIN.md |
| `/rss.xml` | endpoint | typed RSS |

Only SSR routes run `src/middleware.ts`. Static pages bypass it - anything needing access
control MUST export `prerender = false` (honest boundary, never fake client-side hiding).

## 3. Repository layout

```
astro.config.mjs        adapter cloudflare({prerenderEnvironment:"node"}); env secret schema
wrangler.json           worker bnjibot; ASSETS->dist; D1 BOARD_DB (bnji-board, migrations/);
                        KV BOARD_KV. Repo carries NIL placeholder IDs; real IDs live in the
                        owner's commit on main. compat_date 2026-09-14, nodejs_compat.
migrations/             0001 board_messages + idx_board_public, 0002 profiles,
                         0003 security_events, 0004 board_moderation,
                         0005 admin_credentials, 0006 board_paint, 0007 paint_stickers_activity - applied in order
docs/CONFIGURATION.md   every owner-facing config knob incl. one-time infra setup
docs/DATA.md            board data model, moderation states, rate-limit privacy rules
docs/ADMIN.md           admin credential, sessions, stats, rotation
docs/PROFILES.md        profile counters, click tracking, privacy posture
AGENTS.md               hard rules for agents (read first)
src/config/             public config values (music, dm integrations, board/paint policy,
                        ACCESS_RULES, THEME_CONFIG, INTRO_CONFIG); index.ts re-exports
src/data/               ALL content as typed data: site, navigation (PRIMARY_NAV groups,
                        FUTURE_NAV, FOOTER_NAV), projects, interests, ai-stack, network
                        (SERVICES), lab (EXPERIMENTS), blog.ts helpers
src/components/         Astro components; primitives (GlassPanel, GlassButton, Icon,
                        SectionHeading, PageHeader, BrandMark), scene layers (AeroSky,
                        Starfield, CursorGlow), chrome (Header, Footer, BaseHead),
                        features (MusicPlayer, SettingsOverlay, MessageBoard,
                        BoardPaint, DirectMessage, ProfileCard), lab/ experiments
src/layouts/            Layout.astro (shell + single boot script), BlogPost.astro
src/scripts/            client runtime (see section 5)
src/server/             server-only: env.ts, access.ts, ratelimit.ts, admin.ts,
                          board-store.ts, profile-store.ts, security-store.ts,
                          security-helpers.ts
src/styles/             tokens.css (every design value), global, glass, aero, animations,
                        board, paint (board only), lab, settings
src/middleware.ts       ACCESS_RULES enforcement on SSR routes
```

## 4. The settings system (central nervous system)

**Single source of truth: `src/scripts/settings.ts`.**

- Persistence: one localStorage key `bnji-settings-v1`. Legacy `bnji-theme` honoured as
  migration fallback (pre-paint script only).
- API: `getSettings()`, `setSetting(key, value)`, `subscribeSettings(listener)`,
  `applySettingsToRoot()`, `initSettings()`. Every change dispatches
  `window` CustomEvent **`bnji:settingschange`** (detail = full settings object);
  `scripts/theme.ts` additionally dispatches **`bnji:themechange`**.
- Fields (10): `theme` ('dark'|'light'), `introEnabled`, `muted`, `volume` (0..1),
  `uiScale` (80..130), `performanceMode`, `reducedEffects`, `starDensity` (0..1),
  `cursorEffects`, `advancedGlass`.
- **Defaults are SEEDED from `src/config/`** (THEME_CONFIG.defaultTheme, INTRO_CONFIG.enabled,
  MUSIC_SOURCE.defaultVolume) - config files hold owner defaults, the store holds runtime values.
- `applySettingsToRoot` mirrors state onto `<html>`: `data-intro`, `data-cursor-effects`,
  `data-reduced-effects`, `data-performance-mode`, `data-advanced-glass` (each "on"/"off")
  and CSS var `--ui-scale` (global.css: `html { font-size: calc(100% * var(--ui-scale,1)) }`).
  CSS and other modules branch on these attributes - prefer them over reading the store.
- **Pre-paint:** `BaseHead.astro` carries an inline, un-bundled `is:inline` script that reads
  the SAME localStorage key before first paint and applies theme/intro/ui-scale (no flash of
  wrong theme). It duplicates `applySettingsToRoot` logic - **when adding a paint-affecting
  setting, update BOTH**.
- UI: `SettingsOverlay.astro` + `scripts/settings-overlay.ts` (opens from Header). Consumers:
  theme.ts, intro.ts, music.ts (muted/volume), starfield.ts (starDensity, performanceMode),
  interactions.ts (cursorEffects), CSS (reducedEffects hides decorative layers, advancedGlass
  swaps blur/optics for flat fallback).
- Asymmetry by design: the `reducedEffects` SETTING **hides** decorative layers; OS
  `prefers-reduced-motion` **freezes** animation. Pointer/cursor effects are disabled on touch.

## 5. Client runtime

`Layout.astro` bottom has ONE `<script>` calling `boot()` (`src/scripts/boot.ts`).
Order (each `init()` idempotent, individually try/caught via `start()`):
**settings -> theme -> liquid-glass -> settings-overlay -> music-player -> starfield ->
cursor-glow -> background-parallax -> glass-tracking -> magnetic -> nav-toggle ->
nav-dropdowns -> nav-scroll-state -> reveal -> parallax.**
Lab experiments import engines directly and never go through `boot()`.
The opening sequence is the exception to "everything goes through `boot()`":
`IntroSequence.astro` calls `initIntro()` itself, so it only ever initialises on
the page that has one.

Modules: `starfield.ts` (canvas engine), `interactions.ts` (cursor glow, background
parallax, glass tracking, magnetic buttons, nav), `scroll.ts` (reveals/parallax),
`intro.ts` (homepage scroll intro, component-scoped), `music.ts` (player logic),
`board.ts` (board client: fetch, ETag revalidation, optimistic UI),
`board-paint.ts` (shared canvas snapshots, optimistic merge), `board-physics.ts`,
`profile.ts` (view beacon, reactions, click tracking), `device-fingerprint.ts`,
`theme.ts`, `settings.ts`, `settings-overlay.ts`, `liquid-glass.ts`, `environment.ts`.
Admin-only: `admin.ts`, `admin-dashboard.ts`, `board-moderate.ts` — imported by the
admin pages, never by the shared shell.

Music player: pill UI + playlist popover (`MusicPlayer.astro`) over the ordered queue served by
`GET /api/playlist`. `MUSIC_SOURCE.tracks` in `src/config/music.config.ts` is the SEED and the
offline fallback, never the live queue: the stored playlist (`music_playlist_items` /
`music_playlist_state`, D1 `BOARD_DB`) is copied in from it once and is then edited from
`/admin` → *Playlist*. An empty stored playlist stays empty. File and YouTube tracks expose
progress/end events and advance sequentially; Spotify stays an honest embed with manual Skip
only (the supported Spotify embed contract does not expose music-track progress/end to this
player). Volume/mute stay in Settings → Audio. The prerendered markup and the runtime rebuild
share `musicTrackAriaLabel()` / `getMusicTrackDateLabel()`, so the announced and rendered
queue cannot drift. A blocked load-time attempt
gets one retry for controllable tracks on the first trusted page input (without cancelling it).

## 6. Theme & visual system

- **`src/styles/tokens.css` is the only place design values live** (colors, radii, easings).
- Default theme: dark glass. Light theme: painted **Frutiger Aero** scene - layered gradients
  in `AeroSky.astro` + `aero.css`, fully tokenized: `--aero-sky`, `--aero-bloom`,
  `--aero-cloud`, `--aero-bokeh`, `--aero-meadow`, `--aero-orb`, `--aero-wordmark`, plus nav
  tokens. Light-theme contrast fixes exist for `.text-luminous`, `.footer-word`, Header surfaces.
- `glass.css` (panels/buttons; advanced vs flat per `data-advanced-glass`), `animations.css`
  (all motion; respects prefers-reduced-motion), `board.css`, `lab.css` (imported only by
  /lab), `settings.css`, `global.css`.
- `Icon.astro` is the single icon component (globe/rss added this session).
  `manifest.webmanifest` must stay valid JSON (was previously broken).

## 7. Server side (Worker)

**`src/server/` is server-only; client code must never import it.**

- `env.ts` - the ONLY secret access point: `secretEnv()` (astro:env/server) + `workerBindings()`.
  Schema in `astro.config.mjs`, all optional so builds work with zero config:
  `DISCORD_WEBHOOK_URL`, `NTFY_URL`, `BOARD_REST_URL`, `BOARD_REST_TOKEN`,
  `ACCESS_TOKEN`, `ACCESS_PASSWORD_SHA`, `ACCESS_SECRET`.
- `access.ts` - route-guard primitives: `verifyCredential` (bearer token or SHA-256 password),
  `issueSession` (HMAC-signed cookie, payload `pattern:expiry`, 8 h, key `ACCESS_SECRET`),
  `isAuthorized`. **Security invariant (fixed this session): sessions are bound to the rule
  pattern they were issued for** - verification compares the signed pattern with
  `timingSafeEqual`; never remove that check (without it one valid session passes EVERY rule).
- `middleware.ts` - first matching `ACCESS_RULES` entry by `startsWith(pattern)`; unauthorized
  -> `redirectTo` or 401 JSON. `ACCESS_RULES` ships EMPTY (whole site public).
- `board-store.ts` - `BoardStore` interface with two backends: **D1** (`BOARD_DB`, table
  `board_messages`, cursor = base64 `createdAt:id`) and **REST fallback**
  (`BOARD_REST_URL/TOKEN`). `getBoardStore(env)` picks one; returns `null` when unconfigured
  and the API degrades gracefully. Moderation `status` is a closed set
  (`visible|hidden|reported|deleted`), never exposed: public payloads are
  `PublicMessage = Omit<BoardMessage,'status'>`; `deleted` is soft state.
- `ratelimit.ts` - KV-backed (`BOARD_KV`) rate limiting for board/DM writes. KV TTLs are
  clamped to >= 60 s (Cloudflare minimum). Only stores hashed client keys
  (`connectingIp`) - see docs/DATA.md privacy rules; raw IPs are never persisted.
- `api/board.ts` - GET `?limit&cursor` (+`?all=1`), weak ETag/If-None-Match -> 304,
  `cache-control: no-store` on writes; POST `{text,image?}` -> 201. Validation, sanitization
  and limits from `BOARD_CONFIG` (`src/config/board.config.ts`) live here.
- `api/dm.ts` - POST `{message,contact?}` -> provider chosen by `DM_INTEGRATION` config
  (discord webhook / ntfy / none). Credentials env-only.

## 8. Build, deploy, verify

```
npm run build     astro build -> dist/ (assets under dist/client/_astro)
npm run check     astro build && tsc && wrangler deploy --dry-run   <- MUST pass
npx tsc --noEmit  types only
npm run preview   astro build && wrangler dev   <- use THIS to test Worker code
npm run dev       astro dev only - does NOT run middleware/API/Worker runtime
```

- One-time infra (already done by owner): create KV `BOARD_KV` + D1 `bnji-board`, paste real
  IDs into `wrangler.json` (committed on main), `npx wrangler d1 migrations apply bnji-board
  --remote`.
- CI: Cloudflare Workers Builds runs `wrangler deploy` from the repo; check the deployment's
  commit SHA when a build seems stale.
- **Verification chain for any change: `npm run build` + `npx tsc --noEmit` + `npm run check`
  all green. No headless browser is available in sandboxes - verify behaviour with wrangler
  dev / curl.**

## 9. Hard rules (from AGENTS.md - do not violate)

1. **No new dependencies.** Lockfile frozen; if installs drift use `npm install --no-package-lock`.
2. Don't modify deployment infra (`wrangler.json`, `.gitignore` exclusions, `public/fonts/`)
   beyond documented one-time binding setup.
3. Canonical URL only via `SITE.url`/`absoluteUrl()` - never `Astro.url`/`location`/hardcoded domains.
4. No secrets in code/docs/commits; env-only via `src/server/env.ts`.
5. No personal biography anywhere - neutral placeholders only.
6. Owner-facing knobs live in `src/config/`, documented in docs/CONFIGURATION.md.
7. Blog = drop `.md` files in `src/content/blog/`; no CMS, no MDX, no second content dir.
8. No UI frameworks/islands - Astro + CSS + small TS modules only.

## 10. Gotchas learned the hard way

- Links to the board must use `/board/` (trailing slash) or asset-relative URLs 404.
- Astro **scoped styles don't reach dynamically created DOM** - use `:global()` or a plain
  CSS file for anything JS builds.
- Adapter v14: `platformProxy` option is invalid - `prerenderEnvironment: "node"` only.
- Adding a setting that affects first paint -> update BOTH `settings.ts` AND the BaseHead
  pre-paint inline script, or you get a flash of stale state.
- `setSetting` accepts any value - clamp/validate at the store (numbers are clamped there);
  mirror constraints in the overlay UI.
- KV `expirationTtl` minimum is 60 s; ratelimit.ts clamps, don't bypass.
- ETag on board GETs is weak and list-wide; keep `no-store` on POST responses.
- Static (prerendered) pages NEVER execute middleware - route protection requires
  `prerender = false` on the page.
- `npm run dev` cannot exercise API routes/middleware; always `npm run preview`.
- package-lock.json was regenerated this session; the freeze rule applies from that state on.

## 11. Recipes (how to add things)

- **New page:** `src/pages/x.astro` using `Layout`; add entry to `PRIMARY_NAV`/`FOOTER_NAV`
  in `src/data/navigation.ts`; content strings into `src/data/`; styles via tokens.
- **New settings field:** extend `Settings` + `SETTINGS_DEFAULTS` (seed default from
  `src/config/`), apply it in `applySettingsToRoot` (data-attr or CSS var), duplicate in
  BaseHead pre-paint if paint-affecting, add control in `SettingsOverlay.astro` wired in
  `settings-overlay.ts`, consume via `subscribeSettings()`/`bnji:settingschange` or the
  root data-attribute in CSS.
- **New lab experiment:** `src/components/lab/X.astro` + entry in `EXPERIMENTS`
  (`src/data/lab.ts`); own its DOM + rAF loop, pause via IntersectionObserver AND
`visibilitychange` (AGENTS.md §5 — offscreen and hidden-tab are separate gates), expose
  `destroy()`.
- **Board feature:** touch `api/board.ts` (validation/limits) + `board-store.ts` (both D1
  and REST backends!) + `scripts/board.ts` (client) + `board.css`; obey docs/DATA.md
  moderation/privacy model; new columns require a new numbered migration in `migrations/`.
- **Restyle:** tokens.css first; component CSS second; never hardcode hex values elsewhere.
- **New icon:** add to `Icon.astro` - it's the single sprite source.

## 12. Current deployed state

GitHub `main` = full final session state (50-file delta over the post-revert base `157ac94`)
+ owner commit replacing nil D1/KV IDs with real ones. Worker `bnjibot` deploys via
Cloudflare Workers Builds. Remote D1 migration `0001_board_messages.sql` applied.
All checks green on exactly this tree: `npm run build`, `npm exec -- tsc --noEmit`,
`npm run check`. (Use `npm exec --`, not `npx tsc` - the bare `tsc` name resolves to an
unrelated registry package, as AGENTS.md section 7 records.)
