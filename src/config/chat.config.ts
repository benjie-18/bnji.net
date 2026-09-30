/**
 * BNJI.NET — room chat policy (Phase B of the chat plan).
 *
 * All values are PUBLIC: they are limits and switches, not secrets. The chat
 * panel reads them for input attributes, the GameRoom Durable Object reads
 * them for enforcement, and docs/CONFIGURATION.md §8b documents each one.
 *
 * Rollback (plan §14): set `enabled: false` and redeploy — chat frames are
 * then refused with `chat_rejected chat_disabled`, the panel hides itself,
 * and nothing else in the room protocol changes.
 */
export type ChatConfig = {
	/** Master switch. false = chat refused server-side and hidden client-side. */
	enabled: boolean;
	/** Message text, code points, after sanitising (same order of magnitude as the board's 250). */
	maxTextLength: number;
	/** Stored messages per room (plan D2); oldest rows are trimmed on insert. */
	maxStoredMessages: number;
	/** History frames carry at most this many messages — and are additionally byte-packed under ROOM_MAX_OUTBOUND_FRAME_BYTES. */
	historyChunkMessages: number;
	rate: {
		/** Per-member token bucket: burst size, then ~1 token per refillMs (≈15/min sustained). */
		burst: number;
		refillMs: number;
		/** Pre-parse abuse ceiling across ALL frame types per connection; breach closes with 1013. */
		globalPerSecond: number;
	};
};

export const CHAT_CONFIG: ChatConfig = {
	enabled: true,
	maxTextLength: 250,
	maxStoredMessages: 200,
	historyChunkMessages: 25,
	rate: {
		burst: 5,
		refillMs: 4_000,
		globalPerSecond: 8,
	},
};
