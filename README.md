# BNJI.NET

A personal digital hub with two full visual identities: a near-black **space
theme** (living starfield, shooting stars, pink/violet nebula lighting) and a
glossy **Frutiger Aero light theme** (sky gradients, clouds, soap bubbles,
bokeh) — both wrapped in a realistic liquid-glass surface system. Built with
[Astro](https://astro.build), deployed to Cloudflare Workers as static assets.

> **AI agents:** read [`AGENTS.md`](./AGENTS.md) first.
>
> **Owners/developers — the docs index:**
>
> | Document | Covers |
> | --- | --- |
> | [`AGENTS.md`](./AGENTS.md) | Hard rules, architecture map, how to verify a change |
> | [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) | Every configurable value, public vs secret: music sources, Discord notifications, board storage, access control, themes, secrets handling |
> | [`docs/DATA.md`](./docs/DATA.md) | What the board stores — fields, retention, rate-limit data, moderation states |
> | [`docs/ADMIN.md`](./docs/ADMIN.md) | The admin system — the token, sessions, the stats dashboard, and how to rotate the credential |
> | [`docs/PROFILES.md`](./docs/PROFILES.md) | The profile link page: its counter, click tracking and privacy posture |
> | [`docs/AGENT-RECAP.md`](./docs/AGENT-RECAP.md) | Architecture recap: boot order, data flow, and the invariants to preserve |
> | [`docs/DEPLOY.md`](./docs/DEPLOY.md) | Owner runbook: migrations, existing secrets, deployment and verification |
> | [`docs/GAMES-DECISIONS.md`](./docs/GAMES-DECISIONS.md) | Games architecture decision and identity/verifier seams |
> | [`docs/GAMES-OPERATIONS.md`](./docs/GAMES-OPERATIONS.md) | Games setup, privacy/retention, Cloudflare Free quotas and first-game recipe |
> | [`docs/CHAT-SYSTEM-PLAN.md`](./docs/CHAT-SYSTEM-PLAN.md) | **Living plan:** room chat (Phases A–C implemented), private messaging with images, friends |
> | [`docs/DATA-COLLECTION-POLICY.md`](./docs/DATA-COLLECTION-POLICY.md) | What the site may collect, retention, admin visibility and disclosure rules |
> | [`docs/DEPENDENCY-POLICY.md`](./docs/DEPENDENCY-POLICY.md) | Dependency tiers, review process, and the infrastructure changes each one allows |
>
> Content note: this project intentionally carries **no personal biography**;
> identity copy is neutral placeholder text by design.
>
> **Status note (2026-09-30):** chat plan Phase A — display names (guest,
> session-scoped) and public account handles with exact-match lookup — Phase B
> — in-room chat (bounded plain text, reconnect history, host kick/mute/remove,
> per-member rate limiting, deleted with the room) — and Phase C — moderation
> tooling (member reporting with snapshots that outlive the room, an `/admin`
> Chat tab with live transcripts, delete/ban/kick/close, a report queue and
> moderation log, blocklist/URL-strip triage config, account export/deletion
> coverage) — are **implemented**. Private messaging, friends and presence are
> **planned, not implemented** — see `docs/CHAT-SYSTEM-PLAN.md`. The Games room panel is a transport surface
> with chat; it still has no playable game. The dependency rule changed on the same
> date: dependencies are now permitted per tier under
> `docs/DEPENDENCY-POLICY.md`, and the site may collect and retain chat history
> and comparable activity records under `docs/DATA-COLLECTION-POLICY.md`. Any
> copy on the live site that contradicts those documents is a bug.

## Stack

| Layer     | Choice                                                                 |
| --------- | ---------------------------------------------------------------------- |
| Framework | Astro 7, static output, zero client frameworks                          |
| Content   | Content collections (Markdown) in `src/content/blog/`                   |
| Styling   | Hand-written CSS: tokens, dual themes, liquid glass, aero environment   |
| Client JS | Small TypeScript modules (`src/scripts/`), one deferred bundle          |
| Server    | API routes under `/api/*` + route-guard middleware (see below)             |
| Adapter   | `@astrojs/cloudflare` — public pages prerendered; APIs run in the Worker |
| Feeds     | `@astrojs/rss` (`/rss.xml`) and `@astrojs/sitemap`                      |

## Quick start

Requires Node ≥ 22.

```bash
npm install        # or: npm ci
npm run dev        # local dev server with HMR
npm run build      # static build into dist/
npm run preview    # build + wrangler dev (Worker-accurate preview)
npm run check      # build + tsc + wrangler deploy --dry-run
npm test           # the behaviour suite in tests/ (node:test, no browser needed)
npm run deploy     # publish to Cloudflare Workers
```

## Features

- **Settings overlay** — one glass dialog (header gear icon) backed by a
  central settings store: theme, intro on/off, audio mute/volume, UI scale,
  performance mode, reduced effects, particle density, cursor effects and
  advanced glass. Every setting persists to localStorage and is applied
  pre-paint (no flash of the wrong theme or effects state).
- **Dual themes** — dark space (primary) and Frutiger Aero light, switched in
  the settings overlay, persisted, applied pre-paint (no flash), fully
  token-driven.
- **Living sky** — canvas starfield with smooth twinkle (no flicker), pointer
  excitation, shooting stars in dark mode; the light theme rests the starfield
  and shows clouds, bubbles and bokeh instead.
- **Liquid glass** — gradient edge rims, internal optics (specular sheet,
  bounce refraction, environmental bleed), pointer-tracked highlights and hover
  sweeps; graceful fallback without `backdrop-filter`.
- **Theme-aware cursor** — stellar halo in dark, water-lens caustic in light;
  inert on touch and under reduced motion.
- **Scroll intro** — the homepage opens with a scroll-scrubbed cinematic (white
  field, blue star zooming/rotating until its energy fills the viewport);
  enable/disable comes from the settings store, reduced motion always
  bypasses it.
- **Background music** — a small status-dot pill (play/pause + mute + playlist)
  with the volume living in the Settings overlay; an ordered queue of YouTube,
  Spotify and direct-file tracks, editable from `/admin` → *Playlist* and
  seeded from `src/config/music.config.ts`. Autoplay is attempted on load; if
  the load-time attempt is blocked, the first trusted page input triggers one
  additional attempt without cancelling the visitor's action, and a tap-to-play
  fallback remains. File and YouTube tracks expose a real transport, so the
  queue always shows progress and advances on its own; a Spotify track is an
  embed with no supported music-track progress or end event, so the progress
  region is hidden with a note saying why and its own controls take over —
  Skip still works.
- **Profile card** — link-in-bio card (avatar orb, badges, bio, chips, link
  rows, copy-handle block) modelled on ayo.so profile cards, placeholder copy.
- **Public message board** (`/board/`, linked from the nav — no longer a
  global overlay) — floating bubbles (light) / star orbs (dark) with buoyancy,
  collisions and drag; mobile-safe composer (dvh/svh, safe-area insets,
  visual-viewport keyboard tracking); visible-count slider that walks older
  pages via the API's keyset cursor (initial load capped at 10); full-archive
  dialog; polling that pauses while the tab is hidden and revalidates with
  ETags; server-side validation, sanitization, rate limits; D1-backed
  persistence with cursor pagination + moderation statuses (or external REST
  store) via `/api/board`; KV-shared rate limiting. A separate shared paint
  canvas (available in D1 board mode) sits below it, with pens, erasing,
  shapes, text, conflict-safe sync, live refresh, fullscreen and PNG export.
  REST board mode clearly marks Paint unavailable rather than sending canvas
  writes to an unsupported backend.
- **Private messages** — contact form delivered server-side through a Discord
  webhook or ntfy push; credentials live only in Worker secrets.
- **Display names, handles & room chat (implemented) + planned: private
  messaging and friends** — you can set a display name from the `/games/`
  rooms panel (guests: kept 30 days keyed by a digest of the session cookie;
  signed-in: your account name) and claim one public handle per account
  (unique, exact-match lookup, changeable once every 30 days). Rooms also have
  plain-text chat: it survives reconnects as bounded history, is rate-limited,
  and is deleted with the room (≤2 hours) — the room's host can remove
  messages and kick or mute members. Messages can be reported: snapshots are
  kept in D1 for review after the room is gone, and `/admin` has a Chat tab
  for live transcripts, deletes, bans and the report queue. Still planned:
  live account-to-account direct messages with images, and a friends system
  with presence. Full design,
  phases, schema sketches, quota math and open questions are in
  [`docs/CHAT-SYSTEM-PLAN.md`](./docs/CHAT-SYSTEM-PLAN.md); everything in that
  list beyond names/handles is not implemented yet.
- **The Lab** — 16 runnable experiments and small games across 13 components
  (starfield tuner, liquid-glass lab, glass minesweeper, orbit field, 3D piano,
  isometric stack, voxel map, CPS counter, Bubble Pop, Memory Pairs, Reaction
  Timer and more). Each owns its DOM subtree. The ones running a continuous
  `requestAnimationFrame` loop pause via `IntersectionObserver` when scrolled
  away and on `visibilitychange` when the tab is hidden; the rest are driven by
  user events and have no loop to pause.
- **Games** (`/games/`, linked under Projects) — a typed catalog linking five existing Lab mini-games without copying them. The shared lifecycle/tracker, private admin view, fail-closed score verifier, optional global player identity, bounded cross-device versioned saves, and generic authenticated Durable Object room transport are implemented. Guest/local play remains available; no playable game or game-specific score/turn validation was added. Free-plan rollout/migrations are owner-operated; see `docs/GAMES-OPERATIONS.md`.
- **Browser tools** (`/tools/`, linked from the Projects dropdown) — fourteen
  tools that never send anything anywhere, because there is no API route behind
  any of them. The page opens on a repertory: four categories — Images & color,
  Text & lists, Convert & calculate, Time & dates — listed in
  `src/data/tools.ts`, each one reachable by a link or by its digit (`1`–`4`,
  and `0` for all). `src/scripts/tools-index.ts` shows one category at a time,
  which is what keeps fourteen tools from being one long scroll; with JavaScript
  off the same links jump and every tool is on the page. The copy is
  deliberately spare — each tool keeps its labels, its limits and one line of
  trade-offs where a limit would otherwise be invisible. The four with the most
  behaviour behind them: *Image converter* decodes, resizes and re-encodes
  PNG, JPEG and WebP locally: aspect-ratio-preserving resize, a quality slider
  that is disabled (with the reason shown) for PNG, input/output previews with
  real byte deltas, and a clear error instead of a silent format substitution
  when a browser cannot encode the requested format. *Word counter* counts words, characters, sentences, paragraphs, lines, keywords and
  reading/speaking times as you type, from a textarea or a dropped text file:
  words are split with the browser's own `Intl.Segmenter`, so a script with no
  spaces (Chinese, Japanese, Thai) counts properly and “well-known” stays one
  word, while a browser without one gets the space split pinned and disabled
  with the reason shown. A paste over the character limit is refused out loud
  instead of being truncated by a `maxlength`, and the numbers on screen are
  cleared with it rather than left describing text that is no longer in the box;
  the clipboard summary is built from the same counts the panel shows, and
  “copied” is only said when the write resolved. *Text diff* compares two texts
  or two dropped text files line by line, in a unified or a side-by-side view
  with a context slider, marks the words that changed inside a changed line, and
  copies a real unified patch (`git apply` reads it). Line endings are folded
  first, so a file saved on Windows does not show every line as changed, and a
  difference that is only a trailing line break is named rather than swallowed.
  The comparison is a longest-common-subsequence table whose cost is one number
  the tool can quote, so it refuses past a cell budget instead of wedging a
  phone, it stops auto-comparing past a size threshold and clears the panel
  rather than leaving a stale diff on screen, and it caps the rows it draws
  while the copied patch still holds every line. *Color picker*
  holds one color as HSV and shows it as hex, RGB, HSL, HSV, CMYK, HWB and
  OKLCH, computed in the tab from the published formulas rather than a library.
  A per-pixel color wheel — the angle is the hue, the distance from the centre is
  how much color there is — sits beside hue, saturation and brightness sliders
  that set exactly the same values; the sliders are the accessible path, because
  both canvases are `aria-hidden` and pointer-only and every value the pointer
  can reach a labelled control reaches too. It reads any CSS color the browser
  can read (a name, `hsl()`, `oklch()`, through the CSSOM and a canvas
  `fillStyle` rather than a second guess at the spec), checks a color against a
  background with four WCAG badges that quote the thresholds they were measured
  against, builds six harmony schemes, keeps a working palette that copies out
  as CSS custom properties, and takes a color from an uploaded image: the pixel
  you click is that exact pixel at the file's own resolution, never an average
  of its neighbors, and up to eight common colors are counted from a copy
  downscaled to 160px on its long edge with the share each one had printed
  beside it. Four things it will not pretend to: there is no alpha channel (a
  hex or a pixel with one is read and reported as dropped), CMYK is derived from
  RGB because an honest conversion needs a press profile nobody has told it
  about, contrast is WCAG 2.x relative luminance and not APCA, and a canvas
  reports sRGB, so a photo taken in Display P3 is converted on the way in. A
  browser with no canvas gets the wheel hidden with the reason shown and the
  image half refused before it is read, with everything else still working.
  Limits, pace domains, the common-words list, the diff budgets, the color
  formats and schemes, and the view copy live in `src/config/tools.config.ts`.
- **Admin panel** (`/admin`, gated) — one shared access token stored as a
  SHA-256 hash in D1 and rotated from the panel itself; a site-wide statistics
  dashboard built only from data the app already records; board moderation;
  a security-event log; private Games & play session/device/playtime views; and
  the runtime configuration dump. Raw game/security tracking retention is
  editable in the panel and swept hourly. Sessions are
  HttpOnly/Secure/SameSite and are invalidated the moment the token rotates.
  Full write-up in [`docs/ADMIN.md`](./docs/ADMIN.md).
- **Access control** — `ACCESS_RULES` declares protected prefixes; `src/middleware.ts`
  enforces them for SSR routes, and a build-time check (`scripts/verify-access.mjs`)
  fails the build if a protected page is ever prerendered, since a prerendered page
  is served without running any Worker code. The admin surface uses the DB-backed
  guard described above; the generic HMAC primitives remain available for other
  rules.

## Project layout

```
docs/CONFIGURATION.md  every configurable value, public vs secret, how to swap
docs/DATA.md           what the message board stores, retention, moderation data
docs/ADMIN.md          the admin system: credential, sessions, stats, rotation
docs/PROFILES.md       the profile page: counters, click tracking, privacy posture
docs/AGENT-RECAP.md    architecture recap and the invariants to preserve
docs/DEPLOY.md         owner runbook: migrations, secrets, deploy, verification
migrations/            D1 schema, applied in order (board, profiles, telemetry,
                       moderation, admin credential, music playlist)
tests/                 behaviour suite: node:test + a DOM shim, so the controllers,
                       stores and pure geometry run without a browser
src/
  config/       music, dm integration, board policy, access rules, theme, intro,
                browser tools (formats + limits)
  components/   glass primitives, sections, lab experiments, tools, board, player…
  data/         typed site content (site, navigation, projects, lab, blog…)
  layouts/      Layout (shell) and BlogPost (article chrome)
  middleware.ts route-guard enforcement for ACCESS_RULES
  pages/        routes + API boundaries (board, dm, profile analytics, security
                enrichment, admin/*)
  scripts/      settings store + overlay, theme, starfield, interactions,
                scroll, board physics, music, intro, profile, admin, tools…
  server/       board/profile/security stores, rate limiter, access primitives,
                the admin guard, env access
  styles/       tokens, glass, aero, animations, global, lab, board, settings,
                tools
public/         fonts, favicon, og-cover, manifest, post hero images
scripts/        verify-access.mjs — build-time protected-route check
```

## Writing a blog post

Drop a `.md` file into `src/content/blog/`:

```markdown
---
title: "Post title"
description: "One or two sentences for listings, RSS and social cards."
pubDate: "Sep 16 2026"
heroImage: "/blog-placeholder-1.jpg"   # optional, root-relative from public/
tags: ["lorem"]                        # optional
draft: false                           # optional; true hides it everywhere
---
```

## Secrets & safety

Secrets are **environment-only** (`wrangler secret put …`, `.dev.vars`
locally). The schema in `astro.config.mjs` declares them; `src/server/env.ts`
is the only reader. Nothing secret is ever inlined into client bundles, and
user-generated content is rendered inert (textContent / validated data URLs).

## Deployment

Static build served by the Worker defined in `wrangler.json` (assets
`./dist`). API routes and middleware run in the Worker; everything else is
prerendered. See `docs/CONFIGURATION.md` §9 before touching infra.
