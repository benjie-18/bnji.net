/**
 * Chat plan Phase C — admin endpoints, report snapshot, and the blocklist,
 * inside the real `GameRoom` Durable Object.
 *
 * The service token comes from wrangler.test.json's ACCESS_SECRET var (the
 * same env shape production gets as a wrangler secret). Membership auth,
 * socket handoffs (4003 kick / 4002 close), hibernation, and SQL state are
 * all real here — only route-level guards (origin, rate limit, admin panel
 * session) are node-test material in tests/chat-moderation.test.ts.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GameRoom } from '../../src/server/game-room-do';
import { roomAdminServiceToken } from '../../src/server/game-room-protocol';
import { CHAT_CONFIG } from '../../src/config/chat.config';
import {
	connect, createRoom, principalHash, snapshotOf, sqlRows, stubFor, uniqueRoomCode,
	type BoxFrame,
} from './support';

const LABEL_A = { 'x-bnji-chat-label': encodeURIComponent('Alice') };
const LABEL_B = { 'x-bnji-chat-label': encodeURIComponent('Bob') };
const PRINCIPAL_C = 'guest:cccccccccccccccccccccccccccccccc';
const send = (socket: WebSocket, payload: Record<string, unknown>): void => socket.send(JSON.stringify(payload));
const chatOf = (frame: BoxFrame): boolean => frame.type === 'chat';

async function adminToken(): Promise<string> {
	const token = await roomAdminServiceToken((env as unknown as { ACCESS_SECRET?: string }).ACCESS_SECRET ?? '');
	expect(token, 'wrangler.test.json must expose ACCESS_SECRET for service auth').toBeTruthy();
	return token!;
}
const adminRead = (code: string, headers: Record<string, string> = {}) =>
	stubFor(code).fetch(new Request(`https://room.test/admin/read?code=${code}`, { headers }));
const adminPost = (code: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
	stubFor(code).fetch(new Request(`https://room.test/admin/action?code=${code}`, {
		method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
	}));
const reportPost = (code: string, principal: string, body: Record<string, unknown>) =>
	stubFor(code).fetch(new Request(`https://room.test/report?code=${code}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-bnji-verified-principal': principal },
		body: JSON.stringify(body),
	}));

describe('GameRoom — Phase C admin service endpoints', () => {
	it('fails closed without the service token and serves read without a principal', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		const token = await adminToken();

		const anonymous = await adminRead(code);
		expect(anonymous.status, 'admin path must not leak the principal 401').toBe(403);
		expect(((await anonymous.json()) as { error?: string }).error).toBe('service_unauthorized');

		const wrong = await adminRead(code, { 'x-bnji-room-admin': 'not-the-token' });
		expect(wrong.status).toBe(403);

		const ok = await adminRead(code, { 'x-bnji-room-admin': token });
		expect(ok.status).toBe(200);
		const body = await ok.json() as { room: { gameId: string }; chatEnabled: boolean; members: unknown[]; messages: unknown[]; hostLog: unknown[] };
		expect(body.room.gameId).toBe('bnji.glass-minesweeper');
		expect(body.chatEnabled).toBe(true);
		expect(Array.isArray(body.members)).toBe(true);
		expect(Array.isArray(body.messages)).toBe(true);
		expect(Array.isArray(body.hostLog)).toBe(true);
		expect(JSON.stringify(body), 'the secret itself never travels').not.toContain((env as unknown as { ACCESS_SECRET: string }).ACCESS_SECRET);
	});

	it('delete_message tombstones with source "admin" for every socket and logs it', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		const token = await adminToken();
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', LABEL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', LABEL_B);
		await b.box.next(snapshotOf);
		await a.box.next((frame) => frame.type === 'members' && (frame.members as unknown[]).length >= 2);

		send(b.socket, { v: 1, type: 'chat', text: 'raiding the room' });
		await a.box.next(chatOf);

		const response = await adminPost(code, { type: 'delete_message', n: 1 }, { 'x-bnji-room-admin': token });
		expect(response.status).toBe(200);

		const forA = await a.box.next((frame) => frame.type === 'chat_delete');
		expect(forA).toMatchObject({ n: 1, source: 'admin' });
		const forB = await b.box.next((frame) => frame.type === 'chat_delete');
		expect(forB).toMatchObject({ n: 1, source: 'admin' });

		const rows = await sqlRows<{ removed: string | null; text: string }>(code, 'SELECT removed, text FROM game_room_chat WHERE n = 1');
		expect(rows[0].removed).toBe('admin');
		expect(rows[0].text, 'soft-deleted text is blanked, not kept around').toBe('');
		const log = await sqlRows<{ action: string }>(code, 'SELECT action FROM game_room_chat_log ORDER BY id DESC LIMIT 1');
		expect(log[0].action).toBe('delete_admin');
		void a.socket; void b.socket;
	});

	it('kick closes the target with 4003 while others stay; close_room ends the room with 4002', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		const token = await adminToken();
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', LABEL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', LABEL_B);
		await b.box.next(snapshotOf);
		await a.box.next((frame) => frame.type === 'members' && (frame.members as unknown[]).length >= 2);

		const kicked = await adminPost(code, { type: 'kick', principalHash: await principalHash('guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') }, { 'x-bnji-room-admin': token });
		expect(kicked.status).toBe(200);
		expect((await a.box.closed()).code).toBe(4003);
		const log = await sqlRows<{ action: string }>(code, 'SELECT action FROM game_room_chat_log ORDER BY id DESC LIMIT 1');
		expect(log[0].action).toBe('kick_admin');
		const members = await sqlRows<{ principal_hash: string }>(code, 'SELECT principal_hash FROM game_room_members');
		expect(members.some((row) => row.principal_hash === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
		// The other member is untouched and can still talk.
		send(b.socket, { v: 1, type: 'chat', text: 'still here' });
		expect((await b.box.next((frame) => frame.type === 'chat')).text).toBe('still here');
		void b.socket;

		const closed = await adminPost(code, { type: 'close_room' }, { 'x-bnji-room-admin': token });
		expect(closed.status).toBe(200);
		const closeEvent = await b.box.closed();
		expect(closeEvent.code).toBe(4002);
		expect(closeEvent.reason).toBe('Room closed by administrator');

		// Every room table is emptied (teardown deletes rows; the DO schema itself
		// is idempotent CREATE TABLE IF NOT EXISTS) and the object reports gone.
		for (const table of ['game_room', 'game_room_members', 'game_room_chat', 'game_room_chat_log', 'game_room_mutes']) {
			const [row] = await sqlRows<{ total: number }>(code, `SELECT COUNT(*) AS total FROM ${table}`);
			expect(Number(row.total), table).toBe(0);
		}
		const gone = await adminRead(code, { 'x-bnji-room-admin': token });
		expect(gone.status).toBe(404);
	});

	it('refuses malformed admin actions with 400 before touching anything', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		const token = await adminToken();
		for (const body of [{ type: 'nope' }, { type: 'kick' }, { type: 'kick', principalHash: 'short' }, { type: 'delete_message' }]) {
			const response = await adminPost(code, body, { 'x-bnji-room-admin': token });
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		// The room is untouched: no log rows, no deletions.
		const log = await sqlRows<{ action: string }>(code, 'SELECT action FROM game_room_chat_log');
		expect(log.length).toBe(0);
	});
});

describe('GameRoom — report snapshot (plan §6.4)', () => {
	it('accepts member reports, snapshots the author hash + text, and keeps idempotent 200s', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', LABEL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', LABEL_B);
		await b.box.next(snapshotOf);
		await a.box.next((frame) => frame.type === 'members' && (frame.members as unknown[]).length >= 2);

		send(a.socket, { v: 1, type: 'chat', text: 'look at https://spam.example deal' });
		await b.box.next(chatOf);

		const response = await reportPost(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { n: 1 });
		expect(response.status).toBe(200);
		const body = await response.json() as { snapshot: { authorHash: string; label: string; text: string; messageAt: number } };
		expect(body.snapshot.authorHash).toBe(await principalHash('guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
		expect(body.snapshot.label).toBe('Alice');
		expect(body.snapshot.text).toBe('look at https://spam.example deal');
		expect(body.snapshot.messageAt).toBeGreaterThan(0);

		// Non-members cannot report.
		const outsider = await reportPost(code, PRINCIPAL_C, { n: 1 });
		expect(outsider.status).toBe(403);
		expect(((await outsider.json()) as { error?: string }).error).toBe('not_member');

		// Bad n, unknown n.
		expect((await reportPost(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { n: '1' })).status).toBe(400);
		expect((await reportPost(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { n: 99 })).status).toBe(404);

		// Removed messages cannot be reported.
		const token = await adminToken();
		expect((await adminPost(code, { type: 'delete_message', n: 1 }, { 'x-bnji-room-admin': token })).status).toBe(200);
		const after = await reportPost(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { n: 1 });
		expect(after.status).toBe(404);
		expect(((await after.json()) as { error?: string }).error).toBe('message_not_found');
		void a.socket; void b.socket;
	});
});

describe('GameRoom — §6.3 blocklist in front of the socket', () => {
	it('rejects blocked terms softly with error "blocked" and leaves the socket alive', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		CHAT_CONFIG.filter.blocklist.push('forbidden-phrase');
		try {
			const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', LABEL_A);
			await a.box.next(snapshotOf);

			send(a.socket, { v: 1, type: 'chat', text: 'this is FORBIDDEN-PHRASE ok' });
			const rejected = await a.box.next((frame) => frame.type === 'chat_rejected');
			expect(rejected).toMatchObject({ error: 'blocked' });

			// A normal message still goes through: soft rejection, no close.
			send(a.socket, { v: 1, type: 'chat', text: 'still here' });
			const accepted = await a.box.next(chatOf);
			expect(accepted.text).toBe('still here');
			void a.socket;
		} finally {
			CHAT_CONFIG.filter.blocklist.length = 0;
		}
	});
});
