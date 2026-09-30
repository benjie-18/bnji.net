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
	/** Plan §6.3 — a triage aid, NOT a guarantee (docs must say so). */
	filter: {
		/** Case-insensitive substring terms refused at send time; empty list = filter inert. */
		blocklist: string[];
		/** Replace URLs with `[link]` in the ADMIN transcript view only; raw text is untouched. */
		stripUrlsForAdmin: boolean;
	};
	/** Plan §6.2/§6.4 — report throttling and ban bounds. */
	moderation: {
		/** D1 per-IP report budget (game_auth_attempts, prefix bnji-chat-report:). */
		reportWindowMs: number;
		reportMaxPerWindow: number;
		/** Ban duration used when an action omits one; hard ceiling on any ban. */
		defaultBanMinutes: number;
		maxBanMinutes: number;
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
	filter: {
		// Owner-editable. Empty = no term filtering (the strip-URLs admin view
		// behaviour is independent of this list).
		blocklist: [],
		stripUrlsForAdmin: true,
	},
	moderation: {
		reportWindowMs: 10 * 60_000,
		reportMaxPerWindow: 10,
		defaultBanMinutes: 60,
		maxBanMinutes: 60 * 24 * 7,
	},
};
