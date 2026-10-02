# Agent report — 2026-10-01 — Games leaderboards, public labels, Stack & fullscreen

**Scope of this half:** per-game leaderboard pages, the `@handle · DisplayName`
label form, automatic score submission on a personal best, the Stack visual
fixes, fullscreen for every shelled game, and the layout-shift fixes that fall
out of the other four. The second half (open lobbies, durable kicks, the people
index) is in
[`AGENT-REPORT-2026-10-01-lobbies-and-people-index.md`](./AGENT-REPORT-2026-10-01-lobbies-and-people-index.md).

## What shipped

- **Per-game leaderboards.** `src/pages/games/[game]/leaderboard.astro` builds
  one static page per standalone game that advertises a leaderboard
  (`getStandaloneGames().filter(hasLeaderboard)`), rendered by
  `src/components/GameLeaderboard.astro` and hydrated by
  `src/scripts/game-leaderboard.ts` (tabs + `mountGlassTabs` for the travelling
  slab). `GET /api/games/scores/my` answers the signed-in player's own standing
  so a page can say where the visitor is without exposing anyone else's row.
- **Automatic submission.** `src/scripts/game-scores.ts` decides with
  `beatsBest()` whether a finished run improves the player's server-stored
  personal best and submits only then; `outcomeMessage()` turns a refusal into
  one plain sentence (or nothing at all for the ordinary "not a best" case).
  Attested modes (PvP Minesweeper wins) still go through the DO-attested path —
  a client total is never trusted.
- **Public labels composed at read time.** `formatPublicLabel()` /
  `sanitizePublicLabel()` in `src/server/display-name.ts` render
  `@handle · DisplayName`, `@handle`, or the display name alone, from
  `NAMES_CONFIG.publicLabel` (48 characters, separator ` · `). Nothing is
  stored composed: one rename or one new handle updates every surface — the
  leaderboard, room rosters, chat and friends rows — with no schema change to
  any 1–48 `CHECK`. The room upgrade header carries the composed label and the
  DO re-validates it with `sanitizePublicLabel` (running a composed label
  through `sanitizeDisplayName` would refuse `@` and degrade every handle label
  to "Player").
- **Stack fixes** (`src/components/lab/StackGame.astro`): the canvas bitmap now
  follows the device pixel ratio and the CSS box owns the size (block edges stop
  arriving resampled); debris and tower are painted in one depth-sorted pass
  instead of debris always on top; the sliced-block geometry takes the exposed
  strip from the old slab (a chip breaks off the tower instead of appearing
  beside it); the combo badge is a reserved, faded-in slot rather than a
  `hidden` node that slides SCORE and BEST sideways; the viewport reads the
  shared `--game-field*` tokens instead of private literals.
- **Fullscreen & layout shift** (`src/components/GameShell.astro` and the game
  pages): the shell surface goes fullscreen with the page chrome gone, the
  action strip reserves `--game-action-row-size` so a fullscreen label swap
  cannot resize the panel, the panel reserves `--game-shell-reserve` (measured
  by `scripts/game-shell.ts`) so paused/results swaps do not move the page, and
  status lines use the shared `.glass-status` (a reserved row) rather than
  collapsing to zero height.

## New shared primitives

`src/styles/glass.css` gains the vocabulary the redesigned pages already name:
`.glass-label`, `.glass-field`, `.glass-note`, `.glass-status`, `.glass-item`,
and the `.glass-tabs` strip/indicator contract (`--tab-l/r/t/b`,
`data-direction`, `data-ready`, `data-instant`). They are global for the same
reason the board styles are: the friends, messages and room clients build fields
and rows in JavaScript, and an Astro-scoped rule cannot reach a node created
after the page compiled. `tokens.css` gains the game-surface tokens
(`--game-board-*`, `--game-piece-*`, `--game-cell-*`, `--game-count-*`,
`--game-field*`, `--game-on-accent`, `--game-action-row-size`); the values are
the literals the pages carried, so the change is one of ownership, not colour.

## Verification (this tree)

- `npm exec -- astro build` — 18 built pages, 2 access rules, no protected route
  served statically (`node scripts/verify-access.mjs`).
- `npm exec -- tsc --noEmit` — 0 errors.
- `npm test` — node:test **388 pass / 0 fail**; vitest (workerd) **46 pass / 0
  fail** across 8 files.
- `npm run check` — build + access verification + tsc + `wrangler deploy
  --dry-run` all pass.
- No browser in this sandbox: visual behaviour is verified structurally (DOM
  contracts in `tests/lab-games.test.ts`, `tests/dm-client.test.ts`), not with
  screenshots.

## Rollback and follow-ups

- No new bindings, secrets or `wrangler.json` changes. The only migration is
  `migrations/0017_room_lobby_index.sql` (index-only, `idx_room_registry_game`),
  committed on its own as infrastructure.
- Score auto-submission is off for anyone without a display name
  (`{ kind: 'unnamed' }` explains it once) and never blocks play.
- The Stack depth sort is a painter's-order sort over an isometric projection;
  it is exact for the current projection and would need revisiting if the view
  gains a rotatable camera.
