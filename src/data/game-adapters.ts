/**
 * Client-side mirror of the registered server game adapters.
 *
 * The server registries (`registerRoomStateAuthority` / `registerScoreVerifier`)
 * are server-only; browser copy must not import them. This list exists purely
 * so shared UI (game-room-ui, the leaderboard pages) can describe a game
 * honestly — "no adapter registered" is a true statement for most games but
 * false for chess. Keep it in sync when registering a new adapter (import it
 * from `src/server/game-adapters/register-all.ts`); `SCORE_VERIFIER_GAMES` is
 * cross-checked against the route's actual registry by
 * `tests/score-verifier-registry.test.ts`, so drift fails the suite.
 */
import type { Game } from './games';

/** Games whose ROOM state is validated by a server authority (`registerRoomStateAuthority`). */
export const REGISTERED_ADAPTER_GAMES: readonly string[] = ['bnji.chess', 'bnji.pvp-minesweeper'];

/**
 * Games whose SCORES a server verifier will accept (`registerScoreVerifier`).
 * A leaderboard is only published for these: every other entry's best is
 * device-local, and an empty public board that can never be scored honestly is
 * worse than no board at all.
 */
export const SCORE_VERIFIER_GAMES: readonly string[] = ['bnji.isometric-stack', 'bnji.chess', 'bnji.pvp-minesweeper'];

export function hasRegisteredAdapter(gameId: string | undefined): boolean {
	return typeof gameId === 'string' && REGISTERED_ADAPTER_GAMES.includes(gameId);
}

export function hasScoreVerifier(gameId: string | undefined): boolean {
	return typeof gameId === 'string' && SCORE_VERIFIER_GAMES.includes(gameId);
}

/** The modes a leaderboard is split by; a game without explicit modes has one board called `default`. */
export function leaderboardModes(game: Game): string[] {
	return game.modes && game.modes.length > 0 ? [...game.modes] : ['default'];
}

/**
 * True when this catalog entry has a public leaderboard page: available, hosted
 * on its own route (never a Lab pointer), and backed by a server verifier.
 */
export function hasLeaderboard(game: Game): boolean {
	return game.status === 'available' && !game.labHref && Boolean(game.href) && hasScoreVerifier(game.id);
}

/** `/games/stack/` → `/games/stack/leaderboard/`; null for anything without a route of its own. */
export function leaderboardHref(game: Game): string | null {
	if (!game.href || !hasLeaderboard(game)) return null;
	return `${game.href.replace(/\/$/, '')}/leaderboard/`;
}

/** Human label for a mode tab, matching the catalog's own vocabulary. */
export const MODE_LABEL: Record<string, string> = {
	default: 'Leaderboard',
	'fastest-mate': 'Fastest mate',
	quick: 'Quick · 6×6',
	normal: 'Normal · 9×9',
	hard: 'Hard · 14×14',
};
