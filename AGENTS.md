# AGENTS.md — rules for AI coding agents in this repository

BNJI.NET is a personal digital hub: Astro 7, static output, Cloudflare Workers
static assets, hand-written CSS, and a small set of TypeScript client modules.
There is **no UI framework** (no React/Vue/Svelte islands). Everything a visitor
sees is HTML + CSS; JavaScript only enhances.

Read this file first. The rules below exist to keep the build fast, the bundle
tiny, the design coherent and the deployment boring.

## 1. Hard rules (do not violate)

1. **Dependencies are allowed, deliberately.** The lockfile is no longer
   frozen. `docs/DEPENDENCY-POLICY.md` is the authority: Tier A (dev-only) is
   routine; Tier B (runtime, never shipped to browsers) needs a one-line
   justification in the same commit; Tier C (visitor-facing or architecture
   changing) needs a decision record and a measured first-paint budget. Commit
   the lockfile with the manifest, keep `npm audit` clean, and update
   `docs/DEPENDENCY-AUDIT.md` when production dependencies change.
2. **Do not modify deployment infrastructure silently.** `wrangler.json`, the
   Worker entry, D1 migrations, bindings and Durable Object classes may change
   when a planned feature needs it (see `docs/CHAT-SYSTEM-PLAN.md`), but each
   change is its own reviewed commit, is reflected in `docs/DEPLOY.md` and
   `docs/CONFIGURATION.md`, and never weakens the build-output exclusions in
   `.gitignore` (`.astro/`, `.wrangler/`, `dist/`, `node_modules/`).
   `public/fonts/` stays untouched.
3. **Canonical origin lives in one place**: `src/data/site.ts` (`SITE.url`).
   `astro.config.mjs` imports it for `site:`. Components must use
   `absoluteUrl()`/`SITE.url` — never `Astro.url`, never `location`, never a
   hardcoded domain other than in `site.ts`.
4. **No secrets.** No API keys, tokens or private endpoints in code, docs or
   commit messages. Secrets are environment-only and read exclusively through
   `src/server/env.ts` (`astro:env/server` getSecret + worker bindings); the
   schema lives in `astro.config.mjs`. See docs/CONFIGURATION.md.
5. **No personal biography.** Identity copy is neutral placeholder text
   (lorem ipsum). Never reintroduce real names, locations, schools, hardware
   or life details anywhere — components, data, docs, blog or assets.
6. **Configuration lives in `src/config/`** (music, dm integration, board
   policy, access rules, theme, intro) and is documented in
   docs/CONFIGURATION.md. Components read config; they never hard-code
   service URLs, limits or provider behaviour.
7. **Keep the blog workflow dumb-simple**: a post is one Markdown file in
   `src/content/blog/` (MDX and its workflow were removed). Never introduce a
   CMS, a build step for content, or a second content directory.
8. **Data collection is allowed; silent collection is not.**
   `docs/DATA-COLLECTION-POLICY.md` is the authority. Storing chat history,
   admin-visible message logs, per-session activity and similar is permitted
   when the same commit registers the surface in `docs/DATA.md` (fields,
   purpose, retention, who can read it), puts its limits and retention in
   `src/config/`, and adds the plain-language line to the public privacy page
   (`/privacy/`, planned — until it exists the feature's own page must say what
   is stored). Credentials stay hashed, public APIs stay minimal, and "we
   collect it" is never a substitute for "we document it".

## 2. Architecture map

| Path                     | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `src/config/*.ts`        | All owner-facing configuration: music source, DM provider, board policy, names policy (display-name/handle limits), ACCESS_RULES, theme + intro defaults (these SEED the visitor settings store in `src/scripts/settings.ts`; runtime values live there, persisted in localStorage `bnji-settings-v1`, controlled from the Settings overlay). Public values only. |
| `src/server/*.ts`        | Server-only modules: board stores (d1/rest), KV rate limiter, access primitives, env access. Never imported by client code. |
| `src/middleware.ts`      | Route-guard enforcement for ACCESS_RULES (SSR routes only; honest about static limits). |
| `src/pages/api/*`        | API boundaries: `/api/board`, `/api/dm`. `prerender = false`; validation, sanitization, rate limits live here. |
| `src/data/*.ts`          | All site content as typed data (site, navigation, projects, interests, ai-stack, network, lab, blog helpers). Components and pages read from here. |
| `src/components/`        | Astro components. Primitives: `GlassPanel`, `GlassButton`, `SectionHeading`, `PageHeader`, `BrandMark`, `Icon`. Sections: `Hero`, `AboutPreview`, `ProjectsPreview`, … |
| `src/components/lab/`    | Runnable experiments for `/lab/`. Each owns its DOM subtree + rAF loop, pauses via IntersectionObserver, has a `destroy()` path. |
| `src/layouts/`           | `Layout.astro` (shell: head, starfield, header, footer, boot script — no board; the board lives only on `/board/`), `BlogPost.astro` (article chrome + pager). |
| `src/pages/`             | Routes. `rss.xml.ts` is the typed RSS endpoint. |
| `src/scripts/`           | Client runtime. `starfield.ts` (canvas engine), `interactions.ts` (cursor glow, glass tracking, magnetic buttons, nav), `scroll.ts` (reveals, parallax), `boot.ts` (single entry, started by `Layout.astro`). |
| `src/styles/`            | `tokens.css` (every design value), `glass.css`, `animations.css`, `global.css`, `lab.css` (imported only by the lab page). |
| `src/content/blog/`      | Posts. Schema in `src/content.config.ts`. Read posts only via `src/data/blog.ts`. |

Section components are one concern each; pages compose them in order. Never
build a monolithic page template with inline content — put content in
`src/data/`, structure in components.

Planned surfaces — private messaging with images and friends/presence — are
specified in `docs/CHAT-SYSTEM-PLAN.md`, with the collection rules in
`docs/DATA-COLLECTION-POLICY.md`. Room chat (plan Phase B) and admin chat
tooling (plan Phase C: D1 moderation store, `/admin` Chat tab, service-auth
`/admin/read` + `/admin/action` on the `GameRoom` DO, `POST /api/chat/report`)
are now implemented; everything else in that list is **not**. Until a phase
lands, public copy, `README.md` and this map must describe it as planned.
Phase C test surface: `tests/chat-moderation.test.ts` (D1 store, §6.3 helpers,
route guards) and `tests/workerd/room-moderation.spec.ts` (real DO service
endpoints — needs `ACCESS_SECRET` in `wrangler.test.json`, which is already
set); migration `0014_chat_moderation.sql` must be applied before the admin
Chat tab can store anything.

## 3. Content rules

- Frontmatter fields: `title`, `description`, `pubDate`, optional `heroImage`,
  `tags`, `draft`. Schema in `src/content.config.ts`.
- Listings, RSS (`src/pages/rss.xml.ts`) and the pager all go through
  `src/data/blog.ts` (`getBlogPosts()`, `postUrl()`); never call
  `getCollection()` directly in a page.
- Posts must contain real writing, not lorem ipsum. Placeholders get deleted.
- Internal links use trailing slashes (`/projects/`, `/blog/<slug>/`).

## 4. Styling rules

- Every colour/spacing/radius/elevation/z-index/duration/easing is a custom
  property in `src/styles/tokens.css`. **No new hex values outside tokens.**
- Surfaces use the glass system: `data-glass="…"` variants or the `GlassPanel`
  / `GlassButton` components. Do not hand-roll `backdrop-filter`.
- Chips and small elements that would stack blur layers must not use
  `backdrop-filter` (see `glass.css` comments).
- Animations: transform/opacity only (compositor-friendly). Anything that hides
  content before JS runs must be behind the `html.js` class guard, and must be
  neutralised under `prefers-reduced-motion`. Keep the `forced-colors` fallback
  working.
- Type: three voices only — display (system geometric), body (Atkinson
  Hyperlegible, self-hosted), mono (system mono). Sizes/steps come from tokens.
- TWO THEMES: `:root` = dark space, `[data-theme='light']` = Frutiger Aero.
  Component CSS may branch on `html[data-theme=...]` for *visual voice*
  (bubble vs star, halo material) but never for layout or content, and never
  with hard-coded colours — both voices read tokens. New effects must degrade
  in both themes and under reduced motion.

## 5. JavaScript & performance rules

- Client code enters through `boot()` only. New behaviour = new function in an
  existing `src/scripts/` module (or a new module added to `boot.ts`), wrapped
  in the same try/catch style.
- All loops: `requestAnimationFrame`, capped, and paused when offscreen
  (IntersectionObserver) or hidden (`visibilitychange`). Provide `destroy()`.
- Pointer/cursor effects are gated on `(hover: hover) and (pointer: fine)` in
  CSS and on a pointer-type check in TS; touch devices get a static sky.
- Canvas starfield density scales with viewport area; never render more stars
  on a phone than the engine's mobile budget.
- Images: prefer SVG; raster images live in `public/` and are referenced
  root-relative. Social card is `public/og-cover.png` (source: `og-cover.svg`).

## 6. Accessibility rules

- Landmarks on every page: `header` (nav dock), `main#main`, `footer`, labelled
  `nav`s. One `h1` per page. Skip link targets `#main`.
- Active nav item gets `aria-current="page"`; the mobile toggle manages
  `aria-expanded` and closes on Escape/outside click.
- Decorative nodes (canvas, glow, icons inside labelled links) are
  `aria-hidden="true"`. Interactive controls need a visible label or
  `aria-label`; sliders pair with `<label>` elements.
- Body text contrast ≥ 4.5:1 against glass surfaces; focus states visible
  (`:focus-visible` ring in tokens).

## 7. Verification before finishing any change

The inner loop while iterating, then the full gate before calling it done:

```bash
npm run build          # must pass, no new warnings
npm exec -- tsc        # must be clean (typecheck only)
npm test               # the behaviour suite (node:test) + the DO suite (vitest/workerd) — no browser needed
npm run check          # the gate: build + tsc + wrangler deploy --dry-run
```

`npm run check` already runs the first two, so running it plus `npm test`
covers the gate; the separate lines are for a fast inner loop. There is still
no CI in this repository, so these commands are the enforcement — run them
before saying a change is done. Two things to know about the
typecheck step:

- Use `npm exec -- tsc`, **not** `npx tsc`. If `node_modules` is missing or
  only partly installed, `npx` finds no local `tsc` binary and silently fetches
  an unrelated package of that name from the registry (`tsc@2.0.4`, which is
  not TypeScript and prints "This is not the tsc command you are looking for").
  `npm exec` fails loudly instead.
- `--noEmit` is not needed and is not in the `check` script: `astro/tsconfigs/
  base.json` already sets `noEmit: true`, which the project tsconfig extends.
  A bare `tsc` therefore type-checks without writing `.js` into `src/`.

Then sanity-grep the output:

```bash
grep -rIl "example.com\|localhost" dist/client --include="*.html" --include="*.xml"   # must be empty
grep -rniI "benjamin\|emond\|cegep\|rtx 4070" src public docs README.md AGENTS.md      # must be empty (no personal info)
grep -o "https://bnji.net" dist/client/sitemap-0.xml | head -1                        # canonical origin
```

New routes must appear in `dist/client/sitemap-0.xml` (unless `noindex`).
Headless browsers are unavailable in most sandboxes here: verify structurally
(built HTML, jsdom assertions) and rely on the dev server for visual checks.

## 8. House style

- Tabs for indentation in `.astro`/`.ts`/`.css`; single quotes in TS.
- Component files `PascalCase.astro`; CSS classes kebab-case with a component
  prefix (`.lab-experiment__title`); data files kebab-case `.ts`.
- Comments explain *why*, including the failure a guard prevents. Keep the
  block comment at the top of each component accurate when you change it.
- Do not rewrite unrelated files; keep diffs surgical. Do not delete the
  starter's useful bones (content collections, RSS, sitemap) — they are product
  features.
