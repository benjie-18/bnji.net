/**
 * BNJI.NET — chat plan Phase E: friends, presence and notifications config.
 *
 * Single source of truth for the §8 caps and switches, mirroring
 * src/config/dm.config.ts. `enabled: false` is plan §14's rollback lever for
 * the whole feature (the routes answer `friends_disabled`; DM reverts to its
 * Phase D open behaviour automatically because the friendship gate checks the
 * same switch). Public pages may only describe the feature in plain language
 * while this switch is true (§14: "planned" copy before it is wired).
 */
export const FRIENDS_CONFIG = {
	/** Feature switch (§14 rollback): false → API `friends_disabled`, gate off, UI reads error copy. */
	enabled: true,
	/** §8.1: a player can have at most this many accepted friends. */
	maxFriends: 500,
	/** §8.1: at most this many unanswered outgoing requests. */
	maxPendingOutgoing: 100,
	/** Requests per minute per account (sha256 `bnji-friend-request:` budget, D1 — never KV). */
	requestsPerMinute: 20,
	/** Accept/decline/block/remove/unblock per minute per account. */
	decisionsPerMinute: 60,
	/** Presence WebSocket connects per minute per account (D1, never KV). */
	presenceConnectsPerMinute: 30,
	/** In-app notification badge poll interval for signed-in browsers (§8.3). */
	notificationsPollMs: 60_000,
} as const;
