/**
 * `bnji.pvp-minesweeper` adapter contracts — the room game-action phase
 * machine (lobby → vote → place → race → results), placement budgets, finish
 * validation, elimination, the registered action/round-win seams, and the
 * score verifier's DO attestation call.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MS_GAME_ID,
	normalizeMsRoomState,
	msRoomGameAction,
	type MsRoomState,
} from '../src/server/game-adapters/pvp-minesweeper';
import {
	authorizeGameAction,
	redactGameState,
	verifyRoundWin,
	type GameActionRequest,
} from '../src/server/room-authority';
import {
	msContributorBudget,
	msEncodeBitset,
	msGetMine,
	msSetMine,
} from '../src/game/minesweeper-rules';

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);
const HASH_A = '1'.repeat(64);
const HASH_B = '2'.repeat(64);
const HASH_C = '3'.repeat(64);
type Member = { memberId: string; principalHash: string };
const MEMBERS2: Member[] = [
	{ memberId: A, principalHash: HASH_A },
	{ memberId: B, principalHash: HASH_B },
];
const MEMBERS3: Member[] = [...MEMBERS2, { memberId: C, principalHash: HASH_C }];

type RequestOptions = {
	currentState: unknown;
	now: number;
	actorId?: string;
	isHost?: boolean;
	members?: Member[];
	hasHost?: boolean;
};

function request(action: string, payload: Record<string, unknown>, options: RequestOptions): GameActionRequest {
	const actorId = options.actorId ?? A;
	return {
		gameId: MS_GAME_ID,
		actor: {
			principalHash: actorId === B ? HASH_B : actorId === C ? HASH_C : HASH_A,
			memberId: actorId,
			isHost: options.isHost ?? actorId === A,
		},
		action,
		payload,
		currentState: (options.currentState ?? {}) as Record<string, unknown>,
		now: options.now,
		members: options.members ?? MEMBERS2,
		hasHost: options.hasHost ?? true,
	};
}

function act(action: string, payload: Record<string, unknown>, options: RequestOptions): MsRoomState {
	const decision = msRoomGameAction(request(action, payload, options));
	assert.equal(decision.allowed, true, `${action} should be allowed: ${decision.allowed ? '' : decision.error}`);
	if (!decision.allowed) throw new Error('unreachable');
	return decision.state as MsRoomState;
}

function denied(action: string, payload: Record<string, unknown>, options: RequestOptions): string {
	const decision = msRoomGameAction(request(action, payload, options));
	assert.equal(decision.allowed, false, `${action} should be denied`);
	return decision.allowed ? '' : decision.error ?? 'game_action_rejected';
}

const QUICK_CELLS = [1, 2, 3, 4, 5];

function minesFor(difficulty: 'quick' | 'normal' | 'hard', cells: number[]): string {
	const size = difficulty === 'quick' ? 6 : difficulty === 'normal' ? 9 : 14;
	const field = new Uint8Array(Math.ceil(size * size / 8));
	for (const cell of cells) msSetMine(field, cell);
	return msEncodeBitset(field);
}

function safeClicks(size: number, cells: number[]): number[] {
	const field = new Uint8Array(Math.ceil(size * size / 8));
	for (const cell of cells) msSetMine(field, cell);
	return Array.from({ length: size * size }, (_, cell) => cell).filter((cell) => !msGetMine(field, cell));
}

/** Drive the shared happy path (quick vote) up to an active race with `members`. */
function upToRace(members: Member[], nowRef: { value: number }): MsRoomState {
	let state = act('ms_start', {}, { currentState: {}, now: nowRef.value, members, isHost: true });
	state = act('ms_vote', { v: 'quick' }, { currentState: state, now: (nowRef.value += 10), actorId: members[0]!.memberId, members });
	state = act('ms_sync', {}, { currentState: state, now: (nowRef.value += 5_000), members });
	assert.equal(state.phase, 'place');
	assert.equal(state.difficulty, 'quick');
	const roster = state.roster!;
	for (const member of members) {
		const ownIdx = roster.indexOf(member.memberId);
		const c: Record<string, string> = {};
		for (let target = 0; target < roster.length; target += 1) {
			if (target === ownIdx) continue;
			// The author's budget for THIS target: their index among the target's authors.
			const authorIndex = target < ownIdx ? ownIdx - 1 : ownIdx;
			const budget = msContributorBudget(5, authorIndex, roster.length - 1);
			c[String(target)] = minesFor('quick', QUICK_CELLS.slice(0, budget));
		}
		state = act('ms_place', { c, r: 1 }, { currentState: state, now: (nowRef.value += 10), actorId: member.memberId, members });
	}
	assert.equal(state.phase, 'race', 'the last ready action opens the race');
	return state;
}

test('registry: the game-action and round-win seams resolve bnji.pvp-minesweeper, others fail closed', async () => {
	const decision = await authorizeGameAction({
		gameId: MS_GAME_ID,
		actor: { principalHash: HASH_A, memberId: A, isHost: true },
		action: 'ms_start', payload: {},
		currentState: {}, now: 1,
		members: MEMBERS2, hasHost: true,
	});
	assert.equal(decision.allowed, true);

	const foreign = await authorizeGameAction({
		gameId: 'bnji.chess',
		actor: { principalHash: HASH_A, memberId: A, isHost: true },
		action: 'ms_start', payload: {},
		currentState: {}, now: 1,
		members: MEMBERS2, hasHost: true,
	});
	assert.equal(foreign.allowed, false);
	assert.equal(foreign.allowed === false && foreign.error, 'game_adapter_unavailable');

	assert.equal(verifyRoundWin('bnji.not-a-game', {}, { principalHash: HASH_A, round: 1 }), null);
});

test('normalize: fresh rooms start in the lobby and corrupt stored state fails closed', () => {
	const fresh = normalizeMsRoomState({});
	assert.equal(fresh.ok, true);
	if (fresh.ok) assert.deepEqual(fresh.state, { phase: 'lobby', phaseAt: 0, round: 0, wins: {} });

	assert.equal(normalizeMsRoomState(null).ok, false);
	assert.equal(normalizeMsRoomState({ phase: 'duel' }).ok, false);
	assert.equal(normalizeMsRoomState({ phase: 'vote', phaseAt: 1, round: 1 }).ok, false, 'vote requires its votes map');
	assert.equal(normalizeMsRoomState({ phase: 'place', phaseAt: 1, round: 1, difficulty: 'medium' }).ok, false);
	assert.equal(normalizeMsRoomState({ phase: 'race', phaseAt: 1, round: 1, difficulty: 'quick', roster: [A, B] }).ok, false, 'race requires alive');
	assert.equal(normalizeMsRoomState({ phase: 'results', phaseAt: 1, round: 1, difficulty: 'quick', roster: [A, B] }).ok, false, 'results requires results');
	assert.equal(normalizeMsRoomState({ phase: 'vote', phaseAt: 1, round: 1, votes: { ['x']: 'quick' } }).ok, false, 'member ids must be 24-hex');
	// Canonical rebuild drops unknown client-injected keys…
	const withExtras = normalizeMsRoomState({ phase: 'lobby', phaseAt: 5, round: 2, wins: {}, sneaky: true });
	assert.equal(withExtras.ok, true);
	if (withExtras.ok) assert.equal('sneaky' in withExtras.state, false);
	// …while known fields in the wrong phase are rejected outright.
	assert.equal(normalizeMsRoomState({ phase: 'lobby', phaseAt: 5, round: 2, wins: {}, results: { round: 2 } }).ok, false);
});

test('full 2-player round: vote → place (exact budgets) → race → clear → results → next vote', () => {
	let state = act('ms_start', {}, { currentState: {}, now: 1000, isHost: true });
	assert.equal(state.phase, 'vote');
	assert.equal(state.round, 1);

	state = act('ms_vote', { v: 'quick' }, { currentState: state, now: 1500, actorId: A });
	state = act('ms_vote', { v: 'hard' }, { currentState: state, now: 1600, actorId: B });
	// A vote may be changed while the window is open (member-scoped overwrite).
	state = act('ms_vote', { v: 'normal' }, { currentState: state, now: 1700, actorId: B });
	assert.deepEqual(state.votes, { [A]: 'quick', [B]: 'normal' });

	// Before the deadline the vote stays open.
	const early = act('ms_sync', {}, { currentState: state, now: 5999 });
	assert.equal(early.phase, 'vote');
	// At the deadline the tally closes; quick vs normal ties → normal first in preference order.
	const closed = act('ms_sync', {}, { currentState: early, now: 6000 });
	assert.equal(closed.phase, 'place');
	assert.equal(closed.difficulty, 'normal', 'tie prefers normal over quick');
	assert.deepEqual(closed.roster, [A, B]);
	assert.equal(closed.round, 1);

	const cells = [1, 2, 3, 4, 5];
	assert.equal(denied('ms_place', { c: { ['1']: minesFor('normal', cells.slice(0, 4)) }, r: 1 }, { currentState: closed, now: 7000, actorId: A }), 'bad_mine_count', 'exact budget (10 mines for the solo author)');
	assert.equal(denied('ms_place', { c: { ['0']: minesFor('normal', cells) }, r: 1 }, { currentState: closed, now: 7000, actorId: A }), 'bad_mine_board', 'cannot target your own board');
	assert.equal(denied('ms_place', { r: 1 }, { currentState: closed, now: 7000, actorId: C }), 'not_in_round');
	assert.equal(denied('ms_vote', { v: 'quick' }, { currentState: closed, now: 7000, actorId: A }), 'wrong_phase');

	const fieldCells = [0, 11, 22, 33, 44, 55, 66, 71, 77, 80];
	let placed = act('ms_place', { c: { ['1']: minesFor('normal', fieldCells) } }, { currentState: closed, now: 7000, actorId: A });
	assert.equal(placed.phase, 'place');
	assert.deepEqual(placed.ready, [], 'submitting mines alone is not ready');
	placed = act('ms_place', { r: 1 }, { currentState: placed, now: 7100, actorId: A });
	assert.deepEqual(placed.ready, [A]);
	const reReady = act('ms_place', { r: 1 }, { currentState: placed, now: 7150, actorId: A });
	assert.deepEqual(reReady.ready, [A], 're-acking is idempotent');
	// B readies without ever submitting → placements missing.
	assert.equal(denied('ms_place', { r: 1 }, { currentState: placed, now: 7200, actorId: B }), 'placements_missing');
	const raced = act('ms_place', { c: { ['0']: minesFor('normal', [7, 8, 9, 10, 12, 13, 14, 15, 16, 17]) }, r: 1 }, { currentState: placed, now: 7200, actorId: B });
	assert.equal(raced.phase, 'race', 'last ready starts the race immediately');
	assert.deepEqual(raced.alive, [A, B]);
	assert.equal(raced.ready, undefined);

	// A clears their received board (mines placed by B on target 0).
	const clicks = safeClicks(9, [7, 8, 9, 10, 12, 13, 14, 15, 16, 17]);
	// Incomplete click lists are acknowledged progress, with a private field view reply.
	const partial = msRoomGameAction(request('ms_finish', { c: clicks.slice(0, 5) }, { currentState: raced, now: 9000, actorId: A }));
	assert.equal(partial.allowed, true);
	if (partial.allowed) {
		assert.deepEqual((partial.state as MsRoomState).clicks?.[A], clicks.slice(0, 5));
		const view = partial.reply as { size: number; revealed: number[]; numbers: number[] } | undefined;
		assert.equal(view?.size, 9, 'normal is 9×9');
		assert.deepEqual(view?.revealed, clicks.slice(0, 5));
		assert.equal(view?.numbers?.length, 81);
	}
	// Mine clicks and duplicate cells stay denied.
	assert.equal(denied('ms_finish', { c: [7] }, { currentState: raced, now: 9000, actorId: A }), 'hit_mine');
	assert.equal(denied('ms_finish', { c: [11, 11] }, { currentState: raced, now: 9000, actorId: A }), 'bad_clicks');
	// A racer's own sync in race phase returns the private field view.
	const sync = msRoomGameAction(request('ms_sync', {}, { currentState: raced, now: 9100, actorId: A }));
	assert.equal(sync.allowed, true);
	if (sync.allowed) {
		const view = sync.reply as { size: number; numbers: number[] } | undefined;
		assert.equal(view?.size, 9);
		assert.equal(view?.numbers?.length, 81);
	}
	const results = act('ms_finish', { c: clicks }, { currentState: raced, now: 9400, actorId: A });
	assert.equal(results.phase, 'results');
	assert.deepEqual(results.results, {
		round: 1,
		difficulty: 'normal',
		winner: A,
		winnerHash: HASH_A,
		reason: 'clear',
		mineCells: {
			'0': minesFor('normal', [7, 8, 9, 10, 12, 13, 14, 15, 16, 17]),
			'1': minesFor('normal', [0, 11, 22, 33, 44, 55, 66, 71, 77, 80]),
		},
	}, 'results reveal every authored field');
	assert.deepEqual(results.wins, { [A]: 1 });
	assert.equal(results.placements, undefined, 'results state drops the heavy boards');

	assert.equal(denied('ms_vote', { v: 'quick' }, { currentState: results, now: 9500, actorId: B }), 'wrong_phase');
	const nextVote = act('ms_sync', {}, { currentState: results, now: results.phaseAt + 5000 });
	assert.equal(nextVote.phase, 'vote');
	assert.equal(nextVote.round, 2, 'the next round opens automatically');
	assert.deepEqual(nextVote.wins, { [A]: 1 }, 'room tally survives the reset');
	assert.equal(nextVote.results, undefined);
});

test('elimination: last standing wins, multi-player races continue after one death', () => {
	// 2-player: one death ends the round for the opponent.
	const race2 = upToRace(MEMBERS2, { value: 10_000 });
	const afterDie = act('ms_die', {}, { currentState: race2, now: 12_000, actorId: A });
	assert.equal(afterDie.phase, 'results');
	assert.equal(afterDie.results?.winner, B);
	assert.equal(afterDie.results?.winnerHash, HASH_B);
	assert.equal(afterDie.results?.reason, 'elimination');
	assert.deepEqual(afterDie.wins, { [B]: 1 });

	// 3-player: first death shrinks the field, second death crowns the survivor.
	const race3 = upToRace(MEMBERS3, { value: 40_000 });
	const afterFirst = act('ms_die', {}, { currentState: race3, now: 42_000, actorId: A, members: MEMBERS3 });
	assert.equal(afterFirst.phase, 'race');
	assert.deepEqual(afterFirst.alive, [B, C]);
	assert.equal(denied('ms_die', {}, { currentState: afterFirst, now: 42_100, actorId: A, members: MEMBERS3 }), 'not_racing');
	const afterSecond = act('ms_die', {}, { currentState: afterFirst, now: 43_000, actorId: B, members: MEMBERS3 });
	assert.equal(afterSecond.phase, 'results');
	assert.equal(afterSecond.results?.winner, C);
	assert.equal(afterSecond.results?.winnerHash, HASH_C);
});

test('broadcast redaction never ships incoming minefields to clients', () => {
	const race = upToRace(MEMBERS2, { value: 20_000 });
	const redacted = redactGameState(MS_GAME_ID, race as unknown as Record<string, unknown>);
	assert.equal('placements' in redacted, false, 'race state must drop placements before broadcast');
	assert.equal(redacted.phase, 'race');
	const vote = { phase: 'vote', phaseAt: 1, round: 1, votes: { [A]: 'quick' }, wins: {} };
	assert.equal(redactGameState(MS_GAME_ID, vote as unknown as Record<string, unknown>).phase, 'vote');
	const chess = redactGameState('bnji.chess', { seats: { white: 'x' } } as unknown as Record<string, unknown>);
	assert.equal('seats' in chess, true, 'games without a redactor broadcast unchanged');
});

test('clock guards: placement deadline force-starts the race; a vanishing roster aborts to lobby', () => {
	let state = act('ms_start', {}, { currentState: {}, now: 1000, isHost: true });
	state = act('ms_sync', {}, { currentState: state, now: 6000 });
	assert.equal(state.phase, 'place');
	// Nobody readies; at +60s the race starts anyway with whatever is placed.
	const raced = act('ms_sync', {}, { currentState: state, now: state.phaseAt + 60_001 });
	assert.equal(raced.phase, 'race');

	// A one-player roster at vote close cancels the round back to the lobby.
	const loneVote = act('ms_start', {}, { currentState: {}, now: 100, isHost: true });
	const aborted = act('ms_sync', {}, { currentState: loneVote, now: 5_100, members: [{ memberId: A, principalHash: HASH_A }] });
	assert.equal(aborted.phase, 'lobby', 'a one-player roster cancels the round');
});

test('start guards: host-only while a host exists, two members minimum, hostless rooms allow anyone', () => {
	const oneMember = denied('ms_start', {}, { currentState: {}, now: 1000, members: [{ memberId: A, principalHash: HASH_A }], isHost: true });
	assert.equal(oneMember, 'need_more_players');
	const notHost = denied('ms_start', {}, { currentState: {}, now: 1000, actorId: B, isHost: false });
	assert.equal(notHost, 'host_only');
	const hostless = act('ms_start', {}, { currentState: {}, now: 1000, actorId: B, isHost: false, hasHost: false });
	assert.equal(hostless.phase, 'vote');
	assert.equal(denied('ms_start', {}, { currentState: hostless, now: 1100, isHost: true }), 'wrong_phase');
});

test('corrupt stored state and unknown actions are denied fail-closed', () => {
	assert.equal(denied('ms_sync', {}, { currentState: { phase: 'vote' }, now: 1 }), 'state_corrupt');
	assert.equal(denied('ms_warp', {}, { currentState: {}, now: 1 }), 'unknown_action');
});

test('round-win attestation matches only the exact winner and round', () => {
	const results: MsRoomState = {
		phase: 'results', phaseAt: 9000, round: 4, difficulty: 'hard', roster: [A, B],
		wins: { [A]: 1 },
		results: { round: 4, difficulty: 'hard', winner: A, winnerHash: HASH_A, reason: 'clear' },
	};
	const state = results as unknown as Record<string, unknown>;
	assert.deepEqual(verifyRoundWin(MS_GAME_ID, state, { principalHash: HASH_A, round: 4 }), { ok: true, mode: 'hard' });
	assert.deepEqual(verifyRoundWin(MS_GAME_ID, state, { principalHash: HASH_B, round: 4 }), { ok: false });
	assert.deepEqual(verifyRoundWin(MS_GAME_ID, state, { principalHash: HASH_A, round: 3 }), { ok: false });
	assert.equal(verifyRoundWin(MS_GAME_ID, { phase: 'nope' }, { principalHash: HASH_A, round: 4 }), null, 'corrupt state cannot attest');
});

test('score verifier: attested wins increment, every other claim fails closed', async () => {
	const { getScoreVerifier } = await import('../src/server/score-verifiers');
	const verifier = getScoreVerifier(MS_GAME_ID);
	assert.ok(verifier, 'minesweeper verifier registered on import');
	const base = { gameId: MS_GAME_ID, modeId: 'quick', score: 0, tieBreak: null, displayName: 'Duel Dana', idempotencyKey: 'ms-claim-abcdef12' };
	const player = { sessionId: 'a'.repeat(32), playerId: null };
	const proof = { roomCode: 'AbCdEfGhIjKlMnOpQrStUv', round: 3 };

	const calls: { principal: string | null; body: unknown } = { principal: null, body: null };
	const runtime = {
		GAME_ROOMS: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (input: RequestInfo | URL) => {
					const request = new Request(input);
					calls.principal = request.headers.get('x-bnji-verified-principal');
					calls.body = await request.json();
					return new Response(JSON.stringify({ ok: true, mode: 'quick' }), { status: 200, headers: { 'content-type': 'application/json' } });
				},
			}),
		},
	};

	const accepted = await verifier!({ ...base, proof }, player, runtime);
	assert.deepEqual(accepted, { score: 1, tieBreak: null, increment: true });
	assert.equal(calls.principal, `guest:${player.sessionId}`);
	assert.deepEqual(calls.body, { gameId: MS_GAME_ID, round: 3 });

	// Attestation says a different difficulty than the claim's mode.
	const wrongMode = await verifier!({ ...base, modeId: 'hard', proof }, player, runtime);
	assert.equal(wrongMode, null);

	const rejectedRuntime = {
		GAME_ROOMS: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: false, error: 'not_winner' }), { status: 404 }) }),
		},
	};
	assert.equal(await verifier!({ ...base, proof }, player, rejectedRuntime), null);
	const throwingRuntime = {
		GAME_ROOMS: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: async () => { throw new Error('offline'); } }),
		},
	};
	assert.equal(await verifier!({ ...base, proof }, player, throwingRuntime), null);
	assert.equal(await verifier!({ ...base, proof }, player, undefined), null, 'fail closed without a room namespace');

	assert.equal(await verifier!({ ...base, proof: null }, player, runtime), null);
	assert.equal(await verifier!({ ...base, proof: { roomCode: 'short', round: 1 } }, player, runtime), null);
	assert.equal(await verifier!({ ...base, proof: { roomCode: proof.roomCode, round: 0 } }, player, runtime), null);
	assert.equal(await verifier!({ ...base, proof: { roomCode: proof.roomCode, round: 1.5 } }, player, runtime), null);
	assert.equal(await verifier!({ ...base, modeId: 'default', proof }, player, runtime), null, 'mode must be a difficulty');
});
