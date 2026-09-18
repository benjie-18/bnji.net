# BNJI.NET

A personal digital hub with two full visual identities: a near-black **space
theme** (living starfield, shooting stars, pink/violet nebula lighting) and a
glossy **Frutiger Aero light theme** (sky gradients, clouds, soap bubbles,
bokeh) — both wrapped in a realistic liquid-glass surface system. Built with
[Astro](https://astro.build), deployed to Cloudflare Workers as static assets.

> AI agents: read [`AGENTS.md`](./AGENTS.md) first.
> Owners/developers: every configurable value is documented in
> [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md) — music sources, Discord
> notifications, board storage, access control, themes, secrets handling.
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
| Server    | Two API boundaries (`/api/board`, `/api/dm`) + route-guard middleware   |
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

- **Dual themes** — dark space (primary) and Frutiger Aero light, switched by
  the nav toggle, persisted, applied pre-paint (no flash), fully token-driven.
- **Living sky** — canvas starfield with smooth twinkle (no flicker), pointer
  excitation, shooting stars in dark mode; the light theme rests the starfield
  and shows clouds, bubbles and bokeh instead.
- **Liquid glass** — gradient edge rims, internal optics (specular sheet,
  bounce refraction, environmental bleed), pointer-tracked highlights and hover
  sweeps; graceful fallback without `backdrop-filter`.
- **Theme-aware cursor** — stellar halo in dark, water-lens caustic in light;
  inert on touch and under reduced motion.
- **Scroll intro** — the homepage opens with a scroll-scrubbed cinematic (white
  field, blue star zooming/rotating until its energy fills the viewport), with
  skip button, session memory and a reduced-motion bypass.
- **Background music** — one player, four swappable sources (YouTube, Spotify,
  direct file, or none) configured in `src/config/music.config.ts`; full
  play/pause/volume/mute/loading/error states; never autoplays.
- **Profile card** — link-in-bio card (avatar orb, badges, bio, chips, link
  rows, copy-handle block) modelled on ayo.so profile cards, placeholder copy.
- **Public message board** — floating bubbles (light) / star orbs (dark) with
  buoyancy, collisions and drag; composer anchored bottom-centre; visible-count
  slider; full-archive dialog; server-side validation, sanitization, rate
  limits; pluggable persistence (memory → KV → REST) via `/api/board`.
- **Private messages** — contact form delivered server-side through a Discord
  webhook or ntfy push; credentials live only in Worker secrets.
- **The Lab** — runnable experiments and small games: starfield tuner, glass
  bench, orbit field, Bubble Pop, Memory Pairs, Reaction Timer.
- **Access-control groundwork** — `ACCESS_RULES` + middleware + signed-session
  primitives for future private routes; honest about static-route limits.

## Project layout

```
docs/CONFIGURATION.md  every configurable value, public vs secret, how to swap
src/
  config/       music, dm integration, board policy, access rules, theme, intro
  components/   glass primitives, sections, lab experiments, board, player…
  data/         typed site content (site, navigation, projects, lab, blog…)
  layouts/      Layout (shell) and BlogPost (article chrome)
  middleware.ts route-guard enforcement for ACCESS_RULES
  pages/        routes + /api/board + /api/dm (server boundaries)
  scripts/      starfield, interactions, scroll, board physics, music, intro…
  server/       board stores, rate limiter, access primitives, env access
  styles/       tokens, glass, aero, animations, global, lab, board
public/         fonts, favicon, og-cover, manifest, post hero images
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
