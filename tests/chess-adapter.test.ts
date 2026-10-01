/**
 * `bnji.chess` adapter contracts — the two fail-closed seams from
 * src/server/score-verifiers.ts and src/server/room-authority.ts, plus the
 * HTTP score route end-to-end against a harness D1.
 *
 * Authority: server-authoritative replay (the DO persists only what the
 * authority returns), seat claiming, turn/seat enforcement, resign, forged
 * proposals, and a full fool's-mate game.
 *
 * Verifier: only a replayable, genuinely terminal checkmate of the claimed
 * colour scores; the score is recomputed server-side from the ply count.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { authorizeRoomStateTransition, type RoomStateTransition } from '../src/server/room-authority';
import { CHESS_GAME_ID, CHESS_MODE_ID, chessRoomAuthority } from '../src/server/game-adapters/chess';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();

const MEMBER_A = 'a'.repeat(24);
const MEMBER_B = 'b'.repeat(24);
const MEMBER_C = 'c'.repeat(24);
const FOOLS = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

function transition(actor: string, current: unknown, proposed: unknown): RoomStateTransition {
	return {
		gameId: CHESS_GAME_ID,
		actor: { principalHash: 'f'.repeat(64), memberId: actor, isHost: false },
		baseRevision: 0,
		currentRevision: 0,
		currentState: (current ?? {}) as Record<string, unknown>,
		proposedState: proposed as Record<string, unknown>,
	};
}

function database() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: db, DM_CONVERSATIONS: null, PRESENCE: null };
	globalThis.__BNJI_TEST_SECRETS__ = {};
	return db;
}

function jsonContext(path: string, body: unknown, origin = 'http://localhost'): APIContext {
	const url = `http://localhost${path}`;
	const headers = new Headers({ 'content-type': 'application/json' });
	if (origin) headers.set('origin', origin);
	const request = new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
	return { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
}

test('authority: first move claims white, replayed state is canonical', async () => {
	const proposed = { seats: { white: MEMBER_A, black: null }, moves: ['e2e4'], turn: 'b', status: 'active', junk: 'ignored' };
	const decision = await authorizeRoomStateTransition(transition(MEMBER_A, {}, proposed));
	assert.equal(decision.allowed, true, JSON.stringify(decision));
	assert.ok(decision.allowed && decision.state);
	const state = decision.allowed ? decision.state : null;
	assert.deepEqual(state, {
		seats: { white: MEMBER_A, black: null },
		moves: ['e2e4'],
		turn: 'b',
		status: 'active',
	});
});

test('authority: seats enforce turns across players', async () => {
	const afterE4 = { seats: { white: MEMBER_A, black: null }, moves: ['e2e4'], turn: 'b', status: 'active' };
	// B claims the empty black seat with a legal reply.
	const reply = await authorizeRoomStateTransition(
		transition(MEMBER_B, afterE4, { ...afterE4, moves: ['e2e4', 'e7e5'], seats: { white: MEMBER_A, black: MEMBER_B }, turn: 'w' }),
	);
	assert.equal(reply.allowed, true, JSON.stringify(reply));
	assert.ok(reply.allowed && reply.state);

	// Black is now B's seat: B cannot play White's next move…
	const overstepBlack = await authorizeRoomStateTransition(
		transition(MEMBER_B, reply.state, { ...(reply.state as object), moves: ['e2e4', 'e7e5', 'g1f3'] } as RoomStateTransition['currentState']),
	);
	assert.equal(overstepBlack.allowed, false, JSON.stringify(overstepBlack));
	assert.equal(overstepBlack.allowed === false ? overstepBlack.error : '', 'not_your_turn');

	// …and A (white seat) cannot answer for Black on a black-to-move position.
	const blackTurn = { seats: { white: MEMBER_A, black: MEMBER_B }, moves: ['e2e4'], turn: 'b', status: 'active' };
	const overstepWhite = await authorizeRoomStateTransition(
		transition(MEMBER_A, blackTurn, { ...blackTurn, moves: ['e2e4', 'e7e5'] }),
	);
	assert.equal(overstepWhite.allowed, false, JSON.stringify(overstepWhite));
	assert.equal(overstepWhite.allowed === false ? overstepWhite.error : '', 'not_your_turn');
});

test('authority: rejects illegal moves, multi-move jumps and forged seats', async () => {
	const current = { seats: { white: MEMBER_A, black: MEMBER_B }, moves: ['e2e4', 'e7e5'], turn: 'w', status: 'active' };
	const illegal = await authorizeRoomStateTransition(
		transition(MEMBER_A, current, { ...current, moves: ['e2e4', 'e7e5', 'a1a2'] }),
	);
	assert.equal(illegal.allowed, false);
	assert.equal(illegal.allowed === false ? illegal.error : '', 'illegal_move');

	const twoMoves = await authorizeRoomStateTransition(
		transition(MEMBER_A, current, { ...current, moves: ['e2e4', 'e7e5', 'g1f3', 'g8f6'] }),
	);
	assert.equal(twoMoves.allowed, false);
	assert.equal(twoMoves.allowed === false ? twoMoves.error : '', 'bad_proposal');

	const forged = await authorizeRoomStateTransition(
		transition(MEMBER_A, current, { ...current, moves: ['e2e4', 'e7e5', 'g1f3'], seats: { white: MEMBER_A, black: MEMBER_C } }),
	);
	assert.equal(forged.allowed, false);
	assert.equal(forged.allowed === false ? forged.error : '', 'bad_seats');
});

test('authority: resign ends the game for the seat holder only', async () => {
	const current = { seats: { white: MEMBER_A, black: MEMBER_B }, moves: ['e2e4', 'e7e5'], turn: 'w', status: 'active' };
	const outsider = await authorizeRoomStateTransition(
		transition(MEMBER_C, current, { ...current, resign: 'white' }),
	);
	assert.equal(outsider.allowed, false);
	assert.equal(outsider.allowed === false ? outsider.error : '', 'not_your_seat');

	const resign = await authorizeRoomStateTransition(
		transition(MEMBER_A, current, { ...current, resign: 'white' }),
	);
	assert.equal(resign.allowed, true, JSON.stringify(resign));
	assert.ok(resign.allowed && resign.state);
	assert.deepEqual(resign.allowed ? resign.state?.over : null, { winner: 'black', reason: 'resign' });
	assert.equal(resign.allowed ? (resign.state as { status?: string })?.status : '', 'over');

	// Nothing moves after the game is over.
	const after = await authorizeRoomStateTransition(
		transition(MEMBER_B, resign.allowed ? resign.state : current, { moves: ['e2e4'] }),
	);
	assert.equal(after.allowed, false);
	assert.equal(after.allowed === false ? after.error : '', 'game_over');
});

test('authority: corrupt stored state fails closed', async () => {
	const corrupt = await authorizeRoomStateTransition(
		transition(MEMBER_A, { seats: 'nope', moves: 'e2e4' }, { moves: ['e2e4'] }),
	);
	assert.equal(corrupt.allowed, false);
	assert.equal(corrupt.allowed === false ? corrupt.error : '', 'state_corrupt');
});

test("authority: full fool's mate produces the over state", async () => {
	let current: unknown = {};
	let actor = MEMBER_A;
	for (let ply = 0; ply < FOOLS.length; ply += 1) {
		const seatState = (current as { seats?: Record<string, string | null> }).seats ?? { white: null, black: null };
		const moves = [...((current as { moves?: string[] }).moves ?? []), FOOLS[ply]];
		const proposed = { seats: { ...seatState }, moves, turn: ply % 2 === 0 ? 'b' : 'w', status: 'active' };
		if (ply % 2 === 0 && !proposed.seats.white) proposed.seats.white = actor;
		if (ply % 2 === 1 && !proposed.seats.black) proposed.seats.black = actor;
		const decision = await authorizeRoomStateTransition(transition(actor, current, proposed));
		assert.equal(decision.allowed, true, `ply ${ply}: ${JSON.stringify(decision)}`);
		assert.ok(decision.allowed && decision.state);
		current = decision.allowed ? decision.state : current;
		actor = actor === MEMBER_A ? MEMBER_B : MEMBER_A;
	}
	const final = current as { status: string; over?: { winner: string; reason: string }; moves: string[] };
	assert.equal(final.status, 'over');
	assert.deepEqual(final.over, { winner: 'black', reason: 'checkmate' });
	assert.deepEqual(final.moves, FOOLS);
});

test('verifier: legal checkmate proofs score, everything else is rejected', async () => {
	const { getScoreVerifier } = await import('../src/server/score-verifiers');
	const verifier = getScoreVerifier(CHESS_GAME_ID);
	assert.ok(verifier, 'chess verifier registered on import');
	const base = { gameId: CHESS_GAME_ID, modeId: CHESS_MODE_ID, score: 0, tieBreak: null, displayName: 'T', idempotencyKey: 'k'.repeat(16) };

	const fools = await verifier({ ...base, proof: { moves: FOOLS, color: 'black' } }, { sessionId: 's', playerId: null });
	assert.deepEqual(fools, { score: 99_600, tieBreak: 4 });

	// Wrong colour for the same game.
	assert.equal(await verifier({ ...base, proof: { moves: FOOLS, color: 'white' } }, { sessionId: 's', playerId: null }), null);
	// Illegal move inside the record.
	assert.equal(await verifier({ ...base, proof: { moves: ['e2e5'], color: 'white' } }, { sessionId: 's', playerId: null }), null);
	// Legal moves but no terminal position.
	assert.equal(await verifier({ ...base, proof: { moves: ['e2e4', 'e7e5'], color: 'white' } }, { sessionId: 's', playerId: null }), null);
	// Scholar's mate is a white win.
	const scholars = await verifier(
		{ ...base, proof: { moves: ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'], color: 'white' } },
		{ sessionId: 's', playerId: null },
	);
	assert.deepEqual(scholars, { score: 99_300, tieBreak: 7 });
	// Shape garbage.
	assert.equal(await verifier({ ...base, proof: 'fools' }, { sessionId: 's', playerId: null }), null);
	assert.equal(await verifier({ ...base, proof: { moves: [], color: 'black' } }, { sessionId: 's', playerId: null }), null);
	assert.equal(await verifier({ ...base, proof: { moves: FOOLS, color: 'draw' } }, { sessionId: 's', playerId: null }), null);
	// Wrong game / mode never reaches the chess logic.
	assert.equal(await verifier({ ...base, gameId: 'bnji.memory-pairs', proof: { moves: FOOLS, color: 'black' } }, { sessionId: 's', playerId: null }), null);
	assert.equal(await verifier({ ...base, modeId: 'default', proof: { moves: FOOLS, color: 'black' } }, { sessionId: 's', playerId: null }), null);
});

test('score route: 201 for a valid claim, leaderboard row, fail-closed elsewhere', async () => {
	database();
	const scores = await import('../src/pages/api/games/scores');
	const leaderboard = await import('../src/pages/api/games/leaderboard');

	const body = {
		gameId: CHESS_GAME_ID,
		mode: CHESS_MODE_ID,
		score: 99_600,
		tieBreak: 4,
		displayName: 'Checkmate Carl',
		idempotencyKey: 'chess-claim-abcdef12',
		proof: { moves: FOOLS, color: 'black' },
	};
	const created = await scores.POST(jsonContext('/api/games/scores', body));
	assert.equal(created.status, 201, await created.clone().text());
	const createdBody = await created.json() as { ok: boolean; score: number };
	assert.equal(createdBody.ok, true);
	assert.equal(createdBody.score, 99_600, 'server recomputes the score');

	// The public leaderboard exposes the row.
	const read = await leaderboard.GET({
		request: new Request('http://localhost/api/games/leaderboard?gameId=bnji.chess&mode=fastest-mate'),
		url: new URL('http://localhost/api/games/leaderboard?gameId=bnji.chess&mode=fastest-mate'),
		params: {}, cookies: { get: () => undefined },
	} as unknown as APIContext);
	assert.equal(read.status, 200, await read.clone().text());
	const board = await read.json() as { rows?: { displayName: string; score: number }[] };
	const rows = board.rows ?? [];
	assert.ok(rows.length >= 1, JSON.stringify(board));
	const first = rows[0]!;
	assert.equal(first.score, 99_600);

	// A tampered proof cannot score (fail-closed 422, not silent acceptance).
	const bad = await scores.POST(jsonContext('/api/games/scores', { ...body, idempotencyKey: 'chess-claim-bad-0001', proof: { moves: ['e2e4', 'd7d5'], color: 'white' } }));
	assert.equal(bad.status, 422, await bad.clone().text());

	// A game without a registered verifier still fails closed.
	const unregistered = await scores.POST(jsonContext('/api/games/scores', {
		gameId: 'bnji.memory-pairs', mode: 'default', score: 10, tieBreak: null,
		displayName: 'Nope', idempotencyKey: 'mem-claim-abcdef12', proof: { anything: true },
	}));
	assert.equal(unregistered.status, 503, await unregistered.clone().text());

	// Cross-origin submissions stay blocked.
	const cross = await scores.POST(jsonContext('/api/games/scores', body, 'https://evil.example'));
	assert.equal(cross.status, 403);
});
