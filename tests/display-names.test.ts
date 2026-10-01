/**
 * Phase A of docs/CHAT-SYSTEM-PLAN.md — display names and handles.
 *
 * The sanitizer is unit-tested against every hostile class the plan calls out
 * (compatibility forms, invisible format characters, length boundaries,
 * reserved staff names), then the routes are exercised through the real API
 * handlers and the real migration SQL on a real SQLite engine: guest profiles
 * keyed by session digest, account handles with uniqueness + cooldown,
 * exact-match search with no id leakage, export coverage, and the retention
 * sweep's fixed 30-day guest window.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { isValidHandle, sanitizeDisplayName } from '../src/server/display-name';
import { NAMES_CONFIG } from '../src/config/names.config';
import { purgeExpiredGuestProfiles, runRetentionSweep, type RetentionDb } from '../src/server/tracking-retention';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const accountApi = await import('../src/pages/api/games/account.ts');
const exportRoute = await import('../src/pages/api/games/account/export.ts');
const profileApi = await import('../src/pages/api/profile/name.ts');
const playersApi = await import('../src/pages/api/players.ts');
const GUEST_A = '0123456789abcdef0123456789abcdef';
const GUEST_B = 'abcdef0123456789abcdef0123456789';

type RateLimitKv = { get(key: string, type?: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
const idleKv: RateLimitKv = { get: async () => null, put: async () => undefined };
function countingKv(): RateLimitKv {
	const counts = new Map<string, number>();
	return {
		async get(key) { return counts.has(key) ? String(counts.get(key)) : null; },
		async put(key, value) { counts.set(key, Number.parseInt(value, 10) || 0); },
	};
}

function database(kv: RateLimitKv = idleKv) {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: db, BOARD_KV: kv };
	globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'game-admin-test-session-secret' };
	return db;
}
function requestContext(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string; query?: string } = {}): APIContext {
	const url = `http://localhost${path}${options.query ?? ''}`;
	const headers = new Headers({ origin: options.origin ?? 'http://localhost' });
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
async function setName(cookie: string | undefined, displayName: string): Promise<Response> {
	return profileApi.POST(requestContext('/api/profile/name', { method: 'POST', cookie, body: { displayName } }));
}
async function claimHandle(cookie: string, handle: string): Promise<Response> {
	return accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie, body: { action: 'set-handle', handle }, ip: '203.0.113.9' }));
}

// ---------------------------------------------------------------- sanitizer

test('the shared display-name sanitizer normalises, strips invisibles, and counts code points', () => {
	assert.deepEqual(sanitizeDisplayName('  Ada Lovelace  '), { ok: true, name: 'Ada Lovelace' });
	assert.deepEqual(sanitizeDisplayName('ﬁne artist'), { ok: true, name: 'fine artist' }, 'NFKC folds the ligature');
	assert.deepEqual(sanitizeDisplayName('a\u202Eb'), { ok: true, name: 'ab' }, 'bidi override stripped');
	assert.deepEqual(sanitizeDisplayName('A\u200D B'), { ok: true, name: 'A B' }, 'zero-width joiner stripped');
	assert.deepEqual(sanitizeDisplayName('tab\tline\nbreak\u00a0here'), { ok: true, name: 'tab line break here' });
	assert.deepEqual(sanitizeDisplayName('x\u0000y'), { ok: true, name: 'xy' }, 'C0 control stripped');
	assert.deepEqual(sanitizeDisplayName('日本語テスト'), { ok: true, name: '日本語テスト' });
	// 24 code points is inclusive; astral characters count as one each.
	assert.equal(sanitizeDisplayName('𐀀'.repeat(24)).ok, true);
	const tooLong = sanitizeDisplayName('𐀀'.repeat(25));
	assert.equal(tooLong.ok, false);
	if (!tooLong.ok) assert.equal(tooLong.error, 'display_name_too_long');
	const asciiLong = sanitizeDisplayName('a'.repeat(25));
	assert.equal(asciiLong.ok, false);
	if (!asciiLong.ok) assert.equal(asciiLong.error, 'display_name_too_long');
});

test('the sanitizer refuses non-names and reserves staff names after NFKC case-folding', () => {
	for (const value of ['', '   ', 'user@name', 'emoji😀', 'one/two', 'x'.repeat(30) + '@', 42, null, undefined]) {
		const result = sanitizeDisplayName(value);
		assert.equal(result.ok, false, String(value));
		if (!result.ok) assert.equal(result.error, 'invalid_display_name', String(value));
	}
	for (const value of ['admin', 'Admin', 'ADMIN', 'ａｄｍｉｎ', 'moderator', ' bnji ', 'System']) {
		const result = sanitizeDisplayName(value);
		assert.equal(result.ok, false, value);
		if (!result.ok) assert.equal(result.error, 'display_name_reserved', value);
	}
});

test('handles are lowercase, bounded, and share the reserved list', () => {
	assert.equal(isValidHandle('sky_patel'), true);
	assert.equal(isValidHandle('abc'), true);
	assert.equal(isValidHandle('a_b9'), true);
	assert.equal(isValidHandle('ab'), false, 'below the minimum');
	assert.equal(isValidHandle('a'.repeat(21)), false, 'above the maximum');
	assert.equal(isValidHandle('Sky'), false, 'uppercase is normalised at the route, never accepted raw');
	assert.equal(isValidHandle('sky patel'), false);
	assert.equal(isValidHandle('sky.patel'), false);
	assert.equal(isValidHandle('café'), false);
	assert.equal(isValidHandle('admin'), false);
	assert.equal(isValidHandle('sky-patel'), false);
	assert.equal(isValidHandle(undefined), false);
	assert.equal(isValidHandle(42), false);
});

// ------------------------------------------------------------- guest names

test('guest display names are keyed by the session digest and the raw session never reaches D1', async () => {
	const db = database();
	const posted = await setName(`bnji_ps=${GUEST_A}`, 'Ghost Rider');
	assert.equal(posted.status, 200, await posted.clone().text());
	assert.deepEqual(await posted.json(), { displayName: 'Ghost Rider', scope: 'guest' });
	const rows = db.raw.prepare('SELECT session_hash, display_name, created_at, updated_at FROM guest_profiles').all() as { session_hash: string; display_name: string; created_at: number; updated_at: number }[];
	assert.equal(rows.length, 1);
	assert.equal(rows[0].session_hash, createHash('sha256').update(GUEST_A).digest('hex'));
	assert.equal(rows[0].session_hash.length, 64);
	assert.notEqual(rows[0].session_hash, GUEST_A);
	const dump = JSON.stringify(db.raw.prepare('SELECT * FROM guest_profiles').all());
	assert.ok(!dump.includes(GUEST_A), 'the raw bnji_ps session id is absent from the stored profile');

	const read = await profileApi.GET(requestContext('/api/profile/name', { cookie: `bnji_ps=${GUEST_A}` }));
	assert.deepEqual(await read.json(), { displayName: 'Ghost Rider', scope: 'guest' });

	const rename = await setName(`bnji_ps=${GUEST_A}`, 'Second Name');
	assert.equal(rename.status, 200);
	const after = db.raw.prepare('SELECT session_hash, display_name FROM guest_profiles').all() as { session_hash: string; display_name: string }[];
	assert.equal(after.length, 1, 'a second set updates the same row');
	assert.equal(after[0].display_name, 'Second Name');

	// A visitor with no session at all gets a minted cookie and guest scope.
	const fresh = await profileApi.GET(requestContext('/api/profile/name'));
	assert.deepEqual(await fresh.json(), { displayName: null, scope: 'guest' });
	assert.ok(responseCookies(fresh).some((cookie) => cookie.startsWith('bnji_ps=')), 'the minted session is returned to the browser');
});

test('profile naming is origin-checked and KV rate-limited per IP', async () => {
	database(countingKv());
	const deniedOrigin = await profileApi.POST(requestContext('/api/profile/name', { method: 'POST', cookie: `bnji_ps=${GUEST_A}`, origin: 'https://attacker.test', body: { displayName: 'Sneaky' } }));
	assert.equal(deniedOrigin.status, 403);
	assert.equal((await deniedOrigin.json() as { error: string }).error, 'origin_not_allowed');
	for (let attempt = 1; attempt <= NAMES_CONFIG.limits.nameChangeMax; attempt += 1) {
		const response = await setName(`bnji_ps=${GUEST_A}`, `Rider${attempt}`);
		assert.equal(response.status, 200, `attempt ${attempt} inside the window`);
	}
	const throttled = await setName(`bnji_ps=${GUEST_A}`, 'Rider6');
	assert.equal(throttled.status, 429, 'the sixth change inside the window is refused');
	const body = await throttled.json() as { error: string; retryAfter: number };
	assert.equal(body.error, 'rate_limited');
	assert.ok(body.retryAfter >= 1);
	assert.ok(throttled.headers.get('retry-after'));
});

// ------------------------------------------------------------ account names

test('signed-in profile naming renames the account through the shared sanitizer', async () => {
	const db = database();
	const created = await createAccount(db, GUEST_A, 'Player One');
	const renamed = await setName(created.cookie, 'Renamed Rider');
	assert.equal(renamed.status, 200, await renamed.clone().text());
	assert.deepEqual(await renamed.json(), { displayName: 'Renamed Rider', scope: 'account' });
	assert.equal((db.raw.prepare('SELECT display_name FROM game_players').get() as { display_name: string }).display_name, 'Renamed Rider');

	const reserved = await setName(created.cookie, 'moderator');
	assert.equal(reserved.status, 422);
	assert.equal((await reserved.json() as { error: string }).error, 'display_name_reserved');

	// The legacy account rename action now runs the same shared rules
	// (fullwidth "ｍｏｄｅｒａｔｏｒ" NFKC-folds into the reserved word).
	const legacy = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: created.cookie, body: { action: 'rename', displayName: 'ｍｏｄｅｒａｔｏｒ' } }));
	assert.equal(legacy.status, 400);
	assert.equal((await legacy.json() as { error: string }).error, 'display_name_reserved');
	assert.equal((db.raw.prepare('SELECT display_name FROM game_players').get() as { display_name: string }).display_name, 'Renamed Rider');
});

// ----------------------------------------------------------------- handles

test('handle claims are exact-format, unique, and cooldown-gated', async () => {
	const db = database();
	const created = await createAccount(db, GUEST_A, 'Player One');

	const claim = await claimHandle(created.cookie, 'sky_patel');
	assert.equal(claim.status, 200, await claim.clone().text());
	assert.deepEqual(await claim.json(), { handle: 'sky_patel' });
	const stored = db.raw.prepare('SELECT handle, handle_changed_at FROM game_players').get() as { handle: string; handle_changed_at: number };
	assert.equal(stored.handle, 'sky_patel');
	assert.ok(Number(stored.handle_changed_at) > 0);

	// Idempotent re-submit of the owned handle succeeds inside the cooldown,
	// and input is normalised case-insensitively.
	assert.equal((await claimHandle(created.cookie, 'SKY_PATEL')).status, 200, 'normalised re-claim of the same handle');

	// Invalid formats are refused before any counter or storage work.
	for (const handle of ['x', 'sky patel', 'sky-patel', 'admin', 'a'.repeat(21)]) {
		const refused = await claimHandle(created.cookie, handle);
		assert.equal(refused.status, 400, handle);
		assert.equal((await refused.json() as { error: string }).error, 'invalid_handle');
	}

	// A different account cannot take the same handle.
	const other = await createAccount(db, GUEST_B, 'Player Two');
	const taken = await claimHandle(other.cookie, 'sky_patel');
	assert.equal(taken.status, 409);
	assert.equal((await taken.json() as { error: string }).error, 'handle_taken');

	// Changing the handle inside the 30-day cooldown is refused with retryAfter.
	const cooldown = await claimHandle(created.cookie, 'other_handle');
	assert.equal(cooldown.status, 429);
	const cooldownBody = await cooldown.json() as { error: string; retryAfter: number };
	assert.equal(cooldownBody.error, 'handle_cooldown');
	assert.ok(cooldownBody.retryAfter > 29 * 86_400_000 / 1000, 'nearly the full 30 days remain');
	assert.ok(cooldownBody.retryAfter <= 30 * 86_400_000 / 1000);
	assert.ok(cooldown.headers.get('retry-after'));

	// Once the cooldown elapses the change goes through.
	db.raw.prepare('UPDATE game_players SET handle_changed_at = ?1').run(Date.now() - 31 * 86_400_000);
	const changed = await claimHandle(created.cookie, 'other_handle');
	assert.equal(changed.status, 200, await changed.clone().text());
	assert.deepEqual(await changed.json(), { handle: 'other_handle' });

	const status = await accountApi.GET(requestContext('/api/games/account', { cookie: created.cookie }));
	const statusBody = await status.json() as { handle: string | null };
	assert.equal(statusBody.handle, 'other_handle');
});

test('handle search is exact-match, minimal in what it reveals, and IP-throttled', async () => {
	const db = database();
	const created = await createAccount(db, GUEST_A, 'Player One');
	assert.equal((await claimHandle(created.cookie, 'sky_patel')).status, 200);

	const found = await playersApi.GET(requestContext('/api/players', { query: '?handle=sky_patel' }));
	assert.equal(found.status, 200);
	const foundText = await found.text();
	assert.deepEqual(JSON.parse(foundText), { found: true, handle: 'sky_patel', displayName: 'Player One' });
	assert.doesNotMatch(foundText, /playerId|sessionId|recoveryHash|tokenHash|bnji_ga|bnji_ps/i);

	const upper = await playersApi.GET(requestContext('/api/players', { query: '?handle=SKY_PATEL' }));
	assert.equal((await upper.json() as { found: boolean }).found, true, 'lookup normalises case');

	const missing = await playersApi.GET(requestContext('/api/players', { query: '?handle=nobody_home' }));
	assert.deepEqual(await missing.json(), { found: false });

	const invalid = await playersApi.GET(requestContext('/api/players', { query: '?handle=ab' }));
	assert.equal(invalid.status, 400);
	assert.equal((await invalid.json() as { error: string }).error, 'invalid_handle');

	// Per-IP window: sky + upper + nobody = 3 spent; five more fit, the ninth is refused.
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const probe = await playersApi.GET(requestContext('/api/players', { query: `?handle=ghost${attempt}` }));
		assert.equal(probe.status, 200, `lookup ${attempt + 4} inside the window`);
	}
	const throttled = await playersApi.GET(requestContext('/api/players', { query: '?handle=ghost9' }));
	assert.equal(throttled.status, 429);
	assert.equal((await throttled.json() as { error: string }).error, 'rate_limited');
	assert.ok(throttled.headers.get('retry-after'));
});

// ------------------------------------------------------- export + deletion

test('account export includes the handle and still leaks no internal identifiers', async () => {
	const db = database();
	const created = await createAccount(db, GUEST_A, 'Player One');
	assert.equal((await claimHandle(created.cookie, 'sky_patel')).status, 200);
	const playerId = (db.raw.prepare('SELECT id FROM game_players').get() as { id: string }).id;

	const exported = await exportRoute.GET(requestContext('/api/games/account/export', { cookie: created.cookie }));
	assert.equal(exported.status, 200);
	const exportText = await exported.text();
	const data = JSON.parse(exportText) as { format: string; version: number; account: { displayName: string; handle: string | null } };
	assert.equal(data.format, 'bnji.game-account-export');
	assert.equal(data.version, 1, 'adding handle is additive; the export version is unchanged');
	assert.deepEqual(data.account.displayName, 'Player One');
	assert.deepEqual(data.account.handle, 'sky_patel');
	assert.doesNotMatch(exportText, new RegExp(`${playerId}|recoveryHash|tokenHash|bnji_ga|bnji_ps`));

	// Deleting the account removes the handle with the player row; the guest
	// profile stays session-scoped (owned by the retention sweep, not by the
	// account — see docs/DATA.md §11).
	await setName(`bnji_ps=${GUEST_A}`, 'Ghost Rider');
	const deleted = await accountApi.DELETE(requestContext('/api/games/account', { method: 'DELETE', cookie: created.cookie, body: { confirmation: 'DELETE' } }));
	assert.equal(deleted.status, 200, await deleted.clone().text());
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM game_players').get() as { n: number }).n, 0);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM guest_profiles').get() as { n: number }).n, 1, 'guest profiles are not account-linked');
});

// --------------------------------------------------------------- retention

test('the retention sweep expires guest display names on the fixed 30-day window', async () => {
	const db = database();
	const now = Date.now();
	const day = 86_400_000;
	const insert = db.raw.prepare('INSERT INTO guest_profiles (session_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)');
	insert.run('a'.repeat(64), 'Old Guest', now - 31 * day, now - 31 * day);
	insert.run('b'.repeat(64), 'Recent Guest', now - 2 * day, now - 2 * day);
	insert.run('c'.repeat(64), 'Ten Day Guest', now - 10 * day, now - 10 * day);

	// Tracking retention defaults to 60 days, which would keep a 31-day-old
	// row; the guest window (30 days) must be what expires it.
	await runRetentionSweep({ BOARD_DB: db });
	const remaining = db.raw.prepare('SELECT display_name FROM guest_profiles').all() as { display_name: string }[];
	assert.deepEqual(remaining.map((row) => row.display_name).sort(), ['Recent Guest', 'Ten Day Guest']);

	// The purge is bounded: 55 expired rows lose only one 50-row batch per call.
	for (let index = 0; index < 55; index += 1) {
		insert.run(index.toString(16).padStart(64, 'f'), 'Backlog', now - 40 * day, now - 40 * day - index);
	}
	const purged = await purgeExpiredGuestProfiles(db as unknown as RetentionDb, now - 30 * day);
	assert.equal(purged, 50, 'one bounded primary batch');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM guest_profiles WHERE updated_at < ?').get(now - 30 * day) as { n: number }).n, 5, 'the rest waits for the next sweep');
});
