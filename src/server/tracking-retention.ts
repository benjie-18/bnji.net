/** Shared dynamic retention policy and bounded expiry sweeps for private engagement rows. */
import { NAMES_CONFIG } from '../config/names.config';
import { purgeChatModerationRows } from './chat-moderation';

type D1Statement = {
	bind(...values: (string | number)[]): D1Statement;
	first<T>(column?: string): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
};
export type RetentionDb = { prepare(sql: string): D1Statement };

export const DEFAULT_TRACKING_RETENTION_DAYS = 60;
export const MIN_TRACKING_RETENTION_DAYS = 1;
export const MAX_TRACKING_RETENTION_DAYS = 365;
/** Per-table/per-invocation cap; sized to reserve D1 Free write headroom for identity and save traffic. */
export const MAX_RETENTION_ROWS_PER_TABLE = 50;
/** A smaller catch-up batch runs only for tables whose primary batch was full. */
export const MAX_RETENTION_ROWS_PER_TABLE_CATCH_UP = 10;
/** Settings read + stale-session close + two security prunes + four primary deletes + four catch-up deletes + guest-profile primary + guest-profile catch-up + five chat-moderation purges (registry, reports, reporters, log, bans — plan Phase C). */
export const MAX_RETENTION_SWEEP_QUERIES = 19;
const DAY_MS = 86_400_000;

function clampRetentionDays(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TRACKING_RETENTION_DAYS;
	return Math.min(MAX_TRACKING_RETENTION_DAYS, Math.max(MIN_TRACKING_RETENTION_DAYS, Math.floor(value)));
}

export type RetentionTable = 'game_sessions' | 'game_scores' | 'security_events' | 'board_paint_activity';
const RETENTION_COLUMNS: Record<RetentionTable, string> = {
	game_sessions: 'last_seen_at',
	game_scores: 'achieved_at',
	security_events: 'created_at',
	board_paint_activity: 'created_at',
};

/** Reads the admin-managed value without fetching the rest of site settings. */
export async function getTrackingRetentionDays(db: RetentionDb): Promise<number> {
	try {
		const value = await db.prepare('SELECT value FROM site_settings WHERE key = ?1').bind('trackingRetentionDays').first<string>('value');
		if (typeof value !== 'string') return DEFAULT_TRACKING_RETENTION_DAYS;
		const parsed: unknown = JSON.parse(value);
		const days = Number(parsed);
		return Number.isInteger(days) && days >= MIN_TRACKING_RETENTION_DAYS && days <= MAX_TRACKING_RETENTION_DAYS
			? days
			: DEFAULT_TRACKING_RETENTION_DAYS;
	} catch {
		return DEFAULT_TRACKING_RETENTION_DAYS;
	}
}

/** Delete at most one bounded batch from a whitelisted raw tracking table. */
export async function purgeExpiredTrackingRows(
	db: RetentionDb,
	table: RetentionTable,
	cutoff: number,
	limit = MAX_RETENTION_ROWS_PER_TABLE,
): Promise<number> {
	const timestampColumn = RETENTION_COLUMNS[table];
	const boundedLimit = Number.isInteger(limit) ? Math.min(MAX_RETENTION_ROWS_PER_TABLE, Math.max(1, limit)) : MAX_RETENTION_ROWS_PER_TABLE;
	const result = await db.prepare(
		`DELETE FROM ${table} WHERE id IN (
			SELECT id FROM ${table} WHERE ${timestampColumn} < ?1 ORDER BY ${timestampColumn} ASC, id ASC LIMIT ?2
		)`,
	).bind(cutoff, boundedLimit).run();
	return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

/** Delete one bounded batch of expired game rows on a scheduled or private admin sweep. */
export async function purgeGameRetention(db: RetentionDb, now = Date.now(), configuredDays?: number): Promise<{ cutoff: number }> {
	const days = clampRetentionDays(configuredDays ?? await getTrackingRetentionDays(db));
	const cutoff = now - days * DAY_MS;
	await purgeExpiredTrackingRows(db, 'game_sessions', cutoff);
	await purgeExpiredTrackingRows(db, 'game_scores', cutoff);
	return { cutoff };
}

/** Close at most one bounded batch of stale game sessions per scheduled sweep. */
export async function closeStaleGameSessions(db: RetentionDb, now = Date.now()): Promise<void> {
	await db.prepare(
		`UPDATE game_sessions SET ended_at = last_seen_at WHERE id IN (
			SELECT id FROM game_sessions WHERE ended_at IS NULL AND last_seen_at < ?1
			ORDER BY last_seen_at ASC, id ASC LIMIT ?2
		)`,
	).bind(now - 120_000, MAX_RETENTION_ROWS_PER_TABLE).run();
}

/** Expired/revoked sessions and aged IP throttle records follow the shared configurable retention window. */
export async function purgeExpiredPlayerSecurityRows(
	db: RetentionDb,
	now = Date.now(),
	retentionDays = DEFAULT_TRACKING_RETENTION_DAYS,
): Promise<number[]> {
	const sessions = await db.prepare(
		`DELETE FROM game_player_sessions WHERE token_hash IN (
			SELECT token_hash FROM game_player_sessions WHERE expires_at <= ?1 OR revoked_at IS NOT NULL
			ORDER BY expires_at ASC LIMIT ?2
		)`,
	).bind(now, MAX_RETENTION_ROWS_PER_TABLE).run();
	const attempts = await db.prepare(
		`DELETE FROM game_auth_attempts WHERE ip_hash IN (
			SELECT ip_hash FROM game_auth_attempts WHERE updated_at < ?1 ORDER BY updated_at ASC LIMIT ?2
		)`,
	).bind(now - clampRetentionDays(retentionDays) * DAY_MS, MAX_RETENTION_ROWS_PER_TABLE).run();
	return [Number(sessions.meta?.changes ?? 0), Number(attempts.meta?.changes ?? 0)];
}

/**
 * Guest display names (chat plan Phase A) follow their own fixed window —
 * NAMES_CONFIG.guestProfiles.retentionDays — not the admin-configurable
 * tracking window: a guest name must outlive no session by more than 30 days
 * regardless of how the board's retention slider is set. Same bounded
 * 50 + 10 batch shape as the tracking tables.
 */
export async function purgeExpiredGuestProfiles(
	db: RetentionDb,
	cutoff: number,
	limit = MAX_RETENTION_ROWS_PER_TABLE,
): Promise<number> {
	const boundedLimit = Number.isInteger(limit) ? Math.min(MAX_RETENTION_ROWS_PER_TABLE, Math.max(1, limit)) : MAX_RETENTION_ROWS_PER_TABLE;
	const result = await db.prepare(
		`DELETE FROM guest_profiles WHERE session_hash IN (
			SELECT session_hash FROM guest_profiles WHERE updated_at < ?1 ORDER BY updated_at ASC, session_hash ASC LIMIT ?2
		)`,
	).bind(cutoff, boundedLimit).run();
	return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

/**
 * One invocation deletes up to 60 expired rows per tracking table: a 50-row
 * primary batch plus a 10-row catch-up batch only when the primary batch was
 * full. Two additional 50-row batches prune expired/revoked player sessions
 * and stale IP throttle buckets, and one bounded batch (plus catch-up) expires
 * guest display names on their fixed 30-day window. At most 14 D1 statements
 * run, well below D1's 50-query invocation ceiling. The row-write budget is
 * documented with the shared Free-plan headroom in docs/GAMES-OPERATIONS.md.
 */
export async function runRetentionSweep(env: Record<string, unknown>): Promise<void> {
	const db = env.BOARD_DB as RetentionDb | undefined;
	if (!db || typeof db.prepare !== 'function') return;
	const days = await getTrackingRetentionDays(db);
	const cutoff = Date.now() - days * DAY_MS;
	try {
		await closeStaleGameSessions(db);
		await purgeExpiredPlayerSecurityRows(db, Date.now(), days);
		const tables: RetentionTable[] = ['game_sessions', 'game_scores', 'security_events', 'board_paint_activity'];
		const firstPass = await Promise.all(tables.map((table) => purgeExpiredTrackingRows(db, table, cutoff)));
		await Promise.all(tables
			.filter((_table, index) => firstPass[index] === MAX_RETENTION_ROWS_PER_TABLE)
			.map((table) => purgeExpiredTrackingRows(db, table, cutoff, MAX_RETENTION_ROWS_PER_TABLE_CATCH_UP)));
		// Guest display names: fixed window, independent of the tracking slider.
		const guestCutoff = Date.now() - NAMES_CONFIG.guestProfiles.retentionDays * DAY_MS;
		const guestPass = await purgeExpiredGuestProfiles(db, guestCutoff);
		if (guestPass === MAX_RETENTION_ROWS_PER_TABLE) {
			await purgeExpiredGuestProfiles(db, guestCutoff, MAX_RETENTION_ROWS_PER_TABLE_CATCH_UP);
		}
		// Phase C: registry + bans expire on their own clocks; reports,
		// reporter de-dup rows and the audit log follow the shared window.
		await purgeChatModerationRows(db, { now: Date.now(), cutoff });
	} catch {
		// Cron failures are visible in Worker invocation logs but contain no visitor data.
		console.error('[bnji] tracking retention sweep failed');
	}
}
