/**
 * `bnji.pvp-minesweeper` through the REAL GameRoom Durable Object: the
 * game-action channel (no 5s state-frame budget), the phase machine with the
 * DO clock, placements/race over live sockets, and `/game/verify_win`
 * attestation — the production wiring from `game-room-do.ts`'s side-effect
 * import, not a test-only registration.
 *
 * The 5s vote/placement/results windows are satisfied by rewinding the
 * stored `phaseAt` (the authority trusts only the DO clock), so the spec
 * never sleeps through a real phase window.
 */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { GameRoom } from '../../src/server/game-room-do';
import {
	SocketBox,
	connect,
	createRoom,
	principalHash,
	stubFor,
	uniqueRoomCode,
	type BoxFrame,
} from './support';

const MS = 'bnji.pvp-minesweeper';

function sendAction(socket: WebSocket, action: string, payload: Record<string, unknown> = {}): void {
	socket.send(JSON.stringify({ v: 1, type: 'action', action, payload }));
}

const actionOf = (action: string) => (frame: BoxFrame) => frame.type === 'action' && frame.action === action;
const rejectedOf = (error: string) => (frame: BoxFrame) => frame.type === 'action_rejected' && frame.error === error;

async function selfMemberId(box: SocketBox): Promise<string> {
	const frame = await box.next((f) => f.type === 'members' && Array.isArray(f.members));
	const members = (frame.members ?? []) as Array<{ memberId: string; isSelf: boolean }>;
	const self = members.find((member) => member.isSelf);
	expect(self, 'members frame must include self').toBeTruthy();
	return String(self!.memberId);
}

/** Rewind the stored phase deadline by `ms` — the authority only trusts the DO clock. */
async function rewindPhase(code: string, ms: number): Promise<void> {
	await runInDurableObject(stubFor(code), (_instance: GameRoom, state: DurableObjectState) => {
		const row = state.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM game_room WHERE id = 1').toArray()[0]!;
		const value = JSON.parse(row.state_json) as Record<string, unknown>;
		value.phaseAt = Number(value.phaseAt ?? 0) - ms;
		state.storage.sql.exec('UPDATE game_room SET state_json = ?1', JSON.stringify(value));
	});
}

async function verifyWin(code: string, principal: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await stubFor(code).fetch(new Request('https://room.test/game/verify_win', {
		method: 'POST',
		headers: { 'x-bnji-verified-principal': principal, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	}));
	const text = await response.text();
	return { status: response.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

function bitset(cells: number[]): string {
	const field = new Uint8Array(Math.ceil(36 / 8)); // quick: 6×6
	for (const cell of cells) field[cell >> 3] = (field[cell >> 3] ?? 0) | (1 << (cell & 7));
	let binary = '';
	for (const byte of field) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeClicks(mines: number[]): number[] {
	const field = new Uint8Array(Math.ceil(36 / 8));
	for (const cell of mines) field[cell >> 3] = (field[cell >> 3] ?? 0) | (1 << (cell & 7));
	const mine = (cell: number) => ((field[cell >> 3] ?? 0) & (1 << (cell & 7))) !== 0;
	return Array.from({ length: 36 }, (_, cell) => cell).filter((cell) => !mine(cell));
}

describe('GameRoom — bnji.pvp-minesweeper actions (production wiring)', () => {
	it('runs a full round over live sockets: start → vote → place → race → clear → attested win', async () => {
		const code = uniqueRoomCode();
		const created = await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now(), MS);
		expect(created.status).toBe(200);

		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		const b = await connect(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
		const aId = await selfMemberId(a.box);
		const bId = await selfMemberId(b.box);

		// A non-host cannot open the round while the room is still in the lobby.
		sendAction(b.socket, 'ms_start');
		await b.box.next(rejectedOf('host_only'));

		// Host starts the round — action frames bypass the 5s state-frame budget entirely.
		sendAction(a.socket, 'ms_start');
		const started = await a.box.next(actionOf('ms_start'));
		expect((started.state as { phase: string }).phase).toBe('vote');
		expect((started.state as { round: number }).round).toBe(1);
		const revisionAfterStart = Number(started.revision);
		await b.box.next(actionOf('ms_start'));

		// Simultaneous votes from both seats within the same second: no throttle, no conflicts.
		sendAction(a.socket, 'ms_vote', { v: 'quick' });
		sendAction(b.socket, 'ms_vote', { v: 'hard' });
		await a.box.next(actionOf('ms_vote'));
		const firstVoteFrame = await b.box.next(actionOf('ms_vote'));
		expect(Number(firstVoteFrame.revision)).toBeGreaterThan(revisionAfterStart);
		const voteFrame = await b.box.next(actionOf('ms_vote'));
		const votes = (voteFrame.state as { votes: Record<string, string> }).votes;
		expect(Object.keys(votes).length).toBe(2);

		// Unknown actions fail closed to the acting socket only.
		sendAction(b.socket, 'ms_nope');
		await b.box.next(rejectedOf('unknown_action'));

		// Close the 5s vote window via the DO clock, then sync into placement.
		await rewindPhase(code, 5_001);
		sendAction(a.socket, 'ms_sync');
		const placed = await a.box.next(actionOf('ms_sync'));
		const placeState = placed.state as { phase: string; difficulty: string; roster: string[] };
		expect(placeState.phase).toBe('place');
		expect(placeState.difficulty, 'quick vs hard ties break in preference order').toBe('quick');
		expect(placeState.roster).toEqual([aId, bId].sort());

		const roster = placeState.roster;
		const aIdx = roster.indexOf(aId);
		const bIdx = roster.indexOf(bId);

		// Exact budgets (5 mines, solo author), then both ready → race opens on the last ack.
		sendAction(a.socket, 'ms_place', { c: { [String(bIdx)]: bitset([1, 2, 3, 4, 5]) }, r: 1 });
		const afterA = await a.box.next(actionOf('ms_place'));
		expect((afterA.state as { phase: string }).phase).toBe('place');
		sendAction(b.socket, 'ms_place', { c: { [String(aIdx)]: bitset([7, 8, 9, 10, 12]) }, r: 1 });
		// A's box already consumed its own place frame, so the next one is B's broadcast — the race opening.
		const raced = await a.box.next(actionOf('ms_place'));
		const raceState = raced.state as { phase: string; alive: string[]; placements?: unknown };
		expect(raceState.phase).toBe('race');
		expect([...raceState.alive].sort()).toEqual([aId, bId].sort());
		expect(raceState.placements, 'broadcast race state never carries minefields').toBeUndefined();

		// The racer's own sync answers with an actor-only field view (numbers + reveals).
		sendAction(a.socket, 'ms_sync');
		await a.box.next(actionOf('ms_sync'));
		const fieldReply = await a.box.next((f) => f.type === 'action_result' && f.action === 'ms_sync');
		const view = fieldReply.reply as { size: number; numbers: number[]; revealed: number[] };
		expect(view.size).toBe(6);
		expect(view.numbers.length).toBe(36);
		expect(view.revealed).toEqual([]);
		expect(b.box.frames.some((f) => f.type === 'action_result'), 'field views never broadcast').toBe(false);

		// A clears the board B designed (mines 7,8,9,10,12 on A's target index).
		sendAction(a.socket, 'ms_finish', { c: safeClicks([7, 8, 9, 10, 12]) });
		const results = await a.box.next(actionOf('ms_finish'));
		const resultsState = results.state as { phase: string; results: { winner: string; winnerHash: string; reason: string; round: number; difficulty: string } };
		expect(resultsState.phase).toBe('results');
		expect(resultsState.results.reason).toBe('clear');
		expect(resultsState.results.winner).toBe(aId);
		expect(resultsState.results.winnerHash).toBe(await principalHash('guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
		expect(resultsState.results.round).toBe(1);
		expect(resultsState.results.difficulty).toBe('quick');

		// DO attestation while the room is fresh: winner yes, others no.
		const win = await verifyWin(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { gameId: MS, round: 1 });
		expect(win.status).toBe(200);
		expect(win.json).toEqual({ ok: true, mode: 'quick' });
		const notWinner = await verifyWin(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { gameId: MS, round: 1 });
		expect(notWinner.status).toBe(404);
		expect(notWinner.json).toEqual({ ok: false, error: 'not_winner' });
		const wrongRound = await verifyWin(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { gameId: MS, round: 2 });
		expect(wrongRound.status).toBe(404);

		a.socket.close();
		b.socket.close();
	});

	it('delivers action bursts with no 5s budget, then the global per-second ceiling takes over', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now(), MS);
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		const b = await connect(code, 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

		// A denial reaches only the acting socket; the peer keeps its view.
		sendAction(b.socket, 'ms_start');
		await b.box.next(rejectedOf('host_only'));
		expect(b.box.frames.some((frame) => frame.type === 'action' && frame.action === 'ms_start')).toBe(false);

		// The full Plan §5.4.1 first-second allowance lands as normal action
		// frames — no 5s `rate_limited`, revisions ticking on every sync.
		const burst = 8;
		for (let i = 0; i < burst; i += 1) sendAction(a.socket, 'ms_sync');
		let lastRevision = 0;
		for (let i = 0; i < burst; i += 1) {
			const frame = await a.box.next((f) => f.type === 'action' || f.type === 'action_rejected' || f.type === 'rate_limited');
			expect(frame.type, 'actions never take the 5s state-write path').toBe('action');
			expect(Number(frame.revision)).toBeGreaterThan(lastRevision);
			lastRevision = Number(frame.revision);
		}

		// The 9th message in the same wall-clock second hits the room-wide
		// abuse ceiling and closes only the offending socket (1013).
		sendAction(a.socket, 'ms_sync');
		const close = await a.box.closed(5_000);
		expect(close.code).toBe(1013);
		// The peer socket is untouched and saw every broadcast from the burst.
		expect(b.box.frames.filter((frame) => frame.type === 'action').length).toBeGreaterThanOrEqual(burst);
		b.socket.close();
	});

	it('fails closed for games without an adapter and unsupported attestations', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now(), 'bnji.glass-minesweeper');
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

		sendAction(a.socket, 'ms_start');
		await a.box.next(rejectedOf('game_adapter_unavailable'));

		const unsupported = await verifyWin(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { gameId: 'bnji.glass-minesweeper', round: 1 });
		expect(unsupported.status).toBe(404);
		expect(unsupported.json).toEqual({ ok: false, error: 'unsupported_game' });
		a.socket.close();
	});

	it('corrupt stored state denies actions with state_corrupt', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Date.now(), MS);
		const a = await connect(code, 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		await runInDurableObject(stubFor(code), (_instance: GameRoom, state: DurableObjectState) => {
			state.storage.sql.exec('UPDATE game_room SET state_json = ?1', JSON.stringify({ phase: 'vote' }));
		});
		sendAction(a.socket, 'ms_sync');
		await a.box.next(rejectedOf('state_corrupt'));
		a.socket.close();
	});
});
