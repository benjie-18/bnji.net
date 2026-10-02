/**
 * BNJI.NET — people index (finding accounts to send friend requests to).
 *
 * The mirror of the open-lobby idea for people: instead of needing an exact
 * handle to find someone, a signed-in account can search the set of accounts
 * that chose a handle. A handle is already the site's public identity — it is on
 * every leaderboard row and `GET /api/players?handle=` already answers whether
 * one exists — so this surface adds discoverability, not new data: the index
 * publishes `handle` and the display name, and nothing else.
 *
 * Two rules the design cannot break:
 *   - no player id, session reference, email, IP, or "last seen" leaves the
 *     server, and the response never says whether someone has an account
 *     without a handle (they are simply not in the index);
 *   - a block in EITHER direction removes the row. The index must not become a
 *     way to discover that you were blocked, which is the same reasoning
 *     `requireDmFriendship` uses when it answers a plain `not_friends`.
 *
 * Rollback (same shape as every other surface here): set `enabled: false` and
 * redeploy. `GET /api/people` answers `503 directory_disabled`, the panel hides
 * itself, and exact-handle requests on /friends/ keep working unchanged.
 */
export type DirectoryConfig = {
	/** Master switch for the index. false = endpoint refuses, panel hidden. */
	enabled: boolean;
	/** Rows returned per request. The endpoint reports `truncated` instead of paging. */
	pageSize: number;
	/** Shortest search string accepted. Handles are 3-20 characters. */
	minQueryLength: number;
	/** Longest search string before it is refused as `invalid_query`. */
	maxQueryLength: number;
	rate: {
		/**
		 * Per-account window. The two D1 reads behind a request are cheap; the point
		 * is to stop a walk, not a search. `requests` is deliberately generous
		 * because the panel searches as you type (see `searchDebounceMs`): a budget
		 * sized to a click-per-minute page would lock someone out mid-thought.
		 */
		windowMs: number;
		requests: number;
	};
	/**
	 * How long the panel waits after the last keystroke before it asks. Public
	 * config, so it is one number with the rest of the knobs rather than a
	 * constant buried in src/scripts/.
	 */
	searchDebounceMs: number;
};

export const DIRECTORY_CONFIG: DirectoryConfig = {
	enabled: true,
	pageSize: 30,
	minQueryLength: 3,
	maxQueryLength: 20,
	rate: { windowMs: 60_000, requests: 30 },
	searchDebounceMs: 350,
};
