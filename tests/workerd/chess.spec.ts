/**
 * `bnji.chess` through the REAL GameRoom Durable Object: WebSocket frames,
 * DO SQLite persistence, CAS revisions, and the authority registered by
 * `game-room-do.ts`'s side-effect import — the production wiring, not a
 * test-only registration.
 *
 * The generic 5 s room state-write throttle is cleared between moves here
 * (one raw `last_state_at` reset) so this spec exercises the chess
 * authority, not the shared pacing rule — room-chat/game-room specs own
 * that behaviour.
 */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GameRoom } from '../../src/server/game-room-do';
import {
	SocketBox,
	connect,
	createRoom,
	delay,
	snapshotOf,
	stubFor,
	uniqueRoomCode,
	type BoxFrame,
} from './support';

const CHESS = 'bnji.chess';

async function clearThrottle(code: string): Promise<void> {
	await runInDurableObject(stubFor(code), (_instance: GameRoom, state: DurableObjectState) => {
		state.storage.sql.exec('UPDATE game_room SET last_state_at = 0');
	});
}

function sendState(socket: WebSocket, baseRevision: number, state: unknown): void {
	socket.send(JSON.stringify({ v: 1, type: 'state', baseRevision, state }));
}

function stateFrame(frame: BoxFrame): boolean {
	return frame.type === 'state' && typeof frame.revision === 'number';
}

async function selfMemberId(box: SocketBox): Promise<string> {
	const frame = await box.next((f) => f.type === 'members' && Array.isArray(f.members));
	const members = f_members(frame);
	const self = members.find((member) => member.isSelf);
	expect(self, 'members frame must include self').toBeTruthy();
	return String(self!.memberId);
}

function f_members(frame: BoxFrame): Array<{ memberId: string; isSelf: boolean }> {
	return (frame.members ?? []) as Array<{ memberId: string; isSelf: boolean }>;
}

describe('GameRoom — bnji.chess authority (production wiring)', () => {
	it("replays a full fool's mate over the socket: seats claim, turns hold, checkmate persists", async () => {
		const code = uniqueRoomCode();
		const created = await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now(), CHESS);
		expect(created.status).toBe(200);

		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		await a.box.next(snapshotOf);
		const aId = await selfMemberId(a.box);

		// 1.e4 — claims the white seat.
		sendState(a.socket, 0, { seats: { white: aId, black: null }, moves: ['f2f3'], turn: 'b', status: 'active' });
		const move1 = await a.box.next((f) => stateFrame(f) && f.revision === 1);
		const after1 = move1.state as { seats: { white: string; black: string | null }; moves: string[]; turn: string; status: string };
		expect(after1.seats.white).toBe(aId);
		expect(after1.moves).toEqual(['f2f3']);
		expect(after1.status).toBe('active');

		await clearThrottle(code);
		const b = await connect(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
		const bSnap = await b.box.next(snapshotOf);
		expect(bSnap.revision, 'B joins at revision 1').toBe(1);
		const bId = await selfMemberId(b.box);

		// 2...e5 — claims black.
		sendState(b.socket, 1, { ...after1, moves: ['f2f3', 'e7e5'], seats: { white: aId, black: bId }, turn: 'w' });
		const move2 = await b.box.next((f) => stateFrame(f) && f.revision === 2);
		const after2 = move2.state as typeof after1 & { seats: { black: string } };
		expect(after2.seats.black).toBe(bId);
		// A sees the same broadcast.
		await a.box.next((f) => stateFrame(f) && f.revision === 2);

		await clearThrottle(code);
		sendState(a.socket, 2, { ...after2, moves: ['f2f3', 'e7e5', 'g2g4'], turn: 'b' });
		const move3 = await a.box.next((f) => stateFrame(f) && f.revision === 3);
		const after3 = move3.state as typeof after2 & { moves: string[] };
		expect(after3.moves).toEqual(['f2f3', 'e7e5', 'g2g4']);

		// 3...Qh4# — the authority computes the terminal state itself.
		await clearThrottle(code);
		sendState(b.socket, 3, { ...after3, moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], turn: 'w' });
		const move4 = await b.box.next((f) => stateFrame(f) && f.revision === 4);
		const final = move4.state as { status: string; over?: { winner: string; reason: string }; moves: string[] };
		expect(final.status).toBe('over');
		expect(final.over).toEqual({ winner: 'black', reason: 'checkmate' });
		expect(final.moves).toEqual(['f2f3', 'e7e5', 'g2g4', 'd8h4']);

		// Persisted in DO SQLite, not just broadcast.
		const rows = await runInDurableObject(stubFor(code), (_i: GameRoom, state: DurableObjectState) =>
			state.storage.sql.exec<{ state_json: string; revision: number }>('SELECT state_json, revision FROM game_room WHERE id = 1').toArray());
		expect(rows[0]!.revision).toBe(4);
		expect(JSON.parse(rows[0]!.state_json).status).toBe('over');

		try { a.socket.close(); } catch { /* already gone */ }
		try { b.socket.close(); } catch { /* already gone */ }
	});

	it('rejects an illegal move without burning the revision, then accepts a legal one', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now(), CHESS);
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		await a.box.next(snapshotOf);
		const aId = await selfMemberId(a.box);

		sendState(a.socket, 0, { seats: { white: aId, black: null }, moves: ['a1a2'], turn: 'b', status: 'active' });
		const rejected = await a.box.next((f) => f.type === 'state_rejected');
		expect(rejected.error).toBe('illegal_move');

		// Revision never moved: the legal retry still targets baseRevision 0.
		sendState(a.socket, 0, { seats: { white: aId, black: null }, moves: ['e2e4'], turn: 'b', status: 'active' });
		const accepted = await a.box.next((f) => stateFrame(f) && f.revision === 1);
		expect((accepted.state as { moves: string[] }).moves).toEqual(['e2e4']);
		try { a.socket.close(); } catch { /* already gone */ }
	});

	it('resign ends the room game; later moves fail with game_over', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now(), CHESS);
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		await a.box.next(snapshotOf);
		const aId = await selfMemberId(a.box);

		sendState(a.socket, 0, { seats: { white: aId, black: null }, moves: ['e2e4'], turn: 'b', status: 'active' });
		const move1 = await a.box.next((f) => stateFrame(f) && f.revision === 1);
		const after1 = move1.state as { seats: { white: string; black: string | null }; moves: string[] };

		await clearThrottle(code);
		const b = await connect(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
		await b.box.next(snapshotOf);
		const bId = await selfMemberId(b.box);
		sendState(b.socket, 1, { ...after1, moves: ['e2e4', 'e7e5'], seats: { white: aId, black: bId }, turn: 'w' });
		await b.box.next((f) => stateFrame(f) && f.revision === 2);

		// White resigns from a fully seated, active game.
		await clearThrottle(code);
		sendState(a.socket, 2, { seats: { white: aId, black: bId }, moves: ['e2e4', 'e7e5'], turn: 'w', status: 'active', resign: 'white' });
		const resigned = await a.box.next((f) => stateFrame(f) && f.revision === 3);
		const final = resigned.state as { status: string; over?: { winner: string; reason: string } };
		expect(final.status).toBe('over');
		expect(final.over).toEqual({ winner: 'black', reason: 'resign' });

		await clearThrottle(code);
		sendState(b.socket, 3, { ...final, moves: ['e2e4', 'e7e5', 'a2a3'] });
		const rejected = await b.box.next((f) => f.type === 'state_rejected');
		expect(rejected.error).toBe('game_over');
		try { a.socket.close(); } catch { /* already gone */ }
		try { b.socket.close(); } catch { /* already gone */ }
		await delay(10);
	});
});
