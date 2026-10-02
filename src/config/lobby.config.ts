/**
 * BNJI.NET — open-lobby policy (public room discovery).
 *
 * Every room a player creates is listed for anyone to join, and the list is
 * served from the D1 `room_registry` rows plus a live probe of each room's
 * Durable Object (only the Worker can reach both, and only the DO knows whether
 * a room is still alive). All values are PUBLIC limits and switches.
 *
 * Owner-visible consequences of listing rooms at all, recorded in
 * docs/GAMES-DECISIONS.md: a room code stops being a secret (a stranger no
 * longer needs an invite), and a room's game, player count and remaining
 * lifetime become public. Nothing about *who* is in a room is published, and no
 * room content (state, chat) is readable through this surface.
 *
 * Rollback: set `enabled: false` and redeploy. The listing endpoint answers
 * `503 lobby_disabled`, the `/games/` lobby panel hides itself, and rooms keep
 * working exactly as they did for their code-holders.
 */
export type LobbyConfig = {
	/** Master switch for public discovery. false = no list, no probe, panel hidden. */
	enabled: boolean;
	/** Candidate `room_registry` rows considered per request, newest first. */
	listLimit: number;
	/** Live DO probes in flight at once. A room that does not answer is not listed. */
	probeConcurrency: number;
	/** How long a room may take to answer `/lobby` before it is treated as gone. */
	probeTimeoutMs: number;
	/**
	 * KV cache lifetime for one game's list. This is the only thing standing
	 * between a busy lobby page and one D1 read + N subrequests per visitor, so
	 * the freshness the UI promises is exactly this number of seconds.
	 */
	cacheTtlSeconds: number;
	/** Floor for the client's own refresh loop, so the UI cannot out-poll the cache. */
	minRefreshSeconds: number;
	rate: {
		/** Per-IP request window. */
		windowMs: number;
		/** Requests per window per IP; the cache absorbs honest use. */
		requests: number;
	};
};

export const LOBBY_CONFIG: LobbyConfig = {
	enabled: true,
	listLimit: 24,
	probeConcurrency: 8,
	probeTimeoutMs: 1_500,
	cacheTtlSeconds: 10,
	minRefreshSeconds: 15,
	rate: { windowMs: 60_000, requests: 30 },
};
