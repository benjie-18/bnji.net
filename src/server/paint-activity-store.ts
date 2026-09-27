/**
 * Admin-only read path for compact shared Paint publish summaries.
 *
 * Visitor IDs are server-issued, random browser-session values, not accounts.
 * Artwork, pointer coordinates, request bodies and client metadata are never
 * selected here. Retention matches security_events (60 days, lazy purge).
 */
type D1Statement = {
	bind(...values: (string | number)[]): D1Statement;
	all<T>(): Promise<{ results: T[] }>;
	first<T>(column?: string): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
};

type D1Database = { prepare(query: string): D1Statement };

type PaintActivityRow = {
	id: number;
	created_at: number;
	revision: number;
	visitor_id: string;
	actions_json: string;
};

export const PAINT_ACTIVITY_RETENTION_DAYS = 60;
export const PAINT_ACTIVITY_MAX_ROWS = 5000;

export async function listPaintActivity(db: D1Database, limit = 50): Promise<{
	events: { id: number; createdAt: number; revision: number; visitorId: string; actions: Record<string, number> }[];
	total: number;
	retentionDays: number;
}> {
	const count = await db.prepare('SELECT COUNT(*) AS cnt FROM board_paint_activity').first<number>('cnt');
	if (Number(count ?? 0) > PAINT_ACTIVITY_MAX_ROWS) {
		const cutoff = Date.now() - PAINT_ACTIVITY_RETENTION_DAYS * 86_400_000;
		await db.prepare('DELETE FROM board_paint_activity WHERE created_at < ?1').bind(cutoff).run();
	}

	const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 1), 100);
	const { results } = await db
		.prepare(
			`SELECT id, created_at, revision, visitor_id, actions_json
			 FROM board_paint_activity ORDER BY created_at DESC, id DESC LIMIT ?1`,
		)
		.bind(safeLimit)
		.all<PaintActivityRow>();
	const total = await db.prepare('SELECT COUNT(*) AS cnt FROM board_paint_activity').first<number>('cnt');

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
		retentionDays: PAINT_ACTIVITY_RETENTION_DAYS,
	};
}
