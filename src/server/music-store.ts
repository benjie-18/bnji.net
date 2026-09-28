/**
 * BNJI.NET — the admin-managed music playlist, stored in D1.
 *
 * One table plus one singleton row, on the existing `BOARD_DB` binding. There
 * is deliberately no second database and no in-memory fallback: an
 * unconfigured store makes the API answer `503 storage_unconfigured` rather
 * than pretending a playlist was saved, exactly like the message board.
 *
 * ORDER IS A COLUMN, NOT AN ARTEFACT
 * ----------------------------------
 * `position` is explicit and unique. Insertion time is NOT the order — the
 * admin reorders, and a reorder has to be a fact that is stored rather than a
 * side effect of when a row happened to be written. Reads are
 * `ORDER BY position`, and every mutation keeps positions dense (0..n-1) so
 * the stored order is also the playback order with nothing to interpret.
 *
 * "NOT INITIALIZED" IS NOT THE SAME AS "EMPTY"
 * --------------------------------------------
 * `music_playlist_state.seeded` distinguishes them. A database that has never
 * been seeded copies `MUSIC_SOURCE.tracks` in once, so an existing deployment
 * keeps its current playlist. Once seeded, the flag is never cleared: an
 * operator who removes every item has made a decision, and re-seeding on the
 * next read would silently undo it. That is the whole reason the flag exists
 * rather than a `COUNT(*) = 0` check.
 *
 * Every mutation is a prepared, bound statement. Multi-row writes go through
 * `batch()`, which D1 runs in one transaction.
 */
import {
	MUSIC_PLAYLIST,
	MUSIC_SOURCE,
	type MusicProvider,
	type MusicTrack,
} from '../config/music.config';

/** One stored playlist item. The public shape is `MusicTrack` (see toMusicTrack). */
export type StoredPlaylistItem = {
	id: string;
	/** Explicit playback order; dense and unique. */
	position: number;
	title: string;
	artist?: string;
	album?: string;
	/** YouTube upload date. */
	publishedAt?: string;
	/** Spotify album release date. */
	releaseDate?: string;
	provider: MusicProvider;
	url: string;
	/** The provider id the link was resolved from, for re-resolution. */
	sourceId?: string;
	createdAt: number;
	updatedAt: number;
};

export type PlaylistMoveDirection = 'up' | 'down';

export interface MusicPlaylistStore {
	readonly kind: 'd1';
	/** Every item, in playback order. */
	list(): Promise<StoredPlaylistItem[]>;
	/** False until the static playlist has been copied in for the first time. */
	isInitialized(): Promise<boolean>;
	/**
	 * Copy `MUSIC_SOURCE.tracks` in, once. Idempotent: a second call (or a
	 * concurrent one) inserts nothing because the ids are the config's own.
	 */
	ensureSeeded(): Promise<StoredPlaylistItem[]>;
	/** Append a new item at the end of the queue. */
	add(item: Omit<StoredPlaylistItem, 'position' | 'createdAt' | 'updatedAt'>): Promise<StoredPlaylistItem>;
	/** Remove an item and close the gap in the order. */
	remove(id: string): Promise<boolean>;
	/** Swap an item with its neighbour. False when the move is out of range. */
	move(id: string, direction: PlaylistMoveDirection): Promise<boolean>;
	/**
	 * Rewrite the whole order. The submitted list must contain exactly the
	 * stored ids — no more, no fewer, no duplicates — or it is refused: a
	 * partial list is a request to delete the missing items, and that is not
	 * what a reorder means.
	 */
	reorder(ids: string[]): Promise<boolean>;
}

/* --- minimal D1 surface (structural, no workers-types dependency) ---------- */

type D1PreparedStatement = {
	bind(...values: (string | number | null)[]): D1PreparedStatement;
	all<T>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta?: { changes?: number } }>;
	/** With a column name, D1 resolves to that column's SCALAR value. */
	first<T>(colName?: string): Promise<T | null>;
};

type D1Database = {
	prepare(query: string): D1PreparedStatement;
	batch(statements: D1PreparedStatement[]): Promise<unknown>;
};

type PlaylistRow = {
	id: string;
	position: number;
	title: string;
	artist: string | null;
	album: string | null;
	published_at: string | null;
	release_date: string | null;
	provider: string;
	url: string;
	source_id: string | null;
	created_at: number;
	updated_at: number;
};

const ITEM_COLUMNS =
	'id, position, title, artist, album, published_at, release_date, provider, url, source_id, created_at, updated_at';

const rowToItem = (row: PlaylistRow): StoredPlaylistItem => ({
	id: row.id,
	position: Number(row.position),
	title: row.title,
	...(row.artist ? { artist: row.artist } : {}),
	...(row.album ? { album: row.album } : {}),
	...(row.published_at ? { publishedAt: row.published_at } : {}),
	...(row.release_date ? { releaseDate: row.release_date } : {}),
	provider: row.provider as MusicProvider,
	url: row.url,
	...(row.source_id ? { sourceId: row.source_id } : {}),
	createdAt: Number(row.created_at),
	updatedAt: Number(row.updated_at),
});

/** The public shape: identical to the player's own model. */
export function toMusicTrack(item: StoredPlaylistItem): MusicTrack {
	return {
		id: item.id,
		title: item.title,
		...(item.artist ? { artist: item.artist } : {}),
		...(item.album ? { album: item.album } : {}),
		...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
		...(item.releaseDate ? { releaseDate: item.releaseDate } : {}),
		provider: item.provider,
		url: item.url,
	};
}

/**
 * Statements per `batch()` call.
 *
 * D1 caps a batch well below this, and chunking costs nothing here because the
 * playlist is bounded at MUSIC_PLAYLIST.maxItems. The order-preserving offset
 * trick in rewritePositions() is what makes chunking safe rather than merely
 * small.
 */
const BATCH_CHUNK = 25;

function chunk<T>(items: T[], size = BATCH_CHUNK): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
	return out;
}

/**
 * Write new positions for a set of items.
 *
 * `position` is UNIQUE, so writing the final values one row at a time can hit a
 * transient collision: row B still holds the slot row A is moving into, and the
 * UPDATE fails on a constraint rather than queueing. Every row is therefore
 * lifted out of the way FIRST, to a slot above every position currently stored
 * (`offset`), and only then written to its final value. Both passes keep the
 * requested relative order, so even a process death between chunks leaves the
 * stored order correct — merely with gaps, which nothing depends on.
 *
 * `offset` is derived from the table, NOT from the rows being moved: the caller
 * only knows the positions it is changing, and an offset computed from those
 * would collide with the rows it is not changing.
 */
async function rewritePositions(db: D1Database, changes: { id: string; position: number }[]): Promise<void> {
	if (changes.length === 0) return;
	const offset = (await highestPosition(db)) + 1;
	const statement = db.prepare('UPDATE music_playlist_items SET position = ?1 WHERE id = ?2');
	for (const group of chunk(changes)) {
		await db.batch(group.map((change) => statement.bind(offset + change.position, change.id)));
	}
	for (const group of chunk(changes)) {
		await db.batch(group.map((change) => statement.bind(change.position, change.id)));
	}
}

/** Highest position currently stored, or -1 for an empty playlist. */
async function highestPosition(db: D1Database): Promise<number> {
	const row = await db
		.prepare('SELECT MAX(position) AS highest FROM music_playlist_items')
		.first<number>('highest');
	return row === null || row === undefined ? -1 : Number(row);
}

function createD1Store(db: D1Database): MusicPlaylistStore {
	// A named function rather than `this.list()` inside the object literal:
	// the store is destructured by callers in places, and a method that
	// depends on its receiver is a method that stops working the first time
	// somebody writes `const { list } = store`.
	const list = async (): Promise<StoredPlaylistItem[]> => {
		const { results } = await db
			.prepare(`SELECT ${ITEM_COLUMNS} FROM music_playlist_items ORDER BY position ASC`)
			.all<PlaylistRow>();
		return results.map(rowToItem);
	};

	return {
		kind: 'd1',

		list,

		async isInitialized() {
			const row = await db
				.prepare('SELECT seeded FROM music_playlist_state WHERE id = 1')
				.first<number>('seeded');
			return Number(row ?? 0) === 1;
		},

		async ensureSeeded() {
			// Two statements, deliberately not one batch: the row is created
			// idempotently first, so a database that has never been touched and
			// one that has both arrive at the same guard below.
			await db
				.prepare(
					`INSERT OR IGNORE INTO music_playlist_state (id, seeded, seeded_at, source_count)
					 VALUES (1, 0, 0, 0)`,
				)
				.bind()
				.run();

			const seeded = await db
				.prepare('SELECT seeded FROM music_playlist_state WHERE id = 1')
				.first<number>('seeded');
			if (Number(seeded ?? 0) === 1) return list();

			// Seed from the static config, appending rather than assuming the
			// table is empty: if anything is already there (a manual row, a
			// half-finished earlier attempt) it keeps its place instead of
			// colliding on position 0.
			const items = MUSIC_SOURCE.tracks;
			const statements: D1PreparedStatement[] = [];
			let next = await highestPosition(db);
			const now = Date.now();
			for (const track of items) {
				next += 1;
				statements.push(
					db
						.prepare(
							`INSERT OR IGNORE INTO music_playlist_items
							   (id, position, title, artist, album, published_at, release_date, provider, url, source_id, created_at, updated_at)
							 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
						)
						.bind(
							track.id,
							next,
							track.title,
							track.artist?.trim() || null,
							track.album?.trim() || null,
							track.publishedAt?.trim() || null,
							track.releaseDate?.trim() || null,
							track.provider,
							track.url,
							null,
							now,
							now,
						),
				);
			}
			// The flag and the rows commit together: either the playlist is
			// seeded and marked, or neither happened.
			statements.push(
				db
					.prepare(
						`UPDATE music_playlist_state
						   SET seeded = 1, seeded_at = ?1, source_count = ?2
						 WHERE id = 1 AND seeded = 0`,
					)
					.bind(now, items.length),
			);
			await db.batch(statements);
			return list();
		},

		async add(item) {
			const count = await db
				.prepare('SELECT COUNT(*) AS cnt FROM music_playlist_items')
				.first<number>('cnt');
			if (Number(count ?? 0) >= MUSIC_PLAYLIST.maxItems) {
				throw new Error('playlist_full');
			}

			const position = (await highestPosition(db)) + 1;
			const now = Date.now();
			await db
				.prepare(
					`INSERT INTO music_playlist_items
					   (id, position, title, artist, album, published_at, release_date, provider, url, source_id, created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
				)
				.bind(
					item.id,
					position,
					item.title,
					item.artist || null,
					item.album || null,
					item.publishedAt || null,
					item.releaseDate || null,
					item.provider,
					item.url,
					item.sourceId || null,
					now,
					now,
				)
				.run();

			return { ...item, position, createdAt: now, updatedAt: now };
		},

		async remove(id) {
			const current = await list();
			const target = current.find((item) => item.id === id);
			if (!target) return false;

			const result = await db
				.prepare('DELETE FROM music_playlist_items WHERE id = ?1')
				.bind(id)
				.run();
			if ((result.meta?.changes ?? 0) === 0) return false;

			// Close the gap: the order is dense, so the item that followed the
			// removed one moves up rather than leaving a hole that a later
			// insert would have to route around.
			const remaining = current.filter((item) => item.id !== id);
			await rewritePositions(
				db,
				remaining
					.map((item, index) => ({ id: item.id, position: index }))
					.filter((change, index) => remaining[index]!.position !== change.position),
			);
			return true;
		},

		async move(id, direction) {
			const current = await list();
			const index = current.findIndex((item) => item.id === id);
			if (index < 0) return false;
			const swapWith = direction === 'up' ? index - 1 : index + 1;
			if (swapWith < 0 || swapWith >= current.length) return false;

			const first = current[index]!;
			const second = current[swapWith]!;
			await rewritePositions(db, [
				{ id: first.id, position: second.position },
				{ id: second.id, position: first.position },
			]);
			return true;
		},

		async reorder(ids) {
			const current = await list();
			if (ids.length !== current.length) return false;

			const byId = new Map(current.map((item) => [item.id, item]));
			const seen = new Set<string>();
			for (const id of ids) {
				// A duplicate id would silently drop an item from the order.
				if (seen.has(id)) return false;
				seen.add(id);
				if (!byId.has(id)) return false;
			}

			const changes = ids
				.map((id, index) => ({ id, position: index, current: byId.get(id)!.position }))
				.filter((change) => change.position !== change.current);
			await rewritePositions(db, changes);
			return true;
		},
	};
}

/**
 * The playlist store for a Worker environment, or null when D1 is absent.
 *
 * A null store is a misconfiguration, not an empty playlist: routes answer 503
 * rather than showing an operator an empty queue that they cannot change.
 */
export function getMusicPlaylistStore(env: Record<string, unknown>): MusicPlaylistStore | null {
	const db = env.BOARD_DB as D1Database | undefined;
	return db && typeof db.prepare === 'function' ? createD1Store(db) : null;
}
