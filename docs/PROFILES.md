# BNJI.NET — Profile System Documentation

Complete reference for the native profile system at `/<slug>/` (currently
`/gizlyy/`). Covers architecture, data model, analytics, security logging,
reactions, and how to add another profile.

Read `AGENTS.md` first — it holds the hard rules. `CONFIGURATION.md` covers
the owner-facing knobs; `DATA.md` covers the Message Board data model.

---

## 1. Architecture overview

The profile system is a reusable, data-driven personal/social page. Content
lives in typed data files (`src/data/profiles/`); the rendering component
(`ProfilePage.astro`) never hardcodes usernames, links or copy. The page
route (`src/pages/gizlyy.astro`) is SSR so view stats and reaction counts
are rendered into the initial HTML from D1.

**Key principle:** adding another profile requires touching only the profile
registry (`src/data/profiles/index.ts`) and creating a new page file. No
component, API or database changes are needed.

```
src/data/profiles/types.ts       ProfileData type definition
src/data/profiles/gizlyy.ts      gizlyy profile content (single source of truth)
src/data/profiles/index.ts       Profile registry + lookup functions
src/config/profile.config.ts     Reaction/cookie policy (PUBLIC config)
src/components/ProfilePage.astro Reusable card component (accepts ProfileData)
src/pages/gizlyy.astro           SSR route — renders card + reactions + stats
src/pages/api/profile/view.ts    POST — view tracking (daily session dedup)
src/pages/api/profile/react.ts   POST/GET — reactions with cooldown
src/pages/api/profile/link/[id]  GET — link redirect + click tracking
src/pages/api/profile/link/click POST — link click beacon (client sendBeacon)
src/pages/api/security/enrich.ts  POST — client device data → security_events
src/pages/api/admin/security.ts  GET — admin security events (token-gated)
src/scripts/profile.ts           Client runtime (beacons, reactions, copy)
src/server/profile-store.ts      D1 data access for analytics tables
src/server/security-store.ts     D1 data access for security_events table
src/server/security-helpers.ts   Request metadata extraction + fingerprinting
migrations/0002_profiles.sql     Schema: profile_views, profile_link_clicks, profile_reactions
migrations/0003_security_events.sql Schema: security_events
public/profiles/gizlyy/          Avatar assets (webp + png fallback)
```

---

## 2. Data model

### 2.1 Profile data (content)

Profile content is defined in `src/data/profiles/<slug>.ts` using the
`ProfileData` type from `types.ts`. This is the single source of truth for
all visible content on the profile page.

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `slug` | string | ✓ | URL path (e.g. `'gizlyy'`) |
| `displayName` | string | ✓ | Main heading |
| `avatar` | string | ✓ | Root-relative image path |
| `avatarAlt` | string | ✓ | Alt text for avatar |
| `bio` | string | ✓ | Short bio paragraph |
| `loves` | string[] | ✓ | Interest list (rendered as chips) |
| `lovesLabel` | string | | Label above loves (default: `'Loves :'`) |
| `badges` | ProfileBadge[] | | Badge chips below name |
| `counter` | ProfileCounter | | Historical counter (e.g. Ayo fire) |
| `extras` | string[] | | Free-form text lines |
| `identities` | string[] | | Identity/metadata chips |
| `links` | ProfileLink[] | ✓ | Social/link buttons |
| `copyBlocks` | ProfileCopyBlock[] | | Copy-to-clipboard blocks |
| `pageTitle` | string | ✓ | SEO title |
| `pageDescription` | string | ✓ | SEO description |

**ProfileLink fields:** `id` (stable analytics key), `label`, `href`,
`icon` (Icon.astro name), `handle` (trailing mono text), `external`
(adds `noopener noreferrer`).

**ProfileCopyBlock fields:** `label` (section heading), `value` (copy target),
`subLabel` (extra text).

### 2.2 Analytics tables (D1 — `BOARD_DB`)

Created by `migrations/0002_profiles.sql`. All times are epoch milliseconds.

#### `profile_views`

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `profile_slug` | TEXT | Profile identifier |
| `session_key` | TEXT | Ephemeral random cookie value |
| `day_key` | TEXT | YYYY-MM-DD (UTC) for daily dedup |
| `created_at` | INTEGER | Epoch ms |

Indexes: `(profile_slug, session_key, day_key)` for dedup lookup;
`(profile_slug, created_at)` for count queries.

A view is counted once per (slug, session, day) triple. The session key is
an ephemeral random value stored in an HttpOnly cookie (`bnji_ps`, 30-day
expiry). It is NOT a fingerprint and has no meaning outside the dedup window.

#### `profile_link_clicks`

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `profile_slug` | TEXT | Profile identifier |
| `link_id` | TEXT | Stable link identifier from ProfileData |
| `session_key` | TEXT | Session key (for basic dedup) |
| `created_at` | INTEGER | Epoch ms |

#### `profile_reactions`

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `profile_slug` | TEXT | Profile identifier |
| `reaction` | TEXT | Emoji (validated against allowlist) |
| `session_key` | TEXT | Session key (for cooldown) |
| `created_at` | INTEGER | Epoch ms |

Cooldown: per-session, per-reaction, 5 minutes (configured in
`profile.config.ts`). Enforced server-side in the POST handler.

### 2.3 Security events table (D1 — `BOARD_DB`)

Created by `migrations/0003_security_events.sql`. Structurally separate from
the public analytics tables — this guarantees security data can never leak
into public responses.

Collection happens in two phases. **Server-side** fields are captured from
Cloudflare headers on every request to a profile endpoint. **Client-side**
fields are reported afterwards by the browser and folded into the same row
by `POST /api/security/enrich`.

#### Server-side fields (captured on every request)

| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `profile_slug` | TEXT | Which profile the request targeted |
| `endpoint` | TEXT | Which API endpoint (`view`, `react`, `link-click`, `link-redirect`) |
| `ip_address` | TEXT | Client IP from `CF-Connecting-IP` |
| `user_agent` | TEXT | User-Agent header (nullable) |
| `cf_country` | TEXT | `CF-IPCountry` header (nullable) |
| `cf_city` | TEXT | Cloudflare `cf.city` (nullable) |
| `cf_asn` | TEXT | Cloudflare `cf.asn` (nullable) |
| `geo_latitude` | REAL | Cloudflare `cf.latitude` — precise geolocation (nullable) |
| `geo_longitude` | REAL | Cloudflare `cf.longitude` — precise geolocation (nullable) |
| `referrer` | TEXT | `Referer` header, truncated to 2048 chars (nullable) |
| `fingerprint` | TEXT | SHA-256 hash of `ua|asn|country` (16-char hex, nullable) |
| `session_key` | TEXT | Session cookie value (nullable) |
| `created_at` | INTEGER | Epoch ms |

#### Client-side fields (enriched after page load)

| Column | Type | Source | Purpose |
|---|---|---|---|
| `screen_width` | INTEGER | `screen.width` | Display width in CSS px |
| `screen_height` | INTEGER | `screen.height` | Display height in CSS px |
| `screen_pixel_ratio` | REAL | `window.devicePixelRatio` | Retina/HiDPI multiplier |
| `hardware_concurrency` | INTEGER | `navigator.hardwareConcurrency` | Logical CPU cores |
| `device_memory` | REAL | `navigator.deviceMemory` | RAM in GB (Chromium-only, coarse buckets) |
| `platform` | TEXT | `navigator.platform` | OS family (e.g. `MacIntel`) |
| `timezone` | TEXT | `Intl.DateTimeFormat()` | IANA timezone (e.g. `America/Toronto`) |
| `language` | TEXT | `navigator.language` | UI language |
| `webgl_renderer` | TEXT | `WEBGL_debug_renderer_info` | GPU renderer string, 256 chars max |
| `touch_support` | INTEGER | `navigator.maxTouchPoints > 0` | 1 / 0 / NULL |
| `device_fingerprint` | TEXT | Derived server-side | SHA-256 of the above + UA (24-char hex) |

**Retention: 60 days.** Lazy cleanup on admin reads — when the row count
exceeds 5000, rows older than 60 days are deleted. 60 days is long enough
to detect sustained abuse patterns (e.g. a weeks-long bot campaign) and
short enough to satisfy Quebec Law 25 and PIPEDA data-minimisation
requirements for security-incident investigation.

**Why these fields:**
- `ip_address`: needed to identify and ban repeat abusers. Stored raw
  (not hashed) because abuse response requires matching against future
  requests from the same IP. Under Law 25/PIPEDA, IP addresses are
  personal information — this is noted in the admin endpoint docs and
  retention policy.
- `user_agent`: distinguishes bots from humans; pattern analysis for
  coordinated abuse.
- `cf_country`, `cf_city`, `cf_asn`: coarse geographic and network
  context for abuse-pattern detection (e.g. traffic spikes from one ASN).
  City-level data from Cloudflare headers is CDN-pop-level, not precise.
- `geo_latitude`, `geo_longitude`: **precise** geolocation from
  `cf.latitude`/`cf.longitude` when the feature is enabled on the
  Cloudflare account. These are IP-derived coordinates and are strictly
  more sensitive than city — they are the highest-risk personal data in
  this table and are treated as such (admin-only, 60-day retention).
- `referrer`: the referring URL, which can contain personal browsing
  context and sensitive query parameters. Truncated to 2048 characters.
- `fingerprint`: a lightweight SHA-256 hash of `ua + asn + country`. This
  is a coarse grouping key, NOT a full device fingerprint. Two visitors
  on the same network with the same browser may share a fingerprint —
  this is acceptable for abuse detection (over-grouping is preferred to
  individual tracking).
- `device_fingerprint`: the client-side counterpart, hashed from screen
  dimensions, hardware, platform, timezone, GPU, and user-agent. It is
  **derived on the server, not accepted from the client** — a
  client-supplied fingerprint would just be a caller-chosen string. The
  raw seed is never stored, only the 24-character hash.
- Screen/hardware/GPU fields: bot farms run homogeneous fleets. Device
  specs that are identical across hundreds of "unique" IPs are one strong
  abuse signal that IP and user-agent alone do not provide.
- `timezone`, `language`, `platform`: timezone/geo mismatches (e.g. an IP
  in Montreal with an `Asia/Tokyo` timezone) are a common automation and
  VPN tell.
- `session_key`: links security events to the analytics session for
  correlation during abuse investigation.

#### How the two phases join

The enrichment endpoint matches on `(session_key, profile_slug, endpoint)`
within a **10-second window**, taking the most recent matching row, and
fills only columns that are currently NULL (`COALESCE` on every field).
A client value can therefore never overwrite a server-observed value.

```
GET  /gizlyy
  └─ POST /api/profile/view           → INSERT security_events (server fields)
  └─ (1500 ms later, after Set-Cookie lands)
     POST /api/security/enrich → UPDATE ... SET screen_width = COALESCE(?, screen_width), ...
```

The client beacon is delayed 1500 ms on purpose: on a **first** visit the
`bnji_ps` cookie is still being set by the `/api/profile/view` response.
Firing the enrichment immediately would race that `Set-Cookie` and find no
session to match. Later visits already have the cookie, so the delay costs
nothing there.

Misses are discarded silently — the endpoint always returns `204` and
never reveals whether an enrichment succeeded. Enrichment is rate limited
to 30 requests per IP per 5 minutes (KV-backed, fails open) so this write
path cannot be used to hammer D1.

---

## 3. Analytics flow

### 3.1 Profile views

1. Client loads `/gizlyy/` — SSR renders the page with current view stats
   and reaction counts from D1.
2. Client script fires `sendBeacon('/api/profile/view', { slug })` on load.
3. Server:
   - Extracts or generates session key from `bnji_ps` cookie.
   - Checks `profile_views` for existing (slug, session, day_key) row.
   - If new: INSERT into `profile_views`, return `{ recorded: true }`.
   - If exists: return `{ recorded: false }`.
   - Sets `Set-Cookie` if session key was generated.
   - Logs a `security_event` (fire-and-forget).
4. Response is 200 regardless — the page has already rendered.

**Dedup strategy:** one count per (profile_slug, session_key, day_key).
A session that refreshes 100 times in one day produces one view. A new
session the next day produces another view. This gives meaningful daily
unique-visitor counts without fingerprinting.

### 3.2 Link clicks

**Primary (JS-enabled):** Client fires `sendBeacon('/api/profile/link/click', { slug, linkId })`
on click. The `<a>` href points to the real URL — navigation is not
delayed or intercepted. The beacon endpoint validates the link ID against
the profile data, records the click, and returns 204.

**Fallback (redirect):** `GET /api/profile/link/<id>?slug=gizlyy` records
the click and returns a 302 redirect to the real URL. This works without
JS but is not the primary tracking mechanism.

Both paths log a `security_event` (fire-and-forget).

### 3.3 Reactions

1. Visitor clicks a reaction button (e.g. 🔥).
2. Client sends `POST /api/profile/react { slug, reaction }` with
   `credentials: 'same-origin'`.
3. Server validates slug and reaction against allowlist, checks cooldown
   (5 min per session per emoji), inserts into `profile_reactions`, returns
   updated counts. Sets `Set-Cookie` if needed.
4. Client updates all reaction counts from the response (optimistic UI
   with rollback on error).
5. Button is disabled for 2 seconds after click to prevent spam.
6. A `security_event` is logged (fire-and-forget).

**Cooldown:** 5 minutes per (profile_slug, reaction, session_key). Server-
enforced; client-side disabling is supplementary.

---

## 4. Security logging

### 4.1 Purpose

Security events exist to detect and respond to abuse of the public profile
endpoints — NOT for personalization, marketing, or general traffic analytics.

### 4.2 What is collected

Server-side, on every request to a profile endpoint:

| Field | Source | Stored as |
|---|---|---|
| IP address | `CF-Connecting-IP` header | Raw text |
| User-Agent | `User-Agent` header | Raw text |
| Country | `CF-IPCountry` header | ISO code |
| City | `cf.city` / `CF-City` | Text (coarse) |
| ASN | `cf.asn` | Number as text |
| Latitude | `cf.latitude` | REAL — precise geolocation |
| Longitude | `cf.longitude` | REAL — precise geolocation |
| Referrer | `Referer` header | Text, 2048 chars max |
| Fingerprint | SHA-256 of `ua|asn|country` | 16-char hex |
| Session key | `bnji_ps` cookie | Raw text |

Client-side, reported once per page load via
`POST /api/security/enrich`:

| Field | Source | Stored as |
|---|---|---|
| Screen size | `screen.width` × `screen.height` | INTEGER |
| Pixel ratio | `window.devicePixelRatio` | REAL |
| CPU cores | `navigator.hardwareConcurrency` | INTEGER |
| Device memory | `navigator.deviceMemory` | REAL (GB) |
| Platform | `navigator.platform` | Text, 128 chars max |
| Timezone | `Intl.DateTimeFormat()` | Text, 64 chars max |
| Language | `navigator.language` | Text, 32 chars max |
| GPU renderer | `WEBGL_debug_renderer_info` | Text, 256 chars max |
| Touch support | `navigator.maxTouchPoints > 0` | INTEGER 1/0 |
| Device fingerprint | SHA-256 of the above + UA, **derived server-side** | 24-char hex |

All of it is collected **for abuse detection only** — the explicit purpose
of this table. It is not used for personalization, marketing, analytics,
or any other product purpose.

### 4.3 What is deliberately NOT collected

- ❌ GPS coordinates, postal codes, or street addresses (geo data is
  IP-derived only, from Cloudflare)
- ❌ Names, email addresses, account IDs, or any other direct personal
  identity
- ❌ Form input, keystrokes, or page content
- ❌ Canvas pixel data (only the WebGL *renderer string* is read, from a
  throwaway context that is immediately destroyed)
- ❌ Audio-context or font-list fingerprinting
- ❌ Cookies, local storage, or identifiers belonging to any third party
- ❌ Cross-site or persistent cross-session identifiers (the session key is
  an ephemeral random value, rotated by cookie expiry, not a tracking ID)

### 4.4 Retention

**60 days.** Rows older than that are purged during admin reads (lazy
cleanup triggered when row count exceeds 5000). Justification: 60 days
covers a sustained abuse campaign (e.g. a weeks-long bot attack) while
minimising the window during which personal information is stored.

Under Quebec's Law 25 and PIPEDA, IP addresses, device identifiers,
precise geolocation, and referrer URLs are all personal information even
when collected for security. The 60-day retention is the minimum useful
window for abuse investigation.

Note: the admin endpoint reads the event list first and the total count
second, so the `total` it reports reflects post-purge state rather than
the pre-purge count on the read that triggered cleanup.

### 4.5 Access control

Security events are accessible ONLY through `GET /api/admin/security`.

**Gate:** the shared admin guard in `src/server/admin.ts` — a valid admin
session cookie, or `Authorization: Bearer <access token>`. The token is
compared against the SHA-256 hash in D1, not against an environment
variable. If the credential is not configured, the endpoint returns 503
rather than failing open.

> This section used to describe an `ACCESS_TOKEN` env-var comparison and
> warn that "this is NOT a real admin system". Both were true of an
> earlier draft and stopped being true when `/admin` shipped. The gate is
> now DB-backed, with server-side sessions, login throttling, `SameSite=Strict`
> session cookies, and immediate invalidation when the token rotates. See
> [`ADMIN.md`](./ADMIN.md) for the full description.

### 4.6 What is NEVER exposed

- Security events do not appear in any public page, API response, or stats
  endpoint.
- The `security_events` table is never queried by the public profile page
  or any public API.
- The admin endpoint returns `cache-control: no-store` and requires auth.
- The enrichment endpoint is write-only: it always returns `204` with an
  empty body, so it can be probed by anyone but discloses nothing.
- IP addresses, user-agent strings, geo coordinates, referrers, and
  fingerprints are not logged to Worker console output (only storage
  errors are logged).
- The client-side collector is bundled into the public page script, but it
  only *reads* device properties and POSTs them — no collected value is
  ever rendered into the HTML or returned by a public endpoint.

### 4.7 Abuse resistance of the collection path itself

The enrichment endpoint is unauthenticated, so it is defended as a write
path rather than as a secret:

- **Rate limited** — 30 requests per IP per 5 minutes, KV-backed so the
  limit holds across Worker isolates. Fails open if the KV binding is
  missing (throttling must not take the site down).
- **Validated** — slug must resolve to a real profile, endpoint must be in
  the allowlist, and every numeric field is range-bounded. Non-finite
  numbers (`NaN`, `Infinity` from a `1e999` payload) and oversized strings
  are dropped, not stored.
- **Write-once** — `COALESCE` on every column means a client can fill
  blanks but never overwrite a server-observed value.
- **Unforgeable fingerprint** — derived server-side from the request's own
  user-agent plus the reported hardware, so it cannot be chosen by the
  caller. The seed is never stored.
- **Silent on failure** — every path returns `204`. A client cannot use
  response codes to fingerprint whether enrichment landed.

---

## 5. Reactions configuration

Defined in `src/config/profile.config.ts` (PUBLIC):

| Value | Default | Description |
|---|---|---|
| `allowedReactions` | `['❤️', '🔥', '✨', '👀', '💀']` | Valid emoji list (server-validated) |
| `reactionCooldownMs` | `300000` (5 min) | Per-session, per-emoji cooldown |
| `sessionCookie` | `'bnji_ps'` | Cookie name for session key |
| `sessionCookieMaxAge` | `2592000` (30 days) | Cookie lifetime |
| `sessionCookieSameSite` | `'Lax'` | Cookie SameSite attribute |

To change the available reactions, edit `allowedReactions` in
`profile.config.ts`. The rendering component reads the list from config —
no template changes needed.

---

## 6. Profile visual system

### 6.1 Background

The profile page renders inside `Layout.astro`, which provides the site's
standard background (aurora + starfield + vignette for dark theme, Aero sky
for light theme). There is no profile-specific background override.

The original Ayo profile background could not be inspected — `cdn.ayo.so`
was unreachable from the sandbox, and the page is a JavaScript SPA so
raw HTML/CSS was not available via `fetch_page`. Per the migration rules,
no approximation was attempted. The background can be customized per-profile
by adding a `background` field to `ProfileData` and applying it in
`ProfilePage.astro`.

### 6.2 Avatar

The avatar is a 192×192 WebP (7.7 KB) stored at
`public/profiles/gizlyy/avatar.webp` with a PNG fallback at
`public/profiles/gizlyy/avatar-192.png`. The display size is 96×96 CSS
pixels (192px raster for retina).

**⚠️ Placeholder:** The current avatar was generated by the AI agent because
`cdn.ayo.so` was unreachable. To replace with the real avatar:

1. Download from `https://cdn.ayo.so/final/9e8d0c4d-8640-43cd-b67e-b5cdf92af326.webp`
2. Place in `public/profiles/gizlyy/avatar.webp`
3. Optionally resize to 192×192 for optimal file size
4. No code changes needed — the profile data references the file path

### 6.3 Customizing the background

To add a custom background for a profile, add a `background` field to
`ProfileData` in `types.ts` (e.g. `background?: string` as a CSS value
or image path), then apply it in `ProfilePage.astro` using BNJI's token
system. This keeps the change data-driven and avoids hardcoding values
in templates.

---

## 7. Adding a new profile

Steps (no component/API/database changes needed):

1. **Create data file:** `src/data/profiles/<slug>.ts`
   - Import `ProfileData` from `./types`
   - Export a const matching the type
   - Place avatar in `public/profiles/<slug>/`

2. **Register:** `src/data/profiles/index.ts`
   - Import the new profile
   - Add to the `PROFILES` array

3. **Create page:** `src/pages/<slug>.astro`
   - Copy the pattern from `gizlyy.astro`
   - Import the new profile data
   - Change the slug in `initProfile('<slug>')`
   - Adjust any page-specific styling if desired

4. **(Optional) Add icons:** If the new profile uses social platforms not
   yet in `Icon.astro`, add the SVG paths there.

5. **(Optional) Navigation:** Add to `PRIMARY_NAV` in `navigation.ts` and/or
   `FOOTER_NAV`.

6. **Verify:** `npm run build && npx tsc --noEmit && npm run check`

---

## 8. File reference

### Configuration

| File | Visibility | Purpose |
|---|---|---|
| `src/config/profile.config.ts` | PUBLIC | Reaction allowlist, cooldowns, cookie config |
| `src/data/site.ts` | PUBLIC | Canonical origin (`SITE.url`) |

### Data

| File | Purpose |
|---|---|
| `src/data/profiles/types.ts` | `ProfileData`, `ProfileLink`, `ProfileCopyBlock`, `ProfileBadge`, `ProfileCounter` types |
| `src/data/profiles/gizlyy.ts` | gizlyy profile content (the ONLY file to edit for content changes) |
| `src/data/profiles/index.ts` | `PROFILES` array, `getProfileBySlug()`, `allProfileSlugs()` |

### Server

| File | Purpose |
|---|---|
| `src/server/profile-store.ts` | D1 store: views, reactions, link clicks |
| `src/server/security-store.ts` | D1 store: security events (admin-only) |
| `src/server/security-helpers.ts` | Request metadata extraction, fingerprint computation |
| `src/server/env.ts` | Environment access (secrets + bindings) |

### Components

| File | Purpose |
|---|---|
| `src/components/ProfilePage.astro` | Reusable card component (data-driven) |

### Pages / API

| Route | Method | Purpose |
|---|---|---|
| `/gizlyy/` | GET (SSR) | Profile page |
| `/api/profile/view` | POST | View tracking beacon |
| `/api/profile/react` | POST | Add reaction |
| `/api/profile/react?slug=X` | GET | Get reaction counts |
| `/api/profile/link/click` | POST | Link click beacon |
| `/api/security/enrich` | POST | Client device data → security_events (rate limited) |
| `/api/profile/link/<id>?slug=X` | GET | Link click + redirect |
| `/api/admin/security` | GET | Admin security events (token-gated) |

### Client

| File | Purpose |
|---|---|
| `src/scripts/profile.ts` | View beacon, reactions, link tracking, copy blocks |

### Migrations

| File | Tables |
|---|---|
| `migrations/0002_profiles.sql` | `profile_views`, `profile_link_clicks`, `profile_reactions` |
| `migrations/0003_security_events.sql` | `security_events` |

### Assets

| File | Purpose |
|---|---|
| `public/profiles/gizlyy/avatar.webp` | Avatar (WebP, 192×192, 7.7 KB) — **placeholder** |
| `public/profiles/gizlyy/avatar-192.png` | Avatar fallback (PNG, 192×192, 57 KB) — **placeholder** |