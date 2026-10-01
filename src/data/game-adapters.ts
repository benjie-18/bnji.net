/**
 * Client-side mirror of the registered server game adapters.
 *
 * The server registries (`registerRoomStateAuthority` / `registerScoreVerifier`)
 * are server-only; browser copy must not import them. This list exists purely
 * so shared UI (game-room-ui) can describe a room honestly — "no adapter
 * registered" is a true statement for most games but false for chess. Keep it
 * in sync when registering a new adapter; the adapter tests fail loudly if a
 * game reaches production without both halves.
 */
export const REGISTERED_ADAPTER_GAMES: readonly string[] = ['bnji.chess', 'bnji.pvp-minesweeper'];

export function hasRegisteredAdapter(gameId: string | undefined): boolean {
	return typeof gameId === 'string' && REGISTERED_ADAPTER_GAMES.includes(gameId);
}
