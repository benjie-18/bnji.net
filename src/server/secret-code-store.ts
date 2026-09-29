/**
 * BNJI.NET — secret code usage analytics storage (D1).
 *
 * Tracks usage counts and last-used timestamps for secret codes.
 * Returns null when the D1 database binding is unavailable.
 */

type D1PreparedStatement = {
	bind(...values: (string | number | null)[]): D1PreparedStatement;
	all<T>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta?: { changes?: number } }>;
	first<T>(colName?: string): Promise<T | null>;
};

type D1Database = {
	prepare(query: string): D1PreparedStatement;
};

export type CodeUseStat = {
	code: string;
	count: number;
	lastUsedAt: number;
};

export interface SecretCodeStore {
	readonly kind: 'd1';

	recordCodeUse(code: string, now: number): Promise<void>;
	getCodeStats(): Promise<CodeUseStat[]>;
}

function createD1SecretCodeStore(db: D1Database): SecretCodeStore {
	return {
		kind: 'd1',

		async recordCodeUse(code: string, now: number): Promise<void> {
			const cleanCode = code.trim().toLowerCase();
			if (!cleanCode) return;

			await db
				.prepare(
					`INSERT INTO secret_code_uses (code, count, last_used_at)
					 VALUES (?1, 1, ?2)
					 ON CONFLICT(code) DO UPDATE SET count = count + 1, last_used_at = ?2`,
				)
				.bind(cleanCode, now)
				.run();
		},

		async getCodeStats(): Promise<CodeUseStat[]> {
			const { results } = await db
				.prepare(
					'SELECT code, count, last_used_at FROM secret_code_uses ORDER BY count DESC, last_used_at DESC',
				)
				.bind()
				.all<{ code: string; count: number; last_used_at: number }>();

			return results.map((row) => ({
				code: row.code,
				count: Number(row.count),
				lastUsedAt: Number(row.last_used_at),
			}));
		},
	};
}

export function getSecretCodeStore(env: Record<string, unknown> | undefined): SecretCodeStore | null {
	const db = env?.BOARD_DB as D1Database | undefined;
	if (db && typeof db.prepare === 'function') return createD1SecretCodeStore(db);
	return null;
}
