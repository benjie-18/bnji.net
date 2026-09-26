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
 * Moderation groundwork
 * ---------------------
 * Every message carries `status`: visible | hidden | reported | deleted.
 * listPublic() only ever returns visible/reported rows — hidden and deleted
 * messages never reach a public fetch, enforced in SQL, not in the route.
 * setStatus() exists for the future moderation surface; no UI or route uses
 * it yet.
 *
 * Data model (serialisable, tiny):
 *   { id, text, image?, hue, status, createdAt }
 * `image` is stored ONLY as a validated data: URL (re-validated on write by
 * the route); `hue` is a stable 0-359 tint seed.
 */
import { BOARD_CONFIG } from '../config/board.config';

export type MessageStatus = 'visible' | 'hidden' | 'reported' | 'deleted';

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

export interface BoardStore {
	readonly kind: 'd1' | 'rest';
	listPublic(options: ListOptions): Promise<MessagePage>;
	add(message: BoardMessage): Promise<void>;
	/** Moderation groundwork: flip a message's status. Returns false if unknown id. */
	setStatus(id: string, status: MessageStatus): Promise<boolean>;
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

type D1PreparedStatement = {
	bind(...values: (string | number | null)[]): D1PreparedStatement;
	all<T>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta?: { changes?: number } }>;
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
};

const PUBLIC_STATUSES = `'visible', 'reported'`;

function createD1Store(db: D1Database): BoardStore {
	const rowToMessage = (row: D1Row): BoardMessage => ({
		id: row.id,
		text: row.body,
		...(row.image ? { image: row.image } : {}),
		hue: row.hue,
		status: row.status,
		createdAt: row.created_at,
	});

	return {
		kind: 'd1',
		async listPublic({ limit, cursor }) {
			const seek = cursor ? decodeCursor(cursor) : null;
			// Keyset pagination: strictly older than the cursor position in
			// (created_at DESC, id DESC) order. Hidden/deleted are filtered in
			// SQL so they can never reach a public fetch.
			const query = seek
				? `SELECT id, body, image, hue, status, created_at FROM board_messages
				   WHERE status IN (${PUBLIC_STATUSES})
				     AND (created_at < ?1 OR (created_at = ?1 AND id < ?2))
				   ORDER BY created_at DESC, id DESC
				   LIMIT ?3`
				: `SELECT id, body, image, hue, status, created_at FROM board_messages
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
		async setStatus(id, status) {
			const result = await db
				.prepare(`UPDATE board_messages SET status = ?1 WHERE id = ?2`)
				.bind(status, id)
				.run();
			return (result.meta?.changes ?? 0) > 0;
		},
	};
}

/* --- rest provider ----------------------------------------------------------- */

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
		async setStatus(id, status) {
			const response = await fetch(`${url}/${encodeURIComponent(id)}/status`, {
				method: 'PATCH',
				headers: headers(),
				body: JSON.stringify({ status }),
			});
			return response.ok;
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
