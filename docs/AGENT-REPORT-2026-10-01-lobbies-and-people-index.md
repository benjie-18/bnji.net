# Agent report — 2026-10-01 — Open lobbies, durable kicks & the people index

**Scope of this half:** public room discovery (with the durable host kick it
needs to stay honest) and account discovery by handle fragment. The other half
is in
[`AGENT-REPORT-2026-10-01-games-leaderboards-labels.md`](./AGENT-REPORT-2026-10-01-games-leaderboards-labels.md).

## Open lobbies

- **Listing.** `GET /api/games/lobbies[?gameId=]` (`src/pages/api/games/lobbies.ts`)
  reads candidate rows from `room_registry`, probes each room's Durable Object
  through `GET /lobby`, and returns only rooms that answered as joinable:
  `{ lobbies: [{ roomCode, gameId, players, capacity, createdAt, expiresAt,
  revision }], truncated, stale, checkedAt, refreshAfterSeconds }`. A full, gone
  or too-slow room is **absent**, not listed and broken; a probe that did not
  answer sets `stale: true` rather than being silently dropped.
- **The DO probe** (`src/server/game-room-do.ts`, `lobbyProbe()`): `live`,
  `gameId`, `players` (the same seat count the next join is measured against),
  `capacity` (`ROOM_CAPACITY`), `createdAt`, `expiresAt`, `revision`. It answers
  about the **room**, never the caller — the Worker caches one list per game and
  shares it with every visitor, so a per-visitor answer would poison the cache.
- **Cost control.** 10 s shared KV cache (`bnji-lobby:`), 8 probes in flight,
  1.5 s per probe, 24 candidates per page, 30 requests/min per IP
  (`src/config/lobby.config.ts`). `enabled: false` answers `503
  lobby_disabled` and hides the panel.
- **UI.** The Games page rooms section and `RoomPanel.astro` (game pages) both
  render an "Open lobbies" panel, refreshed by `src/scripts/game-room-ui.ts`
  (auto-refresh at `max(minRefreshSeconds, refreshAfterSeconds)`; manual refresh
  cooldown). A row shows the game, `players/capacity` and the time left, with a
  Join button that dials the existing room socket.
- **Accepted trade-off, recorded.** A room code stops being a secret the moment
  the room is listed. That *is* the feature, the panel copy says so, and
  `LOBBY_CONFIG.enabled = false` restores the code-only behaviour without
  touching the socket. See `docs/GAMES-DECISIONS.md` and `docs/DATA.md` §11.

## Durable host kick

The moderation phase already had a host kick (member row deleted, socket closed
4003). It was not durable: the kicked principal could immediately rejoin. Now:

- `handleKick` / the admin `kick` action also write
  `game_room_kicks (principal_hash, kicked_at)` in the DO's SQLite;
- `acceptConnection` checks the lockout before admission. A locked-out principal
  is **upgraded and then closed with 4003** — a refused upgrade reaches the
  browser as a generic connection error, and the close code is the only way the
  client can say *why* the door is shut;
- `teardown()` deletes the table with the rest of the room, so the lockout dies
  with the room and a future room under the same code starts clean;
- the client distinguishes 4002 (room ended) from 4003 (removed) in
  `src/scripts/game-room-ui.ts` and clears the dead code from the panel.

## The people index

- `GET /api/people?query=<fragment>` (`src/pages/api/people.ts`) is
  account-only, same-origin, `no-store`, 30 searches/min per account
  (KV prefix `people-index:`), and off entirely when `DIRECTORY_CONFIG.enabled`
  is false (`503 directory_disabled`) or Phase E friends are off
  (`503 friends_disabled` — a result would have no action to offer).
- `src/server/people-index.ts` is a handle-fragment search over accounts that
  chose a handle. It returns handle, display name and the caller's own edge
  (`none` / `pending_out` / `pending_in` / `friends`) and nothing else: no
  player id, session, email, IP or "last seen". Blocks are filtered in SQL **in
  both directions**, so the index cannot be used to discover a block, and the
  response never says whether an account without a handle exists.
- `src/scripts/people-panel.ts` renders the results into the `/friends/` page,
  debounced at `searchDebounceMs`, with a request/accept awareness that hands
  the chosen handle back to the friends client (one implementation of
  request/accept/block). `/friends/` also gains the tabbed list strip
  (Requests / Friends / Sent / Blocked) built on the shared `.glass-tabs`.
- `docs/DATA.md` §11 registers both surfaces; both are read-only, and neither
  adds a stored field.

## Tests added or updated

- `tests/game-lobby.test.ts` — probe removal rules, `stale`/`truncated`,
  ordering, and KV cache round-trip/failure.
- `tests/people-index.test.ts` — query normalisation, LIKE escaping, edge
  labels, and the both-directions block rule on the real schema.
- `tests/display-names.test.ts` — `formatPublicLabel` / `sanitizePublicLabel`.
- `tests/game-scores.test.ts` — `beatsBest` boundary cases and outcome copy.
- `tests/workerd/room-lobby.spec.ts` — DO probe contract, seat counting, the
  durable lockout and its teardown.
- `tests/workerd/room-chat.spec.ts` — the kick assertion now expects the
  lockout (rejoin closes 4003, seat not re-taken).
- `tests/lab-games.test.ts`, `tests/dm-client.test.ts` — updated to the Stack
  combo slot and the composer's own status line.

## Verification (this tree)

- `npm test` — node:test **388 pass / 0 fail**; vitest (workerd) **46 pass / 0
  fail** across 8 files.
- `npm run check` — build (18 pages, 2 access rules), tsc 0 errors,
  `wrangler deploy --dry-run`, all green.
- Migration `0017_room_lobby_index.sql` is index-only, has no binding or secret
  change, and is committed on its own as infrastructure.
