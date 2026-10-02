/**
 * The ONE side-effect import point for every game adapter module.
 *
 * Importing this module registers every game's score verifier (and, for games
 * that have one, room authority) in the current isolate. The two consumers are
 * `src/pages/api/games/scores.ts` (verifiers, inside the Worker) and
 * `src/server/game-room-do.ts` (authorities, inside the GameRoom DO); ES-module
 * caching makes duplicate registration impossible.
 *
 * THIS LIST IS THE WIRING. An adapter that exists but is never imported here
 * is invisible to the server: its leaderboard page renders, its client auto-
 * submits, and every submission fails closed with `503 verifier_unavailable` —
 * the bnji.isometric-stack outage of 2026-10. So the invariant is tested, not
 * assumed: `tests/score-verifier-registry.test.ts` imports the score route in
 * a clean process and fails unless EVERY standalone game in the catalog ends
 * up with a registered verifier. Adding a game with server-verified scores is
 * therefore: create `game-adapters/<slug>.ts`, add ONE import here, and list
 * it in `SCORE_VERIFIER_GAMES` (`src/data/game-adapters.ts`) so the public
 * leaderboard page exists. The test fails loudly if any of the three drifts.
 *
 * Lab-pointer games (`labHref`) have no server side at all and deliberately
 * stay out of this list — their submissions fail closed by design.
 */
import './chess';
import './pvp-minesweeper';
import './stack';
