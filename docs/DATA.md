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
| `image` | `image` | `TEXT` nullable | Optional attachment, stored **inline** as a `data:` URL. The route re-validates on every write: strict `data:image/(png\|jpeg\|webp\|gif);base64,…` regex, MIME allowlist, and ≤ `BOARD_CONFIG.maxImageBytes` (**400 KB decoded**, computed from base64 length). No remote URLs are ever stored. |
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
  `dm:hour:<ip>` (1 h, max 10).
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
   Invalid images are silently dropped from the post (the text still posts).
3. **Storage:** inline in `board_messages.image` (`TEXT`). No object storage,
   no thumbnails, no deduplication, no expiry — an image lives exactly as long
   as its message row (§3).
4. **Delivery:** inline again in every list/archive response that includes the
   message. Be aware of the arithmetic: one at-cap image is ≈ 533 KB of
   base64, so a 10-message page of image-heavy posts is ≈ 5 MB of JSON, and
   the archive walk multiplies that. If the board grows image traffic, moving
   attachments to object storage (e.g. R2) with a reference/thumbnail in the
   row is the first refactor to reach for.

## 7. Privacy summary

- Messages are **public by design**; posting requires no account and stores no
  identity.
- The only personal datum touched is the connecting IP, held transiently in KV
  rate-limit key names (§4) and never written to D1 or logs beyond Worker
  console warnings.
- No secrets, tokens or credentials are stored in the database; connection
  identifiers live in `wrangler.json` bindings and secrets in the Worker
  environment (`wrangler secret put`), per [`CONFIGURATION.md`](./CONFIGURATION.md).
