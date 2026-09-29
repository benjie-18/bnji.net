import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSecretCodeStore } from '../src/server/secret-code-store';
import { POST } from '../src/pages/api/code/use';

declare global {
	var __BNJI_TEST_BINDINGS__: Record<string, unknown>;
}

type MockRow = { code: string; count: number; last_used_at: number };

function createMockD1Database() {
	const rows = new Map<string, MockRow>();
	const calls: { query: string; values: (string | number | null)[] }[] = [];

	return {
		calls,
		rows,
		prepare(query: string) {
			let boundValues: (string | number | null)[] = [];
			const statement = {
				bind(...values: (string | number | null)[]) {
					boundValues = values;
					return statement;
				},
				async run() {
					calls.push({ query, values: boundValues });
					if (query.includes('INSERT INTO secret_code_uses')) {
						const code = String(boundValues[0]);
						const now = Number(boundValues[1]);
						const existing = rows.get(code);
						if (existing) {
							existing.count += 1;
							existing.last_used_at = now;
						} else {
							rows.set(code, { code, count: 1, last_used_at: now });
						}
					}
					return { meta: { changes: 1 } };
				},
				async all<T>() {
					calls.push({ query, values: boundValues });
					const results = Array.from(rows.values()).sort((a, b) => b.count - a.count) as unknown as T[];
					return { results };
				},
				async first<T>() {
					return null;
				},
			};
			return statement;
		},
	};
}

describe('secret-code-store', () => {
	it('returns null if env or BOARD_DB is missing', () => {
		assert.equal(getSecretCodeStore(undefined), null);
		assert.equal(getSecretCodeStore({}), null);
	});

	it('records code usage and retrieves stats', async () => {
		const mockDb = createMockD1Database();
		const store = getSecretCodeStore({ BOARD_DB: mockDb })!;
		assert.ok(store);
		assert.equal(store.kind, 'd1');

		const now = 1700000000000;
		await store.recordCodeUse('  VERITY  ', now);
		await store.recordCodeUse('verity', now + 1000);
		await store.recordCodeUse('matrix', now + 2000);

		const stats = await store.getCodeStats();
		assert.equal(stats.length, 2);
		assert.equal(stats[0].code, 'verity');
		assert.equal(stats[0].count, 2);
		assert.equal(stats[0].lastUsedAt, now + 1000);

		assert.equal(stats[1].code, 'matrix');
		assert.equal(stats[1].count, 1);
		assert.equal(stats[1].lastUsedAt, now + 2000);
	});
});

describe('POST /api/code/use', () => {
	it('rejects non-json or missing code payload', async () => {
		const request = new Request('http://localhost/api/code/use', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});

		const mockContext = {
			request,
			locals: {},
			url: new URL(request.url),
		} as any;

		const response = await POST(mockContext);
		assert.equal(response.status, 400);
	});

	it('records code use on valid POST', async () => {
		const mockDb = createMockD1Database();
		globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: mockDb };

		const request = new Request('http://localhost/api/code/use', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: 'VERITY' }),
		});

		const mockContext = {
			request,
			locals: {},
			url: new URL(request.url),
		} as any;

		const response = await POST(mockContext);
		assert.equal(response.status, 200);

		const body = (await response.json()) as { ok?: boolean };
		assert.equal(body.ok, true);

		const rows = Array.from(mockDb.rows.values());
		assert.equal(rows.length, 1);
		assert.equal(rows[0].code, 'verity');
		assert.equal(rows[0].count, 1);

		globalThis.__BNJI_TEST_BINDINGS__ = {};
	});
});
