# Chat, private messaging and friends — implementation plan

**Status: living spec. Phase A (display names + account handles) and Phase B
(room chat: delivery, history, rate limits, host moderation — DO tables,
`CHAT_CONFIG`, protocol, panel) are implemented as of 2026-09-30
(migration `0013_names.sql`, `src/server/display-name.ts`,
`src/config/names.config.ts`, `POST/GET /api/profile/name`,
`GET /api/players?handle=`, handle claim via `/api/games/account`
`action: "set-handle"`; Phase B in `src/server/game-room-protocol.ts`,
`src/server/game-room-do.ts`, `src/config/chat.config.ts`,
`tests/workerd/room-chat.spec.ts`); phases C–E are design only —
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
| 4 | Live private messaging, account↔account, with images | New `/messages/` | Bounded retention window (default 60 days, owner answer 2026-09-30), not permanent | D |
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
| D7 | Who may DM whom | Anyone / friends only / message requests | **Friends only**, with one "message request" from a non-friend as a follow-up if the phase overruns. **Resolved 2026-09-30 (flagged sequencing tension: the friends tables are Phase E) — Phase D ships open between any two registered accounts, rate-limited and handle-exact; Phase E flips the gate to friends-only and adds blocks**  — **E flipped the gate: open/send/attachments now answer 403 `not_friends` (or `blocked`), blocks remove the friendship so sends die for both sides** |
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

~~The current per-connection check (1 msg/s, evaluated before parsing, closes
the socket with `1013`) cannot be shared with chat — a normal typing burst would
kill the connection.~~ **Implemented in Phase B as follows:**

1. **Global abuse ceiling** (pre-parse, byte-bounded): raised to 8 msg/s
   (`CHAT_CONFIG.rate.globalPerSecond`), close on breach with `1013`. Still
   cheap, still first — checked before parsing, so junk floods cost one
   comparison.
2. **Per-member chat budget**: token bucket in the socket attachment (burst 5,
   refill ~1 per 4 s ≈ 15/min sustained). Attachments survive hibernation, so
   this costs zero storage reads; a *reconnect* gets a fresh bucket, which is
   the correct reset point (a new socket is a new connection).
3. **Storage cap**: 200 rows/room, trimmed on insert.

Zero KV writes. On Workers Free, KV allows 1,000 writes/day account-wide and
room create/join already spend some of it.

### 5.5 Moderation inside the room

- **Host controls**: remove a message (visible as "message removed"), kick a
  member (existing membership delete path), mute a member for the room's
  remaining lifetime. *(Phase B amendment: the mute flag lives in a
  `game_room_mutes` DO table keyed by hashed principal, not in the socket
  attachment — attachments die with the socket, so an attachment flag would
  reset on every reconnect. The table is deleted with the room.)*
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

> **Owner-approved (2026-09-30):** the site is personal-use only; small gaps
> of exactly this kind are acceptable. The registry trade-off above is
> accepted as the price of admin-visible rooms — documented, not a blocker.

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

**Implemented in Phase C (deviations recorded, not silent):**

- Service token = `sha256("bnji-room-admin:v1:" + ACCESS_SECRET)` in header
  `x-bnji-room-admin`; the DO fails closed (403 `service_unauthorized`) with no
  secret, and the gateway answers 503 `admin_service_unconfigured` so a missing
  secret is loudly visible rather than silently broken.
- The transcript panel gained **Kick** (disconnect without a ban) and the queue
  gained an **Active bans** panel backed by a new `chat_bans` table — the plan
  listed ban creation in §6.2/§6.4 but no ban *store* or unban path (gap
  filled; see §9.1).
- `close_room` also deletes the room's registry row (404-tolerant), so a
  closed room never lingers in the Active rooms list.
- Escalate = ban the reported message's author for
  `moderation.defaultBanMinutes` (max `moderation.maxBanMinutes`); every
  successful action writes `chat_moderation_log`.
- Routes live on the Astro pages API (`src/pages/api/admin/chat/*`), not the
  worker `index.ts` — the admin auth helpers (`isAdminRequest`, D1, session
  cookies) all exist there; `roomServiceFetch` reaches the DO the same way
  (`/admin/read`, `/admin/action`).

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

**Implemented in Phase C:** snapshots carry `author_hash` (sha256 of the
principal, not the member ID — the member ID is room-scoped and useless for
account export/deletion) plus label, text and message time; distinct reporters
live in `chat_reporters` (PK `room_code + message_n + reporter_hash`). The
HTTP layer mirrors the board's pattern (`senders` analogue): the report route
uses D1 counter `reserveAuthAttempt` with prefix `bnji-chat-report:` (10 per
10 minutes per hashed IP — never KV, per the standing no-KV rule), a
same-origin check, and explicit errors: `not_member` (403), `message_not_found`
(404), `room_expired` (410), `rate_limited` (429), `room_service_unavailable`
(503).

## 7. Phase D — live private messaging (registered accounts)

### 7.1 Product

- `/messages/` lists conversations with unread counts; opening one connects a
  hibernating WebSocket for live delivery.
- Messages persist in D1 for the retention window (default 60 days — owner answer 2026-09-30), so an
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

> **Prepared for groups (owner decision 2026-09-30, not scheduled):** group
> conversations will require this identity and the ≤2-member assumption in D4
> to be redesigned first — see the owner addition in §9.4.

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
- **Phase D interim (owner answer 2026-09-30):** with friends/blocks still in
  Phase E, the enforcement that ships in D is the Phase C `chat_bans` row — a
  banned principal gets `403 chat_banned` on every DM route. `player_blocks`
  and conversation hiding arrive with Phase E, which also flips D7 to
  friends-only.

## 8. Phase E — friends, presence, notifications

Phase E is implemented as of 2026-10-01: `migrations/0016_friends.sql`,
`/friends/` + `GET/POST/DELETE /api/friends`, the `Presence` DO behind
`GET /api/presence`, the in-app badge via `GET /api/notifications`, and the
D7 friends-only gate on DM open/send/attachments — with tests at the node,
workerd and (locally-run) Playwright tiers.

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
| `chat_reports` | C | shared retention sweep (≤`trackingRetentionDays`) | content snapshot at report time (`author_hash` = sha256(principal)); UNIQUE `(room_code, message_n)` |
| `chat_reporters` | C | with its report | PK `(room_code, message_n, reporter_hash)` — distinct-report counting |
| `chat_bans` | C | until `expires_at` (≤`moderation.maxBanMinutes`) or manual unban; expired rows swept | principal hash + reason; blocks `/ws` join (403 `chat_banned`) |
| `chat_moderation_log` | C | shared retention sweep | admin audit trail (action, hashes, detail — unlinkable to accounts) |
| `dm_conversations` | D | account lifetime | canonical pair digest |
| `dm_messages` | D | **default 60 days** (owner answer 2026-09-30), config | body text, sender, sequence, read watermark |
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

**Phase C resolution (2026-09-30):** the export now includes a
`chatModeration` section — `reportsOnYourMessages` (snapshots where your
message was reported), `reportsYouFiled`, and `ban` — and account deletion
sweeps every Phase C row keyed to the principal (`chat_reports.author_hash`,
`chat_reporters.reporter_hash`, `chat_bans`, `room_registry.owner_hash`) inside
its existing atomic batch. `chat_moderation_log` is deliberately kept: its rows
are hashed-principal audit entries with no account link, same treatment as the
board's moderator notes. Live room text still cannot be exported (room-keyed,
≤2 h) — the `roomChat: { included: false, reason }` section stands, with its
comment updated now that the registry exists.

**Owner addition (2026-09-30, not scheduled):** the owner wants **group
conversations (group chats)** added to this plan. They stay deferred until the
owner schedules them; when they are, Phase D is the phase to adapt — §7.2's
pair-digest conversation identity and D4's per-conversation DO both assume
exactly two members and must generalize (multi-member identity, roster/fanout,
per-group membership and moderation) *before* any D code lands. Do not start
that work until it is scheduled.

### 9.5 What this means for account export/deletion

Both already exist (`/api/games/account`, `/api/games/account/export`). They
must be extended in the phase that adds each table, not afterwards — an export
that silently omits the user's messages is a correctness bug under
`DATA-COLLECTION-POLICY.md`.

**Phase B note (2026-09-30, flagged tension):** `game_room_chat` and
`game_room_chat_log` are the first tables added by a phase that *cannot* be
gathered into the account export: they live inside ephemeral per-room DOs,
are keyed to rooms rather than accounts (the only link is a hashed principal),
and there is no room index until Phase C's `room_registry`. Because chat also
cannot outlive its room (≤2 h — far shorter than any export/deletion
round-trip), Phase B's export ships an explicit `roomChat: { included:
false, reason }` section so the omission is declared, never silent, and
account deletion needs no chat cascade (nothing account-linked survives the
room). When `room_registry` exists, revisit whether deletion should sweep
still-live rooms for the deleted account's hashed principal; exporting full
room-chat history would additionally need a principal index across live rooms
and is an owner decision if ever wanted.

## 10. Planned API surface

| Route | Phase | Auth |
| --- | --- | --- |
| `POST /api/profile/name` | A | player-context (guest or account) |
| `GET/POST /api/chat/messages` (or WS frames on the existing room socket) | B | room membership |
| `POST /api/chat/report` | C ✅ | room membership (DO snapshot → D1) |
| `GET /api/admin/chat/rooms`, `GET /api/admin/chat/room`, `POST /api/admin/chat/action` | C ✅ | admin guard (pages API → DO `/admin/*` service endpoints) |
| `GET /api/dm/conversations` | D ✅ | account |
| `POST /api/dm/conversations` (open by exact handle — the composer's entry, D8) | D ✅ | account + friendship (enforced since E) |
| `GET /api/dm/messages` (history pull: `after` catch-up / `before` scrollback / newest page — §7.3's reconnect) | D ✅ | account + conversation membership |
| `POST /api/dm/messages` | D ✅ | account + friendship (enforced since E per D7's resolved answer — 403 `not_friends`/`blocked`) |
| `POST /api/dm/attachments` | D ✅ | account + friendship (enforced since E) |
| `GET /api/dm/media/:id` | D ✅ | account + conversation membership |
| `GET /api/dm/ws` (live-frame socket upgrade) | D ✅ | account + conversation membership |
| `POST /api/dm/read` (read watermark, §7.1) | D ✅ | account + conversation membership |
| `POST /api/dm/hide` (delete-for-me, D12) | D ✅ | account + conversation membership |
| `POST /api/dm/report` (§12.5's report path — owner: gate filled inside D) | D ✅ | account, non-author member |
| `GET/POST/DELETE /api/friends` | E ✅ | account |
| `GET /api/presence` (WS) | E ✅ | account (route mints handle + accepted-friend handles; the DO re-validates shapes) |
| `GET /api/notifications` (in-app badge counts, §8.3) | E ✅ | account |

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

**Phase D resolution (2026-09-30, owner: fill the gate inside D):** all three
exist as of Phase D — `POST /api/dm/report` snapshots into `dm_reports`
(admin Chat tab, shared audit log), `chat_bans` is enforced on every DM route
(escalate action included), and the written response policy is drafted in
`DATA-COLLECTION-POLICY.md` §9 for the owner's review before deploy.

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

> **Status (2026-09-30):** the harness above was adopted —
> `@cloudflare/vitest-pool-workers` (Tier A) runs the DO suite
> (`tests/workerd/*.spec.ts`), and the intro paragraph predates it. Phase C's
> slice of the matrix: `tests/chat-moderation.test.ts` (D1 stores, §6.3
> helpers, report/admin route guards, export + deletion assertions) and
> `tests/workerd/room-moderation.spec.ts` (service auth 403/200, transcript
> read, delete/kick/close handoffs, `/report` membership + snapshot, blocklist
> rejection) — plus Report/admin-tombstone/blocked copy wiring in
> `tests/e2e/game-room-chat.spec.ts` (local Playwright run required before
> deploy).

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

All six questions are answered; the questions stay as the record of what was
asked, each with the owner's decision.

1. **Admins and DM content (D10).** — **Resolved 2026-09-30: plan default.**
   Metadata plus on-report snapshots; full-content logging stays off. (If that
   ever changes, the DM composer must say so at the point of use.)
2. **Retention window for DMs.** — **Resolved 2026-09-30: 60 days** (owner
   picked 60 over the 30-day recommendation; `docs/DATA.md` §11 updated).
3. **R2 vs D1 for images (D6).** — **Resolved 2026-09-30: try R2 only if it
   costs nothing.** Never enable billing or create a bucket without asking the
   owner first; D1 base64 (proven, free, ~1.4 MB ceiling) is the shipping path
   while R2 stays unavailable.
4. **Guest names (D3).** — **Resolved 2026-09-30: D1, session-scoped** as
   planned (`guest_profiles`, keyed by session digest) — shipped in Phase A.
5. **Handles (D8).** — **Resolved 2026-09-30: one global handle per account**,
   exact-match search — shipped in Phase A.
6. **Paint attribution (§6 of the data policy).** — **Resolved 2026-09-30:
   account/session attribution only**, plus the action detail the owner
   chooses; no full replay. (Data policy §2 records the wider permission the
   owner added: full IPs and stored sticker images are *allowed*, each needing
   its own register row before it ships.)

### Amendment 2026-10-01 — a kick is a lockout

Phase B shipped a host kick as a disconnect + membership delete. The owner's
open-lobby request ("…with the host able to kick them") made the gap
load-bearing: in a **listed** room a kicked player could walk straight back in,
which is a doorbell, not a kick. Amendment: the room DO keeps a
`game_room_kicks` table (hashed principal → kicked_at/member_id/label); a host or
admin kick writes it before deleting the seat, closes the socket `4003`, and the
`/ws` upgrade refuses a kicked principal with `403 room_kicked` until the room is
torn down (`teardown()` deletes the table with the rest of the room's state).
Nothing else in the moderation model moved: mutes still survive reconnects, bans
are still D1-scoped and outlive the room, and no kick data is written to D1.

## 16. What this plan does not do

- It does not write any code, migration, config or binding.
- It does not change the room protocol, the room DO, the admin panel or the
  data model by itself.
- It does not claim the features exist. Until each phase lands, the public docs
  describe them as planned, and `README.md` keeps saying so.
