import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import type { D1Database } from '../src/server/game-store';
import { resolvePlayerContext } from '../src/server/player-context';
import { checkPlayerLoginLockout, PLAYER_SAVE_MAX_BYTES, PLAYER_SAVE_MAX_SLOTS, sha256Hex, validateSaveData, writePlayerSave } from '../src/server/player-store';
import { registerScoreVerifier } from '../src/server/score-verifiers';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const accountApi = await import('../src/pages/api/games/account.ts');
const exportRoute = await import('../src/pages/api/games/account/export.ts');
const savesApi = await import('../src/pages/api/games/saves.ts');
const gameSessionApi = await import('../src/pages/api/games/session.ts');
const scoresApi = await import('../src/pages/api/games/scores.ts');
const adminGamesApi = await import('../src/pages/api/admin/games.ts');
const ADMIN_TOKEN = 'test-game-admin-secret';
const GUEST_A = '0123456789abcdef0123456789abcdef';
const GUEST_B = 'abcdef0123456789abcdef0123456789';
const GUEST_C = 'fedcba9876543210fedcba9876543210';
const GAME = 'bnji.glass-minesweeper';
const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function database() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: db, BOARD_KV: { get: async () => null, put: async () => undefined } };
	globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'game-admin-test-session-secret' };
	return db;
}
function requestContext(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string; headers?: Record<string, string>; query?: string } = {}): APIContext {
	const url = `http://localhost${path}${options.query ?? ''}`;
	const headers = new Headers({ origin: options.origin ?? 'http://localhost', ...(options.headers ?? {}) });
	if (options.cookie) headers.set('cookie', options.cookie);
	if (options.ip) headers.set('cf-connecting-ip', options.ip);
	if (options.body !== undefined) headers.set('content-type', 'application/json');
	const body = options.body === undefined ? undefined : JSON.stringify(options.body);
	const request = new Request(url, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
	return { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
}
function responseCookies(response: Response): string[] {
	return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
}
function cookieValue(response: Response, name: string): string {
	const cookie = responseCookies(response).find((item) => item.startsWith(`${name}=`));
	assert.ok(cookie, `missing ${name} Set-Cookie`);
	return cookie!.slice(name.length + 1).split(';', 1)[0];
}
function authCookie(response: Response, guest = GUEST_A): string {
	return `bnji_ps=${guest}; bnji_ga=${cookieValue(response, 'bnji_ga')}`;
}
async function createAccount(db: ReturnType<typeof database>, guest = GUEST_A, name = 'Player One') {
	const response = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: `bnji_ps=${guest}`, body: { action: 'create', displayName: name }, ip: '203.0.113.1' }));
	assert.equal(response.status, 201, await response.clone().text());
	return { response, body: await response.json() as Record<string, unknown>, cookie: authCookie(response, guest) };
}
async function createSave(db: ReturnType<typeof database>, cookie: string, body: Record<string, unknown>) {
	return savesApi.PUT(requestContext('/api/games/saves', { method: 'PUT', cookie, body }));
}

// The security contract must survive the actual API handlers and migration SQL.
test('account creation stores only credential/session digests and safely claims the current guest history', async () => {
	const db = database();
	db.raw.prepare(`INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address)
		VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
		.run(GUEST_A, RUN, GAME, 100, 200, 200, '203.0.113.5');
	db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, achieved_at, session_id, display_name, validation_state, idempotency_key)
		VALUES (?, 'default', 42, 300, ?, 'guest-name', 'validated', 'claim-score-key-0001')`).run(GAME, GUEST_A);
	db.raw.prepare(`INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address)
		VALUES (?, ?, ?, 100, 200, 200, 0, ?)`)
		.run(GUEST_C, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', GAME, '203.0.113.6');
	db.raw.prepare(`INSERT INTO game_scores (game_id, mode_id, score, achieved_at, session_id, display_name, validation_state, idempotency_key)
		VALUES (?, 'default', 41, 301, ?, 'unlinked-name', 'validated', 'claim-score-key-0002')`).run(GAME, GUEST_C);
	const { response, body, cookie } = await createAccount(db);
	const code = String(body.recoveryCode);
	assert.match(code, /^BNJI-[A-HJ-NP-Z2-9]{32}$/);
	assert.equal(body.recoveryCodeDisplayedOnce, true);
	assert.doesNotMatch(response.headers.get('cache-control') ?? '', /public/i);
	const stored = db.raw.prepare('SELECT id, recovery_hash, display_name FROM game_players').get() as { id: string; recovery_hash: string; display_name: string };
	assert.match(stored.id, /^[a-f0-9]{32}$/);
	assert.equal(stored.recovery_hash, createHash('sha256').update(code).digest('hex'));
	assert.notEqual(stored.recovery_hash, code);
	const token = cookie.match(/bnji_ga=([^;]+)/)?.[1] ?? '';
	assert.match(token, /^[A-Za-z0-9_-]{43}$/);
	assert.equal((db.raw.prepare('SELECT token_hash FROM game_player_sessions').get() as { token_hash: string }).token_hash, createHash('sha256').update(token).digest('hex'));
	for (const cookieHeader of responseCookies(response)) {
		if (cookieHeader.startsWith('bnji_ga=')) assert.match(cookieHeader, /Secure; HttpOnly;?$/);
	}
	assert.equal((db.raw.prepare('SELECT player_id FROM game_sessions').get() as { player_id: string }).player_id, stored.id);
	assert.equal((db.raw.prepare('SELECT player_id FROM game_scores WHERE session_id = ?').get(GUEST_A) as { player_id: string }).player_id, stored.id);
	assert.equal((db.raw.prepare('SELECT player_id FROM game_sessions WHERE session_id = ?').get(GUEST_C) as { player_id: string | null }).player_id, null, 'account creation must not claim another guest');
	assert.equal((db.raw.prepare('SELECT player_id FROM game_scores WHERE session_id = ?').get(GUEST_C) as { player_id: string | null }).player_id, null, 'account creation must not claim another guest score');
	const status = await accountApi.GET(requestContext('/api/games/account', { cookie }));
	const statusText = await status.text();
	assert.deepEqual(JSON.parse(statusText), { authenticated: true, displayName: 'Player One', saveCount: 0, handle: null });
	assert.doesNotMatch(statusText, /playerId|sessionId|recoveryHash|tokenHash|BNJI-/i);
});

	test('login uses case-insensitive high-entropy recovery codes, claims only this guest, and caps active device sessions', async () => {
	const db = database();
	db.raw.prepare(`INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address)
		VALUES (?, ?, ?, 1, 2, 2, 0, '203.0.113.7')`).run(GUEST_A, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', GAME);
	const created = await createAccount(db, GUEST_A, 'Global Name');
	const recovery = String(created.body.recoveryCode);
	const otherGuestRun = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
	db.raw.prepare(`INSERT INTO game_sessions (session_id, run_id, game_id, started_at, last_seen_at, last_heartbeat_at, active_ms, ip_address)
		VALUES (?, ?, ?, 1, 2, 2, 0, '203.0.113.7')`).run(GUEST_B, otherGuestRun, GAME);
	const login = await accountApi.POST(requestContext('/api/games/account', {
		method: 'POST', cookie: `bnji_ps=${GUEST_B}`, body: { action: 'login', recoveryCode: recovery.toLowerCase() }, ip: '198.51.100.2',
	}));
	assert.equal(login.status, 200, await login.clone().text());
	assert.deepEqual(await login.json(), { authenticated: true, displayName: 'Global Name' });
	const storedId = (db.raw.prepare('SELECT id FROM game_players').get() as { id: string }).id;
	assert.equal((db.raw.prepare('SELECT player_id FROM game_sessions WHERE session_id = ?').get(GUEST_B) as { player_id: string }).player_id, storedId);
	assert.equal((db.raw.prepare('SELECT player_id FROM game_sessions WHERE session_id = ?').get(GUEST_A) as { player_id: string }).player_id, storedId);
	assert.notEqual(cookieValue(login, 'bnji_ga'), cookieValue(created.response, 'bnji_ga'));
	for (let index = 0; index < PLAYER_SAVE_MAX_SLOTS + 2; index += 1) {
		const token = `device-session-${String(index).padStart(2, '0')}`;
		const hash = createHash('sha256').update(token).digest('hex');
		// The route-generated tokens are 256-bit; this direct fixture isolates the SQL cap.
		await db.prepare('INSERT OR REPLACE INTO game_player_sessions (token_hash, player_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)')
			.bind(hash, storedId, 1_000 + index, Date.now() + 86_400_000).run();
	}
	assert.ok((db.raw.prepare('SELECT COUNT(*) AS n FROM game_player_sessions WHERE player_id = ? AND expires_at > ? AND revoked_at IS NULL').get(storedId, Date.now()) as { n: number }).n > 10, 'direct fixture makes too many active sessions to test the route cap');
	const cappedLogin = await accountApi.POST(requestContext('/api/games/account', {
		method: 'POST', cookie: `bnji_ps=${GUEST_B}`, body: { action: 'login', recoveryCode: recovery }, ip: '198.51.100.2',
	}));
	assert.equal(cappedLogin.status, 200);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_player_sessions WHERE player_id = ? AND expires_at > ? AND revoked_at IS NULL').get(storedId, Date.now()) as { n: number }).n, 10);
});

test('account and save mutations reject unexpected envelope keys without changing credentials or rows', async () => {
	const db = database();
	const created = await createAccount(db);
	const recoveryCode = String(created.body.recoveryCode);
	const cookie = created.cookie;
	const attemptsBefore = (db.raw.prepare('SELECT COUNT(*) AS n FROM game_auth_attempts').get() as { n: number }).n;
	const login = await accountApi.POST(requestContext('/api/games/account', {
		method: 'POST', cookie: `bnji_ps=${GUEST_B}`, body: { action: 'login', recoveryCode, ignored: 'extra' }, ip: '198.51.100.33',
	}));
	assert.equal(login.status, 400);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_auth_attempts').get() as { n: number }).n, attemptsBefore);
	const extraSignOut = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie, body: { action: 'sign-out', ignored: true } }));
	assert.equal(extraSignOut.status, 400);
	const extraRotation = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie, body: { action: 'rotate-recovery-code', ignored: true } }));
	assert.equal(extraRotation.status, 400);
	const stillAuthenticated = await accountApi.GET(requestContext('/api/games/account', { cookie }));
	assert.equal((await stillAuthenticated.json() as { authenticated: boolean }).authenticated, true);
	const saved = await createSave(db, cookie, { gameId: GAME, slotId: 'default', schemaVersion: 1, data: { level: 1 }, expectedRevision: null });
	assert.equal(saved.status, 200);
	const extraPut = await createSave(db, cookie, { gameId: GAME, slotId: 'default', schemaVersion: 1, data: { level: 2 }, expectedRevision: 1, playerId: 'another-player' });
	assert.equal(extraPut.status, 400);
	const extraDelete = await savesApi.DELETE(requestContext('/api/games/saves', { method: 'DELETE', cookie, body: { gameId: GAME, slotId: 'default', expectedRevision: 1, playerId: 'another-player' } }));
	assert.equal(extraDelete.status, 400);
	assert.equal((db.raw.prepare('SELECT revision, data_json FROM game_saves').get() as { revision: number; data_json: string }).revision, 1);
	const extraAccountDelete = await accountApi.DELETE(requestContext('/api/games/account', { method: 'DELETE', cookie, body: { confirmation: 'DELETE', playerId: 'another-player' } }));
	assert.equal(extraAccountDelete.status, 400);
	for (const body of [{}, { confirmation: 'delete' }]) {
		const unconfirmed = await accountApi.DELETE(requestContext('/api/games/account', { method: 'DELETE', cookie, body }));
		assert.equal(unconfirmed.status, 400, 'account deletion requires the exact confirmation word');
	}
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_players').get() as { n: number }).n, 1);
});

test('login failures lock out after eight attempts per IP without storing the raw IP or code', async () => {
	const db = database();
	const badCode = `BNJI-${'A'.repeat(32)}`;
	for (let count = 1; count <= 8; count += 1) {
		const cookie = `bnji_ps=${count % 2 ? GUEST_A : GUEST_B}`;
		const response = await accountApi.POST(requestContext('/api/games/account', {
			method: 'POST', cookie, body: { action: 'login', recoveryCode: badCode }, ip: '198.51.100.99',
			headers: { 'x-forwarded-for': `203.0.113.${count}`, 'user-agent': `audit-client-${count}` },
		}));
		assert.equal(response.status, count === 8 ? 429 : 401);
	}
	const locked = await accountApi.POST(requestContext('/api/games/account', {
		method: 'POST', cookie: `bnji_ps=${GUEST_B}`, body: { action: 'login', recoveryCode: badCode }, ip: '198.51.100.99',
		headers: { 'x-forwarded-for': '192.0.2.1', 'user-agent': 'different-client' },
	}));
	assert.equal(locked.status, 429, 'changing guest cookies, User-Agent, or X-Forwarded-For does not bypass the Cloudflare IP bucket');
	assert.ok(Number(locked.headers.get('retry-after')) > 0);
	const attemptRow = db.raw.prepare('SELECT attempts, window_started_at FROM game_auth_attempts').get() as { attempts: number; window_started_at: number };
	assert.equal(attemptRow.attempts, 8);
	const expired = await checkPlayerLoginLockout(db as unknown as D1Database, await sha256Hex('bnji-game-login:198.51.100.99'), attemptRow.window_started_at + 15 * 60_000 + 1);
	assert.equal(expired.locked, false, 'lockout expires after the 15-minute window');
	const stored = JSON.stringify(db.raw.prepare('SELECT * FROM game_auth_attempts').all());
	assert.doesNotMatch(stored, /198\.51\.100\.99|A{32}/);
});

test('same-origin mutation checks, recovery rotation, sign-out, and account deletion revoke access', async () => {
	const db = database();
	const created = await createAccount(db);
	const oldCode = String(created.body.recoveryCode);
	const oldCookie = created.cookie;
	const deniedOrigin = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: oldCookie, origin: 'https://attacker.test', body: { action: 'rename', displayName: 'Nope' } }));
	assert.equal(deniedOrigin.status, 403);
	const second = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: `bnji_ps=${GUEST_B}`, body: { action: 'login', recoveryCode: oldCode }, ip: '203.0.113.9' }));
	assert.equal(second.status, 200);
	const rotated = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: oldCookie, body: { action: 'rotate-recovery-code' } }));
	assert.equal(rotated.status, 200);
	const newCode = String((await rotated.json() as Record<string, unknown>).recoveryCode);
	assert.notEqual(newCode, oldCode);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_player_sessions').get() as { n: number }).n, 1, 'rotation keeps only the current session');
	const oldLogin = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', body: { action: 'login', recoveryCode: oldCode }, ip: '203.0.113.10' }));
	assert.equal(oldLogin.status, 401);
	const stillSignedIn = await accountApi.GET(requestContext('/api/games/account', { cookie: oldCookie }));
	assert.equal(stillSignedIn.status, 200);
	const signout = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: oldCookie, body: { action: 'sign-out' } }));
	assert.equal(signout.status, 200);
	assert.ok(responseCookies(signout).some((value) => value.startsWith('bnji_ga=;') && value.includes('Max-Age=0')));
	assert.equal((await accountApi.GET(requestContext('/api/games/account', { cookie: oldCookie }))).status, 200, 'revoked token falls back safely to guest state');

	const newSession = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', body: { action: 'login', recoveryCode: newCode }, ip: '203.0.113.11' }));
	assert.equal(newSession.status, 200);
	const signedInCookie = authCookie(newSession, GUEST_A);
	const playerId = (db.raw.prepare('SELECT id FROM game_players').get() as { id: string }).id;
	await db.prepare('INSERT INTO game_saves (player_id, game_id, slot_id, schema_version, revision, data_json, updated_at) VALUES (?, ?, ?, 1, 1, ?, 1)')
		.bind(playerId, GAME, 'default', '{"progress":1}').run();
	const deleted = await accountApi.DELETE(requestContext('/api/games/account', { method: 'DELETE', cookie: signedInCookie, body: { confirmation: 'DELETE' } }));
	assert.equal(deleted.status, 200);
	assert.deepEqual(await deleted.json(), { deleted: true, localSavesKept: true });
	for (const table of ['game_players', 'game_player_sessions', 'game_saves', 'game_scores', 'game_sessions']) {
		assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} deleted`);
	}
});

test('save contract validates bounded JSON and performs revision compare-and-swap without lost updates', async () => {
	const db = database();
	const created = await createAccount(db);
	const cookie = created.cookie;
	const initial = { gameId: GAME, slotId: 'default', schemaVersion: 1, data: { level: 3, items: ['key'] }, expectedRevision: null };
	const first = await createSave(db, cookie, initial);
	assert.equal(first.status, 200, await first.clone().text());
	assert.equal((await first.json() as { revision: number }).revision, 1);
	const update = await createSave(db, cookie, { ...initial, data: { level: 4 }, expectedRevision: 1 });
	assert.equal(update.status, 200);
	assert.equal((await update.json() as { revision: number }).revision, 2);
	const conflict = await createSave(db, cookie, { ...initial, data: { level: 99 }, expectedRevision: 1 });
	assert.equal(conflict.status, 409);
	const conflictBody = await conflict.json() as { error: string; current: { revision: number; data: unknown } };
	assert.equal(conflictBody.error, 'save_conflict');
	assert.equal(conflictBody.current.revision, 2);
	assert.deepEqual(conflictBody.current.data, { level: 4 });
	const list = await savesApi.GET(requestContext('/api/games/saves', { cookie }));
	assert.equal(list.status, 200);
	const save = ((await list.json() as { saves: Array<{ revision: number; data: unknown }> }).saves[0]);
	assert.equal(save.revision, 2);
	assert.deepEqual(save.data, { level: 4 });
	const badOrigin = await savesApi.PUT(requestContext('/api/games/saves', { method: 'PUT', cookie, origin: 'https://cross-origin.test', body: initial }));
	assert.equal(badOrigin.status, 403);
	assert.equal((await createSave(db, cookie, { ...initial, gameId: 'other.game' })).status, 404);
	assert.equal((await createSave(db, cookie, { ...initial, slotId: '../secret' })).status, 400);
	assert.equal((await createSave(db, cookie, { ...initial, schemaVersion: 0 })).status, 400);
	const tooLarge = await createSave(db, cookie, { ...initial, data: 'x'.repeat(PLAYER_SAVE_MAX_BYTES + 10) });
	assert.equal(tooLarge.status, 400);
	assert.equal((await tooLarge.json() as { error: string }).error, 'save_too_large');
	assert.equal(validateSaveData({ nested: { too: { deep: 'x' } } }).ok, true);
	assert.equal(validateSaveData(undefined).ok, false);
	assert.equal(validateSaveData({ a: Number.NaN }).ok, false);
	const deleteStale = await savesApi.DELETE(requestContext('/api/games/saves', { method: 'DELETE', cookie, body: { gameId: GAME, slotId: 'default', expectedRevision: 1 } }));
	assert.equal(deleteStale.status, 409);
	const deleteCurrent = await savesApi.DELETE(requestContext('/api/games/saves', { method: 'DELETE', cookie, body: { gameId: GAME, slotId: 'default', expectedRevision: 2 } }));
	assert.equal(deleteCurrent.status, 200);
	const deleteRetry = await savesApi.DELETE(requestContext('/api/games/saves', { method: 'DELETE', cookie, body: { gameId: GAME, slotId: 'default', expectedRevision: 2 } }));
	assert.equal(deleteRetry.status, 200, 'lost delete responses can be retried idempotently');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_saves').get() as { n: number }).n, 0);
});

test('two independent player accounts cannot list, overwrite, or merge each other’s save slots', async () => {
	const db = database();
	const ownerA = await createAccount(db, GUEST_A, 'Owner A');
	const ownerB = await createAccount(db, GUEST_B, 'Owner B');
	const saveA = await createSave(db, ownerA.cookie, { gameId: GAME, slotId: 'default', schemaVersion: 1, data: { owner: 'A' }, expectedRevision: null });
	assert.equal(saveA.status, 200);
	const emptyB = await savesApi.GET(requestContext('/api/games/saves', { cookie: ownerB.cookie }));
	assert.equal(emptyB.status, 200);
	assert.deepEqual((await emptyB.json() as { saves: unknown[] }).saves, []);
	const saveB = await createSave(db, ownerB.cookie, { gameId: GAME, slotId: 'default', schemaVersion: 1, data: { owner: 'B' }, expectedRevision: null });
	assert.equal(saveB.status, 200);
	for (const [owner, cookie] of [['A', ownerA.cookie], ['B', ownerB.cookie]] as const) {
		const listed = await savesApi.GET(requestContext('/api/games/saves', { cookie }));
		const payload = await listed.json() as { saves: Array<{ revision: number; data: unknown }> };
		assert.equal(payload.saves.length, 1);
		assert.equal(payload.saves[0]?.revision, 1);
		assert.deepEqual(payload.saves[0]?.data, { owner });
	}
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_saves').get() as { n: number }).n, 2);
});

test('save quotas cap the whole player at 25 slots and reject guests without altering local state', async () => {
	const db = database();
	const created = await createAccount(db);
	for (let slot = 0; slot < PLAYER_SAVE_MAX_SLOTS; slot += 1) {
		const response = await createSave(db, created.cookie, { gameId: GAME, slotId: `slot-${slot}`, schemaVersion: 1, data: { slot }, expectedRevision: null });
		assert.equal(response.status, 200, `slot ${slot}`);
	}
	const over = await createSave(db, created.cookie, { gameId: GAME, slotId: 'overflow', schemaVersion: 1, data: {}, expectedRevision: null });
	assert.equal(over.status, 409);
	assert.equal((await over.json() as { error: string }).error, 'save_slot_limit');
	const guest = await savesApi.GET(requestContext('/api/games/saves', { cookie: `bnji_ps=${GUEST_B}` }));
	assert.equal(guest.status, 401);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_saves').get() as { n: number }).n, 25);
});

test('guest and authenticated identity flow into tracking/scores, while public responses omit internal keys', async () => {
	const db = database();
	const guestSession = RUN;
	const created = await createAccount(db, GUEST_A, 'Server Display Name');
	const authenticatedCookie = created.cookie;
	const tracking = await gameSessionApi.POST(requestContext('/api/games/session', {
		method: 'POST', cookie: authenticatedCookie,
		body: { gameId: GAME, runId: guestSession, kind: 'start', activeMs: 0, screenClass: 'standard', inputClass: 'touch' },
	}));
	assert.equal(tracking.status, 204);
	const playerId = (db.raw.prepare('SELECT id FROM game_players').get() as { id: string }).id;
	assert.equal((db.raw.prepare('SELECT player_id FROM game_sessions WHERE run_id = ?').get(guestSession) as { player_id: string }).player_id, playerId);
	const verifierContexts: Array<{ sessionId: string; playerId: string | null }> = [];
	let verifiedName = '';
	const unregister = registerScoreVerifier(GAME, async (claim, context) => {
		verifierContexts.push(context);
		verifiedName = claim.displayName;
		return { score: claim.score, tieBreak: claim.tieBreak };
	});
	try {
		const submitted = await scoresApi.POST(requestContext('/api/games/scores', {
			method: 'POST', cookie: authenticatedCookie,
			body: { gameId: GAME, mode: 'default', score: 75, tieBreak: null, displayName: 'Spoofed Client Name', idempotencyKey: 'player-score-key-0001', proof: { opaque: true } },
		}));
		assert.equal(submitted.status, 201, await submitted.clone().text());
		assert.equal(verifierContexts[0]?.playerId, playerId);
		assert.equal(verifiedName, 'Server Display Name');
		const publicBoard = await (await import('../src/pages/api/games/leaderboard.ts')).GET(requestContext('/api/games/leaderboard', { query: `?gameId=${GAME}&mode=default` }));
		assert.equal(publicBoard.status, 200);
		const publicText = await publicBoard.text();
		assert.match(publicText, /Server Display Name/);
		assert.doesNotMatch(publicText, new RegExp(`${playerId}|${GUEST_A}|sessionId|playerId|ipAddress|userAgent`));
	} finally { unregister(); }
});

test('account export and authenticated admin metadata reveal neither credentials nor internal player IDs', async () => {
	const db = database();
	const created = await createAccount(db);
	const playerId = (db.raw.prepare('SELECT id FROM game_players').get() as { id: string }).id;
	await db.prepare('INSERT INTO game_saves (player_id, game_id, slot_id, schema_version, revision, data_json, updated_at) VALUES (?, ?, ?, 1, 1, ?, 1)')
		.bind(playerId, GAME, 'default', '{"state":"private"}').run();
	const exported = await exportRoute.GET(requestContext('/api/games/account/export', { cookie: created.cookie }));
	assert.equal(exported.status, 200);
	const exportText = await exported.text();
	assert.match(exportText, /bnji.game-account-export/);
	assert.match(exportText, /private/);
	assert.doesNotMatch(exportText, new RegExp(`${playerId}|recoveryHash|tokenHash|bnji_ga|bnji_ps`));
	const unauthorized = await adminGamesApi.GET(requestContext('/api/admin/games'));
	assert.equal(unauthorized.status, 401);
	const adminTokenHash = createHash('sha256').update(ADMIN_TOKEN).digest('hex');
	db.raw.prepare('UPDATE admin_credentials SET token_hash = ? WHERE id = 1').run(adminTokenHash);
	const admin = await adminGamesApi.GET(requestContext('/api/admin/games', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
	assert.equal(admin.status, 200);
	const adminText = await admin.text();
	assert.match(adminText, /"identity"/);
	assert.match(adminText, /"players":1/);
	assert.match(adminText, /"saveBlobs":1/);
	assert.doesNotMatch(adminText, /recovery_hash|token_hash|recoveryCode|BNJI-[A-HJ-NP-Z2-9]{32}/);
});

test('an authenticated cookie cannot silently downgrade if D1 is unavailable; public score submissions remain fail-closed', async () => {
	const db = database();
	const created = await createAccount(db);
	globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_KV: { get: async () => null, put: async () => undefined } };
	const context = await resolvePlayerContext(new Request('https://site.test/', { headers: { cookie: created.cookie } })).catch((error) => error);
	assert.ok(context instanceof Error);
	globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: db, BOARD_KV: { get: async () => null, put: async () => undefined } };
	const guestOnly = await resolvePlayerContext(new Request('https://site.test/', { headers: { cookie: `bnji_ps=${GUEST_A}` } }));
	assert.equal(guestOnly.playerId, null);
	assert.equal(guestOnly.sessionId, GUEST_A);
	assert.equal((await scoresApi.POST(requestContext('/api/games/scores', { method: 'POST', cookie: created.cookie, body: { gameId: GAME } }))).status, 400);
});
