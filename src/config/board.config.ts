/**
 * Public visitor message board — CONFIGURATION (public part).
 *
 * The board UI (src/components/MessageBoard.astro) talks only to the API
 * boundary in src/pages/api/board.ts, which talks only to a storage provider
 * implemented in src/server/board-store.ts. Swapping storage never touches UI.
 *
 * Storage providers (src/server/board-store.ts):
 *   'd1'   — Cloudflare D1. The production store: one indexed table, atomic
 *            writes, keyset-cursor pagination and SQL-enforced moderation
 *            filtering. Requires the BOARD_DB binding in wrangler.json plus
 *            migrations (see docs/CONFIGURATION.md §5).
 *   'rest' — external JSON API implementing the same contract, for teams that
 *            already run a backend.
 *            SECRET env: BOARD_REST_URL (+ optional BOARD_REST_TOKEN).
 *   There is NO in-memory production fallback on purpose: an unconfigured
 *   store yields an honest 503 instead of silently losing messages.
 *
 * Rate limiting lives in KV with TTLs (binding BOARD_KV) so limits are shared
 * across Worker isolates; see src/server/ratelimit.ts.
 *
 * PUBLIC vs SECRET: every value in this file is public policy (limits,
 * defaults). Connection strings, tokens, database ids and namespace ids are
 * SECRET/INFRA and belong in wrangler bindings / environment only.
 */
export type BoardConfig = {
	/** Preferred provider; null store (503) when its binding is unavailable. */
	provider: 'd1' | 'rest';
	/** Messages loaded on first paint. */
	defaultVisible: number;
	/** Slider range for "how many messages are displayed". */
	minVisible: number;
	maxVisible: number;
	/** Hard cap for a single list page (cursor pagination walks beyond it). */
	pageSize: number;
	/** Cap for the archive view's first page. */
	archivePageSize: number;
	/**
	 * Message body limit, characters. Enforced SERVER-SIDE in
	 * src/pages/api/board.ts with a 422 rejection (never truncation).
	 */
	maxTextLength: number;
	/** Attached image limit, bytes (decoded). Validated in the route. */
	maxImageBytes: number;
	/** Accepted image MIME types. */
	allowedImageTypes: readonly string[];
	/** Seconds between accepted posts from one client (KV-backed window). */
	postCooldownSeconds: number;
	/** Max accepted posts per client per hour (KV-backed window). */
	hourlyPostLimit: number;
	/** Poll interval for near-real-time updates, ms (0 disables polling). */
	pollIntervalMs: number;
};

export const BOARD_CONFIG: BoardConfig = {
	// ▼▼▼ CONFIGURE HERE ▼▼▼
	provider: 'd1',
	// ▲▲▲ CONFIGURE HERE ▲▲▲
	defaultVisible: 10,
	minVisible: 3,
	maxVisible: 30,
	pageSize: 100,
	archivePageSize: 200,
	maxTextLength: 250,
	maxImageBytes: 400 * 1024,
	allowedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
	postCooldownSeconds: 20,
	hourlyPostLimit: 20,
	pollIntervalMs: 20000,
};
