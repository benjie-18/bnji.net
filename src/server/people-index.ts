/**
 * BNJI.NET — the people index: finding accounts to send a friend request to.
 *
 * `src/server/friend-store.ts` resolves an EXACT handle; this module is the
 * discoverability half, so a player no longer has to learn a handle out of band.
 * Both share one principle: a row is two labels and nothing else.
 *
 * Three properties this file exists to hold:
 *
 *  1. **Only handles.** The candidate set is accounts that chose a handle, which
 *     is the identity the site already publishes on every leaderboard row. An
 *     account without a handle is absent, and the response never says whether a
 *     given name has an account — that is `/api/players`' job and its throttle.
 *  2. **A block hides in both directions.** The filter is in the SQL, not in a
 *     flag, because a flag would tell someone they were blocked. A blocked-away
 *     row is not a lie: /community/friends/ still lists whom *you* blocked, which is the
 *     only side anyone is entitled to see.
 *  3. **Relationship state, never relationship lists.** `friendState` describes
 *     the caller's own edge to that person (the same rows /community/friends/ renders), so
 *     the UI can say "requested" instead of offering a button that will fail.
 */
import type { D1Database } from './game-store';
import { DIRECTORY_CONFIG } from '../config/directory.config';

export type PersonRow = {
	handle: string;
	displayName: string;
	/** The caller's own edge to this account. No edge is `'none'`; a block is no row at all. */
	friendState: 'none' | 'pending_out' | 'pending_in' | 'friends';
};

export type PeoplePage = { people: PersonRow[]; truncated: boolean };

const QUERY_PATTERN = /^[a-z0-9_]+$/;

/** A query is a handle fragment and nothing else: no wildcards, no backslashes. */
export function normalizePeopleQuery(raw: string | null | undefined): { query: string } | { error: string } {
	const query = String(raw ?? '').trim().toLowerCase();
	if (!query) return { query: '' };
	if (query.length < DIRECTORY_CONFIG.minQueryLength) return { error: 'query_too_short' };
	if (query.length > DIRECTORY_CONFIG.maxQueryLength) return { error: 'invalid_query' };
	if (!QUERY_PATTERN.test(query)) return { error: 'invalid_query' };
	return { query };
}

/**
 * `_` is a LIKE wildcard and handles are full of them, so a literal underscore
 * must be escaped or `fo_bar` would match `foXbar`. `%` cannot appear (validated
 * above) but is escaped anyway so the helper stays safe to reuse.
 */
export function likePatternFor(query: string): string {
	return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * A prefix hit outranks a substring hit, then handles sort alphabetically. The
 * COLLATE is explicit because `handle` has no index of its own and SQLite's
 * default ordering is byte order, which for `[a-z0-9_]` is exactly what we want
 * to keep stable.
 */
const CANDIDATES_SQL = `
	SELECT p.id, p.handle, p.display_name
	  FROM game_players p
	 WHERE p.handle IS NOT NULL
	   AND p.id <> ?1
	   AND NOT EXISTS (
			SELECT 1 FROM player_blocks b
			 WHERE (b.blocker = p.id AND b.blocked = ?1)
				    OR (b.blocker = ?1 AND b.blocked = p.id)
	   )
	   AND (?2 = '' OR p.handle LIKE ?3 ESCAPE '\\')
	 ORDER BY CASE WHEN ?2 <> '' AND substr(p.handle, 1, length(?2)) = ?2 THEN 0 ELSE 1 END,
	          p.handle COLLATE BINARY ASC
	 LIMIT ?4`;

/** Every edge the caller has, so the page can label itself without an N+1. */
const EDGES_SQL = 'SELECT player_a, player_b, state, requested_by FROM player_friends WHERE player_a = ?1 OR player_b = ?1';

export async function listPeople(
	db: D1Database,
	callerId: string,
	query: string,
	limit = DIRECTORY_CONFIG.pageSize,
): Promise<PeoplePage> {
	const page = Math.max(1, Math.min(100, Math.trunc(limit)));
	const rows = await db.prepare(CANDIDATES_SQL)
		.bind(callerId, query, query ? likePatternFor(query) : '', page + 1)
		.all<{ id: string; handle: string; display_name: string }>();
	const candidates = Array.isArray(rows?.results) ? rows.results : [];
	const truncated = candidates.length > page;
	const listed = candidates.slice(0, page);
	if (listed.length === 0) return { people: [], truncated: false };

	const edges = await db.prepare(EDGES_SQL).bind(callerId).all<{ player_a: string; player_b: string; state: string; requested_by: string }>();
	const byPeer = new Map<string, { state: string; requestedBy: string }>();
	for (const edge of Array.isArray(edges?.results) ? edges.results : []) {
		const peer = edge.player_a === callerId ? edge.player_b : edge.player_a;
		if (!peer || peer === callerId) continue;
		byPeer.set(String(peer), { state: String(edge.state), requestedBy: String(edge.requested_by) });
	}
	return {
		people: listed.map((row) => ({
			handle: String(row.handle),
			displayName: String(row.display_name),
			friendState: friendStateFor(byPeer.get(String(row.id)), callerId, String(row.id)),
		})),
		truncated,
	};
}

/**
 * `declined` maps to `none` on purpose: a decline is a stale row, not a state to
 * advertise, and the request path (`friendAction`) is what decides whether a new
 * request is allowed. Blocked pairs never reach here — the SQL removed them.
 */
function friendStateFor(edge: { state: string; requestedBy: string } | undefined, callerId: string, peerId: string): PersonRow['friendState'] {
	if (!edge) return 'none';
	if (edge.state === 'accepted') return 'friends';
	if (edge.state !== 'pending') return 'none';
	return edge.requestedBy === callerId ? 'pending_out' : 'pending_in';
}
