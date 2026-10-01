/**
 * Chat plan Phase C — moderation stores, §6.3 filter helpers, and routes.
 *
 * Platform behaviour (service-authenticated DO endpoints, membership-auth
 * report snapshot) is covered by tests/workerd/room-moderation.spec.ts;
 * this file locks the D1 layer, the report/admin routes' guards and
 * validation, account export/deletion coverage, and the pure helpers.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import type { D1Database } from '../src/server/game-store';
import { CHAT_CONFIG } from '../src/config/chat.config';
import {
	containsBlockedTerm, roomAdminServiceToken, stripUrlsForDisplay,
} from '../src/server/game-room-protocol';
import {
	accountModerationStatements, activeChatBan, addModerationLog, clearChatBan, deleteAccountModerationRows,
	deleteRoomRegistryEntry, exportFiledReports, exportReportsOnAccount, getChatBan, getChatReport, getRoomRegistryEntry,
	hasReporter, listActiveChatBans, listActiveRooms, listChatReports, listModerationLog, purgeChatModerationRows,
	recordChatReport, registerRoom, setChatBan, setChatReportStatus,
} from '../src/server/chat-moderation';
import { deletePlayerAccount, sha256Hex } from '../src/server/player-store';

declare global {
	// Set by tests/support/register.mjs; the stubs read both live at call time.
	var __BNJI_TEST_SECRETS__: Record<string, string>;
	var __BNJI_TEST_BINDINGS__: Record<string, unknown>;
}
globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'test-session-secret' };
globalThis.__BNJI_TEST_BINDINGS__ = {};

const ADMIN_TOKEN = 'chat-admin-test-token';
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url))
	.filter((name) => name.endsWith('.sql')).sort();

type TestDb = D1Database & { raw: ReturnType<typeof createTestD1>['raw'] };
function freshDatabase(): TestDb {
	const db = createTestD1() as unknown as TestDb;
	for (const name of MIGRATIONS) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	return db;
}
function bind(db: ReturnType<typeof freshDatabase> | null): void {
	globalThis.__BNJI_TEST_BINDINGS__ = db ? { BOARD_DB: db } : {};
}
function seedAdmin(db: ReturnType<typeof freshDatabase>): void {
	// Upsert: this test deletes the row to prove the 503 guard, then reseeds.
	db.raw.prepare('INSERT INTO admin_credentials (id, token_hash, updated_at) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash')
		.run(createHash('sha256').update(ADMIN_TOKEN).digest('hex'));
}
function requestContext(path: string, options: { method?: string; body?: unknown; token?: string; origin?: string; ip?: string; query?: string } = {}): APIContext {
	const url = `http://localhost${path}${options.query ?? ''}`;
	const headers = new Headers({ origin: options.origin ?? 'http://localhost' });
	if (options.token) headers.set('authorization', `Bearer ${options.token}`);
	if (options.ip) headers.set('cf-connecting-ip', options.ip);
	if (options.body !== undefined) headers.set('content-type', 'application/json');
	const body = options.body === undefined ? undefined : JSON.stringify(options.body);
	const request = new Request(url, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
	return { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
}
const CODE = 'hT3sIstHisAroomCod3xXx';
const now = () => Date.now();

/* ------------------------------------------------------------------ stores */

test('room registry: idempotent register, live-only listing, delete', async () => {
	const db = freshDatabase();
	const t = now();
	await registerRoom(db, { code: CODE, gameId: 'bnji.glass-minesweeper', ownerHash: 'a'.repeat(64), createdAt: t, expiresAt: t + 1_000 });
	await registerRoom(db, { code: CODE, gameId: 'bnji.glass-minesweeper', ownerHash: 'a'.repeat(64), createdAt: t, expiresAt: t + 1_000 });
	const rows = await listActiveRooms(db, t);
	assert.equal(rows.length, 1, 'register is idempotent');
	assert.equal(rows[0].gameId, 'bnji.glass-minesweeper');
	assert.ok(await getRoomRegistryEntry(db, CODE, t));
	assert.equal(await getRoomRegistryEntry(db, CODE, t + 2_000), null, 'expired rooms are not listable');
	await registerRoom(db, { code: 'x'.repeat(22), gameId: 'bnji.glass-minesweeper', ownerHash: 'b'.repeat(64), createdAt: t - 5_000, expiresAt: t - 1 });
	assert.equal((await listActiveRooms(db, t)).length, 1, 'past-expiry rows are skipped');
	await deleteRoomRegistryEntry(db, CODE);
	assert.equal((await listActiveRooms(db, t)).length, 0);
});

test('reports: distinct reporters count once, snapshots export, status transitions log', async () => {
	const db = freshDatabase();
	const t = now();
	const snapshot = { authorHash: 'c'.repeat(64), label: 'Alice', text: 'buy my thing', messageAt: t - 100 };
	const first = await recordChatReport(db, { code: CODE, n: 3, snapshot, reporterHash: 'd'.repeat(64), now: t });
	assert.equal(first.reportCount, 1);
	assert.equal(first.created, true);
	// Production checks hasReporter() first — same principal never double-counts.
	assert.equal(await hasReporter(db, CODE, 3, 'd'.repeat(64)), true);
	assert.equal(await hasReporter(db, CODE, 3, 'e'.repeat(64)), false);
	const second = await recordChatReport(db, { code: CODE, n: 3, snapshot, reporterHash: 'e'.repeat(64), now: t + 1 });
	assert.equal(second.reportCount, 2);

	const open = await listChatReports(db, { status: 'open' });
	assert.equal(open.length, 1);
	assert.equal(open[0].text, 'buy my thing', 'evidence survives independent of the room');
	assert.equal(open[0].authorHash, 'c'.repeat(64));

	const resolved = await setChatReportStatus(db, { id: open[0].id, status: 'resolved', note: 'removed elsewhere', now: t + 2 });
	assert.equal(resolved?.status, 'resolved');
	assert.equal((await listChatReports(db, { status: 'open' })).length, 0);

	assert.equal((await exportReportsOnAccount(db, 'c'.repeat(64))).length, 1);
	assert.equal((await exportReportsOnAccount(db, 'f'.repeat(64))).length, 0);
	const filed = await exportFiledReports(db, 'd'.repeat(64));
	assert.deepEqual(filed.map((row) => [row.roomCode, row.messageN]), [[CODE, 3]]);
});

test('bans: active window, expiry sweep, export', async () => {
	const db = freshDatabase();
	const t = now();
	await setChatBan(db, { principalHash: 'b'.repeat(64), reason: 'spam', now: t, expiresAt: t + 60_000 });
	assert.equal(await activeChatBan(db, 'b'.repeat(64), t), t + 60_000);
	assert.equal(await activeChatBan(db, 'b'.repeat(64), t + 61_000), null, 'expiry ends the ban');
	const exported = await getChatBan(db, 'b'.repeat(64));
	assert.equal(exported?.reason, 'spam');
	await setChatBan(db, { principalHash: 'b'.repeat(64), reason: 'again', now: t, expiresAt: t + 120_000 });
	assert.equal((await listActiveChatBans(db, t)).length, 1, 're-ban upserts one row');
	await clearChatBan(db, 'b'.repeat(64));
	assert.equal(await getChatBan(db, 'b'.repeat(64)), null);
});

test('sweep: expired registry/bans and aged reports/log purge within the shared window', async () => {
	const db = freshDatabase();
	const t = now();
	const cutoff = t - 86_400_000;
	await registerRoom(db, { code: CODE, gameId: 'bnji.glass-minesweeper', ownerHash: 'a'.repeat(64), createdAt: t - 10_000, expiresAt: t - 1 });
	await setChatBan(db, { principalHash: 'b'.repeat(64), now: t - 10_000, expiresAt: t - 1 });
	await recordChatReport(db, { code: CODE, n: 1, snapshot: { authorHash: 'c'.repeat(64), label: 'A', text: 'old', messageAt: t - 90_000_000 }, reporterHash: 'd'.repeat(64), now: cutoff - 1 });
	await addModerationLog(db, { action: 'close_room', roomCode: CODE, now: cutoff - 1 });
	// A live registry row and a fresh log row must survive.
	await registerRoom(db, { code: 'y'.repeat(22), gameId: 'bnji.glass-minesweeper', ownerHash: 'e'.repeat(64), createdAt: t, expiresAt: t + 1_000 });
	await addModerationLog(db, { action: 'ban', targetHash: 'f'.repeat(64), now: t });

	const purged = await purgeChatModerationRows(db, { now: t, cutoff });
	assert.deepEqual(purged, { registry: 1, reports: 1, reporters: 1, log: 1, bans: 1 });
	assert.equal((await listActiveRooms(db, t)).length, 1, 'live room survives');
	assert.equal((await listModerationLog(db)).length, 1, 'recent audit row survives');
});

test('account deletion removes every Phase C row keyed to the principal', async () => {
	const db = freshDatabase();
	const t = now();
	const playerId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
	const hash = await sha256Hex(`player:${playerId}`);
	await recordChatReport(db, { code: CODE, n: 7, snapshot: { authorHash: hash, label: 'Me', text: 'mine', messageAt: t }, reporterHash: hash, now: t });
	await setChatBan(db, { principalHash: hash, now: t, expiresAt: t + 1_000 });
	await registerRoom(db, { code: CODE, gameId: 'bnji.glass-minesweeper', ownerHash: hash, createdAt: t, expiresAt: t + 1_000 });
	// Someone else's rows must survive.
	await recordChatReport(db, { code: 'z'.repeat(22), n: 1, snapshot: { authorHash: '9'.repeat(64), label: 'Other', text: 'theirs', messageAt: t }, reporterHash: '8'.repeat(64), now: t });

	await deletePlayerAccount(db, playerId);
	assert.equal((await exportReportsOnAccount(db, hash)).length, 0, 'authored report snapshots deleted');
	assert.equal((await exportFiledReports(db, hash)).length, 0, 'filed reports deleted');
	assert.equal(await getChatBan(db, hash), null, 'ban lifted');
	assert.equal((await listActiveRooms(db, t)).length, 0, 'owned registry rows deleted');
	assert.equal((await exportReportsOnAccount(db, '9'.repeat(64))).length, 1, 'other accounts untouched');

	// The statement helper is what the batch uses — same effect standalone.
	await recordChatReport(db, { code: CODE, n: 9, snapshot: { authorHash: hash, label: 'Me', text: 'back', messageAt: t }, reporterHash: hash, now: t });
	for (const statement of accountModerationStatements(db, hash)) await statement.run();
	assert.equal((await exportReportsOnAccount(db, hash)).length, 0);
	await deleteAccountModerationRows(db, hash); // idempotent no-op
});

/* --------------------------------------------------------- §6.3 filter bits */

test('blocklist and URL stripper are triage aids with sharp edges', () => {
	assert.equal(containsBlockedTerm('Buy MY Thing now', ['my thing']), true, 'case-insensitive');
	assert.equal(containsBlockedTerm('perfect match', ['my thing']), false);
	assert.equal(containsBlockedTerm('anything', []), false, 'empty list is inert');
	assert.equal(containsBlockedTerm('anything', ['', '  ']), false, 'blank terms are ignored');
	assert.equal(containsBlockedTerm('anything', ['anything']), true);

	assert.equal(stripUrlsForDisplay('see https://evil.test/x now'), 'see [link] now');
	assert.equal(stripUrlsForDisplay('or www.evil.test/x'), 'or [link]');
	assert.equal(stripUrlsForDisplay('plain text only'), 'plain text only');
	assert.equal(stripUrlsForDisplay('a https://one.test b http://two.test'), 'a [link] b [link]', 'every URL');
	// Bare domains are NOT stripped: emails and hostnames stay readable.
	assert.equal(stripUrlsForDisplay('mail me at me@example.test'), 'mail me at me@example.test');
});

test('admin service token derives from the shared secret and fails closed', async () => {
	const token = await roomAdminServiceToken('secret-one');
	assert.ok(token && /^[a-f0-9]{64}$/.test(token));
	assert.equal(token, await roomAdminServiceToken('secret-one'), 'deterministic');
	assert.notEqual(token, await roomAdminServiceToken('secret-two'));
	assert.equal(await roomAdminServiceToken(undefined), null, 'no secret, no admin room access');
	assert.equal(await roomAdminServiceToken(null), null);
});

/* ------------------------------------------------------------------ routes */

const reportRoute = await import('../src/pages/api/chat/report.ts');
const adminRoomsRoute = await import('../src/pages/api/admin/chat/rooms.ts');
const adminRoomRoute = await import('../src/pages/api/admin/chat/room.ts');
const adminActionRoute = await import('../src/pages/api/admin/chat/action.ts');

test('report route: origin and payload guards, then room-service and budget failures', async () => {
	const db = freshDatabase();
	bind(db);
	try {
		const cross = await reportRoute.POST(requestContext('/api/chat/report', { method: 'POST', origin: 'https://attacker.test', body: { code: CODE, n: 1 } }));
		assert.equal(cross.status, 403);

		for (const body of [
			{ n: 1 }, { code: 'short', n: 1 }, { code: CODE, n: 0 }, { code: CODE, n: '1' }, { code: CODE },
			{ code: CODE, n: 1, extra: true },
		]) {
			const response = await reportRoute.POST(requestContext('/api/chat/report', { method: 'POST', body, ip: '198.51.100.1' }));
			assert.equal(response.status, 400, JSON.stringify(body));
		}

		// No GAME_ROOMS binding in this harness: valid input fails closed.
		const valid = await reportRoute.POST(requestContext('/api/chat/report', { method: 'POST', body: { code: CODE, n: 1 }, ip: '198.51.100.2' }));
		assert.equal(valid.status, 503);
		assert.equal(((await valid.json()) as { error?: string }).error, 'room_service_unavailable');

		// Budget: 10 per 10 minutes per hashed IP, D1-counted (no KV).
		let limited: Response | null = null;
		for (let attempt = 0; attempt < 11; attempt += 1) {
			const response = await reportRoute.POST(requestContext('/api/chat/report', { method: 'POST', body: { code: CODE, n: 1 }, ip: '198.51.100.3' }));
			if (response.status === 429) { limited = response; break; }
			assert.equal(response.status, 503, `attempt ${attempt + 1}`);
		}
		assert.ok(limited, 'the eleventh report in the window is refused');
		assert.equal(((await limited.json()) as { error?: string }).error, 'rate_limited');

		// Chat kill switch covers reporting too.
		CHAT_CONFIG.enabled = false;
		try {
			const disabled = await reportRoute.POST(requestContext('/api/chat/report', { method: 'POST', body: { code: CODE, n: 1 }, ip: '198.51.100.4' }));
			assert.equal(disabled.status, 403);
			assert.equal(((await disabled.json()) as { error?: string }).error, 'chat_disabled');
		} finally { CHAT_CONFIG.enabled = true; }
	} finally { bind(null); }
});

test('admin chat routes: guards, dashboard payload, and action validation', async () => {
	const db = freshDatabase();
	seedAdmin(db);
	bind(db);
	const t = now();
	try {
		// Guards first: unconfigured, then missing/wrong credentials.
		db.raw.prepare('DELETE FROM admin_credentials').run();
		assert.equal((await adminRoomsRoute.GET(requestContext('/api/admin/chat/rooms', { token: ADMIN_TOKEN }))).status, 503);
		seedAdmin(db);
		assert.equal((await adminRoomsRoute.GET(requestContext('/api/admin/chat/rooms'))).status, 401);
		assert.equal((await adminActionRoute.POST(requestContext('/api/admin/chat/action', { method: 'POST', token: 'wrong', body: { action: 'close_room', code: CODE } }))).status, 401);

		// Dashboard payload shape with seeded rows.
		await registerRoom(db, { code: CODE, gameId: 'bnji.glass-minesweeper', ownerHash: 'a'.repeat(64), createdAt: t, expiresAt: t + 1_000 });
		await recordChatReport(db, { code: CODE, n: 2, snapshot: { authorHash: 'c'.repeat(64), label: 'Bob', text: 'reported text', messageAt: t }, reporterHash: 'd'.repeat(64), now: t });
		await setChatBan(db, { principalHash: 'b'.repeat(64), reason: 'test', now: t, expiresAt: t + 1_000 });
		await addModerationLog(db, { action: 'close_room', roomCode: 'q'.repeat(22), now: t });

		const dashboard = JSON.parse(await (await adminRoomsRoute.GET(requestContext('/api/admin/chat/rooms', { token: ADMIN_TOKEN }))).text()) as {
			rooms: unknown[]; reports: unknown[]; log: unknown[]; bans: unknown[]; filter: { blocklist: string[]; stripUrlsForAdmin: boolean };
		};
		assert.equal(dashboard.rooms.length, 1);
		assert.equal(dashboard.reports.length, 1);
		assert.equal(dashboard.log.length, 1);
		assert.equal(dashboard.bans.length, 1);
		assert.equal(dashboard.filter.stripUrlsForAdmin, CHAT_CONFIG.filter.stripUrlsForAdmin);

		// Transcript: code validation, unknown room, then service-unavailable.
		assert.equal((await adminRoomRoute.GET(requestContext('/api/admin/chat/room', { token: ADMIN_TOKEN, query: '?code=nope' }))).status, 400);
		assert.equal((await adminRoomRoute.GET(requestContext('/api/admin/chat/room', { token: ADMIN_TOKEN, query: `?code=${'k'.repeat(22)}` }))).status, 404);
		const noService = await adminRoomRoute.GET(requestContext('/api/admin/chat/room', { token: ADMIN_TOKEN, query: `?code=${CODE}` }));
		assert.equal(noService.status, 503);
		assert.equal(((await noService.json()) as { error?: string }).error, 'room_service_unavailable');

		// Actions: payload validation without touching the room service.
		const badBodies: unknown[] = [
			{}, { action: 'nope' }, { action: 'close_room' }, { action: 'close_room', code: 'bad' },
			{ action: 'ban', principalHash: 'short' }, { action: 'report_resolve', id: 0 },
			{ action: 'delete_message', code: CODE }, { action: 'kick', principalHash: 'a'.repeat(64) },
		];
		for (const body of badBodies) {
			const response = await adminActionRoute.POST(requestContext('/api/admin/chat/action', { method: 'POST', token: ADMIN_TOKEN, body }));
			assert.equal(response.status, 400, JSON.stringify(body));
		}

		// D1-only actions succeed without a room service: resolve + ban + unban.
		const report = (await listChatReports(db))[0];
		const resolved = await adminActionRoute.POST(requestContext('/api/admin/chat/action', { method: 'POST', token: ADMIN_TOKEN, body: { action: 'report_resolve', id: report.id, note: 'handled' } }));
		assert.equal(resolved.status, 200);
		assert.equal((await getChatReport(db, report.id))?.status, 'resolved');

		const banned = await adminActionRoute.POST(requestContext('/api/admin/chat/action', { method: 'POST', token: ADMIN_TOKEN, body: { action: 'ban', principalHash: 'e'.repeat(64), minutes: 30, reason: 'raid' } }));
		assert.equal(banned.status, 200);
		const banRow = await getChatBan(db, 'e'.repeat(64));
		assert.ok(banRow && banRow.expiresAt > now() + 25 * 60_000);
		const unbanned = await adminActionRoute.POST(requestContext('/api/admin/chat/action', { method: 'POST', token: ADMIN_TOKEN, body: { action: 'unban', principalHash: 'e'.repeat(64) } }));
		assert.equal(unbanned.status, 200);
		assert.equal(await getChatBan(db, 'e'.repeat(64)), null);

		// Room-touching action fails closed without the DO binding (no new audit row).
		const closeBefore = (await listModerationLog(db)).filter((row) => row.action === 'close_room').length;
		const close = await adminActionRoute.POST(requestContext('/api/admin/chat/action', { method: 'POST', token: ADMIN_TOKEN, body: { action: 'close_room', code: CODE } }));
		assert.equal(close.status, 503);
		const log = await listModerationLog(db);
		assert.ok(log.some((row) => row.action === 'report_resolve'));
		assert.ok(log.some((row) => row.action === 'ban'));
		assert.equal((log.filter((row) => row.action === 'close_room').length), closeBefore, 'failed close leaves no new audit row');
	} finally { bind(null); }
});
