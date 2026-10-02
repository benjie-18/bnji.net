/**
 * Open lobbies — the DO half, inside the real `GameRoom`.
 *
 * Two contracts are pinned here because both are invisible to route tests:
 *
 *  1. `GET /lobby` answers about the ROOM, never about the caller. The Worker
 *     caches one list per game and shares it with every visitor, so a per-visitor
 *     answer would poison the cache; `players` is the same count the next join is
 *     measured against, so "listed as joinable" and "the join succeeds" agree.
 *  2. A kick is durable for the room's lifetime. The member row is deleted (the
 *     seat frees up) but the principal is written to `game_room_kicks`, so a
 *     rejoin is accepted at the transport and immediately closed with 4003 —
 *     which is the only way the client can say *why* the door is shut.
 */
import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GameRoom } from '../../src/server/game-room-do';
import { ROOM_CAPACITY, ROOM_TTL_MS } from '../../src/server/game-room-protocol';
import {
	connect, createRoom, principalHash, snapshotOf, sqlRows, stubFor, uniqueRoomCode,
	type BoxFrame,
} from './support';

const PRINCIPAL_A = 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRINCIPAL_B = 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PRINCIPAL_C = 'guest:cccccccccccccccccccccccccccccccc';
const LABEL_A = { 'x-bnji-chat-label': encodeURIComponent('Alice') };
const LABEL_B = { 'x-bnji-chat-label': encodeURIComponent('Bob') };
const HEADER = (principal: string): Record<string, string> => ({ 'x-bnji-verified-principal': principal });
const send = (socket: WebSocket, payload: Record<string, unknown>): void => socket.send(JSON.stringify(payload));
const membersAtLeast = (count: number) => (frame: BoxFrame) => frame.type === 'members' && (frame.members as unknown[]).length >= count;

const probe = (code: string, principal = PRINCIPAL_A) =>
	stubFor(code).fetch(new Request('https://room.test/lobby', { method: 'GET', headers: HEADER(principal) }));

type ProbeBody = {
	live?: boolean; gameId?: string; players?: number; capacity?: number;
	createdAt?: number; expiresAt?: number; revision?: number;
};

describe('GameRoom — open-lobby probe', () => {
	it('answers a live room with its joinability facts, for any caller', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);

		const response = await probe(code, PRINCIPAL_B);
		expect(response.status).toBe(200);
		const body = await response.json() as ProbeBody;
		expect(body.live).toBe(true);
		expect(body.gameId).toBe('bnji.glass-minesweeper');
		// `players` counts seats the next join would compete with, capacity is the
		// same ceiling the join path enforces.
		expect(body.players).toBe(1);
		expect(body.capacity).toBe(ROOM_CAPACITY);
		expect(body.createdAt).toBeGreaterThan(0);
		expect(body.expiresAt).toBeGreaterThan(Date.now());
		expect(body.revision).toBe(0);

		// The probe is about the room, not the caller: a non-member asking the same
		// question gets the same row (this is what makes the shared cache safe).
		const outsider = await probe(code, PRINCIPAL_C);
		expect(await outsider.json() as ProbeBody).toMatchObject({ live: true, players: 1 });

		void a.socket;
	});

	it('answers live:false for a room that never existed or has ended', async () => {
		const missing = await probe(uniqueRoomCode(), PRINCIPAL_A);
		expect(missing.status).toBe(200);
		expect((await missing.json() as ProbeBody).live).toBe(false);

		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A, Date.now() - ROOM_TTL_MS + 3_000);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);
		expect((await (await probe(code)).json() as ProbeBody).live).toBe(true);
		await runDurableObjectAlarm(stubFor(code));
		await a.box.closed();
		expect((await (await probe(code)).json() as ProbeBody).live).toBe(false);
	});

	it('counts every seat, so a full room cannot be listed as joinable', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		// `createRoom` already seats its creator, so filling the room takes
		// ROOM_CAPACITY - 1 more connections — the point is the last seat.
		const sockets: WebSocket[] = [];
		for (let index = 0; index < ROOM_CAPACITY - 1; index += 1) {
			const member = await connect(code, `guest:${String(index).padStart(32, '0')}`, {});
			await member.box.next(snapshotOf);
			sockets.push(member.socket);
		}
		const body = await (await probe(code)).json() as ProbeBody;
		expect(body.players).toBe(ROOM_CAPACITY);
		expect(body.capacity).toBe(ROOM_CAPACITY);
		for (const socket of sockets) socket.close(1000, 'test over');
	});
});

describe('GameRoom — durable host kick', () => {
	it('locks a kicked principal out for the room\'s life, then forgets on teardown', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A, Date.now() - ROOM_TTL_MS + 4_000);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, PRINCIPAL_B, LABEL_B);
		await b.box.next(snapshotOf);
		const roster = await a.box.next(membersAtLeast(2));
		const bMemberId = (roster.members as Array<{ memberId: string; isSelf: boolean; label: string }>)
			.find((member) => !member.isSelf && member.label === 'Bob')?.memberId;
		expect(bMemberId).toBeTruthy();

		send(a.socket, { v: 1, type: 'kick', member: bMemberId! });
		expect((await b.box.closed()).code).toBe(4003);

		// The seat is gone (the room is not smaller by accident) but the lockout
		// remembers the principal.
		const members = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members');
		expect(Number(members[0].count)).toBe(1);
		const kicks = await sqlRows<{ principal_hash: string }>(code, 'SELECT principal_hash FROM game_room_kicks');
		expect(kicks.map((row) => row.principal_hash)).toEqual([await principalHash(PRINCIPAL_B)]);

		// Rejoining is upgraded and then closed: the client gets the close code,
		// not a transport error, so it can say "the host removed you".
		const rejoin = await connect(code, PRINCIPAL_B, LABEL_B);
		expect((await rejoin.box.closed()).code).toBe(4003);
		const membersAfter = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members');
		expect(Number(membersAfter[0].count), 'a locked-out rejoin must not take a seat').toBe(1);

		// The lockout is per principal: someone else can still take the free seat.
		const c = await connect(code, PRINCIPAL_C, {});
		await c.box.next(snapshotOf);
		expect(Number((await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members'))[0].count)).toBe(2);

		// Teardown clears the lockout with the rest of the room — the next room
		// under this code starts with no history.
		await runDurableObjectAlarm(stubFor(code));
		await a.box.closed();
		await c.box.closed();
		const after = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_kicks');
		expect(Number(after[0].count)).toBe(0);
	});
});
