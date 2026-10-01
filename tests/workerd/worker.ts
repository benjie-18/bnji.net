/**
 * Test Worker entry for `@cloudflare/vitest-pool-workers`.
 *
 * The production entry (`src/worker.ts`) imports the Astro HTTP handler and
 * the built `dist/` assets, which a unit-test run must not depend on. This
 * entry registers only the Durable Object classes under test, so the pool can
 * boot workerd from source with no build step. Keep it in sync with the DO
 * exports of `src/worker.ts` — a class tested here is a class shipped there.
 */
export { GameRoom } from '../../src/server/game-room-do';
export { DMConversation } from '../../src/server/dm-conversation-do';
