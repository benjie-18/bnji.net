# BNJI.NET — data documentation: the Message Board

What the message board actually stores, where, for how long, and what a future
moderation flow would touch. Everything here describes the code as it exists —
sources of truth are `migrations/0001_board_messages.sql`,
`src/server/board-store.ts`, `src/pages/api/board.ts`, `src/server/ratelimit.ts`
and `src/config/board.config.ts`. Configuration (limits, providers, windows) is
documented separately in [`CONFIGURATION.md`](./CONFIGURATION.md) §5.

**Collection policy:** what the site is allowed to store, who may read it, and
what must be disclosed is governed by
[`DATA-COLLECTION-POLICY.md`](./DATA-COLLECTION-POLICY.md). That policy
permits chat history, admin-visible message logs and activity attribution, and
requires every surface to be registered in §11 of this document before it
ships.

## 1. Where data lives

| Store | Binding | Contents |
| --- | --- | --- |
| **Cloudflare D1** (SQLite) | `BOARD_DB` | One table, `board_messages` — every board message, permanently. |
| **Cloudflare KV** | `BOARD_KV` | Rate-limit counters only (see §4). No messages. |

If the configured provider is `'rest'` instead of `'d1'`
(`BOARD_CONFIG.provider`), messages live in the external JSON API named by the
`BOARD_REST_URL` secret under the same contract, and this document describes
the contract rather than the remote's internals. There is **no in-memory
storage**: an unconfigured store makes `/api/board` answer
`503 storage_unconfigured` instead of silently discarding posts.

## 2. What is stored per message

D1 columns (`board_messages`) ↔ API/JSON names:

| Column | API field | Type | Why it exists |
| --- | --- | --- | --- |
| `id` | `id` | `TEXT` PRIMARY KEY | Server-generated at accept time: `<epoch-ms in base36>-<6 random base36 chars>`. Stable identity for the pagination cursor's tie-breaker, for `setStatus()`, and for client-side dedupe. Never supplied by clients. |
| `body` | `text` | `TEXT NOT NULL` | The message. Trimmed, control characters stripped, hard-capped at `BOARD_CONFIG.maxTextLength` (**250**) in the route — over-long posts are rejected with `422 text_too_long`, never truncated. |
| `image` | `image` | `TEXT` nullable | Optional attachment, stored **inline** as a `data:` URL. The route re-validates on every write: strict `data:image/(png\|jpeg\|webp\|gif);base64,…` regex, MIME allowlist, and ≤ `BOARD_CONFIG.maxImageBytes` (**1.4 MB decoded**, computed from base64 length, never by decoding). No remote URLs are ever stored. |

> **Why 1.4 MB and not 25 MB.** This column is where the ceiling comes from — not
> the request path. Workers would accept a 25 MB upload (request bodies go to
> 100 MB; base64 inside JSON expands 25 MB to ~33 MB, which still fits), but D1
> caps **a string, BLOB or table row at 2,000,000 bytes**
> ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). An inline
> `data:` URL must live in one column, so the largest image that can be stored
> is `2,000,000 × 3/4 ≈ 1.49 MB`; 1.4 MB leaves room for the rest of the row
> (id, body, status, timestamps) with ~133 KB of margin. A 25 MB image is ~16×
> that ceiling and would fail at the INSERT with `SQLITE_TOOBIG` — an opaque
> 500, not a clean rejection. Genuinely supporting 25 MB means moving the file
> out of the row (R2 object storage + a reference in D1), which is an
> architecture change rather than a constant.
| `hue` | `hue` | `INTEGER NOT NULL DEFAULT 0` | A 0–359 tint seed chosen once server-side (`Math.random`) so every visitor sees the same colour for a given bubble/star, without storing a full colour. |
| `status` | *(never exposed)* | `TEXT NOT NULL DEFAULT 'visible'`, `CHECK (status IN ('visible','hidden','reported','deleted'))` | Moderation state, a closed set enforced at the storage layer, not just in code. Stripped from every public payload (`PublicMessage = Omit<BoardMessage,'status'>`). See §5. |
| `created_at` | `createdAt` | `INTEGER NOT NULL` | Epoch **milliseconds** from the server clock at accept time. Sort key (newest first), cursor anchor, and display timestamp. |

Index: `idx_board_public ON board_messages (status, created_at DESC, id DESC)` —
serves the public-feed query (status filter + newest-first keyset seek)
directly; pagination never scans hidden/deleted rows via this index.

There is deliberately nothing else: no author identity, no IP address, no
user-agent, no edit history, no `updated_at`, no moderation audit columns
(who/when/why a status changed). Those do not exist yet — see §5 for what a
moderation flow would need to add.

## 3. Retention

- **Messages persist indefinitely.** There is no TTL, no expiry, no pruning job
  anywhere in the codebase. Rows leave the table only via a direct D1 command
  (`wrangler d1 execute … DELETE`) — no application code path deletes rows.
- **`deleted` is a soft state.** Flipping `status` to `'deleted'` removes a
  message from every public response but keeps the row (and its body/image) on
  disk for audit. Nothing currently performs hard deletion.
- **No backups/export pipeline is configured.** D1's own snapshotting is the
  only recovery mechanism today.

## 4. Abuse-prevention data (rate limiting)

`src/server/ratelimit.ts` keeps **fixed-window counters in KV** for board and
DM abuse throttles. The key names contain the connecting IP only for the short
window described below. This is separate from private security-event and Games
tracking in D1; those tables and their access/retention rules are documented in
[`PROFILES.md`](./PROFILES.md) and
[`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md).

- **Key shape:** `rl:<scope>:<clientKey>:<windowIndex>`, where
  `windowIndex = floor(now / windowMs)`. Scopes in use: `board:post:<ip>`
  (20 s window, max 1), `board:hour:<ip>` (1 h, max `hourlyPostLimit` = 20),
  `dm:post:<ip>` (window from `DM_INTEGRATION.cooldownSeconds`, max 1),
  `dm:hour:<ip>` (1 h, max 10), and `board-paint:<ip>` (1 h, max 30 publishes).
- **Value:** the integer hit count for that window. Nothing else.
- **`clientKey`** is the Cloudflare `connectingIp`; when absent (e.g. local
  dev) it falls back to the literal `unknown`, which pools all such clients
  into one bucket.
- **Retention:** each key is written with `expirationTtl` = remainder of its
  window + 1 s, floored at **60 s** (KV's minimum TTL). So the 20-second
  cooldown keys live about a minute and the hourly keys about an hour, then KV
  deletes them automatically. **The IP address therefore survives at most
  ~1 hour past its last use, only inside key names, and never reaches D1.**
- **Semantics:** counters are shared across Worker isolates (that is the point
  of KV). Two concurrent same-window hits can race the read-then-put and
  under-count by one — the documented bound is "limit + concurrency". If the
  KV binding is missing or failing, rate limiting **fails open** with a console
  warning; it is an abuse throttle, not authentication.

## 5. Moderation: what exists, and what a future flow would touch

**Exists today (schema + enforcement only, no UI, no HTTP surface):**

- the `status` column with its `CHECK` constraint and four-value vocabulary;
- SQL-enforced public filtering: the D1 store's `listPublic()` selects
  `WHERE status IN ('visible','reported')`, so `hidden` and `deleted` rows
  cannot reach a public response even if a route forgot to check. `reported`
  is intentionally **still public** — it flags "pending review", it does not
  hide. (The `'rest'` provider applies the same filter defensively on
  responses from the remote.)
- `status` is stripped from every public payload, including the POST echo;
- `BoardStore.setStatus(id, status)` — a single-row `UPDATE` in D1 (returns
  `false` for unknown ids via `meta.changes`), a `PATCH {url}/{id}/status` in
  the REST provider. **No route, script or UI calls it yet.**

**Intended flow when moderation is built (not implemented):**

1. **Report:** a visitor action flips `visible → reported`. The message stays
   public and lands in a review queue (a server-side query for
   `status = 'reported'`).
2. **Hide:** a moderator flips `reported|visible → hidden`. The message
   disappears from the public feed on the next request — no deploy, no cache
   purge (responses are `no-store`; client ETags revalidate).
3. **Delete:** `→ deleted`, the soft delete: publicly gone, row retained.
4. **Restore:** any status `→ visible`.

**What that flow would still need to add** (gaps a contributor should know
about): an authenticated admin surface (the repo has no auth for this —
`ACCESS_RULES` exists but protects routes, not actions); audit columns
(`moderated_at`, `moderation_reason`, actor) since none exist; a report
endpoint with its own rate limiting; and a decision on hard-deletion/purge
policy for `deleted` rows.

## 6. Image lifecycle

Attachments exist end-to-end today, with validation split across two tasks:

1. **Client (composer, `src/scripts/board.ts`):** file input restricted to the
   configured MIME types; the script checks type and size, then reads the file
   as a `data:` URL (`FileReader`) and POSTs it inline. (Further client-side
   hardening of upload validation is tracked as a separate follow-up task —
   it has not landed in these files.)
2. **Server (`/api/board` POST):** re-validates independently — strict
   data-URL regex, MIME allowlist, byte cap derived from the base64 length.
   A rejected image fails the **whole post** with a named error
   (`image_too_large` / `image_unsupported`, both `422`, the first carrying
   `maxBytes`) rather than being dropped from an otherwise-accepted message —
   a visitor whose upload vanished silently would reasonably conclude it had
   worked.
3. **Storage:** inline in `board_messages.image` (`TEXT`). No object storage,
   no thumbnails, no deduplication, no expiry — an image lives exactly as long
   as its message row (§3).
4. **Delivery:** inline again in every list/full-list response that includes the
   message. Be aware of the arithmetic: one at-cap image is ≈ 1.87 MB of
   base64, so a page of image-heavy posts is multi-megabyte JSON, and the
   full-list cursor walk multiplies that. If the board grows image traffic,
   moving attachments to object storage (e.g. R2) with a reference/thumbnail
   in the row is the first refactor to reach for — and it is also what would
   lift the 1.4 MB ceiling (see the note on the `image` column).

## 7. Site-wide statistics (admin only)

`GET /api/admin/stats` (`src/pages/api/admin/stats.ts`) serves the dashboard's
numbers. It is a **read-only aggregate over tables that already exist** — it
adds no storage of its own — and it deliberately calls the same store methods
the public features call, so a dashboard figure cannot drift from the number a
visitor sees.

| Group | Source | What "total" means |
| --- | --- | --- |
| Traffic | `profile_views` via `getViewStats()` | `COUNT(*)` over **distinct `(session_key, day_key)`** — one view per session per day. This is the same total rendered in the public profile pill and the `/gizlyy/` stat block. |
| Engagement | `profile_reactions`, `profile_link_clicks` | Row counts per reaction and per link. Labels come from the profile data, so the panel says "Reddit", not `reddit`. |
| Message board | `boardStore.summarize()` | `total`, `byStatus`, `postedLast24h`, `reportedLast24h`. No "recent posts" total is shown, because the store does not aggregate one. |
| Security | `security_store.summarize()` | `total`, `last24h`, `uniqueIps`, `uniqueDevices`, `enriched`, `bySurface`, `byEndpoint`, `retentionDays`. |
| Credential | `admin_credentials.updated_at` | `0` = the seeded token is still in use. |

Rules the endpoint holds itself to:

- **No invented metrics.** Every field maps to a real column. A group whose
  store is unavailable returns `null` and the panel prints an explanation, not a
  convincing `0`.
- **Security telemetry stays separate.** It lives in `security_events` under
  the shared configurable raw-tracking retention (default 60 days, 1–365) and
  never contributes to any public or traffic figure. An hourly Cron sweep and
  guarded admin reads delete at most 50 expired rows per table per invocation;
  query cutoffs exclude expired rows immediately. The scheduled sweep can delete
  at most 60 per table (50 plus a 10-row catch-up when the first batch is full).
  Backlogs larger than one batch take multiple hourly sweeps plus scheduler
  jitter to delete physically, because D1 has no row-TTL feature on this design.
- **Deduplicated by the source.** The per-session-per-day rule is the store's,
  not the dashboard's, so a refresh cannot inflate a total.

## 8. The admin credential row

`migrations/0005_admin_credentials.sql` adds one table, `admin_credentials`,
with a single row enforced by `CHECK (id = 1)`:

| Column | Type | Contents |
| --- | --- | --- |
| `id` | INTEGER PK | Always `1`. The constraint is what makes a second admin impossible at the storage layer. |
| `token_hash` | TEXT NOT NULL | `hex(sha256(token))`. The access token itself is never stored, and its plaintext appears nowhere in the repository. |
| `updated_at` | INTEGER NOT NULL | Epoch ms of the last rotation; `0` for the seeded row. |

See [`CONFIGURATION.md`](./CONFIGURATION.md) §6a for the setup, rotation and
recovery procedure.

## 9. Privacy summary

- Messages are **public by design**; posting requires no account and stores no
  identity.
- The board/DM rate limiter holds the connecting IP transiently in KV key
  names (§4); it does not write those rate-limit keys to D1. This is not a
  site-wide statement: the separate profile `security_events` and Games
  `game_sessions` stores collect additional request/device metadata for
  abuse-detection and private usage reporting. They are admin-only, have
  configurable retention, and are described in [`PROFILES.md`](./PROFILES.md)
  and [`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md). A 60-day default is a
  product setting, not a claim of legal compliance.
- **Credential material is stored as a hash, never as a secret.**
  `admin_credentials.token_hash` is a SHA-256 digest — there is no code path
  that reads the access token back, by design. The HMAC key that signs admin
  sessions (`ACCESS_SECRET`) is a Worker secret, never in the database.
  Connection identifiers live in `wrangler.json` bindings and all other secrets
  in the Worker environment (`wrangler secret put`).
- Profile analytics (`profile_views`, `profile_reactions`,
  `profile_link_clicks`) are keyed by an **ephemeral random session cookie**
  (`bnji_ps`, `src/config/session.config.ts`), not by a player identity. The
  `session_key` is discarded with the cookie and is not correlatable across
  sessions. Games may optionally upgrade the same validated guest session to a
  separate global player identity; this does not change profile analytics or
  `/admin` authentication.
- Games identity rows are in `game_players`, `game_player_sessions`,
  `game_auth_attempts`, and `game_saves` (migration `0012`). Recovery codes
  contain 160 bits of random entropy and only their SHA-256 digests are stored;
  opaque 256-bit session tokens are also stored only as digests. The
  authentication-throttle table stores a hashed IP, not the source IP. Account
  identity and saves are optional; guest play/local progress do not require
  them. Players may export or delete their account; deleting cascades saves,
  linked score/run references as implemented, and live sessions. There is no
  email or operator-assisted recovery. The game save JSON is private, bounded
  to 16 KiB/blob and 25 slots/player; the generic schema does not validate game
  rules or scores. See [`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md) for the
  full contract, retention, quotas and owner rollout.
- Room codes and room state live in short-lived SQLite-backed `GameRoom`
  Durable Objects (maximum two-hour lifetime); game state is opaque and
  untrusted, with no generic score/game-rule validation. **Room chat is
  implemented (chat plan Phase B, 2026-09-30)** and permitted
  ([`CHAT-SYSTEM-PLAN.md`](./CHAT-SYSTEM-PLAN.md)): bounded plain text lives
  only inside the room's own Durable Object SQLite, survives reconnects as
  history, and is deleted with the room by the same `alarm()` sweep — a room
  conversation never outlives the room, and no chat row is ever written to KV
  or D1. That supersedes the earlier recorded "no chat history" position. See
  the Games operations/decision records for the exact message/state bounds
  and quota policy.
- **Planned collection surfaces** (registered here when implemented, per the
  collection policy): a room registry that lets administrators list and read
  active rooms; report snapshots and a moderation audit log; account-to-account
  private messages with images under a bounded retention window; friendships,
  blocks and presence; and optional Paint attribution. None of these exist
  yet, and none may ship without the register entry, the config value for
  retention, and the privacy-page line described in
  [`DATA-COLLECTION-POLICY.md`](./DATA-COLLECTION-POLICY.md) §1. (Guest display
  names and account handles were the first surfaces on this list to land; they
  are now live and registered in §11 below.)

## 10. Shared Paint canvas

The Paint area below `/board/` is separate from `board_messages`. Its API is
`/api/paint`; the singleton state lives in `board_paint_state` in `BOARD_DB`,
created by migrations `0006_board_paint.sql` and
`0007_paint_stickers_activity.sql`.

### Storage and size bounds

- The singleton stores a 1200 × 750 PNG drawing layer, its revision and update
  time, plus a JSON list of stable-ID stickers. It does not append pointer
  events or an unbounded image history.
- The drawing PNG is capped at 850,000 data-URL characters. Stickers are resized
  client-side into a 60 × 39 pixel maximum import box with aspect ratio preserved,
  encoded as PNG, and limited server-side to 24 items, 18,000 characters each,
  and 180,000 characters total. A sticker may then be resized up to a 240 × 156
  pixel ceiling (4x the import box in each axis), which the server enforces as
  the stored-size limit. Because `validateStickers()` requires a stored
  PNG's own pixel dimensions to match the sticker's width and height, a resize
  is not a rectangle-only change: the bitmap is re-encoded at the new size from
  the upload-time original, so repeated resizes never compound resampling. The combined drawing and sticker state is capped
  at 1,050,000 characters; the streamed JSON request is capped at 1,100,000
  bytes. The D1 per-string/row ceiling is 2,000,000 bytes, leaving row headroom
  [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- `board_paint_commits` retains at most 128 recent request IDs for idempotent
  retries. It is not an artwork or visitor history.

### Shared editing and concurrency

The browser keeps drawing operations and sticker changes local until **Sync &
refresh** publishes them. The request carries its base revision. If another
visitor publishes first, the server returns the newer drawing and sticker
state; local drawing marks are rebased above that snapshot and sticker edits
are replayed by stable ID. A conflicting move/removal/resize of a sticker
changed by another visitor is skipped and announced rather than silently
replacing their newer version. A resize records the pre-drag rectangle and the
new bitmap, so undoing it restores the previous size without a second lookup. Conditional revision updates and D1's atomic `batch()` preserve
concurrent commits. A dropped-response retry reuses the identical request ID
and payload, so it cannot duplicate an accepted publish. Polling remains a
conditional 20-second refresh while the section is visible.

The drawing tools include pen, eraser, line, rectangle, ellipse, text, spray and
glow. Stickers remain separate editable items over the drawing snapshot: they
can be dragged or moved with arrow keys while selected, and removed with the
eraser. A selected sticker also shows four corner handles; dragging one resizes
it with the opposite corner as a fixed anchor, and the aspect ratio stays locked
unless Shift is held. Alt with an arrow key resizes from the keyboard (Ctrl or
Cmd frees the ratio), which keeps the whole interaction reachable without a
pointer. Handles and the selection outline are drawn on the preview layer, which
is cleared on every gesture and is never published or exported. Export includes
both layers. Fullscreen covers the whole Paint workspace
(including its controls), not only the canvas.

### Published activity and privacy

`board_paint_activity` is a separate **admin-only** activity trail, not the
public security-events table. It records accepted publishes only: timestamp,
revision, validated action-type counts and a random, opaque Paint session ID
from a session cookie. It does not store accounts, IP addresses, pointer paths,
sticker images, canvas contents or unpublished edits. The session ID groups
requests within a browser session but does not identify a real person or an
authenticated visitor. The trail is never returned by `/api/paint`; it is
available only through the guarded admin Paint activity endpoint and has
`cache-control: no-store`.

> **Changed 2026-09-30:** the paragraph above describes the code as it stands.
> It is no longer a permanent limit. [`DATA-COLLECTION-POLICY.md`](./DATA-COLLECTION-POLICY.md)
> §6 permits extending this trail — account/session attribution, per-action
> detail, and (with a strong recommendation against) pointer paths or canvas
> snapshots on report. Each extension is a separate register entry here and a
> config value, and it must be disclosed before it is switched on.

Paint activity follows the shared `trackingRetentionDays` setting (default
60 days, 1–365) and is capped at 5,000 rows. The hourly Worker sweep deletes at
most 60 expired rows per table (a 50-row primary batch plus a 10-row catch-up
only when the primary batch is full); private admin reads make a separate
bounded batch of at most 50. Query filters hide expired rows immediately.
Larger backlogs take multiple sweeps plus scheduler jitter to delete physically. Public publishes remain limited
to 30 per IP per hour using the existing KV throttle; its transient IP key has
the TTL described in §4 and is not copied into the activity table.

Paint requires `BOARD_CONFIG.provider === 'd1'`. With the message board in
`rest` mode, the existing visible unavailable state and API response
`503 paint_requires_d1_board` remain in place; Paint never writes behind the
external REST provider or assumes an undocumented contract.

## 11. Collection register

Required by [`DATA-COLLECTION-POLICY.md`](./DATA-COLLECTION-POLICY.md) §1: every
surface that stores user content or behaviour appears here **before it ships**,
with its retention and readership stated. Today's register:

| Surface | Stored | Retention | Who can read it | Disclosed |
| --- | --- | --- | --- | --- |
| Message board | Message text, optional image, status, report count | Permanent (§3) | Public (visible/reported); admins see all statuses | Board page notes moderation; admins are named in `/admin` docs |
| Board Paint activity | Accepted-publish counts, revision, opaque Paint session ID | `trackingRetentionDays` (default 60) | Admins only | §10 above |
| Profile analytics | View/react/click counts keyed by ephemeral session cookie | 60 days default | Admins only (aggregates public) | [`PROFILES.md`](./PROFILES.md) |
| Security events | Request metadata, device fingerprint, hashed IP | 60 days default | Admins only | [`PROFILES.md`](./PROFILES.md) |
| Games tracking | Anonymous run rows, coarse device class, server-observed IP/UA | `trackingRetentionDays` | Admins only | [`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md) |
| Games account | Display name, optional public handle, digested recovery code/sessions, saves, scores | Until account deletion | Own account; admins see aggregates | [`GAMES-OPERATIONS.md`](./GAMES-OPERATIONS.md) |
| Guest display names | Display name for this browser, stored keyed by a SHA-256 digest of the session cookie (the raw cookie value is never stored) | 30 days after the last change (config) | Own session only — never linked to an account; not browsable by admins | `/games/` rooms panel note + this row |
| Account handles | Public handle + handle-change timestamp | Until account deletion | Public by exact match: handle and display name only, never a player ID | `/games/` account panel note + this row |
| Room chat | Bounded plain text (≤250 code points after sanitising), display label (your display name or `Player`/`Guest` fallback, re-sanitised server-side), opaque per-room member ID, hashed principal, monotone message number, tombstone markers, host-action log | Room lifetime (≤2 h): deleted with the room by the DO `alarm()` sweep; trimmed to the newest 200 messages per room (`CHAT_CONFIG`) | Room members live; admins while the room exists (admin tooling is Phase C) | `/games/` room chat panel line + this row; account export states its exclusion explicitly (room-keyed, ≤2 h) |
| Private messages | **Planned** — text, images, read watermark | Bounded window, default 30 days (config) | The two participants; admins per the configured visibility mode | `docs/CHAT-SYSTEM-PLAN.md` (to be added here when implemented) |
| Friends / blocks / presence | **Planned** — handles, edge states, ephemeral presence | Account lifetime; presence ephemeral | Own account; presence visible to accepted friends | `docs/CHAT-SYSTEM-PLAN.md` (to be added here when implemented) |

Rules for this table: no row may say "permanent" by omission; every row's
retention value lives in `src/config/`; and any surface whose stored fields
change gets its row updated in the same commit.
