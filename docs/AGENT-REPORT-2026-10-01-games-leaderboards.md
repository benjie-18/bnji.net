# Agent report — per-game leaderboards, readable labels, room polish (2026-10-01)

**Reconstruction note.** This report describes work landed on branch
`arena/01a0fa5d-bnji-net` from an owner request made on 2026-10-01. The original
capture of this report was lost with the session that produced it, so it has been
rebuilt from the landed tree and re-verified at the end of the change. Every
claim below is checked against the code in this repository, not quoted from the
lost session.

**Status:** uncommitted working-tree change on the branch. Migration `0017` is
additive and **not applied** — applying migrations is an owner action
(`docs/DEPLOY.md` §2).

## 1. What the owner asked for, and what shipped

| # | Request | What shipped |
| --- | --- | --- |
| 1 | Leaderboard pages per game, reachable from the catalog | Static sibling routes `/games/<slug>/leaderboard/` for every scored game (`stack`, `chess`, `pvp-minesweeper`), prerendered from `getStandaloneGames().filter(hasLeaderboard)`; links from `GameCard` and `GameShell`; a leaderboard section on `/games/`. |
| 2 | Names like "handle · account name" everywhere | `formatPublicLabel` in `src/server/display-name.ts` composes `@handle · Display Name` **at read time** from `game_players.handle` + `display_name` (no column, no migration, no backfill); `NAMES_CONFIG.publicLabel` clamps to 48 code points with separator ` · `; the same composed label is used by the leaderboard, the room roster and chat authors via `sanitizePublicLabel`. |
| 3 | Submit a score when a run beats my best, keep the manual claim | `src/scripts/game-scores.ts`: `readStanding` → `beatsBest` (mirrors the `game_scores` upsert: higher score, or equal score with a strictly better tie-break; `UNRANKED_TIE_BREAK = 1_000_000_001`) → `submitRun`; an unreadable standing submits nothing; PvP wins use `submitAttestedWin` (name → POST → standing refresh) and never send a client total; the claim form stays as fallback. |
| 4 | Lab games must not appear in the room menu | The `/games/` room `<select id="room-game">` is built from `getStandaloneGames()`, so `bnji.glass-minesweeper` and the other Lab cards are gone; `POST /api/games/rooms` stays permissive on purpose (a code must never become a dead end); Stack stays in the menu. |
| 5 | Stack visual bugs (hidden face, blurry canvas, sparks, miss feedback, overlay) | Filled front faces `p3→p2→p6→p7` (the hidden −x face was being filled instead), DPR-aware canvas fit with `aspect-ratio`, world-space sparks, clamped + faded ground shadow, a miss now produces visible debris and **no** shell `results` swap, the game-over overlay lives inside the viewport, and combo/action slots are reserved so the HUD cannot reflow the board. |
| 6 | Chess board fights the page when scrolling | Survivability column minimums, three-column layout holds to 1040px, the board wrapper scrolls its own overflow with `overscroll-behavior-x: contain`, the move list contains its scroll and only auto-scrolls while already at the tail. |
| 7 | Fullscreen for the games | One toggle in `GameShell` + `src/scripts/game-shell.ts`; the button ships hidden and is only revealed when the Fullscreen API exists; `aria-pressed` mirrors real state; `data-game-fullscreen` marks the surface and the root. Lab experiment cards are out of scope (they are not wrapped in `GameShell`). |
| 8 | One glass language instead of per-page controls | `.glass-tabs` + `.glass-tabs__item`/`__indicator` (motion in `glass.css`, geometry in `tokens.css`), `.glass-item`, `.glass-field`, `.glass-status`, `.glass-note`, `.glass-row`, `chip--danger`/`chip--plain`, `glass-button--danger`; the admin nav, `/friends/`, `/messages/` and the leaderboards all use them; `src/scripts/glass-tabs.ts` is the single travelling-capsule implementation. |

## 2. Verification (re-run at the end of the change)

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npm exec -- tsc --noEmit` | 0 errors |
| Build | `npm run build` | 18 static pages prerendered, sitemap written, `[verify-access] OK — 2 rule(s), 18 built page(s), 20 source page(s), no protected route served statically` |
| Node suite | `node --import ./tests/support/register.mjs --test "tests/**/*.test.ts"` | 426 pass / 0 fail |
| Workerd suite | `npm run test:do` | 8 files, 48 pass / 0 fail |
| Built-output leaks | `grep -rl "example.com\|localhost" dist/client` | no matches |
| Sitemap | `dist/client/sitemap-0.xml` | contains `games/stack/leaderboard/`, `games/chess/leaderboard/`, `games/pvp-minesweeper/leaderboard/` |
| Room menu | `dist/client/games/index.html` select contents | exactly `bnji.isometric-stack`, `bnji.chess`, `bnji.pvp-minesweeper` |
| Migration | — | `0017_room_lobby_index.sql` present, **not applied** (owner step) |

New tests: `tests/game-leaderboard.test.ts`, `tests/game-scores.test.ts`
(beatsBest ↔ upsert parity, status mapping, attested ordering), plus the friends
and people-index suites.

## 3. Files

**New:** `src/pages/games/[game]/leaderboard.astro`,
`src/components/GameLeaderboard.astro`, `src/scripts/game-leaderboard.ts`,
`src/scripts/game-scores.ts`, `src/styles/games.css`,
`src/data/game-adapters.ts` helpers, `src/scripts/glass-tabs.ts`.

**Changed:** `src/components/{GameShell,GameCard,Chip,RoomPanel,lab/StackGame}.astro`;
`src/config/{index,names.config}.ts`; `src/data/games.ts`;
`src/pages/{games,friends,messages}.astro`, `src/pages/admin/index.astro` and
`src/pages/games/{chess,pvp-minesweeper,stack}.astro`; `src/scripts/{game-shell,game-runtime,game-room-ui,game-rooms,friends-ui,messages-ui,admin-dashboard,game-player-ui}.ts`;
`src/scripts/games/{stack,chess,pvp-minesweeper}.ts`;
`src/server/{display-name,game-store}.ts`; `src/styles/{tokens,glass,admin}.css`;
`tests/{dm-client,game-runtime,lab-games}.test.ts`; `docs/{CONFIGURATION,DATA,DEPLOY,GAMES-DECISIONS,GAMES-OPERATIONS,CHAT-SYSTEM-PLAN}.md`.

## 4. Follow-up sizing: how hard is public room discovery?

Not part of this change, but the owner asked. The pieces:

- **Listing needs two data sources.** Rooms live in Durable Objects, which cannot
  be enumerated; the D1 `room_registry` rows say which codes were created and for
  which game, and only a live probe of each DO says whether the room still exists
  and how many seats it has taken. Both already exist — the listing is a read of
  each, not new state.
- **The cost is subrequests, not storage.** One D1 read + up to N DO probes per
  page view; a short KV cache and a `listLimit` bound make that affordable on the
  Free plan, with the cache TTL as the freshness the UI may promise.
- **The safety question is the room code.** Listing a room publishes its code, so
  a stranger no longer needs an invite — that is the feature, but it must be a
  product decision (recorded in `GAMES-DECISIONS.md`), and the code must not leak
  anywhere else (no index, no prerender, no URL, no analytics).
- **"Joinable" must be re-checked at click time.** A stale row is the only real
  failure mode, so the list drops anything that is not `live:true`, matching its
  game, not full and not expired — and the panel never blocks the code path.
