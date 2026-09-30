/**
 * Platform-faithful retro-tests for the existing `GameRoom` Durable Object.
 *
 * These run inside workerd through `@cloudflare/vitest-pool-workers`, so
 * hibernation, `getWebSockets()`, socket attachments and DO SQLite are the
 * real implementations — the coverage the `node:test` harness could not give
 * (docs/CHAT-SYSTEM-PLAN.md §13: `cloudflare:workers` is stubbed there with
 * `env` only, so the DO cannot even be imported).
 *
 * Baseline behaviour locked in here before any chat work lands:
 *   1. the DO authenticates every control/upgrade itself (no client-forged
 *      principal survives), membership admits up to capacity, leave deletes
 *      the member row;
 *   2. host handoff picks the longest-connected member with an open socket
 *      and never bounces back automatically;
 *   3. CAS: a stale `baseRevision` conflicts without moving `revision`, an
 *      unregistered game authority fails closed, a registered one advances
 *      `revision` exactly once, and the 5 s state-write window soft-rejects;
 *   4. reconnect grace: a closed member keeps its row (and member ID) for
 *      `ROOM_RECONNECT_GRACE_MS`, loses it after, and a replacement ID proves
 *      the grace window actually gates re-entry;
 *   5. socket attachments survive DO eviction (the hibernation contract that
 *      Phase B's per-member rate bucket relies on);
 *   6. `alarm()` teardown closes sockets with 4002 and deletes the room rows
 *      — nothing outlives the room.
 *
 * Two current-behaviour quirks these tests must respect (both deliberately
 * scheduled for change by plan §5.4, so neither is asserted as desirable):
 *   - the per-connection ceiling is 1 msg/s and a same-second second message
 *     closes the socket with 1013 — sends on one socket are spaced >1 s apart;
 *   - every `stub.fetch` body must be drained or workerd counts the stream as
 *     an active reference and refuses to evict the instance.
 */
import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GameRoom } from '../../src/server/game-room-do';
import { registerRoomStateAuthority } from '../../src/server/room-authority';
import { ROOM_CAPACITY, ROOM_TTL_MS } from '../../src/server/game-room-protocol';

const GAME = 'bnji.glass-minesweeper';
const PRINCIPAL_A = 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRINCIPAL_B = 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
/** The current ceiling closes a socket on a second message within one wall-clock second. */
const MSG_GAP_MS = 1_100;
const HEADERS = (principal: string, extra: Record<string, string> = {}): Record<string, string> => ({
	'x-bnji-verified-principal': principal,
	...extra,
});

let roomSeq = 0;
function uniqueRoomCode(): string {
	// Same shape as production (22 base64url chars); uniqueness keeps the
	// suite independent of cross-test storage isolation semantics.
	roomSeq += 1;
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 20) + roomSeq.toString(36).padStart(2, '0');
}

async function principalHash(principal: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(principal));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type BoxFrame = { v?: number; type?: string; [key: string]: unknown };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Collects one test client's inbound frames and its close event. */
class SocketBox {
	readonly frames: BoxFrame[] = [];
	private used = new Set<number>();
	private closedWith: { code: number; reason: string } | null = null;

	constructor(socket: WebSocket) {
		socket.addEventListener('message', (event) => {
			try { this.frames.push(JSON.parse(String(event.data)) as BoxFrame); } catch { /* not JSON */ }
		});
		socket.addEventListener('close', (event) => {
			this.closedWith = { code: event.code, reason: event.reason };
		});
		socket.accept();
	}

	/** First unconsumed frame matching `match`, or fail after `timeoutMs`. */
	async next(match: (frame: BoxFrame) => boolean, timeoutMs = 5_000): Promise<BoxFrame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const index = this.frames.findIndex((frame, i) => !this.used.has(i) && match(frame));
			if (index >= 0) {
				this.used.add(index);
				return this.frames[index];
			}
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for frame; saw: ${this.frames.map((frame) => String(frame.type)).join(', ') || '(none)'}`);
			}
			await delay(20);
		}
	}

	async closed(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
		const deadline = Date.now() + timeoutMs;
		while (!this.closedWith) {
			if (Date.now() >= deadline) throw new Error('timed out waiting for socket close');
			await delay(20);
		}
		return this.closedWith;
	}
}

function stubFor(code: string) {
	const namespace = env.GAME_ROOMS;
	return namespace.get(namespace.idFromName(code));
}

async function createRoom(code: string, principal: string, now = Date.now()): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await stubFor(code).fetch(new Request('https://room.test/create', {
		method: 'POST',
		headers: HEADERS(principal, { 'content-type': 'application/json' }),
		body: JSON.stringify({ gameId: GAME, now }),
	}));
	// Drain the body: an unread stream keeps an active reference on the
	// instance, which a later evictDurableObject() refuses to break.
	const text = await response.text();
	return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

async function connect(code: string, principal: string): Promise<{ socket: WebSocket; box: SocketBox }> {
	const response = await stubFor(code).fetch(new Request('https://room.test/ws', {
		method: 'GET',
		headers: HEADERS(principal, { upgrade: 'websocket' }),
	}));
	if (response.status !== 101) throw new Error(`expected 101 upgrade, got ${response.status}: ${await response.text()}`);
	const socket = response.webSocket;
	if (!socket) throw new Error('101 response carried no webSocket');
	return { socket, box: new SocketBox(socket) };
}

/** Raw SQL reads/writes against the DO under test (storage seeding + asserts). */
function sqlRows<T extends Record<string, SqlStorageValue>>(code: string, query: string, ...bindings: (string | number)[]): Promise<T[]> {
	return runInDurableObject(stubFor(code), (_instance: GameRoom, state: DurableObjectState) =>
		state.storage.sql.exec<T>(query, ...bindings).toArray(),
	);
}

const snapshotOf = (frame: BoxFrame): boolean => frame.type === 'snapshot';

describe('GameRoom — membership', () => {
	it('authenticates itself: no header, no room; bad path, 404', async () => {
		const code = uniqueRoomCode();
		const anonymous = stubFor(code);
		const create = await anonymous.fetch(new Request('https://room.test/create', { method: 'POST', body: '{}' }));
		expect(create.status).toBe(401);
		expect((await create.json() as { error: string }).error).toBe('room_authentication_required');
		const upgrade = await anonymous.fetch(new Request('https://room.test/ws', { headers: { upgrade: 'websocket' } }));
		expect(upgrade.status).toBe(401);
		await createRoom(code, PRINCIPAL_A);
		const missingPath = await stubFor(code).fetch(new Request('https://room.test/nope', { method: 'POST', headers: HEADERS(PRINCIPAL_A) }));
		expect(missingPath.status).toBe(404);
		await missingPath.text();
	});

	it('admits up to capacity, refuses duplicate creation and a 9th member', async () => {
		const code = uniqueRoomCode();
		const created = await createRoom(code, PRINCIPAL_A);
		expect(created.status).toBe(200);
		expect(created.body.created).toBe(true);
		expect(created.body.capacity).toBe(ROOM_CAPACITY);
		expect(Number(created.body.expiresAt)).toBeGreaterThan(Date.now());

		const duplicate = await createRoom(code, PRINCIPAL_A);
		expect(duplicate.status).toBe(409);
		expect(duplicate.body.error).toBe('room_already_exists');

		const first = await connect(code, PRINCIPAL_A);
		const firstSnapshot = await first.box.next(snapshotOf);
		expect(firstSnapshot.revision).toBe(0);
		expect(firstSnapshot.isHost).toBe(true);
		expect(firstSnapshot.connectedMembers).toBe(1);

		const second = await connect(code, PRINCIPAL_B);
		const secondSnapshot = await second.box.next(snapshotOf);
		expect(secondSnapshot.isHost).toBe(false);
		expect(secondSnapshot.connectedMembers).toBe(2);
		await first.box.next((frame) => frame.type === 'presence' && frame.connectedMembers === 2);

		// Fill the remaining six seats, then the 9th principal must be refused.
		const extras: Array<{ socket: WebSocket; box: SocketBox }> = [];
		for (let i = 0; i < 6; i += 1) {
			const principal = `guest:${(i + 1).toString(16).padStart(32, 'c')}`;
			extras.push(await connect(code, principal));
		}
		const overflow = await stubFor(code).fetch(new Request('https://room.test/ws', {
			method: 'GET',
			headers: HEADERS('guest:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', { upgrade: 'websocket' }),
		}));
		expect(overflow.status).toBe(409);
		expect((await overflow.json() as { error: string }).error).toBe('room_full');

		// Leave deletes the member row, so the seat frees up for a rejoin.
		second.socket.send(JSON.stringify({ v: 1, type: 'leave' }));
		expect((await second.box.closed()).code).toBe(1000);
		const members = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members');
		expect(Number(members[0].count)).toBe(7);
		const rejoin = await connect(code, PRINCIPAL_B);
		const rejoinSnapshot = await rejoin.box.next(snapshotOf);
		expect(rejoinSnapshot.connectedMembers).toBe(8);
		void first.socket; void second.socket; for (const extra of extras) void extra.socket;
	});
});

describe('GameRoom — host handoff', () => {
	it('hands the host role to the longest-connected member with an open socket, and never back automatically', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, PRINCIPAL_B);
		const bSnapshot = await b.box.next(snapshotOf);
		expect(bSnapshot.isHost).toBe(false);

		a.socket.close(1000, 'bye');
		expect((await a.box.closed()).code).toBe(1000);
		const handoff = await b.box.next((frame) => frame.type === 'presence' && frame.isHost === true);
		expect(handoff.connectedMembers).toBe(1);

		// A reconnects while B holds the host role: ownership does not bounce back.
		const aAgain = await connect(code, PRINCIPAL_A);
		const aSnapshot = await aAgain.box.next(snapshotOf);
		expect(aSnapshot.isHost).toBe(false);
		expect(aSnapshot.hasHost).toBe(true);
		const owners = await sqlRows<{ owner_hash: string }>(code, 'SELECT owner_hash FROM game_room WHERE id = 1');
		expect(owners[0].owner_hash).toBe(await principalHash(PRINCIPAL_B));
	});
});

describe('GameRoom — state authority and CAS', () => {
	it('conflicts on a stale baseRevision without moving revision, fails closed with no authority, then commits exactly once with one', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A);
		await a.box.next(snapshotOf);

		// Stale revision → conflict snapshot, room untouched.
		a.socket.send(JSON.stringify({ v: 1, type: 'state', baseRevision: 7, state: { score: 1 } }));
		const conflict = await a.box.next((frame) => frame.type === 'conflict');
		expect(conflict.revision).toBe(0);
		await delay(MSG_GAP_MS);

		// Correct revision but no registered game authority → fail closed.
		a.socket.send(JSON.stringify({ v: 1, type: 'state', baseRevision: 0, state: { score: 1 } }));
		const rejected = await a.box.next((frame) => frame.type === 'state_rejected');
		expect(rejected.error).toBe('game_adapter_unavailable');
		const unrated = await sqlRows<{ revision: number }>(code, 'SELECT revision FROM game_room WHERE id = 1');
		expect(Number(unrated[0].revision)).toBe(0);
		await delay(MSG_GAP_MS);

		// Register the game's authority (the integration seam a game adapter
		// uses) and commit for real: revision advances by exactly one.
		const unregister = registerRoomStateAuthority(GAME, (transition) => ({ allowed: true, state: transition.proposedState }));
		try {
			a.socket.send(JSON.stringify({ v: 1, type: 'state', baseRevision: 0, state: { score: 1 } }));
			const committed = await a.box.next((frame) => frame.type === 'state');
			expect(committed.revision).toBe(1);
			expect(committed.state).toEqual({ score: 1 });

			// Inside the 5 s state-write window (and clear of the 1 msg/s
			// ceiling) a second write soft-rejects; the socket stays open.
			await delay(MSG_GAP_MS);
			a.socket.send(JSON.stringify({ v: 1, type: 'state', baseRevision: 1, state: { score: 2 } }));
			const limited = await a.box.next((frame) => frame.type === 'rate_limited');
			expect(Number(limited.retryAfterMs)).toBeGreaterThan(0);
			expect(Number(limited.retryAfterMs)).toBeLessThanOrEqual(5_000);
		} finally {
			unregister();
		}
		const finalState = await sqlRows<{ revision: number; state_json: string }>(code, 'SELECT revision, state_json FROM game_room WHERE id = 1');
		expect(Number(finalState[0].revision)).toBe(1);
		expect(JSON.parse(finalState[0].state_json)).toEqual({ score: 1 });
	});
});

describe('GameRoom — reconnect grace', () => {
	it('keeps a closed member row through the grace window and replaces the member ID after it', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const first = await connect(code, PRINCIPAL_A);
		await first.box.next(snapshotOf);
		const before = await sqlRows<{ member_id: string; reconnect_until: number | null }>(
			code, 'SELECT member_id, reconnect_until FROM game_room_members WHERE principal_hash IS NOT NULL',
		);
		expect(before[0].reconnect_until).toBeNull();

		first.socket.close(1001, 'dropped');
		expect((await first.box.closed()).code).toBe(1001);
		const during = await sqlRows<{ member_id: string; reconnect_until: number | null }>(
			code, 'SELECT member_id, reconnect_until FROM game_room_members WHERE principal_hash IS NOT NULL',
		);
		expect(during[0].member_id).toBe(before[0].member_id);
		expect(Number(during[0].reconnect_until)).toBeGreaterThan(Date.now());

		// Reconnect inside the window: same membership row, slot restored.
		const back = await connect(code, PRINCIPAL_A);
		await back.box.next(snapshotOf);
		const rejoined = await sqlRows<{ member_id: string; reconnect_until: number | null }>(
			code, 'SELECT member_id, reconnect_until FROM game_room_members WHERE principal_hash IS NOT NULL',
		);
		expect(rejoined[0].member_id).toBe(before[0].member_id);
		expect(rejoined[0].reconnect_until).toBeNull();

		// Simulate an expired grace window, then reconnect: the stale row is
		// swept and a NEW member ID is minted — grace gates re-entry.
		await runInDurableObject(stubFor(code), (_instance: GameRoom, state: DurableObjectState) => {
			state.storage.sql.exec('UPDATE game_room_members SET reconnect_until = ?', Date.now() - 1_000);
		});
		const late = await connect(code, PRINCIPAL_A);
		await late.box.next(snapshotOf);
		const after = await sqlRows<{ member_id: string; reconnect_until: number | null }>(
			code, 'SELECT member_id, reconnect_until FROM game_room_members WHERE principal_hash IS NOT NULL',
		);
		expect(after[0].member_id).not.toBe(before[0].member_id);
		expect(after[0].reconnect_until).toBeNull();
		// The socket that lost its seat is closed by the DO, not left dangling.
		const displaced = await back.box.closed();
		expect(displaced.code).toBe(4001);
	});
});

describe('GameRoom — hibernation', () => {
	it('recovers the per-socket attachment after DO eviction', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A);
		await a.box.next(snapshotOf);

		// Evict the instance: in-memory state is gone, the hibernated socket
		// and its serializeAttachment() payload must survive.
		await evictDurableObject(stubFor(code));

		a.socket.send(JSON.stringify({ v: 1, type: 'state', baseRevision: 3, state: { score: 1 } }));
		// A reply at all proves the attachment's principalHash and memberId
		// were restored; `conflict` (not `close 1008`) proves they were valid.
		const conflict = await a.box.next((frame) => frame.type === 'conflict', 10_000);
		expect(conflict.revision).toBe(0);
	});
});

describe('GameRoom — expiry teardown', () => {
	it('refuses upgrades into an already-expired room and alarm() deletes every room row', async () => {
		const code = uniqueRoomCode();
		const expiredAt = Date.now() - ROOM_TTL_MS - 5_000;
		const created = await createRoom(code, PRINCIPAL_A, expiredAt);
		expect(created.status).toBe(200);

		const refused = await stubFor(code).fetch(new Request('https://room.test/ws', {
			method: 'GET',
			headers: HEADERS(PRINCIPAL_A, { upgrade: 'websocket' }),
		}));
		expect(refused.status).toBe(410);
		expect((await refused.json() as { error: string }).error).toBe('room_expired');

		await runDurableObjectAlarm(stubFor(code));
		const rooms = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room');
		const members = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members');
		expect(Number(rooms[0].count)).toBe(0);
		expect(Number(members[0].count)).toBe(0);
	});

	it('closes every live socket with 4002 when the TTL elapses', async () => {
		const code = uniqueRoomCode();
		// Expire the room ~1.5 s from now: connect both members while alive.
		await createRoom(code, PRINCIPAL_A, Date.now() - ROOM_TTL_MS + 1_500);
		const a = await connect(code, PRINCIPAL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, PRINCIPAL_B);
		await b.box.next(snapshotOf);

		await delay(1_700);
		await runDurableObjectAlarm(stubFor(code));

		expect((await a.box.closed(10_000)).code).toBe(4002);
		expect((await b.box.closed(10_000)).code).toBe(4002);
		const rooms = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room');
		expect(Number(rooms[0].count)).toBe(0);
		const members = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members');
		expect(Number(members[0].count)).toBe(0);
	});
});
