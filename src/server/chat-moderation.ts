/**
 * Chat plan Phase C — moderation data access (D1, `BOARD_DB`).
 *
 * Everything here is deliberately plain SQL over the same D1 binding the rest
 * of the Games stack uses. The DO never talks to D1: reports are snapshotted
 * by the room (`/report`) and *persisted* by the Worker through these helpers,
 * so the service boundary stays Worker→D1 and DO→room-content.
 *
 * Identity note: every `*Hash` field is sha256 of a room principal
 * (`player:<id>` / `guest:<session>`), the same identifier room membership
 * already uses. No raw ids, no IPs, no cookies are stored here.
 */
import type { D1Database } from './game-store';

export type RoomRegistryEntry = { code: string; gameId: string; ownerHash: string; createdAt: number; expiresAt: number };
export type ChatReportRow = {
	id: number; roomCode: string; messageN: number; authorHash: string; label: string; text: string;
	messageAt: number; reportCount: number; firstReportedAt: number; reportedAt: number;
	status: 'open' | 'resolved' | 'dismissed'; statusNote: string | null; moderatedAt: number | null;
};
export type ChatReportSnapshot = { authorHash: string; label: string; text: string; messageAt: number };
export type ModerationLogRow = { id: number; action: string; roomCode: string | null; messageN: number | null; targetHash: string | null; detail: string | null; createdAt: number };
export type ChatBanRow = { principalHash: string; reason: string | null; createdAt: number; expiresAt: number };

const MAX_LIST = 100;

/** Registry write happens once per room, best-effort: a failed insert never fails an already-created room. */
export async function registerRoom(db: D1Database, entry: RoomRegistryEntry): Promise<void> {
	await db.prepare(
		'INSERT OR IGNORE INTO room_registry (code, game_id, owner_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
	).bind(entry.code, entry.gameId, entry.ownerHash, entry.createdAt, entry.expiresAt).run();
}

export async function listActiveRooms(db: D1Database, now = Date.now(), limit = 50): Promise<RoomRegistryEntry[]> {
	const rows = await db.prepare(
		'SELECT code, game_id, owner_hash, created_at, expires_at FROM room_registry WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?',
	).bind(now, limit).all<{ code: string; game_id: string; owner_hash: string; created_at: number; expires_at: number }>();
	return (rows.results ?? []).map((row) => ({
		code: row.code, gameId: row.game_id, ownerHash: row.owner_hash,
		createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
	}));
}

export async function getRoomRegistryEntry(db: D1Database, code: string, now = Date.now()): Promise<RoomRegistryEntry | null> {
	const row = await db.prepare(
		'SELECT code, game_id, owner_hash, created_at, expires_at FROM room_registry WHERE code = ?1 AND expires_at > ?2',
	).bind(code, now).first<{ code: string; game_id: string; owner_hash: string; created_at: number; expires_at: number }>();
	if (!row) return null;
	return { code: row.code, gameId: row.game_id, ownerHash: row.owner_hash, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
}

export async function deleteRoomRegistryEntry(db: D1Database, code: string): Promise<void> {
	await db.prepare('DELETE FROM room_registry WHERE code = ?1').bind(code).run();
}

/**
 * Record a report against one message. The first reporter creates the row
 * with the DO-provided snapshot; later distinct reporters only bump the
 * count. Repeat reports from the same principal are filtered BEFORE this is
 * called (insert into chat_reporters succeeded), so this function assumes
 * `reporterHash` is new.
 */
export async function recordChatReport(
	db: D1Database,
	input: { code: string; n: number; snapshot: ChatReportSnapshot; reporterHash: string; now?: number },
): Promise<{ reportCount: number; created: boolean }> {
	const now = input.now ?? Date.now();
	await db.prepare(
		'INSERT OR IGNORE INTO chat_reporters (room_code, message_n, reporter_hash, created_at) VALUES (?, ?, ?, ?)',
	).bind(input.code, input.n, input.reporterHash, now).run();
	const updated = await db.prepare(
		`INSERT INTO chat_reports (room_code, message_n, author_hash, label, text, message_at, report_count, first_reported_at, reported_at, status)
		 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open')
		 ON CONFLICT(room_code, message_n) DO UPDATE SET
		   report_count = chat_reports.report_count + 1,
		   reported_at = ?,
		   status = CASE WHEN chat_reports.status = 'dismissed' THEN 'open' ELSE chat_reports.status END
		 RETURNING report_count`,
	).bind(
		input.code, input.n, input.snapshot.authorHash, input.snapshot.label,
		input.snapshot.text, input.snapshot.messageAt, now, now, now,
	).first<{ report_count: number }>();
	const row = await db.prepare(
		'SELECT report_count FROM chat_reports WHERE room_code = ?1 AND message_n = ?2',
	).bind(input.code, input.n).first<{ report_count: number }>();
	void updated;
	return { reportCount: Number(row?.report_count ?? 1), created: Number(row?.report_count ?? 1) === 1 };
}

/** Whether this principal already reported this message (distinct-report counting). */
export async function hasReporter(db: D1Database, code: string, n: number, reporterHash: string): Promise<boolean> {
	const row = await db.prepare(
		'SELECT 1 AS present FROM chat_reporters WHERE room_code = ?1 AND message_n = ?2 AND reporter_hash = ?3',
	).bind(code, n, reporterHash).first<number>();
	return Boolean(row);
}

export async function listChatReports(db: D1Database, options: { status?: ChatReportRow['status'] | 'all'; limit?: number } = {}): Promise<ChatReportRow[]> {
	const limit = Math.min(MAX_LIST, Math.max(1, options.limit ?? 50));
	const rows = options.status && options.status !== 'all'
		? await db.prepare(
			`SELECT id, room_code, message_n, author_hash, label, text, message_at, report_count, first_reported_at, reported_at, status, status_note, moderated_at
			 FROM chat_reports WHERE status = ?1 ORDER BY reported_at DESC LIMIT ?`,
		).bind(options.status, limit).all<Record<string, unknown>>()
		: await db.prepare(
			`SELECT id, room_code, message_n, author_hash, label, text, message_at, report_count, first_reported_at, reported_at, status, status_note, moderated_at
			 FROM chat_reports ORDER BY reported_at DESC LIMIT ?`,
		).bind(limit).all<Record<string, unknown>>();
	return (rows.results ?? []).map(mapReport);
}

export async function getChatReport(db: D1Database, id: number): Promise<ChatReportRow | null> {
	const row = await db.prepare(
		`SELECT id, room_code, message_n, author_hash, label, text, message_at, report_count, first_reported_at, reported_at, status, status_note, moderated_at
		 FROM chat_reports WHERE id = ?1`,
	).bind(id).first<Record<string, unknown>>();
	return row ? mapReport(row) : null;
}

export async function setChatReportStatus(
	db: D1Database,
	input: { id: number; status: ChatReportRow['status']; note?: string | null; now?: number },
): Promise<ChatReportRow | null> {
	const now = input.now ?? Date.now();
	await db.prepare(
		'UPDATE chat_reports SET status = ?, status_note = ?, moderated_at = ? WHERE id = ?',
	).bind(input.status, input.note ?? null, now, input.id).run();
	return getChatReport(db, input.id);
}

function mapReport(row: Record<string, unknown>): ChatReportRow {
	return {
		id: Number(row.id), roomCode: String(row.room_code), messageN: Number(row.message_n),
		authorHash: String(row.author_hash), label: String(row.label), text: String(row.text),
		messageAt: Number(row.message_at), reportCount: Number(row.report_count),
		firstReportedAt: Number(row.first_reported_at), reportedAt: Number(row.reported_at),
		status: String(row.status) as ChatReportRow['status'],
		statusNote: row.status_note === null || row.status_note === undefined ? null : String(row.status_note),
		moderatedAt: row.moderated_at === null || row.moderated_at === undefined ? null : Number(row.moderated_at),
	};
}

export async function addModerationLog(
	db: D1Database,
	input: { action: string; roomCode?: string | null; messageN?: number | null; targetHash?: string | null; detail?: string | null; now?: number },
): Promise<void> {
	await db.prepare(
		'INSERT INTO chat_moderation_log (action, room_code, message_n, target_hash, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
	).bind(input.action, input.roomCode ?? null, input.messageN ?? null, input.targetHash ?? null, input.detail ?? null, input.now ?? Date.now()).run();
}

export async function listModerationLog(db: D1Database, limit = 50): Promise<ModerationLogRow[]> {
	const rows = await db.prepare(
		'SELECT id, action, room_code, message_n, target_hash, detail, created_at FROM chat_moderation_log ORDER BY created_at DESC, id DESC LIMIT ?',
	).bind(Math.min(MAX_LIST, Math.max(1, limit))).all<Record<string, unknown>>();
	return (rows.results ?? []).map((row) => ({
		id: Number(row.id), action: String(row.action),
		roomCode: row.room_code === null || row.room_code === undefined ? null : String(row.room_code),
		messageN: row.message_n === null || row.message_n === undefined ? null : Number(row.message_n),
		targetHash: row.target_hash === null || row.target_hash === undefined ? null : String(row.target_hash),
		detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
		createdAt: Number(row.created_at),
	}));
}

export async function setChatBan(
	db: D1Database,
	input: { principalHash: string; reason?: string | null; now?: number; expiresAt: number },
): Promise<void> {
	await db.prepare(
		`INSERT INTO chat_bans (principal_hash, reason, created_at, expires_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(principal_hash) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at, expires_at = excluded.expires_at`,
	).bind(input.principalHash, input.reason ?? null, input.now ?? Date.now(), input.expiresAt).run();
}

export async function clearChatBan(db: D1Database, principalHash: string): Promise<void> {
	await db.prepare('DELETE FROM chat_bans WHERE principal_hash = ?1').bind(principalHash).run();
}

/** Active ban expiry, or null. Checked at the /ws upgrade while chat is enabled. */
export async function activeChatBan(db: D1Database, principalHash: string, now = Date.now()): Promise<number | null> {
	const row = await db.prepare(
		'SELECT expires_at FROM chat_bans WHERE principal_hash = ?1 AND expires_at > ?2',
	).bind(principalHash, now).first<{ expires_at: number }>();
	return row ? Number(row.expires_at) : null;
}

export async function listActiveChatBans(db: D1Database, now = Date.now(), limit = 50): Promise<ChatBanRow[]> {
	const rows = await db.prepare(
		'SELECT principal_hash, reason, created_at, expires_at FROM chat_bans WHERE expires_at > ? ORDER BY expires_at DESC LIMIT ?',
	).bind(now, Math.min(MAX_LIST, Math.max(1, limit))).all<Record<string, unknown>>();
	return (rows.results ?? []).map((row) => ({
		principalHash: String(row.principal_hash),
		reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
		createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
	}));
}

/**
 * Minimal structural DB shape for the sweep: tracking-retention's `RetentionDb`
 * satisfies it without importing D1Database (keeps the cron bundle free of the
 * full D1 type graph) while real D1 bindings satisfy it in production.
 */
export type SweepDb = {
	prepare(sql: string): { bind(...values: (string | number)[]): { run(): Promise<{ meta?: { changes?: number } }> } };
};

/**
 * Hourly sweep (plan §9.3): expired registry rows and bans, plus reports,
 * reporter de-dup rows and the audit log past the shared retention window.
 * Bounded per table like every other sweep member.
 */
export async function purgeChatModerationRows(
	db: SweepDb,
	input: { now?: number; cutoff: number; limit?: number },
): Promise<{ registry: number; reports: number; reporters: number; log: number; bans: number }> {
	const now = input.now ?? Date.now();
	const limit = Math.max(1, input.limit ?? 50);
	const registry = await db.prepare(
		'DELETE FROM room_registry WHERE code IN (SELECT code FROM room_registry WHERE expires_at <= ?1 ORDER BY expires_at ASC LIMIT ?2)',
	).bind(now, limit).run();
	const reports = await db.prepare(
		'DELETE FROM chat_reports WHERE id IN (SELECT id FROM chat_reports WHERE reported_at < ?1 ORDER BY reported_at ASC LIMIT ?2)',
	).bind(input.cutoff, limit).run();
	const reporters = await db.prepare(
		`DELETE FROM chat_reporters WHERE (room_code, message_n, reporter_hash) IN (
			SELECT room_code, message_n, reporter_hash FROM chat_reporters WHERE created_at < ?1 ORDER BY created_at ASC LIMIT ?2)`,
	).bind(input.cutoff, limit).run();
	const log = await db.prepare(
		'DELETE FROM chat_moderation_log WHERE id IN (SELECT id FROM chat_moderation_log WHERE created_at < ?1 ORDER BY created_at ASC LIMIT ?2)',
	).bind(input.cutoff, limit).run();
	const bans = await db.prepare(
		'DELETE FROM chat_bans WHERE principal_hash IN (SELECT principal_hash FROM chat_bans WHERE expires_at <= ?1 ORDER BY expires_at ASC LIMIT ?2)',
	).bind(now, limit).run();
	return {
		registry: registry.meta?.changes ?? 0, reports: reports.meta?.changes ?? 0,
		reporters: reporters.meta?.changes ?? 0, log: log.meta?.changes ?? 0, bans: bans.meta?.changes ?? 0,
	};
}

/** Account export: chat messages of mine that were reported (§9.5, Phase C tables). */
export async function exportReportsOnAccount(db: D1Database, authorHash: string, limit = 100): Promise<ChatReportRow[]> {
	const rows = await db.prepare(
		`SELECT id, room_code, message_n, author_hash, label, text, message_at, report_count, first_reported_at, reported_at, status, status_note, moderated_at
		 FROM chat_reports WHERE author_hash = ?1 ORDER BY reported_at DESC LIMIT ?`,
	).bind(authorHash, limit).all<Record<string, unknown>>();
	return (rows.results ?? []).map(mapReport);
}

/** Account export: reports this account filed (dedupe rows are per principal). */
export async function exportFiledReports(db: D1Database, reporterHash: string, limit = 100): Promise<Array<{ roomCode: string; messageN: number; createdAt: number }>> {
	const rows = await db.prepare(
		'SELECT room_code, message_n, created_at FROM chat_reporters WHERE reporter_hash = ?1 ORDER BY created_at DESC LIMIT ?',
	).bind(reporterHash, limit).all<Record<string, unknown>>();
	return (rows.results ?? []).map((row) => ({
		roomCode: String(row.room_code), messageN: Number(row.message_n), createdAt: Number(row.created_at),
	}));
}

/**
 * Statements for account deletion (plan §9.5): every Phase C row keyed to
 * this account's room principal — reported content authored, reports filed,
 * bans, and any rooms they still own. Returned as statements so
 * `deletePlayerAccount` can fold them into its atomic batch.
 * `chat_moderation_log` intentionally keeps its rows: after these deletions
 * its target_hash values have no account to point at (the hash is one-way
 * over an id that no longer exists), so the audit trail stays intact without
 * retaining personal data.
 */
export function accountModerationStatements(db: D1Database, principalHash: string): ReturnType<D1Database['prepare']>[] {
	return [
		db.prepare('DELETE FROM chat_reports WHERE author_hash = ?1').bind(principalHash),
		db.prepare('DELETE FROM chat_reporters WHERE reporter_hash = ?1').bind(principalHash),
		db.prepare('DELETE FROM chat_bans WHERE principal_hash = ?1').bind(principalHash),
		db.prepare('DELETE FROM room_registry WHERE owner_hash = ?1').bind(principalHash),
	];
}

export async function deleteAccountModerationRows(db: D1Database, principalHash: string): Promise<void> {
	for (const statement of accountModerationStatements(db, principalHash)) await statement.run();
}

/** Any ban row for the principal (export shows state either way; the sweep removes expired rows). */
export async function getChatBan(db: D1Database, principalHash: string): Promise<ChatBanRow | null> {
	const row = await db.prepare(
		'SELECT principal_hash, reason, created_at, expires_at FROM chat_bans WHERE principal_hash = ?1',
	).bind(principalHash).first<Record<string, unknown>>();
	if (!row) return null;
	return {
		principalHash: String(row.principal_hash),
		reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
		createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
	};
}
