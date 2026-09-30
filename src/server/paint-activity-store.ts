/**
 * Admin-only read path for compact shared Paint publish summaries.
 *
 * Visitor IDs are server-issued, random browser-session values, not accounts.
 * Artwork, pointer coordinates, request bodies and client metadata are never
 * selected here. Retention follows the shared admin setting (60 days by
 * default); admin reads purge at most 100 expired rows per call.
 */
import { getTrackingRetentionDays, purgeExpiredTrackingRows } from './tracking-retention';

type D1Statement = {
	bind(...values: (string | number)[]): D1Statement;
	all<T>(): Promise<{ results: T[] }>;
	first<T>(column?: string): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
};

type D1Database = { prepare(query: string): D1Statement };
type PruneStatement = {
	bind(...values: (string | number | null)[]): PruneStatement;
	first<T>(column?: string): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
};
type PruneDatabase = { prepare(query: string): PruneStatement };

type PaintActivityRow = {
	id: number;
	created_at: number;
	revision: number;
	visitor_id: string;
	actions_json: string;
};

export const PAINT_ACTIVITY_MAX_ROWS = 5000;
export const PAINT_ACTIVITY_PRUNE_BATCH_ROWS = 1;

/** Keep inserts' cap maintenance bounded even if a legacy table is already over its limit. */
export function preparePaintActivityTrim(db: PruneDatabase, maxRows = PAINT_ACTIVITY_MAX_ROWS, batchRows = PAINT_ACTIVITY_PRUNE_BATCH_ROWS): PruneStatement {
	return db.prepare(
		`DELETE FROM board_paint_activity WHERE id IN (
			SELECT id FROM board_paint_activity
			WHERE id NOT IN (SELECT id FROM board_paint_activity ORDER BY created_at DESC, id DESC LIMIT ?1)
			ORDER BY created_at ASC, id ASC LIMIT ?2
		)`,
	).bind(maxRows, batchRows);
}

/** Preserve only the most recent bounded set of Paint idempotency keys, deleting at most one per publish. */
export function preparePaintCommitTrim(db: PruneDatabase, maxRows: number, batchRows = 1): PruneStatement {
	return db.prepare(
		`DELETE FROM board_paint_commits WHERE request_id IN (
			SELECT request_id FROM board_paint_commits
			WHERE request_id NOT IN (SELECT request_id FROM board_paint_commits ORDER BY created_at DESC, rowid DESC LIMIT ?1)
			ORDER BY created_at ASC, rowid ASC LIMIT ?2
		)`,
	).bind(maxRows, batchRows);
}

export async function listPaintActivity(db: D1Database, limit = 50): Promise<{
	events: { id: number; createdAt: number; revision: number; visitorId: string; actions: Record<string, number> }[];
	total: number;
	retentionDays: number;
}> {
	const retentionDays = await getTrackingRetentionDays(db);
	const cutoff = Date.now() - retentionDays * 86_400_000;
	await purgeExpiredTrackingRows(db, 'board_paint_activity', cutoff);

	const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 1), 100);
	const { results } = await db
		.prepare(
			`SELECT id, created_at, revision, visitor_id, actions_json
			 FROM board_paint_activity WHERE created_at >= ?2 ORDER BY created_at DESC, id DESC LIMIT ?1`,
		)
		.bind(safeLimit, cutoff)
		.all<PaintActivityRow>();
	const total = await db.prepare('SELECT COUNT(*) AS cnt FROM board_paint_activity WHERE created_at >= ?1').bind(cutoff).first<number>('cnt');

	return {
		events: results.map((row) => {
			let actions: Record<string, number> = {};
			try {
				const parsed: unknown = JSON.parse(row.actions_json);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					actions = parsed as Record<string, number>;
				}
			} catch {
				// Keep a malformed legacy row visible without exposing its raw JSON.
			}
			return {
				id: Number(row.id),
				createdAt: Number(row.created_at),
				revision: Number(row.revision),
				visitorId: row.visitor_id,
				actions,
			};
		}),
		total: Number(total ?? 0),
		retentionDays,
	};
}
