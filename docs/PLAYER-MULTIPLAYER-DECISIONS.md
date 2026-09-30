# Player identity, saves & rooms — design decision

**Decision recorded:** 2026-09-29 (America/Toronto), before implementation. This extends the existing Games catalog, shell, tracker, leaderboard and `player-context` seam; it does not create or copy a game. It is limited to Workers Free and existing Cloudflare services.

## Identity and recovery

Use a global opaque player ID and a high-entropy, user-held recovery code rather than email/password accounts, a third-party identity provider, or a new secret. Generate 20 random bytes (160 bits); show the encoded code once at account creation/rotation; persist only its SHA-256 digest. Because the input is uniformly random and 160-bit, a deliberately slow password KDF is not useful for this credential and would spend the 10 ms Free CPU budget. Apply persistent, per-IP authentication throttling in D1 as defense in depth. Issue separate random 256-bit opaque sessions in Secure, HttpOnly, SameSite cookies and persist only token digests with expiry/revocation. Resolve both identities only in `src/server/player-context.ts`: guest requests keep the existing `bnji_ps` session ID; authenticated requests additionally get the validated player ID. Never serialize either internal ID or credential/session material into public responses.

Account creation claims only eligible records for the current, validated guest session; it never accepts a player ID from the browser. This preserves the existing guest-to-player score/tracking path. A signed-in user can rotate the recovery code (invalidating old credentials and other sessions), revoke sessions/sign out, export their account data, or delete their account. There is no email-based or operator-assisted recovery: losing both the recovery code and every live session is unrecoverable, so the UI must say so plainly. Claiming local saves is a separate explicit sync action; browser-local state is not discarded by account creation/sign-out.

## Saves

Store versioned, game-agnostic JSON blobs in the existing D1 database. Contract: stable catalog game ID, bounded slot key, integer schema version, JSON data, monotonically increasing revision, and update time. Cap each serialized blob at 16 KiB and each player at 25 slots (≤400 KiB raw payload/account); reject non-catalog IDs and malformed/oversized structures. Provide a client migration registry/hook, but no game-specific migration or gameplay validation. Upserts use compare-and-swap (`expectedRevision`); a stale write returns `409` with current revision/data and never silently wins. Clients persist local copies and pending writes in IndexedDB, retry only transient/network failures with bounded backoff, and stop for explicit conflict/account action. Offer conflict choices rather than automatic overwrite. Authenticated export includes the save contract and blobs; account deletion removes identity-linked data.

## Multiplayer

Choose one SQLite-backed Durable Object per unguessable room code, using the already-custom `src/worker.ts` entrypoint and Astro's Cloudflare handler. The Worker validates the browser's player context at HTTP/WebSocket upgrade and passes a server-derived principal to the private DO binding; the DO never trusts a client-supplied member ID. Use the recommended hibernation WebSocket API, maximum 8 concurrent members, a 4 KiB UTF-8 message bound, a small schema/versioned protocol, a per-connection message ceiling, CAS versions for shared opaque state, a short reconnect grace, and a hard room expiry. Persist only bounded room metadata/state and bounded room chat (see the amendment below). Invalid versions return a conflict snapshot, reconnect resumes only an unexpired room, and expired/full rooms fail explicitly. The server validates envelopes, size, membership and version only: it does **not** validate scores, turns, moves, game rules or client-supplied game state. A future game must supply its own authority/verifier.

> **Amendment — 2026-09-30 (owner decision).** The original decision above
> persisted "no chat history". That is superseded. Room chat is now permitted
> (implemented in chat plan Phase B, 2026-09-30), stored inside the same Durable Object, deleted with the room,
> surviving reconnects for the room's lifetime. Chat does not travel through
> the game-state envelope and never consults `room-authority.ts`; it is a
> transport feature with its own validation, rate budget and admin-visible
> moderation path. The collection rules live in
> [`DATA-COLLECTION-POLICY.md`](./DATA-COLLECTION-POLICY.md), and the phased
> design — room chat, moderation tooling, admin visibility, guest and account
> names, private messaging with images, and friends — is specified in
> [`CHAT-SYSTEM-PLAN.md`](./CHAT-SYSTEM-PLAN.md). Phases A (names) and B (room
> chat) are implemented; Phase C (moderation below) shipped the same day.
>
> **Phase C delivered (2026-09-30):** admin-visible moderation shipped — D1
> `room_registry` (owner-approved §6.1 trade: the site is personal-use only,
> the joinable-code exposure is accepted and documented), reported-message
> snapshots that outlive the room, distinct-reporter counting, an Active bans
> store with expiry (`chat_bans` — the plan's missing ban-store gap), a
> moderation audit log, the `/admin` **Chat** tab (service-authenticated
> transcript read with URL stripping; delete/ban/kick/close; report
> resolve/dismiss/escalate), the §6.3 blocklist/URL-strip config (triage aid,
> empty by default), the member-facing Report button with a D1 rate limit
> (never KV), and the account export/deletion extension (`chatModeration`
> section + keyed-row sweep). Service auth: `sha256('bnji-room-admin:v1:' +
> ACCESS_SECRET)` in `x-bnji-room-admin`, failing closed on both sides.
> Phases D and E are not started. See plan §6's implementation notes for the
> full deviation list.

This is a generic synchronization primitive, not a finished matchmaking/product surface. Rooms are private to participants who have the high-entropy room code; membership requires a validated guest or player session. Bound requests/messages and monitor the shared account quota; Free limits are ceilings, not a capacity promise. Independent local Worker verification (2026-09-29): room creation, matching-Origin WebSocket upgrades for two independent guest-cookie clients, distinct guest principals, stale-revision rejection at revision 0, unexpected disconnect reservation, same-cookie reconnect, fail-closed state rejection (`game_adapter_unavailable` because no game adapter is registered), explicit leave, and host handoff were exercised. No shared game-state revision was advanced. The local Worker used Wrangler/D1/DO emulation; direct local requests do not verify Cloudflare-edge IP-header replacement. This verifies local behavior only, not production deployment, remote DO migration, account-wide quotas under load, or a room's game rules.

## Quota and implementation guardrails

Cloudflare's official pages checked 2026-09-29 list Workers Free at 100,000 Worker requests/day and 10 ms CPU/invocation; D1 Free at 5 million rows read/day, 100,000 rows written/day, 5 GB/account (500 MB/database); and SQLite Durable Objects on Free at 100,000 DO requests/day and 13,000 GB-s/day, with 5 GB/account shared DO storage/row quotas, and 100 DO classes/account. The current official limits page lists 10 GB/object for Paid but no separate Free per-object figure; use the 5 GB Free account total and do not assume a 1 GB Free object cap. WebSocket inbound messages have 20:1 request accounting; hibernation avoids idle duration charges. Static assets do not use Worker invocation quota. These budgets are shared with the existing website/account, not reserved for Games. Do not introduce paid products, third-party services, email/API keys, or new dependencies unless implementation evidence makes one unavoidable (none is proposed).

Sources, all official and to be rechecked before deployment: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/reference/websockets/), [Astro Cloudflare custom Worker entrypoint](https://docs.astro.build/en/guides/integrations-guide/cloudflare/), [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).


## Implementation outcome

This decision was written before the architecture-heavy implementation. The current local build uses `migrations/0012_game_players_saves.sql`, IndexedDB offline saves with a three-attempt transient retry bound, and Wrangler SQLite class migration `game-rooms-v1`. All 12 D1 migrations have been applied only to the local Wrangler database. Local account creation, Secure/HttpOnly cookie, save API, room creation, and actual two-client WebSocket stale-revision/reconnect behavior were smoke-tested. Independent final checks on 2026-09-29: `npm test` passed (270 tests, 0 failed), `npm run check` passed (Astro/access/typecheck/Wrangler dry-run), and all 12 targeted security/consistency mutations were killed. The build still emits Vite's existing `optimizeDeps.esbuildOptions` deprecation warning. No production credential, remote migration, deploy, or paid service was used. `npm run test:e2e` could not run because the Playwright Chromium binary was absent; downloading it failed with a TLS `ECONNRESET`, so visual/axe/mobile browser checks remain unverified in this environment. See `GAMES-OPERATIONS.md` for the exact owner rollout and checked Free quotas.
