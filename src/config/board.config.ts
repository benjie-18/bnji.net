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
	/**
	 * Attached image limit, DECODED bytes. Validated in the route.
	 *
	 * WHY NOT 25MB — the real ceiling is the storage layer, not the transport.
	 *
	 * The transport would happily carry it: Workers accepts request bodies up
	 * to 100MB (Free/Pro), and base64 inside a JSON body expands a 25MB file
	 * to ~33.4MB, so the request would reach the handler intact.
	 *
	 * The database is what refuses. An attachment is stored as a `data:` URL
	 * in a single `board_messages.image` column, and Cloudflare D1 caps a
	 * string, BLOB or row at 2,000,000 bytes:
	 *   https://developers.cloudflare.com/d1/platform/limits/
	 * A 25MB image is ~33,400,000 base64 characters — about 16x that ceiling.
	 * Every such INSERT fails with `SQLITE_TOOBIG` ("string or blob too big"),
	 * which surfaces as an opaque 500, not a clean rejection.
	 *
	 * So the enforced maximum is the largest file whose base64 form still
	 * leaves D1 room for the rest of the row (id, body, status, timestamps):
	 *   1,400,000 x 4/3 = 1,866,667 chars  <  2,000,000-byte row ceiling
	 * that is a ~133KB margin under the hard limit. Raising this past ~1.49MB
	 * would pass validation and then fail at the INSERT.
	 *
	 * Genuinely supporting 25MB needs a different storage path — store the
	 * file in R2 and keep only a reference in D1 — which is a binding and an
	 * architecture change, not a constant. Until then this is the honest
	 * ceiling, and the UI says so in the same words.
	 */
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
	// 1.4 MB decoded — see maxImageBytes above for why not 25 MB.
	maxImageBytes: 1400 * 1024,
	allowedImageTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
	postCooldownSeconds: 20,
	hourlyPostLimit: 20,
	pollIntervalMs: 20000,
};
