/**
 * BNJI.NET — profile analytics storage (D1).
 *
 * Provides view counting (daily session dedup), reaction management (counts
 * and creation with per-session cooldown), and link-click recording.
 * Parallels src/server/board-store.ts in style: returns null when the
 * database binding is missing, so callers degrade gracefully.
 *
 * Privacy: session_key is an ephemeral random cookie value — it is not a
 * fingerprint, not linked to IP, and has no meaning outside the dedup
 * window. No personal data is stored.
 *
 * All write methods are fire-and-forget safe: callers should catch errors
 * and continue rendering the profile page regardless of storage state.
 */

/* --- structural D1 types (same pattern as board-store) -------------------- */

type D1PreparedStatement = {
	bind(...values: (string | number | null)[]): D1PreparedStatement;
	all<T>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta?: { changes?: number } }>;
	/**
	 * With a column name, D1 resolves to that column's SCALAR value (not a row
	 * object) — `first<number>('cnt')` is the number itself. Without one, it
	 * resolves to the whole row. Callers below rely on the scalar form.
	 */
	first<T>(colName?: string): Promise<T | null>;
};

type D1Database = {
	prepare(query: string): D1PreparedStatement;
};

/* --- public types --------------------------------------------------------- */

export type ReactionCounts = Record<string, number>;

export type ViewStats = {
	total: number;
	today: number;
	week: number;
	month: number;
};

export type LinkClicks = Record<string, number>;

export type ReactionRow = {
	reaction: string;
	session_key: string;
	created_at: number;
};

export type TimeSeriesBucket = {
	label: string;
	timestamp: number;
	count: number;
};

export type TimeSeriesScope = 'global' | 'homepage' | 'projects' | 'me';
export type TimeSeriesRange = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

export interface ProfileStore {
	readonly kind: 'd1';

	/* Views */
	recordView(profileSlug: string, sessionKey: string, dayKey: string, now: number): Promise<boolean>;
	getViewStats(profileSlug: string): Promise<ViewStats>;
	getAllTrackedPages(): Promise<{ slug: string; name: string; total: number; today: number; week: number; month: number }[]>;
	getTimeSeriesViews(scope: TimeSeriesScope, timeRange: TimeSeriesRange): Promise<TimeSeriesBucket[]>;

	/* Reactions */
	getReactionCounts(profileSlug: string): Promise<ReactionCounts>;
	addReaction(profileSlug: string, reaction: string, sessionKey: string, now: number): Promise<boolean>;
	getRecentReaction(profileSlug: string, reaction: string, sessionKey: string, since: number): Promise<boolean>;

	/* Link clicks */
	recordLinkClick(profileSlug: string, linkId: string, sessionKey: string, now: number): Promise<void>;
	getLinkClicks(profileSlug: string): Promise<LinkClicks>;
}

/* --- implementation ------------------------------------------------------- */

function createD1ProfileStore(db: D1Database): ProfileStore {
	return {
		kind: 'd1',

		async recordView(profileSlug, sessionKey, dayKey, now) {
			// Check if this session has already been counted today
			const existing = await db
				.prepare(
					'SELECT id FROM profile_views WHERE profile_slug = ?1 AND session_key = ?2 AND day_key = ?3 LIMIT 1',
				)
				.bind(profileSlug, sessionKey, dayKey)
				.first<number>('id');

			if (existing !== null) return false;

			await db
				.prepare(
					'INSERT INTO profile_views (profile_slug, session_key, day_key, created_at) VALUES (?1, ?2, ?3, ?4)',
				)
				.bind(profileSlug, sessionKey, dayKey, now)
				.run();
			return true;
		},

		async getAllTrackedPages() {
			const { results } = await db
				.prepare('SELECT DISTINCT profile_slug FROM profile_views')
				.bind()
				.all<{ profile_slug: string }>();

			const pages: { slug: string; name: string; total: number; today: number; week: number; month: number }[] = [];
			for (const row of results) {
				const slug = row.profile_slug;
				const stats = await this.getViewStats(slug);
				pages.push({
					slug,
					name: slug.startsWith('/') ? slug : `/${slug}/`,
					...stats,
				});
			}
			return pages.sort((a, b) => b.total - a.total);
		},

		async getTimeSeriesViews(scope, timeRange) {
			const now = Date.now();
			let whereClause = '';
			const values: (string | number)[] = [];

			// Scope filter
			if (scope === 'homepage') {
				whereClause = "WHERE (profile_slug = '/' OR profile_slug = '' OR profile_slug = 'homepage')";
			} else if (scope === 'projects') {
				whereClause = "WHERE profile_slug LIKE '/projects%'";
			} else if (scope === 'me') {
				whereClause = "WHERE (profile_slug LIKE '%gizlyy%' OR profile_slug LIKE '%me%' OR profile_slug LIKE '%profile%')";
			}

			// Time range cutoff
			let intervalMs = 86_400_000;
			let bucketCount = 30;

			if (timeRange === 'hour') {
				intervalMs = 3_600_000;
				bucketCount = 24;
			} else if (timeRange === 'day') {
				intervalMs = 86_400_000;
				bucketCount = 30;
			} else if (timeRange === 'week') {
				intervalMs = 7 * 86_400_000;
				bucketCount = 12;
			} else if (timeRange === 'month') {
				intervalMs = 30 * 86_400_000;
				bucketCount = 12;
			} else if (timeRange === 'year') {
				intervalMs = 365 * 86_400_000;
				bucketCount = 5;
			} else if (timeRange === 'all') {
				intervalMs = 30 * 86_400_000;
				bucketCount = 24;
			}

			const since = now - bucketCount * intervalMs;
			whereClause += whereClause ? ` AND created_at >= ${since}` : `WHERE created_at >= ${since}`;

			const { results } = await db
				.prepare(`SELECT created_at FROM profile_views ${whereClause} ORDER BY created_at ASC`)
				.bind(...values)
				.all<{ created_at: number }>();

			// Initialize buckets
			const buckets: TimeSeriesBucket[] = [];
			for (let i = bucketCount - 1; i >= 0; i--) {
				const start = now - i * intervalMs;
				const date = new Date(start);
				let label = '';
				if (timeRange === 'hour') {
					label = `${date.getHours().toString().padStart(2, '0')}:00`;
				} else if (timeRange === 'day') {
					label = `${date.getMonth() + 1}/${date.getDate()}`;
				} else if (timeRange === 'week' || timeRange === 'month' || timeRange === 'all') {
					label = `${date.toLocaleString('default', { month: 'short' })} ${date.getDate()}`;
				} else {
					label = `${date.getFullYear()}`;
				}
				buckets.push({ label, timestamp: start, count: 0 });
			}

			// Aggregate query results into corresponding bucket
			for (const row of results) {
				const t = Number(row.created_at);
				const idx = buckets.findIndex((b, i) => {
					const nextT = i < buckets.length - 1 ? buckets[i + 1].timestamp : Infinity;
					return t >= b.timestamp && t < nextT;
				});
				if (idx !== -1) {
					buckets[idx].count++;
				}
			}

			return buckets;
		},

		async getViewStats(profileSlug) {
			const now = Date.now();
			const oneDay = 86_400_000;
			const startOfDay = now - (now % oneDay);
			const startOfWeek = startOfDay - 6 * oneDay;
			const startOfMonth = startOfDay - 29 * oneDay;

			// Total unique views (count distinct day_key per session)
			const totalRow = await db
				.prepare(
					'SELECT COUNT(*) as cnt FROM (SELECT DISTINCT session_key, day_key FROM profile_views WHERE profile_slug = ?1)',
				)
				.bind(profileSlug)
				.first<number>('cnt');

			// Today: new views counted today
			const todayRow = await db
				.prepare(
					'SELECT COUNT(*) as cnt FROM profile_views WHERE profile_slug = ?1 AND created_at >= ?2',
				)
				.bind(profileSlug, startOfDay)
				.first<number>('cnt');

			// This week
			const weekRow = await db
				.prepare(
					'SELECT COUNT(*) as cnt FROM profile_views WHERE profile_slug = ?1 AND created_at >= ?2',
				)
				.bind(profileSlug, startOfWeek)
				.first<number>('cnt');

			// This month
			const monthRow = await db
				.prepare(
					'SELECT COUNT(*) as cnt FROM profile_views WHERE profile_slug = ?1 AND created_at >= ?2',
				)
				.bind(profileSlug, startOfMonth)
				.first<number>('cnt');

			// D1's first(<col>) resolves to that column's scalar value, not a
			// row object — read it directly rather than as `.cnt`.
			return {
				total: Number(totalRow ?? 0),
				today: Number(todayRow ?? 0),
				week: Number(weekRow ?? 0),
				month: Number(monthRow ?? 0),
			};
		},

		async getReactionCounts(profileSlug) {
			const { results } = await db
				.prepare(
					'SELECT reaction, COUNT(*) as cnt FROM profile_reactions WHERE profile_slug = ?1 GROUP BY reaction',
				)
				.bind(profileSlug)
				.all<{ reaction: string; cnt: number }>();

			const counts: ReactionCounts = {};
			for (const row of results) {
				counts[row.reaction] = Number(row.cnt);
			}
			return counts;
		},

		async addReaction(profileSlug, reaction, sessionKey, now) {
			await db
				.prepare(
					'INSERT INTO profile_reactions (profile_slug, reaction, session_key, created_at) VALUES (?1, ?2, ?3, ?4)',
				)
				.bind(profileSlug, reaction, sessionKey, now)
				.run();
			return true;
		},

		async getRecentReaction(profileSlug, reaction, sessionKey, since) {
			const row = await db
				.prepare(
					'SELECT id FROM profile_reactions WHERE profile_slug = ?1 AND reaction = ?2 AND session_key = ?3 AND created_at >= ?4 LIMIT 1',
				)
				.bind(profileSlug, reaction, sessionKey, since)
				.first<number>('id');
			return row !== null;
		},

		async recordLinkClick(profileSlug, linkId, sessionKey, now) {
			await db
				.prepare(
					'INSERT INTO profile_link_clicks (profile_slug, link_id, session_key, created_at) VALUES (?1, ?2, ?3, ?4)',
				)
				.bind(profileSlug, linkId, sessionKey, now)
				.run();
		},

		async getLinkClicks(profileSlug) {
			const { results } = await db
				.prepare(
					'SELECT link_id, COUNT(*) as cnt FROM profile_link_clicks WHERE profile_slug = ?1 GROUP BY link_id',
				)
				.bind(profileSlug)
				.all<{ link_id: string; cnt: number }>();

			const clicks: LinkClicks = {};
			for (const row of results) {
				clicks[row.link_id] = Number(row.cnt);
			}
			return clicks;
		},
	};
}

/* --- selection ------------------------------------------------------------ */

/**
 * Resolve the profile store for one request. Returns null when the D1
 * binding is unavailable — callers should degrade gracefully (skip
 * analytics, still render the page).
 */
export function getProfileStore(env: Record<string, unknown> | undefined): ProfileStore | null {
	const db = env?.BOARD_DB as D1Database | undefined;
	if (db && typeof db.prepare === 'function') return createD1ProfileStore(db);
	return null;
}