# Games foundation — decision record

**Checked:** 2026-09-29 (UTC). This record captures the part-one catalog, tracking and leaderboard choices. Part two adds identity, saves and generic rooms in [`PLAYER-MULTIPLAYER-DECISIONS.md`](./PLAYER-MULTIPLAYER-DECISIONS.md); no gameplay is added in either part.

## Options and selection

- **Part-one tracking/scores storage:** use existing Cloudflare D1 (`bnji-board` / `BOARD_DB`) rather than Workers KV (not relational/ranking-friendly), a Durable Object (not appropriate as the leaderboard's relational query store), or a paid/external service. D1 supports indexed ranking and bounded admin reporting and is already part of the site. Part two retains D1 for player/session/save records and adds a SQLite-backed Durable Object only for per-room WebSocket coordination. Keep public score reads limited to display name and score fields.
- **Trust model:** scores become public only through a server-registered, game-specific verifier. There is no verifier until a game exists, so the public submission endpoint fails closed with `503 verifier_unavailable`; it never stores or displays client-claimed scores as valid. The store accepts only server-validated records. No speculative replay engine or generic run-ticket system is added.
- **Tracking:** aggregate one `(guest session, game ID, per-tab run ID)` row so simultaneous tabs never overwrite each other's active-time state. Client sends a heartbeat at most once per minute, only while the game is visible/foregrounded and only after game-area activity. It stops accruing after two idle minutes. Server clamps each increment to 65 seconds and uses a shared player-context resolver. Device details/IP remain private in D1, separate from public score reads. Tracking failures do not interrupt play.
- **Retention:** the current source had a fixed 60-day constant and lazy purge after a row threshold; it did not actually expose the retention control claimed by older owner notes. Add a persisted, admin-editable `trackingRetentionDays` setting (default 60, bounded 1–365), extend lazy cleanup, and add an hourly Cloudflare Cron Trigger for idle periods. Deletion uses indexed time cutoffs and a 50-row primary + 10-row catch-up cap/table/hour, deliberately lowered from part one to reserve D1 Free writes for identity/save traffic. Admin reads also perform one bounded recovery batch, but public responses filter at the configured cutoff immediately. Under a backlog larger than one batch, physical deletion takes multiple hourly sweeps plus scheduler jitter; there is no hard one-hour deletion guarantee. Tracking ingest itself remains best-effort and never runs a full-table purge. Cron is selected over perpetual request polling or an external scheduler.
- **Worker runtime:** retain Astro's Cloudflare adapter and bindings. Add a small custom Worker entrypoint only to forward HTTP to Astro and run the scheduled retention sweep. **Amended 2026-09-30:** the original "no new npm dependencies" rule is superseded by the tiered policy in [`DEPENDENCY-POLICY.md`](./DEPENDENCY-POLICY.md); dependencies are permitted per tier, and runtime or visitor-facing ones need justification or a decision record respectively.
- **Game modules:** central typed catalog in `src/data/games.ts`; stable IDs are lowercase, namespaced slugs (`bnji.<slug>`), immutable after public score history exists. Lab experiments remain where they are and are linked, never copied. Shared lifecycle is a compact browser module, not an engine.
- **PvP Minesweeper + Stack (2026-10-01, owner answers):** the PvP Minesweeper leaderboard is a **wins count per difficulty**, made server-trustworthy by asking the round's room DO to attest the win and having the scores route increment the stored best — never accepting a client total. A mine hit is **instant elimination** (the denying `hit_mine` reveals which cell was fatal; the racer self-reports `ms_die`, so whoever designed the minefield scores the kill). Stack ships as a port of the Lab isometric StackGame with **one locked Normal speed**, and the Lab card (`bnji.isometric-stack`) is repointed to the standalone `/projects/games/stack/` page instead of copying the component.

## Free-plan fit and tradeoffs

Cloudflare's official plan pages (checked 2026-09-29; current doc update dates and links are in `GAMES-OPERATIONS.md`) list Workers Free at 100,000 inbound requests/day and 10 ms CPU/invocation; D1 Free at 5 million rows read/day, 100,000 rows written/day, 5 GB/account and 500 MB/database; KV Free at 100,000 reads/day and 1,000 writes/day; SQLite Durable Objects Free at 100,000 DO requests/day, 13,000 GB-s/day, 5 million SQLite rows read/day, 100,000 written/day and 5 GB total storage. A WebSocket handshake is a Worker and DO request; inbound DO WebSocket messages use 20:1 DO request billing, and idle hibernating sockets incur no duration. Static assets do not consume Worker invocation quota; Cron invocations do. Every allowance is shared account-wide. Tracking cleanup is capped at 60 rows/table/hour to reserve D1 writes for accounts/saves; room per-connection message and room state-write ceilings bound the generic DO workload but cannot reserve account-wide capacity. At 100 daily players active 2 hours each there are about 12,000 heartbeat requests/day plus other traffic; see `GAMES-OPERATIONS.md` for the working shared budget and saturation caveats. Leaderboard responses return 25 rows/page (maximum 20 pages over the 500-row/game/mode cap).

D1 exhaustion is surfaced as an API storage error for account/save and score operations; tracking is deliberately best-effort and fails open with no player-facing error. Guest play and device-local saves remain usable. No game can submit a legitimate public score until a game-specific verifier exists.

## Follow-up seams

`src/server/player-context.ts` remains the only identity resolver used by tracking, scores, saves and rooms. It validates the shared guest cookie and (when present) validates the opaque signed-in session through D1; API code never parses account cookies independently. Tracking and score rows retain the guest `session_id` plus nullable `player_id`. Generic save and room envelopes do not validate game rules; future games must still register a game-specific score verifier.

## Leaderboards, discovery and presentation (2026-10-01, owner requests)

- **Per-game leaderboard pages.** Scored games get a static sibling route
  `/projects/games/<slug>/leaderboard/` (prerendered from `getStandaloneGames().filter(hasLeaderboard)`)
  and a link from the catalog card and the game shell. The page is static and the
  rows are fetched from `GET /api/games/leaderboard`; mode and page live in the
  query string via `replaceState`, so a link can point at one board without a
  history entry per tab click. Only games with a **server score verifier** publish
  a board: an empty public board that can never be scored honestly is worse than
  no board.
- **Labels are composed at READ time.** A leaderboard row, a room roster entry and
  a chat author all render `@handle · Display Name` from the player's current
  `handle` + `display_name` (`formatPublicLabel`, `NAMES_CONFIG.publicLabel`,
  max 48 code points, separator ` · `). No new column, no migration, no backfill:
  a rename (or a handle change) updates every board and room at once, and a player
  who never claimed a handle shows only their display name. Labels are always
  inserted as text, never markup.
- **A run auto-submits only when it beats the server-read personal best.**
  `src/scripts/game-scores.ts` reads `GET /api/games/scores/my` first and submits
  only when `beatsBest` mirrors the `game_scores` upsert comparison (higher score,
  or equal score with a strictly better tie-break; `UNRANKED_TIE_BREAK = 1_000_000_001`
  for a null tie-break). An unreadable standing submits **nothing** — "I could not
  check" is not "nothing to beat" — and the manual claim form stays as the visible
  fallback. Idempotency keys are derived from a per-run token (`stk-`/`msw-`/`che-`).
  PvP wins use the DO-attested increment (`attestedIncrement`) in the order
  name → POST → standing refresh, and never send a client-computed total.
- **Open lobbies (owner verbatim: "players to see all lobbies created for each
  game and be able to join them freely, with the host able to kick them").**
  `GET /api/games/lobbies` lists live, joinable rooms for one game or all games: a
  bounded `room_registry` read plus a live `/lobby` probe per candidate DO, KV-cached
  for 10 s and rate-limited per IP. A room appears only while `live:true`, matching
  its registered game, `players < capacity` and `expiresAt > now` — the list claims
  *joinability*, not existence. The room code is published by the listing; room
  state and chat stay member-only. **The kick is a durable lockout**, not a
  disconnect: a host (or admin) kick writes `game_room_kicks` inside the room DO,
  closes the socket `4003`, deletes the membership row, and refuses a raw
  reconnect with `403 room_kicked` until the room is torn down. The member roster
  moved out of the chat panel because seats, teams and kicks matter whether or not
  chat is enabled.
- **The people index is gated, handle-only and block-blind by construction.**
  `GET /api/people` searches handle fragments (≥3 chars, `[a-z0-9_]`) for accounts
  that claimed a handle, returns only `{handle, displayName, friendState}`, filters
  blocks in **both** directions in SQL, and never says whether a given name has an
  account. It is account-only, rate-limited per account, and off with
  `DIRECTORY_CONFIG.enabled` (or `FRIENDS_CONFIG.enabled`).
- **Lab experiments stay out of the room menu.** The room `<select>` on `/projects/games/`
  is built from `getStandaloneGames()`, so `bnji.glass-minesweeper` (and the other
  Lab cards) can no longer be picked for a room. `POST /api/games/rooms` stays
  permissive — the menu is the product decision, and the API keeps accepting any
  catalog game so an existing code never becomes a dead end. Stack deliberately
  **stays** in the menu: it is a standalone game, not a Lab experiment.
- **Presentation fixes.** Stack: the hidden −x face is now filled
  (`p3→p2→p6→p7`), the canvas fits its container at device pixel ratio with an
  `aspect-ratio`, sparks are world-space, the ground shadow is clamped and fades,
  a miss produces visible debris instead of a shell `results` swap, and the
  game-over overlay lives inside the game viewport with reserved combo/action
  slots (`--game-field` tokens for the surface). Chess: survivable column
  minimums, the three-column layout holds to 1040px, the board wrapper scrolls its
  own overflow (`overscroll-behavior-x: contain`), and the move list only
  auto-scrolls while it is already at the tail. Both games' canvas/board tokens
  moved into `src/styles/tokens.css` (`--game-*`) and the shared glass primitives
  (`.glass-tabs`, `.glass-row`, `.glass-field`, `.glass-status`, `.glass-note`)
  were promoted so the admin nav, `/community/friends/`, `/community/messages/` and the leaderboards
  all use one implementation.
- **Fullscreen for every game.** `GameShell` + `src/scripts/game-shell.ts` add one
  toggle: the button ships hidden and is revealed only when the Fullscreen API
  exists, `aria-pressed` mirrors the real state, and `data-game-fullscreen` marks
  the surface and the root so the CSS can expand the surface without the page
  behind it. Lab experiment cards are out of scope by design (they are not wrapped
  in `GameShell`).
