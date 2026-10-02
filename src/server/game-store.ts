/** D1 data access for private play aggregates and server-validated public scores. */
import { formatPublicLabel } from './display-name';
import { closeStaleGameSessions, purgeGameRetention } from './tracking-retention';

export type D1Statement = {
	bind(...values: (string | number | null)[]): D1Statement;
	all<T>(): Promise<{ results: T[] }>;
	first<T>(column?: string): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
};
export type D1Database = {
	prepare(sql: string): D1Statement;
	batch?(statements: D1Statement[]): Promise<unknown[]>;
};

export type GameSessionUpdate = {
	sessionId: string;
	runId: string;
	playerId: string | null;
	gameId: string;
	kind: 'start' | 'heartbeat' | 'end';
	activeMs: number;
	now: number;
	ipAddress: string;
	userAgent: string;
	browser: string;
	operatingSystem: string;
	deviceClass: string;
	screenClass: string;
	inputClass: string;
};

const MAX_ACTIVE_DELTA_MS = 65_000;

/**
 * Create/reopen a session on start; otherwise update the existing row atomically.
 * Client active time is clamped by both payload and server-observed interval.
 */
export async function recordGameSession(db: D1Database, item: GameSessionUpdate): Promise<boolean> {
	const safeActiveMs = Math.min(MAX_ACTIVE_DELTA_MS, Math.max(0, Math.floor(item.activeMs)));
	const { sessionId, runId, playerId, gameId, now } = item;
	if (item.kind === 'start') {
		const result = await db.prepare(
			`INSERT INTO game_sessions
			 (session_id, run_id, player_id, game_id, started_at, ended_at, last_seen_at, last_heartbeat_at, active_ms,
			  ip_address, user_agent, browser, operating_system, device_class, screen_class, input_class)
			 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?5, ?5, 0, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
			 ON CONFLICT(session_id, game_id, run_id) DO UPDATE SET
			   player_id = COALESCE(excluded.player_id, game_sessions.player_id),
			   started_at = CASE WHEN game_sessions.ended_at IS NOT NULL THEN excluded.started_at ELSE game_sessions.started_at END,
			   ended_at = NULL,
			   last_seen_at = excluded.last_seen_at,
			   last_heartbeat_at = excluded.last_heartbeat_at,
			   ip_address = excluded.ip_address,
			   user_agent = excluded.user_agent,
			   browser = excluded.browser,
			   operating_system = excluded.operating_system,
			   device_class = excluded.device_class,
			   screen_class = excluded.screen_class,
			   input_class = excluded.input_class`,
		).bind(
			sessionId, runId, playerId, gameId, now, item.ipAddress, item.userAgent.slice(0, 512), item.browser.slice(0, 40),
			item.operatingSystem.slice(0, 40), item.deviceClass.slice(0, 20), item.screenClass, item.inputClass,
		).run();
		return (result.meta?.changes ?? 0) > 0;
	}

	const result = await db.prepare(
		`UPDATE game_sessions
		 SET active_ms = active_ms + MIN(?1, 65000, MAX(0, ?2 - last_heartbeat_at)),
		     last_seen_at = ?2,
		     last_heartbeat_at = ?2,
		     ended_at = CASE WHEN ?3 = 'end' THEN ?2 ELSE ended_at END
		 WHERE session_id = ?4 AND game_id = ?5 AND run_id = ?6 AND ended_at IS NULL
		   AND (?3 = 'end' OR ?2 - last_heartbeat_at >= 45000)`,
	).bind(safeActiveMs, now, item.kind, sessionId, gameId, runId).run();
	return (result.meta?.changes ?? 0) > 0;
}

export type PublicScore = { displayName: string; score: number; tieBreak: number | null; achievedAt: number };

/**
 * Rows carry the caller's CURRENT public label, not the label they typed when
 * the run was submitted: an account's row is composed from `game_players`
 * (handle + display name) so one rename updates every leaderboard, while a
 * guest row keeps the display name stored on the score. Public surface only —
 * score row IDs, session IDs, player IDs and validation state stay in D1.
 */
function scoreRowLabel(row: { display_name: string; handle: string | null; player_display_name: string | null }): string {
	const composed = formatPublicLabel({ handle: row.handle, displayName: row.player_display_name ?? row.display_name });
	// A stored name that no longer satisfies the sanitizer (a word added to the
	// reserved list, say) must still show something the player recognizes.
	return composed || row.display_name || 'Anonymous';
}

/** Public query deliberately omits score row IDs, session IDs, player IDs, IP/device data, and validation metadata. */
export async function readLeaderboard(
	db: D1Database,
	gameId: string,
	modeId: string,
	page: number,
	pageSize: number,
	cutoff?: number,
): Promise<{ rows: PublicScore[]; hasMore: boolean }> {
	const safePage = Math.min(100, Math.max(0, Math.floor(page)));
	const safePageSize = Math.min(50, Math.max(1, Math.floor(pageSize)));
	const { results } = await db.prepare(
		`SELECT gs.display_name, gs.score, gs.tie_break, gs.achieved_at, p.handle, p.display_name AS player_display_name
		 FROM game_scores gs
		 LEFT JOIN game_players p ON p.id = gs.player_id
		 WHERE gs.game_id = ?1 AND gs.mode_id = ?2 AND gs.validation_state = 'validated'
		   AND (?3 IS NULL OR gs.achieved_at >= ?3)
		 ORDER BY gs.score DESC, COALESCE(gs.tie_break, 1000000001) ASC, gs.achieved_at ASC, gs.id ASC
		 LIMIT ?4 OFFSET ?5`,
	).bind(gameId, modeId, cutoff ?? null, safePageSize + 1, safePage * safePageSize).all<{
		display_name: string; score: number; tie_break: number | null; achieved_at: number;
		handle: string | null; player_display_name: string | null;
	}>();
	return {
		rows: results.slice(0, safePageSize).map((row) => ({
			displayName: scoreRowLabel(row),
			score: Number(row.score),
			tieBreak: row.tie_break === null ? null : Number(row.tie_break),
			achievedAt: Number(row.achieved_at),
		})),
		hasMore: results.length > safePageSize,
	};
}

export type PersonalBest = {
	best: { score: number; tieBreak: number | null; achievedAt: number } | null;
	/** 1-based position among every retained row; null while the caller has no score. */
	rank: number | null;
	entries: number;
};

/**
 * The caller's own standing on one board: their best stored score, their rank
 * among every retained row, and how many rows the board holds.
 *
 * Identity rule, deliberately the same one the account's claim path uses: a
 * signed-in account is measured across EVERY session it has played from (the
 * true account PB, which is what makes an auto-submit decision correct on a
 * second device — and guest rows are backfilled with `player_id` at account
 * create/sign-in, so nothing is stranded). A guest is measured on the
 * validated session id only.
 */
export async function readPersonalBest(
	db: D1Database,
	input: { gameId: string; modeId: string; sessionId: string; playerId: string | null; cutoff?: number },
): Promise<PersonalBest> {
	const owner = input.playerId === null ? 'gs.player_id IS NULL AND gs.session_id = ?3' : 'gs.player_id = ?3';
	const ownerValue = input.playerId ?? input.sessionId;
	const best = await db.prepare(
		`SELECT gs.score, gs.tie_break, gs.achieved_at
		 FROM game_scores gs
		 WHERE gs.game_id = ?1 AND gs.mode_id = ?2 AND gs.validation_state = 'validated'
		   AND (${owner})
		   AND (?4 IS NULL OR gs.achieved_at >= ?4)
		 ORDER BY gs.score DESC, COALESCE(gs.tie_break, 1000000001) ASC, gs.achieved_at ASC, gs.id ASC
		 LIMIT 1`,
	).bind(input.gameId, input.modeId, ownerValue, input.cutoff ?? null)
		.first<{ score: number; tie_break: number | null; achieved_at: number }>();
	// The rank query needs the row above to exist before it can compare against
	// it, so the two are sequential: a single query could answer "how many rows
	// beat score X" but not "X" and "how many beat X" at once.
	const stats = await db.prepare(
		`SELECT COUNT(*) AS entries,
		        COALESCE(SUM(CASE WHEN gs.score > ?4
		             OR (gs.score = ?4 AND COALESCE(gs.tie_break, 1000000001) < COALESCE(?5, 1000000001))
		            THEN 1 ELSE 0 END), 0) AS better
		 FROM game_scores gs
		 WHERE gs.game_id = ?1 AND gs.mode_id = ?2 AND gs.validation_state = 'validated'
		   AND (?3 IS NULL OR gs.achieved_at >= ?3)`,
	).bind(input.gameId, input.modeId, input.cutoff ?? null, best ? Number(best.score) : -1, best?.tie_break ?? null)
		.first<{ entries: number; better: number }>();
	const entries = Number(stats?.entries ?? 0);
	if (!best) return { best: null, rank: null, entries };
	return {
		best: {
			score: Number(best.score),
			tieBreak: best.tie_break === null ? null : Number(best.tie_break),
			achievedAt: Number(best.achieved_at),
		},
		rank: Number(stats?.better ?? 0) + 1,
		entries,
	};
}

export type ValidatedScore = {
	gameId: string;
	modeId: string;
	score: number;
	tieBreak: number | null;
	achievedAt: number;
	sessionId: string;
	playerId: string | null;
	displayName: string;
	idempotencyKey: string;
};

/** Only call after a game-specific server verifier has accepted the run. */
export const MAX_SCORE_RECORDS_PER_MODE = 500;

export async function insertValidatedScore(db: D1Database, score: ValidatedScore): Promise<'stored' | 'not-best' | 'duplicate'> {
	if (!db.batch) throw new Error('atomic_score_batch_unavailable');
	const duplicate = await db.prepare('SELECT game_id, mode_id FROM game_scores WHERE session_id = ?1 AND idempotency_key = ?2')
		.bind(score.sessionId, score.idempotencyKey).first<{ game_id: string; mode_id: string }>();
	if (duplicate) {
		if (duplicate.game_id !== score.gameId || duplicate.mode_id !== score.modeId) throw new Error('idempotency_key_conflict');
		return 'duplicate';
	}
	const insert = db.prepare(
		`INSERT INTO game_scores
		 (game_id, mode_id, score, tie_break, achieved_at, session_id, player_id, display_name, validation_state, idempotency_key)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'validated', ?9)
		 ON CONFLICT(session_id, game_id, mode_id) DO UPDATE SET
		   score = excluded.score, tie_break = excluded.tie_break, achieved_at = excluded.achieved_at,
		   player_id = COALESCE(excluded.player_id, game_scores.player_id), display_name = excluded.display_name,
		   idempotency_key = excluded.idempotency_key
		 WHERE excluded.score > game_scores.score
		    OR (excluded.score = game_scores.score AND COALESCE(excluded.tie_break, 1000000001) < COALESCE(game_scores.tie_break, 1000000001))`,
	).bind(
		score.gameId, score.modeId, score.score, score.tieBreak, score.achievedAt, score.sessionId,
		score.playerId, score.displayName, score.idempotencyKey,
	);
	const prune = db.prepare(
		`DELETE FROM game_scores WHERE game_id = ?1 AND mode_id = ?2
		 AND id NOT IN (
		   SELECT id FROM game_scores WHERE game_id = ?1 AND mode_id = ?2 AND validation_state = 'validated'
		   ORDER BY score DESC, COALESCE(tie_break, 1000000001) ASC, achieved_at ASC, id ASC LIMIT ?3
		 )`,
	).bind(score.gameId, score.modeId, MAX_SCORE_RECORDS_PER_MODE);
	await db.batch([insert, prune]);
	const retained = await db.prepare(
		`SELECT idempotency_key FROM game_scores WHERE session_id = ?1 AND game_id = ?2 AND mode_id = ?3 AND score = ?4`,
	).bind(score.sessionId, score.gameId, score.modeId, score.score).first<string>('idempotency_key');
	return retained === score.idempotencyKey ? 'stored' : 'not-best';
}

export type GameAdminSession = {
	gameId: string;
	startedAt: number;
	endedAt: number | null;
	lastSeenAt: number;
	activeMs: number;
	ipAddress: string;
	userAgent: string;
	browser: string;
	operatingSystem: string;
	deviceClass: string;
	screenClass: string;
	inputClass: string;
};

export async function readGameAdminData(db: D1Database, now = Date.now()): Promise<{
	retentionDays: number;
	totals: { gameId: string; sessions: number; activeMs: number; scores: number }[];
	sessions: GameAdminSession[];
}> {
	await closeStaleGameSessions(db, now);
	const { cutoff } = await purgeGameRetention(db, now);
	const [totals, sessions] = await Promise.all([
		db.prepare(
			`SELECT s.game_id, COUNT(*) AS sessions, SUM(s.active_ms) AS active_ms,
			 (SELECT COUNT(*) FROM game_scores sc WHERE sc.game_id = s.game_id AND sc.achieved_at >= ?1) AS scores
			 FROM game_sessions s WHERE s.last_seen_at >= ?1 GROUP BY s.game_id ORDER BY active_ms DESC LIMIT 100`,
		).bind(cutoff).all<{ game_id: string; sessions: number; active_ms: number; scores: number }>(),
		db.prepare(
			`SELECT game_id, started_at, ended_at, last_seen_at, active_ms, ip_address,
			 user_agent, browser, operating_system, device_class, screen_class, input_class
			 FROM game_sessions WHERE last_seen_at >= ?1 ORDER BY last_seen_at DESC LIMIT 100`,
		).bind(cutoff).all<Record<string, unknown>>(),
	]);
	const retentionDays = Math.round((now - cutoff) / 86_400_000);
	return {
		retentionDays,
		totals: totals.results.map((row) => ({ gameId: row.game_id, sessions: Number(row.sessions), activeMs: Number(row.active_ms ?? 0), scores: Number(row.scores) })),
		sessions: sessions.results.map((row) => ({
			gameId: String(row.game_id), startedAt: Number(row.started_at),
			endedAt: row.ended_at === null ? null : Number(row.ended_at), lastSeenAt: Number(row.last_seen_at),
			activeMs: Number(row.active_ms), ipAddress: String(row.ip_address), userAgent: String(row.user_agent), browser: String(row.browser),
			operatingSystem: String(row.operating_system), deviceClass: String(row.device_class), screenClass: String(row.screen_class), inputClass: String(row.input_class),
		})),
	};
}
