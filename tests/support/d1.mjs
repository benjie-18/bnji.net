/**
 * Test support: a D1-shaped wrapper over Node's built-in SQLite.
 *
 * The playlist store is written against D1's structural surface — prepare,
 * bind, first, all, run, batch — so a thin adapter over `node:sqlite` runs the
 * REAL store code and the REAL migration SQL against a real SQLite engine,
 * including the UNIQUE constraint on `position` that the reorder logic depends
 * on. Nothing is mocked at the SQL level, which is the point: a reorder that
 * violates the constraint must fail here exactly as it would in production.
 *
 * `batch()` is wrapped in a transaction, mirroring D1's documented atomicity.
 */
import { DatabaseSync } from 'node:sqlite';

/** Statements per batch call. Mirrors the chunk size in src/server/music-store.ts. */
const BATCH_CHUNK = 25;

class Statement {
	constructor(db, sql, values = []) {
		this.db = db;
		this.sql = sql;
		this.values = values;
	}

	/**
	 * Returns a NEW bound statement.
	 *
	 * D1's `bind()` is immutable — it hands back a new prepared statement — so
	 * a caller that prepares once and binds many times gets N independent
	 * statements. A mutable shim would quietly share one values array across a
	 * whole batch, which is exactly the kind of bug that makes a test pass and
	 * production fail (or the reverse).
	 */
	bind(...values) {
		return new Statement(this.db, this.sql, values);
	}

	all() {
		return { results: this.db.prepare(this.sql).all(...this.values) };
	}

	run() {
		const info = this.db.prepare(this.sql).run(...this.values);
		return { meta: { changes: Number(info.changes) } };
	}

	first(column) {
		const row = this.db.prepare(this.sql).get(...this.values);
		if (row === undefined || row === null) return null;
		// D1's scalar form: `first<number>('cnt')` is the value, not the row.
		return column === undefined ? row : row[column] ?? null;
	}
}

/**
 * A D1-shaped database over an in-memory SQLite file.
 *
 * `db.raw` exposes the underlying DatabaseSync so a test can run a migration
 * file or inspect rows directly.
 */
export function createTestD1() {
	const raw = new DatabaseSync(':memory:');
	return {
		raw,
		prepare(sql) {
			return new Statement(raw, sql);
		},
		async batch(statements) {
			raw.exec('BEGIN');
			try {
				const results = [];
				for (let index = 0; index < statements.length; index += BATCH_CHUNK) {
					for (const statement of statements.slice(index, index + BATCH_CHUNK)) {
						if (statement.sql.trim().toUpperCase().startsWith('SELECT')) {
							results.push(statement.all());
						} else {
							results.push(statement.run());
						}
					}
				}
				raw.exec('COMMIT');
				return results;
			} catch (error) {
				raw.exec('ROLLBACK');
				throw error;
			}
		},
	};
}
