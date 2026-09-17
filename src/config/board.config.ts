/**
 * Public visitor message board — CONFIGURATION (public part).
 *
 * The board UI (src/components/MessageBoard.astro) talks only to the API
 * boundary in src/pages/api/board.ts, which talks only to a storage provider
 * implemented in src/server/board-store.ts. Swapping storage never touches UI.
 *
 * Storage providers (src/server/board-store.ts):
 *   'memory' — per-Worker-isolate store. Zero setup; messages are shared by
 *              visitors served by the same isolate and survive between
 *              requests, but NOT across isolates or deployments. Default.
 *   'kv'     — Cloudflare KV. True persistence, near-real-time across visitors.
 *              SECRET/INFRA env: a KV namespace bound as BOARD_KV.
 *              Enable:  npx wrangler kv namespace create board
 *                       then add the binding named BOARD_KV in wrangler.json
 *                       (see docs/CONFIGURATION.md). The store auto-detects
 *                       the binding; no code change required.
 *   'rest'   — any external JSON API implementing GET/POST /messages.
 *              SECRET env: BOARD_REST_URL (+ optional BOARD_REST_TOKEN).
 *
 * PUBLIC vs SECRET: every value in this file is public policy (limits,
 * defaults). Connection strings, tokens and namespace IDs are SECRET and
 * belong in the environment / wrangler bindings only.
 */
export type BoardConfig = {
	/** Preferred provider; falls back to 'memory' when unavailable. */
	provider: 'memory' | 'kv' | 'rest';
	/** Messages loaded on first paint (the brief's default). */
	defaultVisible: number;
	/** Slider range for "how many messages are displayed". */
	minVisible: number;
	maxVisible: number;
	/** Hard cap returned by a single list request (full-view pagination). */
	pageSize: number;
	/** Message text limit, characters. */
	maxTextLength: number;
	/** Attached image limit, bytes (decoded). */
	maxImageBytes: number;
	/** Accepted image MIME types. */
	allowedImageTypes: readonly string[];
	/** Seconds between accepted posts from one client. */
	postCooldownSeconds: number;
	/** Poll interval for near-real-time updates, ms (0 disables polling). */
	pollIntervalMs: number;
};

export const BOARD_CONFIG: BoardConfig = {
	// ▼▼▼ CONFIGURE HERE ▼▼▼
	provider: 'memory',
	// ▲▲▲ CONFIGURE HERE ▲▲▲
	defaultVisible: 10,
	minVisible: 3,
	maxVisible: 30,
	pageSize: 100,
	maxTextLength: 280,
	maxImageBytes: 400 * 1024,
	allowedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
	postCooldownSeconds: 20,
	pollIntervalMs: 20000,
};
