/**
 * BNJI.NET — chat plan Phase D: DM report evidence (plan §12.5's "report
 * path", owner answer 2026-09-30: the gate is filled inside Phase D).
 *
 * Mirrors Phase C's proven board/room flow: a report never removes anything —
 * it snapshots the message body and attachment id at report time into
 * `dm_reports`, so evidence survives the 60-day message window, retention
 * purges, and even account deletion. Hashed principals only (author_hash =
 * sha256('player:' + sender), reporter_hash likewise), distinct-report
 * counting through `dm_reporters` — exactly the chat_reports pattern, which
 * is why the admin Chat tab can triage both with one queue.
 */
import type { D1Database } from './game-store';
import { addModerationLog } from './chat-moderation';
import { sha256Hex } from './player-store';

const MAX_LIST = 100;

export type DmReportRow = {
	convId: string;
	messageN: number;
	authorHash: string;
	reporterHash: string;
	body: string;
	imageId: string | null;
	messageAt: number;
	reportCount: number;
	firstReportedAt: number;
	reportedAt: number;
	status: 'open' | 'resolved' | 'dismissed';
	statusNote: string | null;
	moderatedAt: number | null;
};

export type DmMessageSnapshot = { sender: string; body: string; imageId: string | null; messageAt: number };

/** Snapshot the message (D1 is right there — no DO round-trip, unlike rooms). */
export async function recordDmReport(db: D1Database, input: {
	convId: string; messageN: number; snapshot: DmMessageSnapshot; reporterId: string; now?: number;
}): Promise<{ reportCount: number; created: boolean }> {
	const now = input.now ?? Date.now();
	const reporterHash = await sha256Hex(`player:${input.reporterId}`);
	const authorHash = await sha256Hex(`player:${input.snapshot.sender}`);
	const reporter = await db.prepare(
		'INSERT OR IGNORE INTO dm_reporters (conv_id, message_n, reporter_hash, created_at) VALUES (?, ?, ?, ?)',
	).bind(input.convId, input.messageN, reporterHash, now).run();
	const isNewReporter = (reporter.meta?.changes ?? 0) > 0;
	// Distinct-report counting (same rule as chat_reporters): a repeat reporter
	// refreshes `reported_at`/status but never inflates the count.
	// All-anonymous placeholders (mixing `?` with `?N` is not allowed in SQLite).
	await db.prepare(
		`INSERT INTO dm_reports (conv_id, message_n, author_hash, reporter_hash, body, image_id, message_at,
			report_count, first_reported_at, reported_at, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'open')
		 ON CONFLICT(conv_id, message_n) DO UPDATE SET
		   report_count = dm_reports.report_count + ?,
		   reported_at = ?,
		   status = CASE WHEN dm_reports.status = 'dismissed' THEN 'open' ELSE dm_reports.status END`,
	).bind(
		input.convId, input.messageN, authorHash, reporterHash,
		input.snapshot.body, input.snapshot.imageId, input.snapshot.messageAt, now, now,
		isNewReporter ? 1 : 0, now,
	).run();
	const row = await db.prepare(
		'SELECT report_count FROM dm_reports WHERE conv_id = ?1 AND message_n = ?2',
	).bind(input.convId, input.messageN).first<{ report_count: number }>();
	const reportCount = Number(row?.report_count ?? 1);
	return { reportCount, created: reportCount === 1 };
}

/** Audit-log the report into the SAME chat_moderation_log as room reports. */
export async function logDmReport(db: D1Database, input: { convId: string; messageN: number; reporterHash: string; now?: number }): Promise<void> {
	await addModerationLog(db, {
		action: 'dm_report',
		roomCode: `dm:${input.convId}`,
		messageN: input.messageN,
		targetHash: input.reporterHash,
		detail: 'reported by a conversation participant',
		now: input.now,
	});
}

export function mapDmReport(row: Record<string, unknown>): DmReportRow {
	return {
		convId: String(row.conv_id),
		messageN: Number(row.message_n),
		authorHash: String(row.author_hash),
		reporterHash: String(row.reporter_hash),
		body: String(row.body ?? ''),
		imageId: row.image_id === null || row.image_id === undefined ? null : String(row.image_id),
		messageAt: Number(row.message_at),
		reportCount: Number(row.report_count),
		firstReportedAt: Number(row.first_reported_at),
		reportedAt: Number(row.reported_at),
		status: String(row.status) as DmReportRow['status'],
		statusNote: row.status_note === null || row.status_note === undefined ? null : String(row.status_note),
		moderatedAt: row.moderated_at === null || row.moderated_at === undefined ? null : Number(row.moderated_at),
	};
}

export async function listDmReports(db: D1Database, options: { status?: DmReportRow['status'] | 'all'; limit?: number } = {}): Promise<DmReportRow[]> {
	const limit = Math.min(MAX_LIST, Math.max(1, options.limit ?? 50));
	const columns = 'conv_id, message_n, author_hash, reporter_hash, body, image_id, message_at, report_count, first_reported_at, reported_at, status, status_note, moderated_at';
	const rows = options.status && options.status !== 'all'
		? await db.prepare(`SELECT ${columns} FROM dm_reports WHERE status = ?1 ORDER BY reported_at DESC LIMIT ?`).bind(options.status, limit).all<Record<string, unknown>>()
		: await db.prepare(`SELECT ${columns} FROM dm_reports ORDER BY reported_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
	return (rows.results ?? []).map(mapDmReport);
}

export async function getDmReport(db: D1Database, convId: string, messageN: number): Promise<DmReportRow | null> {
	const row = await db.prepare(
		'SELECT conv_id, message_n, author_hash, reporter_hash, body, image_id, message_at, report_count, first_reported_at, reported_at, status, status_note, moderated_at FROM dm_reports WHERE conv_id = ?1 AND message_n = ?2',
	).bind(convId, messageN).first<Record<string, unknown>>();
	return row ? mapDmReport(row) : null;
}

/** Same status vocabulary as room reports; updates land in the shared log by the caller (action route). */
export async function setDmReportStatus(db: D1Database, input: {
	convId: string; messageN: number; status: DmReportRow['status']; note?: string | null; now?: number;
}): Promise<DmReportRow | null> {
	const now = input.now ?? Date.now();
	await db.prepare(
		'UPDATE dm_reports SET status = ?, status_note = ?, moderated_at = ? WHERE conv_id = ? AND message_n = ?',
	).bind(input.status, input.note ?? null, now, input.convId, input.messageN).run();
	return getDmReport(db, input.convId, input.messageN);
}

/** Export helpers (§9.5): reports ON this account's messages + reports it filed. */
export async function exportDmReportsOnAccount(db: D1Database, authorHash: string, limit = 100): Promise<DmReportRow[]> {
	const rows = await db.prepare(
		`SELECT conv_id, message_n, author_hash, reporter_hash, body, image_id, message_at, report_count, first_reported_at, reported_at, status, status_note, moderated_at
		 FROM dm_reports WHERE author_hash = ?1 ORDER BY reported_at DESC LIMIT ?`,
	).bind(authorHash, Math.min(MAX_LIST, limit)).all<Record<string, unknown>>();
	return (rows.results ?? []).map(mapDmReport);
}

export async function exportDmReportsFiled(db: D1Database, reporterHash: string, limit = 100): Promise<Array<{ convId: string; messageN: number; createdAt: number }>> {
	const rows = await db.prepare(
		'SELECT conv_id, message_n, created_at FROM dm_reporters WHERE reporter_hash = ?1 ORDER BY created_at DESC LIMIT ?',
	).bind(reporterHash, Math.min(MAX_LIST, limit)).all<Record<string, unknown>>();
	return (rows.results ?? []).map((row) => ({
		convId: String(row.conv_id),
		messageN: Number(row.message_n),
		createdAt: Number(row.created_at),
	}));
}
