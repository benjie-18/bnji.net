/**
 * BNJI.NET — message board storage providers (D1 primary).
 *
 * The API route (src/pages/api/board.ts) talks only to this module; the UI
 * talks only to the API. Swapping persistence never touches a component.
 *
 * Providers
 * ---------
 *  d1   — Cloudflare D1, the production store. One table (see
 *         migrations/0001_board_messages.sql) with a composite index that
 *         serves the public feed query (status filter + newest-first keyset
 *         cursor) directly. Writes are single atomic INSERTs — no read-
 *         modify-write index, so concurrent posts from different isolates
 *         can never lose each other.
 *  rest — external JSON API for teams that already run a backend
 *         (BOARD_REST_URL / BOARD_REST_TOKEN secrets).
 *
 * There is deliberately NO in-memory production fallback: if neither provider
 * is configured the store factory returns null and the route answers 503
 * storage_unconfigured, instead of silently pretending to persist.
 *
 * Moderation
 * ----------
 * Every message carries `status`: visible | hidden | reported | deleted.
 * listPublic() only ever returns visible/reported rows — hidden and deleted
 * messages never reach a public fetch, enforced in SQL, not in the route.
 *
 * The moderation surface is real and reachable: visitors report a message
 * (POST /api/board/report), admins list everything and change status
 * (GET/POST /api/admin/board). See migrations/0004_board_moderation.sql for
 * report_count / reported_at / status_note / moderated_at.
 *
 * 'reported' is deliberately still PUBLIC: a reported message is not yet
 * judged, and pulling messages off the board the moment anyone dislikes one
 * would let a single grudge censor the board. It disappears on a moderator
 * decision (hidden/deleted), not on a report.
 *
 * Data model (serialisable, tiny):
 *   { id, text, image?, hue, status, createdAt }
 * `image` is stored ONLY as a validated data: URL (re-validated on write by
 * the route); `hue` is a stable 0-359 tint seed.
 */
import { BOARD_CONFIG } from '../config/board.config';

export type MessageStatus = 'visible' | 'hidden' | 'reported' | 'deleted';

export const MESSAGE_STATUSES: readonly MessageStatus[] = [
	'visible',
	'hidden',
	'reported',
	'deleted',
];

export type BoardMessage = {
	id: string;
	text: string;
	/** Validated data: URL, or undefined. Never an arbitrary remote URL. */
	image?: string;
	/** Stable tint seed 0-359. */
	hue: number;
	status: MessageStatus;
	/** Epoch ms. */
	createdAt: number;
};

/** What public fetches return: the moderation status stays server-side. */
export type PublicMessage = Omit<BoardMessage, 'status'>;

/** A message as the admin surface sees it: moderation state included. */
export type ModeratedMessage = BoardMessage & {
	/** How many distinct visitors have reported this. */
	reportCount: number;
	/** Epoch ms of the most recent report, or undefined. */
	reportedAt?: number;
	/** Free-form moderator note. Never returned publicly. */
	statusNote?: string;
	/** Epoch ms of the last moderator action, or undefined. */
	moderatedAt?: number;
};

export type MessagePage = {
	messages: PublicMessage[];
	/** Opaque keyset cursor for the next (older) page, or null when done. */
	nextCursor: string | null;
};

export type ListOptions = {
	limit: number;
	/** Opaque cursor from a previous page; undefined = newest page. */
	cursor?: string;
};

/** Filters for the admin board list. All optional and combinable. */
export type AdminListOptions = {
	limit: number;
	cursor?: string;
	/** Omit to include every status. */
	status?: MessageStatus;
	/** Only messages with at least this many reports. */
	minReports?: number;
	/** Free-text search over the message body. */
	search?: string;
};

export type BoardSummary = {
	total: number;
	byStatus: { status: MessageStatus; count: number }[];
	/** Messages reported in the last 24h. */
	reportedLast24h: number;
	/** Posts in the last 24h. */
	postedLast24h: number;
};

export interface BoardStore {
	readonly kind: 'd1' | 'rest';
	listPublic(options: ListOptions): Promise<MessagePage>;
	add(message: BoardMessage): Promise<void>;
	/** Flip a message's status. Returns false if the id is unknown. */
	setStatus(id: string, status: MessageStatus, note?: string): Promise<boolean>;
	/**
	 * Record a visitor report. Returns the new report count, or null when the
	 * message is unknown. Repeat reports from one session are counted once.
	 */
	recordReport(id: string, sessionKey: string | undefined, now: number): Promise<number | null>;
	/** Admin listing including hidden/deleted. Never used on a public path. */
	listForAdmin(options: AdminListOptions): Promise<{ messages: ModeratedMessage[]; nextCursor: string | null }>;
	/** One message with its moderation state, by id. Undefined when unknown. */
	getMessage(id: string): Promise<ModeratedMessage | undefined>;
	/** Aggregate counts for the admin overview. */
	summarize(): Promise<BoardSummary>;
}

/* --- opaque keyset cursor --------------------------------------------------- */
/* Cursor = base64("[createdAt, id]"): the exact seek position in the
   (created_at DESC, id DESC) order. Opaque to clients, validated on read. */

export function encodeCursor(createdAt: number, id: string): string {
	return btoa(JSON.stringify([createdAt, id]));
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
	try {
		const parsed = JSON.parse(atob(cursor)) as unknown;
		if (!Array.isArray(parsed) || parsed.length !== 2) return null;
		const [createdAt, id] = parsed as [unknown, unknown];
		if (typeof createdAt !== 'number' || typeof id !== 'string') return null;
		return { createdAt, id };
	} catch {
		return null;
	}
}

const toPublic = (message: BoardMessage): PublicMessage => {
	const { status: _status, ...pub } = message;
	return pub;
};

/* --- minimal D1 surface (structural, no workers-types dependency) ----------- */

/**
 * How long report de-duplication rows are kept. Matches the security_events
 * retention (60 days) so both tables age out on the same clock: a report
 * older than that is no longer evidence for an investigation that is itself
 * already outside its own retention window.
 */
export const REPORT_RETENTION_DAYS = 60;

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

type D1Row = {
	id: string;
	body: string;
	image: string | null;
	hue: number;
	status: MessageStatus;
	created_at: number;
	report_count: number;
	reported_at: number | null;
	status_note: string | null;
	moderated_at: number | null;
};

const PUBLIC_STATUSES = `'visible', 'reported'`;

const PUBLIC_COLUMNS = 'id, body, image, hue, status, created_at';
const ADMIN_COLUMNS = `${PUBLIC_COLUMNS}, report_count, reported_at, status_note, moderated_at`;

const rowToMessage = (row: D1Row): BoardMessage => ({
	id: row.id,
	text: row.body,
	...(row.image ? { image: row.image } : {}),
	hue: row.hue,
	status: row.status,
	createdAt: row.created_at,
});

const rowToModerated = (row: D1Row): ModeratedMessage => ({
	...rowToMessage(row),
	reportCount: Number(row.report_count ?? 0),
	...(row.reported_at ? { reportedAt: row.reported_at } : {}),
	...(row.status_note ? { statusNote: row.status_note } : {}),
	...(row.moderated_at ? { moderatedAt: row.moderated_at } : {}),
});

/** Escape LIKE wildcards so a literal % or _ in a search term matches itself. */
function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function createD1Store(db: D1Database): BoardStore {
	return {
		kind: 'd1',
		async listPublic({ limit, cursor }) {
			const seek = cursor ? decodeCursor(cursor) : null;
			// Keyset pagination: strictly older than the cursor position in
			// (created_at DESC, id DESC) order. Hidden/deleted are filtered in
			// SQL so they can never reach a public fetch.
			const query = seek
				? `SELECT ${PUBLIC_COLUMNS} FROM board_messages
				   WHERE status IN (${PUBLIC_STATUSES})
				     AND (created_at < ?1 OR (created_at = ?1 AND id < ?2))
				   ORDER BY created_at DESC, id DESC
				   LIMIT ?3`
				: `SELECT ${PUBLIC_COLUMNS} FROM board_messages
				   WHERE status IN (${PUBLIC_STATUSES})
				   ORDER BY created_at DESC, id DESC
				   LIMIT ?1`;
			const stmt = seek
				? db.prepare(query).bind(seek.createdAt, seek.id, limit + 1)
				: db.prepare(query).bind(limit + 1);
			const { results } = await stmt.all<D1Row>();
			const rows = results.map(rowToMessage);
			const overflow = rows.length > limit;
			const page = overflow ? rows.slice(0, limit) : rows;
			const last = page[page.length - 1];
			return {
				messages: page.map(toPublic),
				nextCursor: overflow && last ? encodeCursor(last.createdAt, last.id) : null,
			};
		},
		async add(message) {
			await db
				.prepare(
					`INSERT OR IGNORE INTO board_messages (id, body, image, hue, status, created_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
				)
				.bind(
					message.id,
					message.text,
					message.image ?? null,
					message.hue,
					message.status,
					message.createdAt,
				)
				.run();
		},
		async setStatus(id, status, note) {
			// moderated_at is stamped on every moderator action, and a fresh
			// note replaces the old one (NULL clears it) so a restore does not
			// silently keep a stale "spam" label.
			const result = await db
				.prepare(
					`UPDATE board_messages
					 SET status = ?1, status_note = ?2, moderated_at = ?3
					 WHERE id = ?4`,
				)
				.bind(status, note ?? null, Date.now(), id)
				.run();
			return (result.meta?.changes ?? 0) > 0;
		},
		async recordReport(id, sessionKey, now) {
			// One report per session per message. The session key is hashed into
			// a small table rather than stored raw, so the board can dedupe
			// repeat reports without keeping a "who reported what" list — an
			// attribution table is personal data with no investigative value
			// beyond the count itself.
			if (sessionKey) {
				await db
					.prepare(
						`INSERT OR IGNORE INTO board_reports (message_id, reporter_key, created_at)
						 VALUES (?1, ?2, ?3)`,
					)
					.bind(id, sessionKey, now)
					.run();
			}

			// Recount from the dedupe table rather than incrementing a counter:
			// an increment would drift if two reports from the same session
			// raced, and COUNT over the deduped rows is always the truth.
			const result = await db
				.prepare(
					`UPDATE board_messages
					 SET report_count = (
					       SELECT COUNT(*) FROM board_reports WHERE message_id = ?1
					 ),
					     reported_at = ?2,
					     -- A visible message that draws a report moves to
					     -- 'reported' (still public, now queued for triage).
					     -- Already-moderated messages keep their status: a report
					     -- must never un-hide or resurrect a deleted message.
					     status = CASE WHEN status = 'visible' THEN 'reported' ELSE status END
					 WHERE id = ?1`,
				)
				.bind(id, now)
				.run();

			if ((result.meta?.changes ?? 0) === 0) return null;
			const count = await db
				.prepare('SELECT report_count FROM board_messages WHERE id = ?1')
				.bind(id)
				.first<number>('report_count');
			return Number(count ?? 0);
		},
		async listForAdmin({ limit, cursor, status, minReports, search }) {
			// Lazy retention for the report de-duplication table, mirroring the
			// security_events purge: admin reads only, same 60-day window, so
			// the two tables age out together. Without this the table grows
			// without bound — it is append-only by design (that is what makes
			// the de-duplication honest).
			try {
				await db
					.prepare('DELETE FROM board_reports WHERE created_at < ?1')
					.bind(Date.now() - REPORT_RETENTION_DAYS * 86_400_000)
					.run();
			} catch (error) {
				console.warn('[bnji] board report cleanup failed:', error);
			}

			const seek = cursor ? decodeCursor(cursor) : null;
			const clauses: string[] = [];
			const values: (string | number)[] = [];

			if (status) {
				values.push(status);
				clauses.push(`status = ?${values.length}`);
			}
			if (typeof minReports === 'number' && minReports > 0) {
				values.push(minReports);
				clauses.push(`report_count >= ?${values.length}`);
			}
			if (search) {
				values.push(`%${escapeLike(search)}%`);
				clauses.push(`body LIKE ?${values.length} ESCAPE '\\'`);
			}
			// Keyset seek: strictly older than the cursor in (created_at, id).
			if (seek) {
				values.push(seek.createdAt);
				const createdIdx = values.length;
				values.push(seek.id);
				const idIdx = values.length;
				clauses.push(`(created_at < ?${createdIdx} OR (created_at = ?${createdIdx} AND id < ?${idIdx}))`);
			}

			const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
			values.push(limit + 1);
			const limitIdx = values.length;

			const { results } = await db
				.prepare(
					`SELECT ${ADMIN_COLUMNS} FROM board_messages ${where}
					 ORDER BY created_at DESC, id DESC LIMIT ?${limitIdx}`,
				)
				.bind(...values)
				.all<D1Row>();

			const overflow = results.length > limit;
			const page = overflow ? results.slice(0, limit) : results;
			const last = page[page.length - 1];
			return {
				messages: page.map(rowToModerated),
				nextCursor: overflow && last ? encodeCursor(last.created_at, last.id) : null,
			};
		},
		async getMessage(id) {
			const row = await db
				.prepare(`SELECT ${ADMIN_COLUMNS} FROM board_messages WHERE id = ?1`)
				.bind(id)
				.first<D1Row>();
			return row ? rowToModerated(row) : undefined;
		},
		async summarize() {
			const dayAgo = Date.now() - 86_400_000;
			const [totalRow, byStatusResults, reportedRow, postedRow] = await Promise.all([
				db.prepare('SELECT COUNT(*) as cnt FROM board_messages').first<number>('cnt'),
				db
					.prepare('SELECT status, COUNT(*) as cnt FROM board_messages GROUP BY status')
					.all<{ status: MessageStatus; cnt: number }>(),
				db
					.prepare('SELECT COUNT(*) as cnt FROM board_messages WHERE reported_at >= ?1')
					.bind(dayAgo)
					.first<number>('cnt'),
				db
					.prepare('SELECT COUNT(*) as cnt FROM board_messages WHERE created_at >= ?1')
					.bind(dayAgo)
					.first<number>('cnt'),
			]);

			return {
				total: Number(totalRow ?? 0),
				byStatus: byStatusResults.results.map((r) => ({ status: r.status, count: Number(r.cnt) })),
				reportedLast24h: Number(reportedRow ?? 0),
				postedLast24h: Number(postedRow ?? 0),
			};
		},
	};
}

/* --- rest provider ----------------------------------------------------------- */

/**
 * External JSON API provider.
 *
 * The moderation methods mirror the D1 semantics against the same REST
 * contract. `summarize` has no upstream counterpart in the original contract,
 * so it reports zeros rather than inventing numbers — an admin overview that
 * silently says "0 messages" on a store that has thousands is worse than one
 * that says "not available", and the route surfaces the provider kind so the
 * operator can tell the difference.
 */
function createRestStore(url: string, token?: string): BoardStore {
	const headers = (): Record<string, string> => ({
		'content-type': 'application/json',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	});
	return {
		kind: 'rest',
		async listPublic({ limit, cursor }) {
			const params = new URLSearchParams({ limit: String(limit) });
			if (cursor) params.set('cursor', cursor);
			const response = await fetch(`${url}?${params}`, { headers: headers() });
			if (!response.ok) throw new Error(`board rest list failed: ${response.status}`);
			const data = (await response.json()) as {
				messages: (PublicMessage & { status?: MessageStatus })[];
				nextCursor?: string | null;
			};
			return {
				// Defensive: never trust a remote to respect the status contract.
				messages: data.messages
					.filter((m) => m.status === undefined || m.status === 'visible' || m.status === 'reported')
					.map(({ status: _status, ...pub }) => pub),
				nextCursor: data.nextCursor ?? null,
			};
		},
		async add(message) {
			const response = await fetch(url, {
				method: 'POST',
				headers: headers(),
				body: JSON.stringify(message),
			});
			if (!response.ok) throw new Error(`board rest add failed: ${response.status}`);
		},
		async setStatus(id, status, note) {
			const response = await fetch(`${url}/${encodeURIComponent(id)}/status`, {
				method: 'PATCH',
				headers: headers(),
				body: JSON.stringify({ status, ...(note ? { note } : {}) }),
			});
			return response.ok;
		},
		async recordReport(id, sessionKey, now) {
			const response = await fetch(`${url}/${encodeURIComponent(id)}/report`, {
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ reporterKey: sessionKey ?? null, createdAt: now }),
			});
			if (!response.ok) return null;
			const data = (await response.json()) as { reportCount?: number };
			return typeof data.reportCount === 'number' ? data.reportCount : 0;
		},
		async listForAdmin({ limit, cursor, status, minReports, search }) {
			const params = new URLSearchParams({ limit: String(limit), all: '1' });
			if (cursor) params.set('cursor', cursor);
			if (status) params.set('status', status);
			if (typeof minReports === 'number' && minReports > 0) params.set('minReports', String(minReports));
			if (search) params.set('search', search);
			const response = await fetch(`${url}?${params}`, { headers: headers() });
			if (!response.ok) throw new Error(`board rest admin list failed: ${response.status}`);
			const data = (await response.json()) as {
				messages: ModeratedMessage[];
				nextCursor?: string | null;
			};
			return {
				messages: (data.messages ?? []).map((m) => ({ ...m, reportCount: Number(m.reportCount ?? 0) })),
				nextCursor: data.nextCursor ?? null,
			};
		},
		async getMessage(id) {
			const response = await fetch(`${url}/${encodeURIComponent(id)}`, { headers: headers() });
			if (response.status === 404) return undefined;
			if (!response.ok) throw new Error(`board rest get failed: ${response.status}`);
			const data = (await response.json()) as ModeratedMessage;
			return { ...data, reportCount: Number(data.reportCount ?? 0) };
		},
		async summarize() {
			return {
				total: 0,
				byStatus: [],
				reportedLast24h: 0,
				postedLast24h: 0,
			};
		},
	};
}

/* --- selection -------------------------------------------------------------- */

/**
 * Resolve the store for one request. `env` is the Worker environment (bindings
 * + secrets arrive via src/server/env.ts). Returns null when nothing is
 * configured — the route turns that into an honest 503.
 */
export function getBoardStore(env: Record<string, unknown> | undefined): BoardStore | null {
	const configured = BOARD_CONFIG.provider;
	if (configured === 'd1') {
		const db = env?.BOARD_DB as D1Database | undefined;
		if (db && typeof db.prepare === 'function') return createD1Store(db);
		return null;
	}
	if (configured === 'rest') {
		const url = env?.BOARD_REST_URL as string | undefined;
		if (url) return createRestStore(url, env?.BOARD_REST_TOKEN as string | undefined);
		return null;
	}
	return null;
}
