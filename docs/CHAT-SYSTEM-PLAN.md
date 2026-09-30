# Chat, private messaging and friends — implementation plan

**Status: living spec. Phase A (display names + account handles) is
implemented as of 2026-09-30 (migration `0013_names.sql`,
`src/server/display-name.ts`, `src/config/names.config.ts`,
`POST/GET /api/profile/name`, `GET /api/players?handle=`, handle claim via
`/api/games/account` `action: "set-handle"`); phases B–E are design only —
none of them is deployed.**
Written 2026-09-30 (America/Toronto) from an audit of commit `48865d8`.

This plan is authorised by an explicit owner decision that overrides the
earlier "no chat history" position recorded in
[`PLAYER-MULTIPLAYER-DECISIONS.md`](./PLAYER-MULTIPLAYER-DECISIONS.md). The
permission to collect and retain chat, to log messages for administrators, and
to attribute activity is recorded in
[`DATA-COLLECTION-POLICY.md`](./DATA-COLLECTION-POLICY.md); the dependency and
infrastructure latitude this plan assumes is recorded in
[`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md). Read those two first — they
are the rules this plan is allowed to spend.

## 1. Scope

| # | Feature | Surface | Persistence | Phase |
| --- | --- | --- | --- | --- |
| 1 | Display names for registered accounts and guests | Rooms, chat, DMs, Paint | Account: permanent. Guest: session-scoped | A |
| 2 | Room chat | `/games/` private rooms | **Ephemeral: lives and dies with the room (≤2 h), survives reconnects** | B |
| 3 | Moderation tooling + admin-visible chat | `/admin` | Room-lifetime; reports bounded by the shared retention sweep | C |
| 4 | Live private messaging, account↔account, with images | New `/messages/` | Bounded retention window (default 30 days), not permanent | D |
| 5 | Friends system | New `/friends/` | Permanent while both accounts exist; cascades on deletion | E |
| 6 | Presence + unread notifications | Header badge | Ephemeral | E |

Out of scope, deliberately: group conversations (>2 people), voice/video,
email or push notifications, message editing, and **end-to-end encryption**
(§12.6 explains why E2E and admin-visible chat cannot both be true).

## 2. What exists today and what this plan reuses

| Existing asset | File(s) | Reused for |
| --- | --- | --- |
| One identity seam: guest session + registered player | `src/server/player-context.ts`, `src/server/player-store.ts` | Every phase; **the only** identity resolver, unchanged |
| Account display names | `game_players.display_name` (1–48 chars), `migrations/0012` | Phase A source of truth for registered users |
| Room DO with hibernating sockets, membership, host handoff, alarm teardown | `src/server/game-room-do.ts` | Phase B chat transport; Phase C moderation |
| Room gateway that strips client-forged principals | `src/server/game-room-gateway.ts`, `api/games/rooms/[roomCode]/ws.ts` | All chat upgrades |
| Fail-closed game-state authority | `src/server/room-authority.ts` | Untouched — chat must not touch it (§5.3) |
| Board moderation pattern: report → count → admin triage | `api/board/report.ts`, `migrations/0004`, `/admin` | Phase C |
| Admin guard + dashboard | `src/server/admin.ts`, `src/pages/admin/index.astro`, `src/scripts/admin-dashboard.ts` | Phase C panels |
| Hourly retention sweep | `src/server/tracking-retention.ts` (Cron `0 * * * *`) | Phase C/D retention |
| KV rate limiter | `src/server/ratelimit.ts` | Friend requests / uploads **only** — never per chat message (§11) |
| Client modules (no framework) | `src/scripts/game-room-ui.ts`, `board.ts`, `boot.ts` | Phase B/D UI, same patterns |

## 3. Decisions required before implementation

Recommendations are stated so work can proceed; each is cheap to change later
except the ones marked **hard to reverse**.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Room chat storage | DO SQLite only / mirror to D1 / D1 only | **DO SQLite only.** Cheapest, already bounded by room expiry, no D1 write pressure |
| D2 | Room chat cap | 100 / 200 / unlimited | **200 messages/room**, config value |
| D3 | Guest name storage | Cookie only / D1 keyed by session digest | **D1 `guest_profiles`, keyed by `sha256(session id)`** — survives reloads, no raw session ID stored |
| D4 | DM transport | Per-conversation DO / per-player inbox DO / polling | **Per-conversation DO** (≤2 members), mirroring `GameRoom`; polling as a degrade path |
| D5 | DM persistence | DO SQLite / D1 / none | **D1 `dm_messages`** with a retention window; D1 is the durable record, the DO is only live fanout |
| D6 | DM images | R2 / D1 base64 / none | **R2 if a Free-account binding is confirmed**, else D1 base64 (board precedent, ≤1.4 MB). Verify R2 binding availability first — sources conflict and enabling R2 needs a payment method |
| D7 | Who may DM whom | Anyone / friends only / message requests | **Friends only**, with one "message request" from a non-friend as a follow-up if the phase overruns |
| D8 | Friend discovery | Handle search / invite links / both | **Unique handle, exact-match search** + invite link. No directory, no suggestions |
| D9 | Presence | Global DO hub / per-conversation only / none | **One `Presence` DO (`idFromName('global')`)**, friends-only visibility, hibernating sockets |
| D10 | Admin visibility into DMs | metadata only / on report / full content | **On report by default, full logging available as a config value** — see §8.3 and Q3. Whichever is set must be disclosed in the UI |
| D11 | Notifications | In-app only / + push / + email | **In-app only.** Push needs a service worker and VAPID secrets; email needs a provider and a data register entry |
| D12 | Message deletion | none / for-me / for-everyone | **Delete-for-me + retention purge.** Delete-for-everyone is deferred (§9.4) |
| D13 | Images in room chat | yes / no | **No in v1.** Rooms stay text-only; revisit after DM images prove the pipeline |
| D14 | Room transcripts | none / opt-in per room | **None by default.** Optional admin "keep transcript" in Phase C, disclosed in-room before it is enabled |

## 4. Phase A — names (prerequisite for everything)

**Registered users** already have `game_players.display_name`. Add:

- `handle` — unique, public, `[a-z0-9_]{3,20}`, immutable for 30 days after a
  change, used for friend requests. Add to `game_players` in a new migration.
- Nothing else changes: recovery codes, sessions, export and deletion keep
  their current contract, extended to cover the new tables (§9.5).

**Guests** get a session-scoped name they can set from the rooms panel:

- New D1 table `guest_profiles(session_hash TEXT PRIMARY KEY, display_name TEXT
  NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`, where
  `session_hash = sha256(bnji_ps session id)`. The raw session ID is never
  stored — the same rule the existing stores follow.
- Guest names expire with the guest session's retention; they are not accounts
  and cannot be friend-requested.

**Shared sanitizer** — one module, `src/server/display-name.ts`, used by the
room upgrade route, the name-setting endpoint, and (later) DM headers:

- NFKC normalise; strip control characters and Unicode format characters
  (`\p{Cf}`, which includes bidi overrides such as U+202E); collapse runs of
  whitespace; trim.
- 1–24 code points (counted with `[...value].length`, not UTF-16 units).
- Allowed: letters, marks, numbers, space, `_ - . ` — nothing else.
- Reserved: `admin`, `moderator`, `bnji`, `system`, and their case-folded
  variants, to make staff impersonation harder.
- Display names are **labels, not identity**. UI shows a small account badge
  for registered users and a "guest" badge otherwise; nobody's permissions ever
  key off a name.

## 5. Phase B — room chat (ephemeral, reconnect-persistent)

### 5.1 Behaviour

- A member of a room opens the chat panel and sends plain text.
- Messages are visible to every connected member in real time.
- A member who reloads or disconnects **and reconnects while the room is alive**
  receives the recent history (up to D2's cap).
- When the room expires (≤2 hours, existing `alarm()`), the chat is deleted
  with it. Nothing about the conversation outlives the room.

### 5.2 Transport

Additive to protocol v1 in `src/server/game-room-protocol.ts`:

```ts
// client → server
{ v: 1, type: 'chat', text: string }
// server → client
{ v: 1, type: 'chat', n: number, label: string, text: string, at: number }
{ v: 1, type: 'chat_history', messages: RoomChatFrame[], more: boolean }
{ v: 1, type: 'chat_rejected', error: string, retryAfterMs?: number }
```

- `n` is a per-room monotone sequence number and the client's dedupe key.
- `label` is the sanitized display name — self-asserted, never an authorization
  input.
- `chat_history` is sent after the existing `snapshot`, **chunked** (25 per
  frame). Note the client currently drops any inbound frame over 4,096
  characters (`src/scripts/game-rooms.ts`); the guard must become a named
  constant and the chunk size must respect it.
- Soft failures (`rate limit`, `muted`, `chat_disabled`) return `chat_rejected`
  and never close the socket. Only genuine protocol violations close, as today.

### 5.3 Separation from game state

Chat is **not** room state. It must not advance `revision`, must not be stored
in `game_room.state_json`, and must never call
`authorizeRoomStateTransition()`. The authority seam stays fail-closed for game
rules; chat is a transport feature with its own validation. A test must assert
that a chat message leaves `revision` unchanged.

### 5.4 Rate limiting

The current per-connection check (1 msg/s, evaluated before parsing, closes the
socket with `1013`) cannot be shared with chat — a normal typing burst would
kill the connection. New shape:

1. **Global abuse ceiling** (pre-parse, byte-bounded): raise to 8 msg/s,
   close on breach. Still cheap, still first.
2. **Per-member chat budget**: token bucket in the socket attachment (burst 5,
   refill ~1 per 4 s ≈ 15/min sustained). Attachments survive hibernation, so
   this costs zero storage reads.
3. **Storage cap**: 200 rows/room, trimmed on insert.

Zero KV writes. On Workers Free, KV allows 1,000 writes/day account-wide and
room create/join already spend some of it.

### 5.5 Moderation inside the room

- **Host controls**: remove a message (visible as "message removed"), kick a
  member (existing membership delete path), mute a member for the room's
  remaining lifetime (attachment flag).
- **Self-service**: delete own message (removes text, leaves a tombstone until
  room expiry so sequence numbers stay stable).
- Every moderation action by the host is recorded in the room's own DO table
  and is visible to admins (§7).

## 6. Phase C — moderation tooling and admin-visible chat

### 6.1 The room registry

Admins cannot inspect a Durable Object without knowing its name (the room
code). Add a D1 registry written at room creation:

```sql
CREATE TABLE IF NOT EXISTS room_registry (
  code        TEXT PRIMARY KEY,      -- the room code (unguessable, ≤2 h lifetime)
  game_id     TEXT NOT NULL,
  owner_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL        -- swept after expiry
);
```

**Trade-off, stated plainly:** storing the code in D1 means a D1 compromise
exposes joinable rooms. Rooms are 2-hour, 8-seat, code-protected spaces, so the
exposure window is small — but it is a real change from "the code exists only
in the URL", and it is the price of admin-visible rooms. The alternative (no
registry, DO pushes flagged content to D1) makes ordinary moderation
impossible, so the registry is recommended.

### 6.2 Admin surfaces (`/admin` → new **Chat** tab)

| Panel | Reads | Actions |
| --- | --- | --- |
| Active rooms | `room_registry` (unexpired only) | open a room's live chat, close a room |
| Room transcript | DO `/admin/read` via the service binding | delete a message, ban the principal for a period |
| Reports queue | `chat_reports` (new) | resolve/dismiss, escalate to a principal ban |
| Moderation log | `chat_moderation_log` (new) | audit only |

All admin routes: existing `isAdminRequest` guard, `cache-control: no-store`,
no internal IDs in any public response.

The DO read endpoint is **service-authenticated**: only the Worker route may
call it, and the DO verifies a header derived from a Worker secret, never a
client-supplied value — same pattern as `x-bnji-verified-principal`.

### 6.3 Server-side content filter

Optional and config-driven (`src/config/chat.config.ts`): a small blocklist and
a URL/link stripper for display. It is a triage aid, not a guarantee, and the
docs must say so — the existing repo voice is careful about not overclaiming,
and a filter is exactly the kind of thing that gets overclaimed.

### 6.4 Reports

Mirror the board's proven flow: `POST /api/chat/report` with the room code and
sequence number; the DO snapshots the message (text, label, author member ID)
into D1 `chat_reports` at report time, so moderation evidence survives the
room's expiry. Distinct-report counting per principal prevents one reporter
from inflating a count, matching `0004_board_moderation.sql`.

## 7. Phase D — live private messaging (registered accounts)

### 7.1 Product

- `/messages/` lists conversations with unread counts; opening one connects a
  hibernating WebSocket for live delivery.
- Messages persist in D1 for the retention window (default 30 days), so an
  offline recipient sees them on next sign-in; "session-based" in the sense
  that nothing is promised forever, not that history vanishes when a tab
  closes.
- Images: attach one image per message (D6), size- and type-bounded.
- Read receipts: a single `read_at` watermark per conversation, not per
  message.

### 7.2 Conversation identity

`dm_conversations` keyed by a deterministic id over the **sorted pair** of
player IDs: `sha256([a, b].sort().join(':'))`. This makes "the conversation
between A and B" a single row no matter who initiates, and the DO name derives
from the same digest, so no lookup race can create duplicates.

### 7.3 Delivery and fanout

1. `POST /api/dm/messages` validates membership, friendship and rate limit, then
   writes the row to D1 (the durable record).
2. The route forwards to `DMConversation` DO `idFromName(conversationId)`, which
   broadcasts to any connected sockets.
3. A client that was offline reconnects and pulls everything after its last
   seen sequence; the DO only ever carries live frames, never history — the
   same split that keeps room chat cheap and DMs durable.

### 7.4 Images

Pipeline, deliberately dependency-light:

1. **Client normalisation**: draw to `<canvas>`, bound the longest edge (config,
   e.g. 1600 px), export as WebP/JPEG. This strips EXIF (including GPS) before
   the bytes ever leave the browser — the single highest-value privacy step and
   it costs no server CPU.
2. **Server validation**: magic-byte sniffing (not the declared MIME type),
   decoded size ≤ 2 MB, allowed set `image/png|jpeg|webp`. **No SVG** — it is a
   script vector.
3. **Storage** (D6): R2 object keyed by attachment id if available; else D1
   base64 in `dm_attachments` (≤1.4 MB decoded, the board's documented ceiling
   under D1's 2 MB row limit).
4. **Serving**: authenticated route that checks conversation membership; sets
   the exact content type, `X-Content-Type-Options: nosniff`, and never
   executes client-provided markup.

The 10 ms CPU budget on Workers Free is the reason all decoding happens in the
browser rather than in a Worker-side image library.

### 7.5 Rate limits and abuse

- Per-account send budget in D1 counters or DO state (KV is avoided).
- Image uploads additionally limited per hour per account.
- Blocked accounts cannot send, cannot open conversations, and their existing
  conversations are hidden, not deleted.

## 8. Phase E — friends, presence, notifications

### 8.1 Schema

```sql
CREATE TABLE IF NOT EXISTS player_friends (
  player_a TEXT NOT NULL, player_b TEXT NOT NULL,   -- canonical: a < b
  state    TEXT NOT NULL CHECK (state IN ('pending','accepted','declined')),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_a, player_b)
);
CREATE TABLE IF NOT EXISTS player_blocks (
  blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
```

- Requests by handle; mutual pending requests auto-accept.
- Caps: 500 friends, 100 pending outgoing, and rate limits on requests.
- Block wins over everything: it removes the friendship, cancels pending
  requests and prevents new ones.
- Friend lists are **private to the account**; presence is visible only to
  accepted friends. A public friend list would leak the social graph and
  requires a decision under the data policy first.

### 8.2 Presence

One hibernating `Presence` DO (`idFromName('global')`) receives a socket per
signed-in browser and answers "which friends are online". At this site's scale
that is a single small object; no polling and no heartbeat writes. If it ever
grows, it splits by player-ID prefix without changing the client contract.

### 8.3 Notifications

In-app only (D11): a header badge for unread messages and pending friend
requests. Push and email are explicitly deferred — each is a new secret, a new
processor and a new data-register entry.

## 9. Data model summary (planned)

### 9.1 D1 (`BOARD_DB`)

| Table | Phase | Retention | Notes |
| --- | --- | --- | --- |
| `guest_profiles` | A | guest-session lifetime | keyed by session **digest** |
| `player_handles` (or a column on `game_players`) | A | account lifetime | unique, exact-match search |
| `room_registry` | C | 2 h + sweep | enables admin inspection (§6.1) |
| `chat_reports` | C | shared retention sweep | content snapshot at report time |
| `chat_moderation_log` | C | shared retention sweep | admin audit trail |
| `dm_conversations` | D | account lifetime | canonical pair digest |
| `dm_messages` | D | **default 30 days**, config | body text, sender, sequence, read watermark |
| `dm_attachments` | D | with its message | fallback store if R2 is unavailable |
| `player_friends` / `player_blocks` | E | account lifetime | cascade on account deletion |
| `room_chat_archive` (only if D14 is enabled) | C+ | configurable | opt-in per room, disclosed in-room |

### 9.2 Durable Objects

| Class | Phase | Keyed by | Storage |
| --- | --- | --- | --- |
| `GameRoom` (exists) | B, C | room code | new `game_room_chat` table + moderation columns |
| `DMConversation` (new) | D | conversation digest | none required (D1 is durable); sockets only |
| `Presence` (new) | E | `'global'` | attachments only |

New DO classes and the R2 binding require `wrangler.json` edits and a DO class
migration — permitted under `DEPENDENCY-POLICY.md` §6 and
`AGENTS.md` §1.2, each in its own reviewed commit with `docs/DEPLOY.md` updated.

### 9.3 Retention and deletion

- Every new table gets a value in `src/config/` and an entry in the
  `docs/DATA.md` register before it ships (required by
  `DATA-COLLECTION-POLICY.md` §1).
- Expired rooms are swept by the existing hourly Cron; `room_registry` and
  `chat_reports` join that sweep.
- `dm_messages` older than the retention window are purged by the same sweep.
- Account deletion extends the existing cascade: conversations, messages,
  attachments, friendships and blocks.

### 9.4 Deferred on purpose

Message editing, delete-for-everyone, conversation archiving/export, group
chats, and link previews (a link preview fetches a URL the sender chose —
that is a server-side request forgery and privacy surface, not a convenience).

### 9.5 What this means for account export/deletion

Both already exist (`/api/games/account`, `/api/games/account/export`). They
must be extended in the phase that adds each table, not afterwards — an export
that silently omits the user's messages is a correctness bug under
`DATA-COLLECTION-POLICY.md`.

## 10. Planned API surface

| Route | Phase | Auth |
| --- | --- | --- |
| `POST /api/profile/name` | A | player-context (guest or account) |
| `GET/POST /api/chat/messages` (or WS frames on the existing room socket) | B | room membership |
| `POST /api/chat/report` | C | room membership |
| `GET /api/admin/chat/rooms`, `GET /api/admin/chat/room`, `POST /api/admin/chat/action` | C | admin guard |
| `GET /api/dm/conversations` | D | account |
| `POST /api/dm/messages` | D | account + friendship |
| `POST /api/dm/attachments` | D | account + friendship |
| `GET /api/dm/media/:id` | D | account + conversation membership |
| `GET/POST/DELETE /api/friends` | E | account |
| `GET /api/presence` (WS) | E | account |

Every route: `prerender = false`, same-origin check on mutations, bounded body
reads (`readBodyTextBounded`), explicit error vocabulary, `no-store` on
anything private.

## 11. Quota and cost model (Workers Free today)

| Budget | Effect | Notes |
| --- | --- | --- |
| **KV writes (1,000/day)** | **Zero new spend** | Chat, DMs, presence and friend requests must never touch KV. Room create/join continue to use the existing limiter |
| Worker requests (100k/day) | Modest | Message POSTs, media reads, admin reads. WS frames do not bill as Worker requests |
| DO requests (100k/day) | Modest | 20:1 accounting for inbound WS messages; hibernation keeps idle sockets free |
| **DO SQLite writes (100k/day)** | **Room chat's constraint** | 200-row cap, trimmed on insert; per-member budget (~15/min) × 8 members = worst case ~14,400 rows for a saturated 2-hour room |
| **D1 writes (100k/day, shared)** | **DM's constraint** | 1 row/message + reads. Personal scale is comfortable; a busy day of rooms + DMs + existing tracking is what the shared 100k cap has to absorb |
| D1 reads (5M/day) | Fine at personal scale | Conversation lists and history pages are indexed and paginated |
| R2 (if adopted) | Free tier exists (10 GB-month, 1M Class A, 10M Class B, free egress) | Verify Free-account binding availability and the payment-method requirement before committing (D6) |
| Paid Workers ($5/mo) | Optional | Only if a limit is actually reached; a budget decision, not a design requirement |

Everything above is shared account-wide with the board, profiles and Games
telemetry. The plan's job is to keep chat from being the feature that silently
consumes the headroom; the numbers to watch are **D1 rows written** and **DO
SQLite rows written** in the dashboards.

## 12. Security, abuse and privacy

### 12.1 Rendering

Plain text only, rendered with `textContent`, exactly like the board
(`src/scripts/board.ts`). No HTML, no auto-linked URLs, no embeds, no
markdown. Room and DM images are the only binary content, and only in Phase D.

### 12.2 Input

Shared sanitizer (§4) for names; NFKC + `\p{Cf}` stripping for message text as
well; code-point length caps; per-message byte caps at the protocol layer.

### 12.3 Identity

Display names are self-asserted labels. Authorisation always keys off
`principalHash` / player ID. The UI distinguishes account and guest visually so
a name cannot be mistaken for verification.

### 12.4 Abuse

Token buckets in DO attachments (rooms), D1-backed counters (DMs, friends),
block lists, host kick/mute, admin bans, report flow with evidence snapshot,
and upload rate limits. Report-driven moderation is what makes an
admin-visible system worth having.

### 12.5 Images

Magic-byte validation, size caps, allowlisted formats, no SVG, client-side EXIF
stripping, authenticated serving with `nosniff`. Illegal-content handling is a
process, not a filter: a report path, a block/ban path, and a written owner
response policy — required before image messaging ships
(`DATA-COLLECTION-POLICY.md` §7).

### 12.6 No end-to-end encryption, and the UI must not imply it

Admin-visible chat and E2E encryption are mutually exclusive. This plan chooses
admin visibility because that is the owner's decision, which means the product
may not market itself as "private" or "encrypted". The DM UI should state
plainly what is stored and who can read it; if E2E is ever wanted, it replaces
Phase C's DM-visibility model and needs its own decision record.

### 12.7 Data policy compliance

Every phase lands with: a `docs/DATA.md` register entry, a config value for
retention, a `/privacy/` page line, and an extension of account export and
deletion. That is the checklist `DATA-COLLECTION-POLICY.md` §1 requires.

## 13. Testing strategy

The repo's `node:test` suite (273 tests passing, verified 2026-09-30) covers
routes and pure logic well, but `src/server/game-room-do.ts` is currently
**untestable**: the test harness stubs `cloudflare:workers` with `env` only, so
importing the DO fails with *"does not provide an export named 'DurableObject'"*
(verified). Every phase in this plan adds DO logic, so the harness is a
prerequisite, not a nice-to-have.

Two options (both now permitted):

| Option | Cost | Buys |
| --- | --- | --- |
| Extend `tests/support/` with a fake DO state + socket (~100 lines) | Zero dependencies | Logic-level tests, one test runner |
| Adopt `vitest` + `@cloudflare/vitest-pool-workers` (Tier A) | A second runner | **Platform-faithful** tests: real hibernation, real `getWebSockets()`, real DO SQLite and D1 |

Recommendation: adopt the pool-workers route, because hibernation semantics are
exactly where a hand-rolled fake diverges from production.

Test matrix to write per phase: protocol parsing (chat frames, names,
attachments), rate-bucket behaviour, membership/authorisation, reconnect
history, expiry deletion, revocation at room close, admin route guards, export
and deletion coverage, and cross-account authorisation for DMs (a stranger must
not read a conversation). End-to-end two-browser-context tests belong in
`tests/e2e/`, which cannot run in this sandbox (no Chromium binary) — run them
locally before any deploy.

## 14. Effort, order and rollback

| Phase | Work | Estimate |
| --- | --- | --- |
| A — names + sanitizer + handle | 1 migration, 1 module, 1 endpoint, tests | 1–1.5 days |
| Test harness (prerequisite) | Stub or pool-workers adoption | 0.5–1 day |
| B — room chat | Protocol, DO, client panel, a11y, tests | 2–3 days |
| C — moderation + admin | Registry, DO read endpoint, reports, admin tab, tests | 2–3 days |
| D — private messaging | Conversations, messages, images, media route, UI, tests | 4–6 days |
| E — friends + presence + badge | Schema, APIs, `/friends/`, presence DO, UI, tests | 3–4 days |
| Cross-cutting | DATA.md register, `/privacy/`, export/deletion, deploy docs | 1–1.5 days |
| **Total** | | **≈ 14–19 focused days** |

Order: harness → A → B → C → D → E. Phase C is deliberately before D: doing
moderation for rooms first proves the admin pattern on a 2-hour, semi-public
surface before applying it to private conversations.

Rollback: each phase is config-gated (`chat.config.ts`, `dm.config.ts`,
`friends.config.ts` with `enabled: false` switches) so a misbehaving feature
can be turned off in a deploy without touching the others or the room state
path. Images (Phase D) can be disabled independently of text messaging.

## 15. Open questions for the owner

1. **Admins and DM content (D10).** Metadata + on-report snapshots (recommended)
   or full content logging from day one? If full logging is chosen, the DM
   composer needs a visible line saying so — otherwise the first friend who
   finds out will be right to be annoyed.
2. **Retention window for DMs.** 30 days recommended; 7 days if you want
   "live-ish", 90 if history matters more than storage.
3. **R2 vs D1 for images (D6).** R2 is the better long-term store, but enabling
   it needs a payment method on file and its Free-account binding availability
   must be confirmed in the dashboard. D1 base64 is proven here and free, with
   a ~1.4 MB ceiling.
4. **Guest names (D3).** Session-scoped in D1 as planned, or cookie-only if you
   want guests to be completely absent from the database.
5. **Handles (D8).** One global handle per account is simple and enables friend
   search; it is also the first permanently public identifier the site has.
   Confirm that is acceptable versus invite-links-only.
6. **Paint attribution (§6 of the data policy).** Which extensions do you
   actually want — account attribution, action detail, or full replay? They are
   very different storage and privacy propositions and should be decided
   before that work is scheduled.

## 16. What this plan does not do

- It does not write any code, migration, config or binding.
- It does not change the room protocol, the room DO, the admin panel or the
  data model by itself.
- It does not claim the features exist. Until each phase lands, the public docs
  describe them as planned, and `README.md` keeps saying so.
