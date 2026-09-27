# BNJI.NET — data documentation: the Message Board

What the message board actually stores, where, for how long, and what a future
moderation flow would touch. Everything here describes the code as it exists —
sources of truth are `migrations/0001_board_messages.sql`,
`src/server/board-store.ts`, `src/pages/api/board.ts`, `src/server/ratelimit.ts`
and `src/config/board.config.ts`. Configuration (limits, providers, windows) is
documented separately in [`CONFIGURATION.md`](./CONFIGURATION.md) §5.

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

`src/server/ratelimit.ts` keeps **fixed-window counters in KV** — this is the
only abuse-prevention state, and the only place a visitor's IP address is
recorded anywhere.

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
- **Security telemetry stays separate.** It lives in `security_events` under its
  own 60-day retention and never contributes to any public or traffic figure.
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
- The only personal datum touched is the connecting IP, held transiently in KV
  rate-limit key names (§4) and never written to D1 or logs beyond Worker
  console warnings.
- **Credential material is stored as a hash, never as a secret.**
  `admin_credentials.token_hash` is a SHA-256 digest — there is no code path
  that reads the access token back, by design. The HMAC key that signs admin
  sessions (`ACCESS_SECRET`) is a Worker secret, never in the database.
  Connection identifiers live in `wrangler.json` bindings and all other secrets
  in the Worker environment (`wrangler secret put`).
- Profile analytics (`profile_views`, `profile_reactions`,
  `profile_link_clicks`) are keyed by an **ephemeral random session cookie**
  (`bnji_ps`, `src/config/session.config.ts`), not by an identity. The
  `session_key` is discarded with the cookie and is not correlatable across
  sessions.

## 10. Shared Paint canvas

The Paint area below `/board/` is a separate shared feature: it does not read,
write, or modify `board_messages`. Its API is `/api/paint`; its state lives in
`board_paint_state`, created by `migrations/0006_board_paint.sql` in the same
`BOARD_DB` database.

### Storage and size bounds

- One singleton row stores the current PNG snapshot, revision number and update
  time. Each accepted publish replaces that one snapshot; the database does
  **not** accumulate every pointer event or an unbounded image history.
- The logical canvas is **1200 × 750 pixels** (900,000 pixels, 8:5 aspect
  ratio). CSS scales it to fit the page; Fullscreen enlarges the same surface,
  and Export PNG downloads that resolution.
- The API accepts only a PNG with those dimensions and caps the data URL at
  **850,000 characters** (the whole streamed JSON request is capped at 860,000
  bytes). Oversized drawings stay local and receive a clear error rather than
  attempting a D1 write. Cloudflare D1's per-string/row ceiling is 2,000,000
  bytes, so this leaves substantial row headroom [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- `board_paint_commits` holds at most the most recent **128** publish request
  IDs. It makes retries safe if a response is lost, but does not retain artwork
  history or user identifiers.

### Shared editing and concurrency

The browser keeps strokes, erasing, shapes and text in a transparent local
layer over the last shared snapshot. The **Sync & refresh** button composes the
visible image and submits its base revision. If another visitor published
first, the server returns the newer snapshot; the browser places the local
layer over it and retries with the new revision. A conditional revision update
prevents two simultaneous publishers from silently replacing each other, and
D1's atomic `batch()` groups the snapshot update and retry record [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
Edits in the same pixels naturally resolve in publish order; the most recent
stroke in an overlapping area appears on top. A 20-second conditional poll
refreshes changed snapshots while the Paint section is visible; a manual Sync
& refresh also fetches the newest state when there are no local marks.

The server stores no strokes, accounts, IPs or browser metadata in D1. Public
publishes are rate limited to 30 per IP per hour using the board's existing KV
throttle; the transient IP key is subject to the same KV retention rules in §4.
Paint is currently available only when `BOARD_CONFIG.provider` is `d1`. If the
message board is switched to `rest`, the component explains that Paint is
unavailable, while `/api/paint` returns `503 paint_requires_d1_board`; it does
not write to D1 behind the REST-backed board or assume an undocumented Paint
contract on the external service. This explicit boundary prevents either mode
from silently losing visitors' work.
