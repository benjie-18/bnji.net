/**
 * Open lobbies, at the Durable Object boundary (plan: owner request
 * 2026-10-01 — "players to see all lobbies created for each game and be able
 * to join them freely, with the host able to kick them").
 *
 * Two halves, and they protect different promises:
 *
 *   1. `GET /lobby` is the ONE read a stranger may perform before joining, so
 *      it must answer with counters and a clock and nothing else, and it must
 *      say "gone" (410) rather than "empty" for an expired room — a stale
 *      registry row must never be listed as joinable.
 *
 *   2. A kick has to be a LOCKOUT, not a doorbell. The host removes a member,
 *      that member's socket closes 4003, its membership row is gone, and a raw
 *      reconnect is REFUSED with 403 room_kicked for the room's remaining
 *      lifetime. Everyone else keeps their seat.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GameRoom } from '../../src/server/game-room-do';
import { ROOM_CAPACITY, ROOM_TTL_MS } from '../../src/server/game-room-protocol';
import { LOBBY_CONFIG } from '../../src/config/lobby.config';
import {
	connect, connectRaw, createRoom, GAME, HEADERS, principalHash, snapshotOf, sqlRows, stubFor,
	uniqueRoomCode, type BoxFrame, PRINCIPAL_A, PRINCIPAL_B, PRINCIPAL_C,
} from './support';

const membersOf = (frame: BoxFrame): boolean => frame.type === 'members';
const send = (socket: WebSocket, payload: Record<string, unknown>): void => socket.send(JSON.stringify(payload));

async function lobby(code: string, principal = PRINCIPAL_C): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await stubFor(code).fetch(new Request('https://room.test/lobby', { method: 'GET', headers: HEADERS(principal) }));
	const text = await response.text();
	return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe('GameRoom — GET /lobby probe', () => {
	it('answers with exactly the keys the lobby list consumes, and nothing private', async () => {
		const code = uniqueRoomCode();
		const created = await createRoom(code, PRINCIPAL_A);
		const seen = await lobby(code);
		expect(seen.status).toBe(200);
		expect(Object.keys(seen.body).sort()).toEqual([
			'capacity', 'connected', 'createdAt', 'expiresAt', 'gameId', 'joinable', 'live', 'players', 'revision',
		]);
		expect(seen.body).toMatchObject({
			live: true,
			gameId: GAME,
			// Creating a room seats its creator, so a brand-new room already has
			// one member — the number the lobby row shows must be the seat count,
			// not the number of second visitors.
			players: 1,
			connected: 0,
			capacity: ROOM_CAPACITY,
			joinable: true,
			revision: 0,
		});
		// The create response does not echo createdAt, so the probe's clock is
		// checked against the room's own window instead: after the room was made
		// and before it expires.
		expect(Number(seen.body.createdAt)).toBeGreaterThan(0);
		expect(Number(seen.body.createdAt)).toBeLessThan(Number(seen.body.expiresAt));
		expect(seen.body.expiresAt).toBe(created.body.expiresAt);
		// The probe is cacheable across visitors: no caller-specific field may
		// appear, or one visitor's answer would be served to another.
		expect(seen.body.isHost).toBeUndefined();
		expect(seen.body.members).toBeUndefined();
		expect(seen.body.state).toBeUndefined();
	});

	it('counts seated members and reports a full room as not joinable', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const fresh = await lobby(code);
		expect(fresh.body.players).toBe(1);
		expect(fresh.body.joinable).toBe(true);

		// Seat the remaining members directly: filling a room over eight real
		// sockets would test the socket layer, which game-room.spec.ts already
		// owns; what matters here is the NUMBER the lobby publishes.
		await runInDurableObject(stubFor(code), (_instance: GameRoom, state) => {
			for (let index = 1; index < ROOM_CAPACITY; index += 1) {
				state.storage.sql.exec(
					'INSERT INTO game_room_members (principal_hash, member_id, joined_at, reconnect_until) VALUES (?, ?, ?, ?)',
					index.toString(16).padStart(64, '0'), `member-${index}`, Date.now(), Date.now() + 60_000,
				);
			}
		});
		const full = await lobby(code);
		expect(full.body.players).toBe(ROOM_CAPACITY);
		expect(full.body.joinable, 'a full room must drop out of the lobby list').toBe(false);
	});

	it('answers 410 for a room that is gone or expired rather than an empty lobby', async () => {
		const missing = await lobby(uniqueRoomCode());
		expect(missing.status).toBe(410);
		expect(missing.body.error).toBe('room_expired');

		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A, Date.now() - ROOM_TTL_MS - 5_000);
		const expired = await lobby(code);
		expect(expired.status).toBe(410);
		expect(expired.body.error).toBe('room_expired');
	});

	it('requires an authenticated principal like every other room read', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const response = await stubFor(code).fetch(new Request('https://room.test/lobby', { method: 'GET' }));
		expect(response.status).toBe(401);
		await response.text();
	});
});

describe('GameRoom — kick lockout', () => {
	it('closes the kicked socket 4003, deletes the seat, and refuses a raw reconnect with 403 room_kicked', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const host = await connect(code, PRINCIPAL_A);
		await host.box.next(snapshotOf);
		const guest = await connect(code, PRINCIPAL_B);
		await guest.box.next(snapshotOf);
		const roster = await host.box.next((frame) => membersOf(frame) && (frame.members as unknown[]).length >= 2);
		const guestMemberId = (roster.members as Array<{ memberId: string; isSelf: boolean }>).find((member) => !member.isSelf)!.memberId;

		send(host.socket, { v: 1, type: 'kick', member: guestMemberId });
		expect(await guest.box.closed()).toMatchObject({ code: 4003 });
		expect(await sqlRows(code, 'SELECT member_id FROM game_room_members')).toHaveLength(1);
		const kicks = await sqlRows<{ principal_hash: string }>(code, 'SELECT principal_hash FROM game_room_kicks');
		expect(kicks).toHaveLength(1);
		expect(kicks[0].principal_hash).toBe(await principalHash(PRINCIPAL_B));

		const refused = await connectRaw(code, PRINCIPAL_B);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ error: 'room_kicked' });

		// A kick is not a room-wide lock: a different player still joins a room
		// that is now one seat lighter, and the lobby says so.
		const third = await connect(code, PRINCIPAL_C);
		await third.box.next(snapshotOf);
		const probe = await lobby(code, PRINCIPAL_C);
		expect(probe.body.players).toBe(2);
		expect(probe.body.joinable).toBe(true);
		expect(LOBBY_CONFIG.enabled).toBe(true);
		void host.socket;
	});

	it('a kicked principal stays out for the room’s lifetime, and teardown clears the lockout', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const host = await connect(code, PRINCIPAL_A);
		await host.box.next(snapshotOf);
		const guest = await connect(code, PRINCIPAL_B);
		await guest.box.next(snapshotOf);
		const roster = await host.box.next((frame) => membersOf(frame) && (frame.members as unknown[]).length >= 2);
		const guestMemberId = (roster.members as Array<{ memberId: string; isSelf: boolean }>).find((member) => !member.isSelf)!.memberId;
		send(host.socket, { v: 1, type: 'kick', member: guestMemberId });
		await guest.box.closed();
		expect((await connectRaw(code, PRINCIPAL_B)).status).toBe(403);

		// Expiry tears the room down. The kick table is room-scoped state, so it
		// dies with it — a later room reusing the code starts clean.
		await runInDurableObject(stubFor(code), (_instance: GameRoom, state) => {
			state.storage.sql.exec('UPDATE game_room SET expires_at = ?', Date.now() - 1);
		});
		await runDurableObjectAlarm(stubFor(code));
		expect(await sqlRows(code, 'SELECT principal_hash FROM game_room_kicks')).toHaveLength(0);
		await createRoom(code, PRINCIPAL_A);
		const rejoin = await connect(code, PRINCIPAL_B);
		await rejoin.box.next(snapshotOf);
		void host.socket;
	});
});
