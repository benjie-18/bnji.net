import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { recordGameSession, readLeaderboard, insertValidatedScore, readGameAdminData, type D1Database } from '../src/server/game-store';
import { resolvePlayerContext } from '../src/server/player-context';
import { getSecurityStore } from '../src/server/security-store';
import { listPaintActivity, PAINT_ACTIVITY_MAX_ROWS, preparePaintActivityTrim, preparePaintCommitTrim } from '../src/server/paint-activity-store';
import { closeStaleGameSessions, MAX_RETENTION_ROWS_PER_TABLE, MAX_RETENTION_ROWS_PER_TABLE_CATCH_UP, MAX_RETENTION_SWEEP_QUERIES, purgeGameRetention, runRetentionSweep } from '../src/server/tracking-retention';
import { defineGameCatalog, GAMES, type Game } from '../src/data/games';
import { updateSiteSettings } from '../src/server/site-settings-store';

const ADMIN_TOKEN = 'games-test-admin-token';
const GAME_ID = 'bnji.glass-minesweeper';
const SESSION_ID = '0123456789abcdef0123456789abcdef';
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();

function freshDatabase() {
	const db = createTestD1();
	for (const migration of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
	return db;
}

const kv = new Map<string, string>();
const rateLimitKv = {
	async get(key: string) { return kv.get(key) ?? null; },
	async put(key: string, value: string) { kv.set(key, value); },
};
function bind(db: ReturnType<typeof freshDatabase> | null, withKv = true): void {
	globalThis.__BNJI_TEST_BINDINGS__ = db
		? { BOARD_DB: db, ...(withKv ? { BOARD_KV: rateLimitKv } : {}) }
		: {};
}
function seedAdmin(db: ReturnType<typeof freshDatabase>): void {
	db.raw.prepare('UPDATE admin_credentials SET token_hash = ? WHERE id = 1')
		.run(createHash('sha256').update(ADMIN_TOKEN).digest('hex'));
}
async function configureRetention(db: ReturnType<typeof freshDatabase>, days: number): Promise<void> {
	bind(db);
	const result = await updateSiteSettings({ trackingRetentionDays: days });
	assert.equal(result.ok, true);
	assert.equal(result.settings.trackingRetentionDays, days);
}
function call(route: (context: APIContext) => Promise<Response>, options: { method?: string; body?: unknown; rawBody?: string; query?: string; token?: string; cookie?: string; ua?: string; ip?: string; origin?: string } = {}): Promise<Response> {
	const url = `http://localhost/api/games${options.query ?? ''}`;
	const headers = new Headers({ origin: options.origin ?? 'http://localhost' });
	if (options.body !== undefined || options.rawBody !== undefined) headers.set('content-type', 'application/json');
	if (options.token) headers.set('authorization', `Bearer ${options.token}`);
	if (options.cookie) headers.set('cookie', options.cookie);
	if (options.ua) headers.set('user-agent', options.ua);
	if (options.ip) headers.set('cf-connecting-ip', options.ip);
	const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
	const request = new Request(url, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
	return route({ request, url: new URL(url), cookies: { get: () => undefined } } as unknown as APIContext);
}
const adminGames = await import('../src/pages/api/admin/games.ts');
const gameSession = await import('../src/pages/api/games/session.ts');
const leaderboard = await import('../src/pages/api/games/leaderboard.ts');
const scores = await import('../src/pages/api/games/scores.ts');

// The tests deliberately exercise the public handlers and actual migration SQL over SQLite.
test('0011 migration applies over populated 0010 schema without changing existing rows and is repeatable', () => {
	const db = createTestD1();
	for (const migration of migrations.filter((name) => name < '0011_games.sql')) {
		db.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
	}
	db.raw.prepare('INSERT INTO board_messages (id, body, hue, status, created_at) VALUES (?, ?, ?, ?, ?)').run('existing-row-1', 'kept', 25, 'visible', 1234);
	db.raw.prepare('INSERT INTO security_events (endpoint, ip_address, created_at) VALUES (?, ?, ?)').run('pre-migration', '203.0.113.9', 1234);
	const gamesMigration = readFileSync(new URL('../migrations/0011_games.sql', import.meta.url), 'utf8');
	db.raw.exec(gamesMigration);
	db.raw.exec(gamesMigration);
	const existing = db.raw.prepare('SELECT id, body, created_at FROM board_messages').get() as Record<string, unknown>;
	assert.equal(existing.id, 'existing-row-1');
	assert.equal(existing.body, 'kept');
	assert.equal(existing.created_at, 1234);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM security_events').get() as { n: number }).n, 1);
	assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('game_sessions', 'game_scores')").get() as { n: number }).n, 2);
});
test('player context validates the shared guest cookie and provides the account seam', async () => {
	const valid = await resolvePlayerContext(new Request('https://site.test/', { headers: { cookie: `bnji_ps=${SESSION_ID}` } }));
	assert.equal(valid.sessionId, SESSION_ID);
	assert.equal(valid.playerId, null);
	assert.deepEqual(valid.setCookies, []);
	const invalid = await resolvePlayerContext(new Request('https://site.test/', { headers: { cookie: 'bnji_ps=forged' } }));
	assert.match(invalid.sessionId, /^[a-f0-9]{32}$/);
	assert.equal(invalid.playerId, null);
	assert.match(invalid.setCookies[0] ?? '', /^bnji_ps=[a-f0-9]{32};/);
	assert.match(invalid.setCookies[0] ?? '', /Secure; HttpOnly/);
});

test('active game sessions clamp deltas, reject too-frequent heartbeat writes, and close idempotently', async () => {
	const db = freshDatabase();
	const base = {
		sessionId: SESSION_ID, runId: RUN_ID, playerId: null, gameId: GAME_ID, activeMs: 0, ipAddress: '203.0.113.7',
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0', browser: 'Chrome',
		operatingSystem: 'Windows', deviceClass: 'desktop', screenClass: 'standard', inputClass: 'fine-pointer',
	};
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, kind: 'start', now: 1_000 }), true);
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, kind: 'heartbeat', activeMs: 30_000, now: 31_000 }), false);
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, kind: 'heartbeat', activeMs: 500_000, now: 71_000 }), true);
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, kind: 'end', activeMs: 100_000, now: 141_000 }), true);
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, kind: 'end', activeMs: 100_000, now: 142_000 }), false);
	const row = db.raw.prepare('SELECT active_ms, ended_at, ip_address FROM game_sessions').get() as Record<string, unknown>;
	assert.equal(row.active_ms, 130_000);
	assert.equal(row.ended_at, 141_000);
	assert.equal(row.ip_address, '203.0.113.7');
});

test('parallel game runs sharing one guest session keep separate heartbeat rows', async () => {
	const db = freshDatabase();
	const base = {
		sessionId: SESSION_ID, playerId: null, gameId: GAME_ID, activeMs: 0, ipAddress: '203.0.113.7',
		userAgent: 'test', browser: 'Other', operatingSystem: 'Other', deviceClass: 'desktop', screenClass: 'standard', inputClass: 'unknown',
	};
	const otherRun = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, runId: RUN_ID, kind: 'start', now: 1_000 }), true);
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, runId: otherRun, kind: 'start', now: 1_000 }), true);
	assert.equal(await recordGameSession(db as unknown as D1Database, { ...base, runId: RUN_ID, kind: 'heartbeat', activeMs: 10_000, now: 60_000 }), true);
	const rows = db.raw.prepare('SELECT run_id, active_ms FROM game_sessions ORDER BY run_id').all() as Array<Record<string, unknown>>;
	assert.equal(rows.length, 2);
	const activeByRun = new Map(rows.map((row) => [row.run_id, row.active_ms]));
	assert.equal(activeByRun.get(RUN_ID), 10_000);
	assert.equal(activeByRun.get(otherRun), 0);
});

test('session heartbeat API sets a guest cookie and keeps storage failures invisible', async () => {
	const db = freshDatabase();
	bind(db);
	const response = await call(gameSession.POST, {
		method: 'POST', ua: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0',
		body: { gameId: GAME_ID, runId: RUN_ID, kind: 'start', activeMs: 0, screenClass: 'compact', inputClass: 'touch' },
	});
	assert.equal(response.status, 204);
	const cookie = response.headers.get('set-cookie') ?? '';
	assert.match(cookie, /^bnji_ps=[a-f0-9]{32};/);
	const guestCookie = cookie.split(';', 1)[0];
	const row = db.raw.prepare('SELECT browser, operating_system, device_class, screen_class, input_class FROM game_sessions').get() as Record<string, unknown>;
	assert.equal(row.browser, 'Firefox');
	assert.equal(row.operating_system, 'Linux');
	assert.equal(row.device_class, 'desktop');
	assert.equal(row.screen_class, 'compact');
	assert.equal(row.input_class, 'touch');
	assert.equal((await call(gameSession.POST, { method: 'POST', cookie: guestCookie, body: { gameId: GAME_ID, runId: RUN_ID, kind: 'heartbeat', activeMs: 65_000 } })).status, 204, '65,000ms is the inclusive telemetry delta ceiling');
	assert.equal((await call(gameSession.POST, { method: 'POST', cookie: guestCookie, body: { gameId: GAME_ID, runId: RUN_ID, kind: 'heartbeat', activeMs: 65_001 } })).status, 204, 'invalid telemetry is silently ignored');
	assert.equal((await call(gameSession.POST, { method: 'POST', cookie: guestCookie, body: { gameId: GAME_ID, runId: 'malformed', kind: 'heartbeat', activeMs: 1 } })).status, 204);
	assert.equal((await call(gameSession.POST, { method: 'POST', cookie: guestCookie, body: { gameId: GAME_ID, runId: RUN_ID, kind: 'heartbeat', activeMs: 1, surprise: true } })).status, 204, 'unexpected telemetry keys are silently ignored');
	assert.equal((await call(gameSession.POST, { method: 'POST', cookie: guestCookie, origin: 'https://attacker.test', body: { gameId: GAME_ID, runId: RUN_ID, kind: 'end', activeMs: 1, screenClass: 'standard', inputClass: 'fine-pointer' } })).status, 204, 'cross-origin telemetry is silently ignored');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_sessions').get() as { n: number }).n, 1);
	assert.equal((db.raw.prepare('SELECT ended_at FROM game_sessions').get() as { ended_at: number | null }).ended_at, null, 'cross-origin beacon cannot close a session');

	bind(null);
	const unavailable = await call(gameSession.POST, { method: 'POST', body: { gameId: GAME_ID, kind: 'heartbeat', activeMs: 50_000 } });
	assert.equal(unavailable.status, 204);
	assert.equal(await unavailable.text(), '');
	bind({ prepare() { throw new Error('simulated D1 quota/database failure'); } } as unknown as ReturnType<typeof freshDatabase>);
	const failedStorage = await call(gameSession.POST, { method: 'POST', body: { gameId: GAME_ID, kind: 'start', runId: RUN_ID, activeMs: 0 } });
	assert.equal(failedStorage.status, 204, 'a D1 quota or database failure must not surface to gameplay');
	assert.equal(await failedStorage.text(), '');
	const malformed = await call(gameSession.POST, { method: 'POST', rawBody: '{' });
	assert.equal(malformed.status, 204, 'malformed best-effort telemetry is ignored');
});

test('best-effort session writes are per-IP rate-limited without surfacing a gameplay error', async () => {
	const db = freshDatabase();
	bind(db);
	const ip = '198.51.100.77';
	for (let attempt = 1; attempt <= 31; attempt += 1) {
		const runId = `00000000-0000-4000-8000-${attempt.toString(16).padStart(12, '0')}`;
		const response = await call(gameSession.POST, {
			method: 'POST', ip, cookie: `bnji_ps=${SESSION_ID}`,
			body: { gameId: GAME_ID, runId, kind: 'start', activeMs: 0 },
		});
		assert.equal(response.status, 204);
	}
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_sessions').get() as { n: number }).n, 30);
});

test('leaderboard stores only a guest session personal best and caps public rows to a fixed shape', async () => {
	const db = freshDatabase();
	const common = { gameId: GAME_ID, modeId: 'default', tieBreak: null, achievedAt: 1000, sessionId: SESSION_ID, playerId: null, displayName: 'Player', idempotencyKey: 'idempotency-key-0001' };
	assert.equal(await insertValidatedScore(db as unknown as D1Database, { ...common, score: 100 }), 'stored');
	assert.equal(await insertValidatedScore(db as unknown as D1Database, { ...common, score: 50, idempotencyKey: 'idempotency-key-0002' }), 'not-best');
	assert.equal(await insertValidatedScore(db as unknown as D1Database, { ...common, score: 100, idempotencyKey: 'idempotency-key-0001' }), 'duplicate');
	assert.equal(await insertValidatedScore(db as unknown as D1Database, { ...common, score: 120, idempotencyKey: 'idempotency-key-0003' }), 'stored');
	db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, achieved_at, session_id, display_name, validation_state, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
		GAME_ID, 'default', 999, 1500, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Pending', 'pending', 'pending-score-key-0001',
	);
	const result = await readLeaderboard(db as unknown as D1Database, GAME_ID, 'default', 0, 25);
	assert.deepEqual(result.rows.map((row) => row.score), [120]);
	assert.deepEqual(Object.keys(result.rows[0] ?? {}).sort(), ['achievedAt', 'displayName', 'score', 'tieBreak']);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_scores').get() as { n: number }).n, 2);
});

test('concurrent validated submissions preserve one personal best and replay is idempotent', async () => {
	const db = freshDatabase();
	const common = { gameId: GAME_ID, modeId: 'default', tieBreak: null, achievedAt: Date.now(), sessionId: SESSION_ID, playerId: null, displayName: 'Guest' };
	const outcomes = await Promise.all([100, 200, 150].map((score, index) => insertValidatedScore(db as unknown as D1Database, {
		...common, score, idempotencyKey: `concurrent-score-key-${String(index).padStart(2, '0')}`,
	})));
	assert.equal(outcomes.length, 3);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_scores WHERE session_id = ?').get(SESSION_ID) as { n: number }).n, 1);
	const best = db.raw.prepare('SELECT score FROM game_scores WHERE session_id = ?').get(SESSION_ID) as { score: number };
	assert.equal(best.score, 200);
	assert.equal(await insertValidatedScore(db as unknown as D1Database, {
		...common, score: 200, idempotencyKey: 'concurrent-score-key-01',
	}), 'duplicate');
});

test('public leaderboard route omits identifiers, while unverified score submissions fail closed', async () => {
	const db = freshDatabase();
	db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, tie_break, achieved_at, session_id, player_id, display_name, validation_state, idempotency_key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validated', ?)`).run(GAME_ID, 'default', 25, null, Date.now(), SESSION_ID, 'future-player-1', 'Guest', 'public-score-key-001');
	bind(db);
	const response = await call(leaderboard.GET, { query: `?gameId=${GAME_ID}` });
	assert.equal(response.status, 200);
	const publicData = await response.json() as Record<string, any>;
	assert.deepEqual(publicData.rows[0], { displayName: 'Guest', score: 25, tieBreak: null, achievedAt: publicData.rows[0].achievedAt });
	assert.equal(JSON.stringify(publicData).includes(SESSION_ID), false);
	assert.equal(JSON.stringify(publicData).includes('future-player-1'), false);
	assert.equal(JSON.stringify(publicData).includes('idempotency'), false);

	const submission = await call(scores.POST, {
		method: 'POST', body: { gameId: GAME_ID, mode: 'default', score: 9_999_999, tieBreak: null, displayName: 'Guest', idempotencyKey: 'client-claimed-score-01', proof: { run: 'untrusted' } },
	});
	assert.equal(submission.status, 503);
	assert.deepEqual(await submission.json(), { error: 'verifier_unavailable' });
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_scores').get() as { n: number }).n, 1);
});

test('leaderboard query limits and unknown modes are validated', async () => {
	const db = freshDatabase();
	bind(db);
	assert.equal((await call(leaderboard.GET, { query: `?gameId=${GAME_ID}&page=20` })).status, 400);
	assert.equal((await call(leaderboard.GET, { query: `?gameId=${GAME_ID}&page=-1` })).status, 400);
	assert.equal((await call(leaderboard.GET, { query: `?gameId=${GAME_ID}&mode=../../admin` })).status, 400);
	assert.equal((await call(leaderboard.GET, { query: '?gameId=made-up' })).status, 404);
	assert.equal((await call(leaderboard.GET, { query: `?gameId=${GAME_ID}&mode=default&extra=ignored` })).status, 200);
	assert.equal((await call(leaderboard.GET, { query: `?gameId=${GAME_ID}&page=19` })).status, 200, 'last allowed page index is inclusive');
});

test('score API rejects malformed, oversized, wrong-type, and out-of-bound claims before verifier lookup', async () => {
	const db = freshDatabase();
	bind(db);
	const valid = { gameId: GAME_ID, mode: 'default', score: 0, tieBreak: null, displayName: '🧊 Guest', idempotencyKey: 'boundary-score-key-01', proof: { ignored: true } };
	assert.equal((await call(scores.POST, { method: 'POST', body: valid, origin: 'https://attacker.test' })).status, 403, 'score writes reject cross-origin cookie-context requests');
	assert.equal((await call(scores.POST, { method: 'POST', rawBody: '{', ip: '198.51.100.10' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: [], ip: '198.51.100.11' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', rawBody: 'x'.repeat(2049), ip: '198.51.100.12' })).status, 413);
	assert.equal((await call(scores.POST, { method: 'POST', rawBody: JSON.stringify({ ...valid, displayName: 'Guest' }).padEnd(2048, ' '), ip: '198.51.100.18' })).status, 503, 'the exact payload-size ceiling is accepted');
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, score: '1' }, ip: '198.51.100.13' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, score: -1 }, ip: '198.51.100.14' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, score: 1_000_000_001 }, ip: '198.51.100.15' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, score: 1_000_000_000, tieBreak: 1_000_000_000 }, ip: '198.51.100.16' })).status, 503, 'inclusive upper boundaries reach the deliberately absent verifier');
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, displayName: 'x'.repeat(24) }, ip: '198.51.100.19' })).status, 503, '24 Unicode code points is the inclusive display-name ceiling');
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, displayName: 'x'.repeat(25) }, ip: '198.51.100.23' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, displayName: '<b>Guest</b>' }, ip: '198.51.100.24' })).status, 503, 'markup characters are data, not an echoed HTML response');
	const scriptPayload = await call(scores.POST, { method: 'POST', body: { ...valid, displayName: '<script>x</script>' }, ip: '198.51.100.28' });
	assert.equal(scriptPayload.status, 503);
	assert.equal((await scriptPayload.text()).includes('<script>'), false, 'score errors never reflect an HTML/script payload');
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, idempotencyKey: 'x'.repeat(64) }, ip: '198.51.100.25' })).status, 503, '64-character idempotency key is inclusive');
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, idempotencyKey: 'x'.repeat(65) }, ip: '198.51.100.26' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, tieBreak: -1 }, ip: '198.51.100.27' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, tieBreak: 'fast' }, ip: '198.51.100.17' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, displayName: 'x'.repeat(25) }, ip: '198.51.100.18' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, displayName: ' \n ' }, ip: '198.51.100.19' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, idempotencyKey: 'short-key-00001' }, ip: '198.51.100.20' })).status, 400);
	assert.equal((await call(scores.POST, { method: 'POST', body: { ...valid, surprise: '<script>alert(1)</script>' }, ip: '198.51.100.21' })).status, 400, 'unexpected fields are rejected before verifier lookup');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_scores').get() as { n: number }).n, 0);
	const sameIp = '198.51.100.30';
	for (let attempt = 0; attempt < 8; attempt += 1) {
		assert.equal((await call(scores.POST, { method: 'POST', body: valid, ip: sameIp })).status, 503);
	}
	const limited = await call(scores.POST, { method: 'POST', body: valid, ip: sameIp });
	assert.equal(limited.status, 429, 'ninth request in the fixed window is throttled');
});

test('missing leaderboard storage fails closed as a public data read while gameplay telemetry stays fail-open', async () => {
	bind(null);
	const response = await call(leaderboard.GET, { query: `?gameId=${GAME_ID}`, ip: '198.51.100.32' });
	assert.equal(response.status, 503);
	const tracking = await call(gameSession.POST, { method: 'POST', body: { gameId: GAME_ID, runId: RUN_ID, kind: 'start', activeMs: 0 } });
	assert.equal(tracking.status, 204);
});

test('public score reads filter by configured retention without deleting on a request', async () => {
	const db = freshDatabase();
	const now = Date.now();
	await configureRetention(db, 7);
	const insert = db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, achieved_at, session_id, display_name, validation_state, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, 'validated', ?)`);
	insert.run(GAME_ID, 'default', 90, now - 8 * 86_400_000, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Expired', 'expired-score-key-01');
	insert.run(GAME_ID, 'default', 80, now - 2 * 86_400_000, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Current', 'current-score-key-01');
	bind(db);
	const response = await call(leaderboard.GET, { query: `?gameId=${GAME_ID}`, ip: '198.51.100.22' });
	assert.equal(response.status, 200);
	assert.deepEqual(((await response.json()) as { rows: Array<{ displayName: string }> }).rows.map((row) => row.displayName), ['Current']);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_scores').get() as { n: number }).n, 2, 'public GET must not perform retention writes');
});

test('leaderboard request rate limit is fixed-window and returns 429 at its configured boundary', async () => {
	const db = freshDatabase();
	bind(db);
	const options = { query: `?gameId=${GAME_ID}`, ip: '198.51.100.31' };
	for (let attempt = 0; attempt < 60; attempt += 1) {
		assert.equal((await call(leaderboard.GET, options)).status, 200);
	}
	const limited = await call(leaderboard.GET, options);
	assert.equal(limited.status, 429);
});

test('Paint publish caps prune one legacy row at a time rather than issuing an unbounded delete', async () => {
	const db = freshDatabase();
	const paintInsert = db.raw.prepare('INSERT INTO board_paint_activity (created_at, revision, visitor_id, actions_json) VALUES (?, ?, ?, ?)');
	for (let index = 1; index <= PAINT_ACTIVITY_MAX_ROWS + 2; index += 1) paintInsert.run(index, index, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{}');
	const paintTrim = preparePaintActivityTrim(db as unknown as Parameters<typeof preparePaintActivityTrim>[0]);
	await paintTrim.run();
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM board_paint_activity').get() as { n: number }).n, PAINT_ACTIVITY_MAX_ROWS + 1);
	await preparePaintActivityTrim(db as unknown as Parameters<typeof preparePaintActivityTrim>[0]).run();
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM board_paint_activity').get() as { n: number }).n, PAINT_ACTIVITY_MAX_ROWS);

	const commitInsert = db.raw.prepare('INSERT INTO board_paint_commits (request_id, revision, created_at) VALUES (?, ?, ?)');
	for (let index = 1; index <= 130; index += 1) commitInsert.run(`request-${index}`, index, index);
	await preparePaintCommitTrim(db as unknown as Parameters<typeof preparePaintCommitTrim>[0], 128).run();
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM board_paint_commits').get() as { n: number }).n, 129);
});

test('security and Paint admin views hide expired backlog while bounded cleanup drains it', async () => {
	assert.equal(MAX_RETENTION_ROWS_PER_TABLE, 50, 'cleanup batches are deliberately capped at 50 rows per table');
	const db = freshDatabase();
	const now = Date.now();
	const old = now - 8 * 86_400_000;
	await configureRetention(db, 7);
	const securityInsert = db.raw.prepare('INSERT INTO security_events (endpoint, ip_address, created_at) VALUES (?, ?, ?)');
	for (let index = 0; index < MAX_RETENTION_ROWS_PER_TABLE + 1; index += 1) securityInsert.run('old', `203.0.113.${index}`, old);
	securityInsert.run('new', '203.0.113.250', now - 60_000);
	const paintInsert = db.raw.prepare('INSERT INTO board_paint_activity (created_at, revision, visitor_id, actions_json) VALUES (?, ?, ?, ?)');
	for (let index = 0; index < MAX_RETENTION_ROWS_PER_TABLE + 1; index += 1) paintInsert.run(old, index + 1, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{}');
	paintInsert.run(now - 60_000, 102, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{}');

	const security = getSecurityStore({ BOARD_DB: db });
	assert.ok(security);
	const events = await security.listRecent({ limit: 20 });
	assert.deepEqual(events.map((event) => event.endpoint), ['new']);
	assert.equal(await security.countMatching({}), 1);
	assert.equal((await security.summarize()).total, 1);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM security_events WHERE created_at < ?').get(now - 7 * 86_400_000) as { n: number }).n, 1, 'one expired row remains for the next bounded sweep, not in the response');

	const paint = await listPaintActivity(db as unknown as Parameters<typeof listPaintActivity>[0], 20);
	assert.equal(paint.events.length, 1);
	assert.equal(paint.events[0]?.revision, 102);
	assert.equal(paint.total, 1);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM board_paint_activity WHERE created_at < ?').get(now - 7 * 86_400_000) as { n: number }).n, 1);
});

test('stale-session closure uses a two-minute cutoff and leaves recent sessions open', async () => {
	const db = freshDatabase();
	const now = Date.now();
	const insert = db.raw.prepare('INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	insert.run(SESSION_ID, RUN_ID, GAME_ID, now - 5 * 60_000, now - 3 * 60_000, now - 3 * 60_000, 100, '203.0.113.1');
	insert.run('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', GAME_ID, now, now - 60_000, now - 60_000, 0, '203.0.113.2');
	await closeStaleGameSessions(db as unknown as import('../src/server/tracking-retention').RetentionDb, now);
	const rows = db.raw.prepare('SELECT ended_at FROM game_sessions ORDER BY session_id').all() as Array<{ ended_at: number | null }>;
	assert.notEqual(rows[0]?.ended_at, null);
	assert.equal(rows[1]?.ended_at, null);
});

test('configured retention sweeps only expired rows, preserves newer rows, and stays within its batch bound', async () => {
	const db = freshDatabase();
	const now = Date.now();
	const day = 86_400_000;
	await configureRetention(db, 7);
	const insertSession = db.raw.prepare('INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	insertSession.run(SESSION_ID, RUN_ID, GAME_ID, now - 8 * day, now - 8 * day, now - 8 * day, 100, '203.0.113.1');
	insertSession.run('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', GAME_ID, now - 6 * day, now - 6 * day, now - 6 * day, 100, '203.0.113.3');
	db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, achieved_at, session_id, display_name, validation_state, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, 'validated', ?)`)
		.run(GAME_ID, 'default', 12, now - 8 * day, 'cccccccccccccccccccccccccccccccc', 'old', 'old-score-key-0001');
	db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, achieved_at, session_id, display_name, validation_state, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, 'validated', ?)`)
		.run(GAME_ID, 'default', 13, now - 6 * day, 'dddddddddddddddddddddddddddddddd', 'new', 'new-score-key-0001');
	for (const [timestamp, suffix] of [[now - 8 * day, 'old'], [now - 6 * day, 'new']] as const) {
		db.raw.prepare('INSERT INTO security_events (endpoint, ip_address, created_at) VALUES (?, ?, ?)').run('game', `203.0.113.${suffix === 'old' ? 2 : 4}`, timestamp);
		db.raw.prepare('INSERT INTO board_paint_activity (created_at, revision, visitor_id, actions_json) VALUES (?, ?, ?, ?)').run(timestamp, suffix === 'old' ? 7001 : 7002, suffix === 'old' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '{}');
	}
	await runRetentionSweep({ BOARD_DB: db });
	for (const table of ['game_sessions', 'game_scores', 'security_events', 'board_paint_activity']) {
		assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1, `${table}: expired row removed, newer row preserved`);
		assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'game_sessions' ? 'last_seen_at' : table === 'game_scores' ? 'achieved_at' : 'created_at'} >= ?`).get(now - 7 * day) as { n: number }).n, 1);
	}

	// Seed beyond both bounded batches. A single sweep deletes at most 60 rows
	// per table; any larger backlog is left for the next scheduled invocation.
	for (let index = 0; index < MAX_RETENTION_ROWS_PER_TABLE + MAX_RETENTION_ROWS_PER_TABLE_CATCH_UP + 1; index += 1) {
		const sessionId = index.toString(16).padStart(32, '0');
		const runId = `${index.toString(16).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
		insertSession.run(sessionId, runId, GAME_ID, now - 9 * day, now - 9 * day, now - 9 * day, 0, '203.0.113.5');
	}
	await runRetentionSweep({ BOARD_DB: db });
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_sessions WHERE last_seen_at < ?').get(now - 7 * day) as { n: number }).n, 1);
	await runRetentionSweep({ BOARD_DB: db });
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_sessions WHERE last_seen_at < ?').get(now - 7 * day) as { n: number }).n, 0);
});

test('game retention uses the explicit configured day window and clamps invalid callers', async () => {
	const db = freshDatabase();
	const now = Date.now();
	const day = 86_400_000;
	const insertSession = db.raw.prepare('INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address) VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
	insertSession.run(SESSION_ID, RUN_ID, GAME_ID, now - 8 * day, now - 8 * day, now - 8 * day, '203.0.113.1');
	insertSession.run('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', GAME_ID, now - 6 * day, now - 6 * day, now - 6 * day, '203.0.113.2');
	await purgeGameRetention(db as unknown as import('../src/server/tracking-retention').RetentionDb, now, 7);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_sessions').get() as { n: number }).n, 1);
	assert.equal((db.raw.prepare('SELECT session_id FROM game_sessions').get() as { session_id: string }).session_id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
	insertSession.run('cccccccccccccccccccccccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', GAME_ID, now - 2 * day, now - 2 * day, now - 2 * day, '203.0.113.3');
	await purgeGameRetention(db as unknown as import('../src/server/tracking-retention').RetentionDb, now, 0);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_sessions').get() as { n: number }).n, 0, 'zero is clamped to the one-day minimum');
	insertSession.run('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ffffffff-ffff-4fff-8fff-ffffffffffff', GAME_ID, now - 30 * day, now - 30 * day, now - 30 * day, '203.0.113.4');
	await purgeGameRetention(db as unknown as import('../src/server/tracking-retention').RetentionDb, now, Number.NaN);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_sessions').get() as { n: number }).n, 1, 'non-finite values fall back to the documented 60-day default');
});

test('retention sweep drains bounded tracking batches and prunes account security rows within D1 query budget', async () => {
	const db = freshDatabase();
	const now = Date.now();
	const day = 86_400_000;
	await configureRetention(db, 7);
	const sessions = db.raw.prepare('INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	const scores = db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, achieved_at, session_id, display_name, validation_state, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, 'validated', ?)`);
	const security = db.raw.prepare('INSERT INTO security_events (endpoint, ip_address, created_at) VALUES (?, ?, ?)');
	const paint = db.raw.prepare('INSERT INTO board_paint_activity (created_at, revision, visitor_id, actions_json) VALUES (?, ?, ?, ?)');
	const maxRows = MAX_RETENTION_ROWS_PER_TABLE + MAX_RETENTION_ROWS_PER_TABLE_CATCH_UP;
	for (let index = 0; index < maxRows; index += 1) {
		const sessionId = (index + 1).toString(16).padStart(32, '0');
		const runId = `${(index + 1).toString(16).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
		const old = now - 8 * day - index;
		sessions.run(sessionId, runId, GAME_ID, old, old, old, 0, '203.0.113.6');
		scores.run(GAME_ID, 'default', index, old, sessionId, 'old score', `old-score-key-${index.toString().padStart(4, '0')}`);
		security.run('game', `203.0.113.${index % 250}`, old);
		paint.run(old, index + 1, `${(index + 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, '{}');
	}
	// Guest display names: exactly full batches on their own 30-day window, plus
	// one row past the tracking window but inside the guest window that must survive.
	const guest = db.raw.prepare('INSERT INTO guest_profiles (session_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)');
	for (let index = 0; index < maxRows; index += 1) {
		guest.run((index + 1).toString(16).padStart(64, 'a'), 'Old Guest', now - 31 * day, now - 31 * day - index);
	}
	guest.run('b'.repeat(64), 'Recent Guest', now - 10 * day, now - 10 * day);

	const queries: string[] = [];
	const deleteLimits: number[] = [];
	const instrumentedDb = {
		prepare(sql: string) {
			queries.push(sql);
			const statement = db.prepare(sql);
			return {
				bind(...values: (string | number)[]) {
					if (/^\s*DELETE/i.test(sql)) deleteLimits.push(Number(values[1]));
					const bound = statement.bind(...values);
					return { first: (column?: string) => bound.first(column), run: () => bound.run() };
				},
			};
		},
	};
	await runRetentionSweep({ BOARD_DB: instrumentedDb });
	assert.equal(queries.length, MAX_RETENTION_SWEEP_QUERIES);
	assert.ok(queries.length < 50, 'the maximum scheduled sweep stays below D1 Free per-invocation query limit');
	// Phase C: five more bounded deletes (registry, reports, reporters, log, bans).
	// Phase D: five more (dm_messages, orphaned/unclaimed attachments, dm_reports, dm_reporters).
	assert.deepEqual(deleteLimits, [50, 50, 50, 50, 50, 50, 10, 10, 10, 10, 50, 10, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
	for (const table of ['game_sessions', 'game_scores', 'security_events', 'board_paint_activity']) {
		const timestamp = table === 'game_sessions' ? 'last_seen_at' : table === 'game_scores' ? 'achieved_at' : 'created_at';
		assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${timestamp} < ?`).get(now - 7 * day) as { n: number }).n, 0, `${table} drains 60 expired rows`);
	}
	const guests = db.raw.prepare('SELECT session_hash, updated_at FROM guest_profiles').all() as { session_hash: string; updated_at: number }[];
	assert.equal(guests.length, 1, 'one guest profile survives');
	assert.equal(guests[0].session_hash, 'b'.repeat(64));
	assert.equal(guests[0].updated_at, now - 10 * day);
});

test('admin games data is protected and displays private session/device details only after authentication', async () => {
	const db = freshDatabase();
	seedAdmin(db);
	const now = Date.now();
	await recordGameSession(db as unknown as D1Database, {
		sessionId: SESSION_ID, runId: RUN_ID, playerId: null, gameId: GAME_ID, kind: 'start', activeMs: 0, now,
		ipAddress: '203.0.113.42', userAgent: 'Example UA', browser: 'Other', operatingSystem: 'Other', deviceClass: 'desktop', screenClass: 'standard', inputClass: 'fine-pointer',
	});
	bind(db);
	assert.equal((await call(adminGames.GET)).status, 401);
	assert.equal((await call(adminGames.GET, { token: 'wrong-admin-token' })).status, 401);
	const privateResponse = await call(adminGames.GET, { token: ADMIN_TOKEN });
	assert.equal(privateResponse.status, 200);
	assert.equal(privateResponse.headers.get('cache-control'), 'no-store');
	const privateData = await privateResponse.json() as Record<string, any>;
	assert.equal(privateData.sessions[0].ipAddress, '203.0.113.42');
	assert.equal(privateData.sessions[0].userAgent, 'Example UA');
	assert.equal(privateData.sessions[0].activeMs, 0);
	assert.equal(privateData.retentionDays, 60);
	const adminText = JSON.stringify(privateData);
	assert.doesNotMatch(adminText, new RegExp(`${SESSION_ID}|${RUN_ID}|sessionId|runId|playerId`), 'the private admin view must not expose internal identity or run IDs');
});

test('Lab tracking stays dynamically imported behind the Lab-only selector', () => {
	const boot = readFileSync(new URL('../src/scripts/boot.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(boot, /from ['\"]\.\/game-runtime['\"]/);
	assert.ok(boot.includes("document.querySelector('[data-lab-experiment]')"));
	assert.ok(boot.includes("import('./game-runtime')"));
});

test('games catalog and navigation have a real empty state and preserve Lab ownership', () => {
	const page = readFileSync(new URL('../src/pages/games.astro', import.meta.url), 'utf8');
	const card = readFileSync(new URL('../src/components/GameCard.astro', import.meta.url), 'utf8');
	const nav = readFileSync(new URL('../src/data/navigation.ts', import.meta.url), 'utf8');
	const footer = readFileSync(new URL('../src/components/Footer.astro', import.meta.url), 'utf8');
	assert.match(page, /No games published yet\./);
	assert.match(card, /Temporarily offline/);
	assert.match(card, /Not playable yet/);
	assert.match(nav, /label: 'Games', href: '\/games\/'/);
	assert.match(nav, /export const FOOTER_NAV/);
	assert.match(footer, /FOOTER_NAV\.map/);
	assert.match(footer, /aria-label="Site"/);
	assert.doesNotMatch(page, /components\/lab\//);
	assert.equal(new Set(GAMES.map((game) => game.id)).size, GAMES.length);
	// Catalog mode vocabulary: Lab experiments share `default`; chess scores `fastest-mate`; PvP Minesweeper ranks per difficulty.
	assert.deepEqual([...new Set(GAMES.flatMap((game) => game.modes ?? []))].sort(), ['default', 'fastest-mate', 'hard', 'normal', 'quick']);
});

test('catalog construction rejects duplicate, malformed, and misleading entries instead of silently overwriting IDs', () => {
	const valid = GAMES[0]!;
	assert.throws(() => defineGameCatalog([valid, valid] as unknown as readonly Game[]), /Duplicate game ID/);
	assert.throws(() => defineGameCatalog([{ ...valid, id: 'bnji.Bad ID' }] as unknown as readonly Game[]), /invalid stable game ID/);
	assert.throws(() => defineGameCatalog([{ ...valid, labHref: undefined, href: undefined }] as unknown as readonly Game[]), /exactly one destination/);
	assert.throws(() => defineGameCatalog([{ ...valid, labHref: '/lab/#bad path' }] as unknown as readonly Game[]), /invalid Lab link/);
	assert.throws(() => defineGameCatalog([{ ...valid, status: 'planned' }] as unknown as readonly Game[]), /cannot have a playable destination/);
	assert.throws(() => defineGameCatalog([{ ...valid, modes: ['default', 'default'] }] as unknown as readonly Game[]), /duplicate or invalid modes/);
});
