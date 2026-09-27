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
> | [`docs/DEPLOY.md`](./docs/DEPLOY.md) | Owner runbook: pull, apply migrations, add secrets, deploy, rotate the admin token |
>
> Content note: this project intentionally carries **no personal biography**;
> identity copy is neutral placeholder text by design.

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
- **Background music** — a small status-dot pill (play/pause + mute) with the
  volume living in the Settings overlay; four swappable sources (YouTube,
  Spotify, direct file, or none) configured in `src/config/music.config.ts`,
  each with its own honest control surface. Autoplay is attempted on load;
  if the load-time attempt is blocked, the first trusted page input triggers
  one additional attempt for file/YouTube without cancelling the visitor's
  action. A tap-to-play fallback remains; Spotify uses its embedded controls.
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
- **The Lab** — 16 runnable experiments and small games across 13 components
  (starfield tuner, liquid-glass lab, glass minesweeper, orbit field, 3D piano,
  isometric stack, voxel map, CPS counter, Bubble Pop, Memory Pairs, Reaction
  Timer and more). Each owns its DOM subtree. The ones running a continuous
  `requestAnimationFrame` loop pause via `IntersectionObserver` when scrolled
  away and on `visibilitychange` when the tab is hidden; the rest are driven by
  user events and have no loop to pause.
- **Admin panel** (`/admin`, gated) — one shared access token stored as a
  SHA-256 hash in D1 and rotated from the panel itself; a site-wide statistics
  dashboard built only from data the app already records; board moderation;
  a security-event log; and the runtime configuration dump. Sessions are
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
                       moderation, admin credential)
src/
  config/       music, dm integration, board policy, access rules, theme, intro
  components/   glass primitives, sections, lab experiments, board, player…
  data/         typed site content (site, navigation, projects, lab, blog…)
  layouts/      Layout (shell) and BlogPost (article chrome)
  middleware.ts route-guard enforcement for ACCESS_RULES
  pages/        routes + API boundaries (board, dm, profile analytics, security
                enrichment, admin/*)
  scripts/      settings store + overlay, theme, starfield, interactions,
                scroll, board physics, music, intro, profile, admin…
  server/       board/profile/security stores, rate limiter, access primitives,
                the admin guard, env access
  styles/       tokens, glass, aero, animations, global, lab, board, settings
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
