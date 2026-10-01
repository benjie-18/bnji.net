/**
 * `bnji.pvp-minesweeper` server adapters — three registered seams in one
 * module (imported by the GameRoom DO for rules, by the scores route for
 * claims; ES-module caching makes duplicate registration impossible):
 *
 *   1. Room game-action handler: the phase machine lives here and only here.
 *      Lobby → 5s vote → placement (each player designs every OTHER player's
 *      board within an exact per-author budget) → race (reveals stay local)
 *      → 5s results → next vote. The DO supplies the trusted clock, member
 *      list and actor identity; nothing client-sent is taken on faith.
 *
 *   2. Round-win verifier: the scores route asks the room DO whether a
 *      principal really won round N — rooms only live 2 hours, so the
 *      attestation happens while the room is fresh.
 *
 *   3. Score verifier: proof = { roomCode, round }; after DO attestation the
 *      route increments the verified win count for that difficulty (mode).
 *
 * Leaderboard contract: modes `quick` | `normal` | `hard`; score = attested
 * wins on that difficulty (each +1 requires a real round win); tie-break null.
 */
import { registerGameActionHandler, registerGameStateRedactor, registerRoundWinVerifier, type GameActionDecision, type GameActionRequest } from '../room-authority';
import { registerScoreVerifier, type ScoreRuntime } from '../score-verifiers';
import { roomNamespace } from '../game-room-gateway';
import { MS_DIFFICULTY_ORDER, MS_PLACE_MS, MS_RESULTS_MS, MS_VOTE_MS, msContributorBudget, msCountMines, msDecodeBitset, msDifficulty, msEncodeBitset, msNumbers, msReplayReveals, msSpec, msUnionBitsets, type MinesweeperDifficulty } from '../../game/minesweeper-rules';

export const MS_GAME_ID = 'bnji.pvp-minesweeper';
export const MS_MODES: readonly MinesweeperDifficulty[] = MS_DIFFICULTY_ORDER;
const MEMBER_PATTERN = /^[a-f0-9]{24}$/;
/** Majority order when votes tie: normal first, then quick, then hard. */
const VOTE_PREFERENCE: readonly MinesweeperDifficulty[] = ['normal', 'quick', 'hard'];

export type MsPhase = 'lobby' | 'vote' | 'place' | 'race' | 'results';
export type MsResults = {
	round: number;
	difficulty: MinesweeperDifficulty;
	winner: string | null;
	winnerHash: string | null;
	reason: 'clear' | 'elimination' | 'draw';
	/** Final-round reveal: the authored field for every board (target index → union bitset). */
	mineCells?: Record<string, string>;
};
export type MsRoomState = {
	phase: MsPhase;
	/** DO-clock timestamp of the current phase start (authority-stamped only). */
	phaseAt: number;
	round: number;
	votes?: Record<string, MinesweeperDifficulty>;
	difficulty?: MinesweeperDifficulty;
	roster?: string[];
	ready?: string[];
	/** roster-index → author roster-index → minefield bitset (compact wire form). */
	placements?: Record<string, Record<string, string>>;
	alive?: string[];
	/** Per-player click lists while racing (stripped at results; visible to the room like any progress meter). */
	clicks?: Record<string, number[]>;
	wins?: Record<string, number>;
	results?: MsResults;
};

export function initialMsRoomState(): MsRoomState {
	return { phase: 'lobby', phaseAt: 0, round: 0, wins: {} };
}

function isIndexKey(value: string): boolean {
	return /^[0-7]$/.test(value);
}

/** Defensive read of stored state: rebuild canonical, drop unknown keys, fail closed on garbage. */
export function normalizeMsRoomState(raw: unknown): { ok: true; state: MsRoomState } | { ok: false } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
	const value = raw as Record<string, unknown>;
	if (Object.keys(value).length === 0) return { ok: true, state: initialMsRoomState() };
	const phase = value.phase;
	if (phase !== 'lobby' && phase !== 'vote' && phase !== 'place' && phase !== 'race' && phase !== 'results') return { ok: false };
	if (!Number.isSafeInteger(value.phaseAt) || Number(value.phaseAt) < 0) return { ok: false };
	if (!Number.isSafeInteger(value.round) || Number(value.round) < 0) return { ok: false };
	const state: MsRoomState = { phase, phaseAt: Number(value.phaseAt), round: Number(value.round) };

	if (value.votes !== undefined) {
		if (phase !== 'vote') return { ok: false };
		if (!value.votes || typeof value.votes !== 'object' || Array.isArray(value.votes)) return { ok: false };
		const votes: Record<string, MinesweeperDifficulty> = {};
		for (const [member, choice] of Object.entries(value.votes as Record<string, unknown>)) {
			if (!MEMBER_PATTERN.test(member)) return { ok: false };
			const difficulty = msDifficulty(choice);
			if (!difficulty) return { ok: false };
			votes[member] = difficulty;
		}
		state.votes = votes;
	} else if (phase === 'vote') {
		return { ok: false };
	}

	const needsRound = phase === 'place' || phase === 'race' || phase === 'results';
	const difficulty = msDifficulty(value.difficulty);
	if (needsRound && !difficulty) return { ok: false };
	if (difficulty) state.difficulty = difficulty;

	if (value.roster !== undefined) {
		if (!Array.isArray(value.roster) || value.roster.length < 2 || value.roster.length > 8) return { ok: false };
		const roster: string[] = [];
		for (const member of value.roster) {
			if (typeof member !== 'string' || !MEMBER_PATTERN.test(member) || roster.includes(member)) return { ok: false };
			roster.push(member);
		}
		state.roster = roster;
	} else if (needsRound) {
		return { ok: false };
	}
	if (needsRound && !state.roster) return { ok: false };

	if (value.ready !== undefined) {
		if (phase !== 'place') return { ok: false };
		if (!Array.isArray(value.ready)) return { ok: false };
		const ready: string[] = [];
		for (const member of value.ready) {
			if (typeof member !== 'string' || !state.roster?.includes(member) || ready.includes(member)) return { ok: false };
			ready.push(member);
		}
		state.ready = ready;
	}

	if (value.placements !== undefined) {
		if (phase !== 'place' && phase !== 'race') return { ok: false };
		if (!value.placements || typeof value.placements !== 'object' || Array.isArray(value.placements)) return { ok: false };
		if (!state.roster || !difficulty) return { ok: false };
		const cellCount = msSpec(difficulty).size * msSpec(difficulty).size;
		const placements: Record<string, Record<string, string>> = {};
		for (const [targetKey, authorsRaw] of Object.entries(value.placements as Record<string, unknown>)) {
			if (!isIndexKey(targetKey) || Number(targetKey) >= state.roster.length) return { ok: false };
			if (!authorsRaw || typeof authorsRaw !== 'object' || Array.isArray(authorsRaw)) return { ok: false };
			const target = Number(targetKey);
			const authors = state.roster.filter((_, index) => index !== target);
			const fields: Record<string, string> = {};
			for (const [authorKey, bitset] of Object.entries(authorsRaw as Record<string, unknown>)) {
				if (!isIndexKey(authorKey) || Number(authorKey) >= state.roster.length || Number(authorKey) === target) return { ok: false };
				if (typeof bitset !== 'string') return { ok: false };
				const authorIndex = authors.indexOf(state.roster![Number(authorKey)]!);
				if (authorIndex < 0) return { ok: false };
				const budget = msContributorBudget(msSpec(difficulty).mines, authorIndex, authors.length);
				if (bitset === '') {
					if (budget !== 0) return { ok: false };
				} else {
					const field = msDecodeBitset(bitset, cellCount);
					if (!field || msCountMines(field) !== budget) return { ok: false };
				}
				fields[authorKey] = bitset;
			}
			placements[targetKey] = fields;
		}
		state.placements = placements;
	}

	if (value.clicks !== undefined) {
		if (phase !== 'race') return { ok: false };
		if (!value.clicks || typeof value.clicks !== 'object' || Array.isArray(value.clicks)) return { ok: false };
		if (!state.roster || !difficulty) return { ok: false };
		const cellCount = msSpec(difficulty).size * msSpec(difficulty).size;
		const clicks: Record<string, number[]> = {};
		for (const [member, cellsRaw] of Object.entries(value.clicks as Record<string, unknown>)) {
			if (!state.roster.includes(member)) return { ok: false };
			if (!Array.isArray(cellsRaw)) return { ok: false };
			const cells: number[] = [];
			for (const cell of cellsRaw) {
				if (!Number.isSafeInteger(cell) || Number(cell) < 0 || Number(cell) >= cellCount) return { ok: false };
				cells.push(Number(cell));
			}
			clicks[member] = cells;
		}
		state.clicks = clicks;
	}

	if (value.alive !== undefined) {
		if (phase !== 'race') return { ok: false };
		if (!Array.isArray(value.alive)) return { ok: false };
		const alive: string[] = [];
		for (const member of value.alive) {
			if (typeof member !== 'string' || !state.roster?.includes(member) || alive.includes(member)) return { ok: false };
			alive.push(member);
		}
		state.alive = alive;
	} else if (phase === 'race') {
		return { ok: false };
	}

	if (value.wins !== undefined) {
		if (!value.wins || typeof value.wins !== 'object' || Array.isArray(value.wins)) return { ok: false };
		const wins: Record<string, number> = {};
		for (const [member, count] of Object.entries(value.wins as Record<string, unknown>)) {
			if (!MEMBER_PATTERN.test(member)) return { ok: false };
			if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 1_000_000) return { ok: false };
			wins[member] = Number(count);
		}
		state.wins = wins;
	} else {
		state.wins = {};
	}

	if (value.results !== undefined) {
		if (phase !== 'results') return { ok: false };
		const results = value.results as Record<string, unknown>;
		if (!results || typeof results !== 'object' || Array.isArray(results)) return { ok: false };
		const round = results.round;
		const resultDifficulty = msDifficulty(results.difficulty);
		const winner = results.winner;
		const winnerHash = results.winnerHash;
		const reason = results.reason;
		if (!Number.isSafeInteger(round) || Number(round) !== state.round) return { ok: false };
		if (!resultDifficulty || resultDifficulty !== difficulty) return { ok: false };
		if (winner !== null && (typeof winner !== 'string' || !MEMBER_PATTERN.test(winner))) return { ok: false };
		if (winnerHash !== null && (typeof winnerHash !== 'string' || !/^[a-f0-9]{64}$/.test(winnerHash))) return { ok: false };
		if (reason !== 'clear' && reason !== 'elimination' && reason !== 'draw') return { ok: false };
		if (reason !== 'draw' && (winner === null || winnerHash === null)) return { ok: false };
		state.results = { round: Number(round), difficulty: resultDifficulty, winner, winnerHash, reason };
		const mineCellsRaw = results.mineCells;
		if (mineCellsRaw !== undefined) {
			if (!mineCellsRaw || typeof mineCellsRaw !== 'object' || Array.isArray(mineCellsRaw)) return { ok: false };
			if (!state.roster) return { ok: false };
			const mineCells: Record<string, string> = {};
			for (const [target, bitset] of Object.entries(mineCellsRaw as Record<string, unknown>)) {
				if (!isIndexKey(target) || Number(target) >= state.roster.length) return { ok: false };
				if (typeof bitset !== 'string') return { ok: false };
				mineCells[target] = bitset;
			}
			state.results.mineCells = mineCells;
		}
	} else if (phase === 'results') {
		return { ok: false };
	}

	return { ok: true, state };
}

// ------------------------------------------------------------ phase machine

function toLobby(state: MsRoomState, now: number): MsRoomState {
	return { phase: 'lobby', phaseAt: now, round: state.round, wins: state.wins ?? {} };
}
function tally(votes: Record<string, MinesweeperDifficulty> | undefined): MinesweeperDifficulty {
	if (!votes) return 'normal';
	const counts = new Map<MinesweeperDifficulty, number>();
	for (const choice of Object.values(votes)) counts.set(choice, (counts.get(choice) ?? 0) + 1);
	let best: MinesweeperDifficulty | null = null;
	let bestCount = -1;
	for (const candidate of VOTE_PREFERENCE) {
		const count = counts.get(candidate) ?? 0;
		if (count > bestCount) { best = candidate; bestCount = count; }
	}
	return best ?? 'normal';
}
function closeVote(state: MsRoomState, members: Array<{ memberId: string }>, now: number): MsRoomState {
	const roster = members.map((member) => member.memberId).sort();
	if (roster.length < 2) return toLobby(state, now);
	return {
		phase: 'place',
		phaseAt: now,
		round: state.round,
		difficulty: tally(state.votes),
		roster,
		ready: [],
		placements: {},
		wins: state.wins ?? {},
	};
}
function startRace(state: MsRoomState, now: number): MsRoomState {
	return {
		phase: 'race',
		phaseAt: now,
		round: state.round,
		difficulty: state.difficulty!,
		roster: state.roster!,
		placements: state.placements ?? {},
		alive: [...state.roster!],
		wins: state.wins ?? {},
		clicks: {},
	};
}
function enterResults(state: MsRoomState, now: number, results: MsResults, winnerTally: boolean): MsRoomState {
	const wins = { ...(state.wins ?? {}) };
	if (winnerTally && results.winner) wins[results.winner] = (wins[results.winner] ?? 0) + 1;
	// 5s results screen reveals every authored minefield (union per board).
	const difficulty = state.difficulty!;
	const spec = msSpec(difficulty);
	const cellCount = spec.size * spec.size;
	const mineCells: Record<string, string> = {};
	for (const [target, authors] of Object.entries(state.placements ?? {})) {
		const decoded: Uint8Array[] = [];
		for (const bitset of Object.values(authors)) {
			const field = msDecodeBitset(bitset, cellCount);
			if (field) decoded.push(field);
		}
		mineCells[target] = msEncodeBitset(msUnionBitsets(decoded));
	}
	return {
		phase: 'results',
		phaseAt: now,
		round: state.round,
		difficulty,
		roster: state.roster!,
		wins,
		results: Object.keys(mineCells).length > 0 ? { ...results, mineCells } : results,
	};
}

/** Lazy, clock-driven transitions applied before every action (and by `ms_sync`). */
export function msAdvance(state: MsRoomState, now: number, members: Array<{ memberId: string }>): MsRoomState {
	if (state.phase === 'vote' && now >= state.phaseAt + MS_VOTE_MS) return closeVote(state, members, now);
	if (state.phase === 'place' && now >= state.phaseAt + MS_PLACE_MS && (state.roster?.length ?? 0) >= 2) return startRace(state, now);
	if (state.phase === 'place' && now >= state.phaseAt + MS_PLACE_MS) return toLobby(state, now);
	if (state.phase === 'results' && now >= state.phaseAt + MS_RESULTS_MS) {
		return { phase: 'vote', phaseAt: now, round: state.round + 1, votes: {}, wins: state.wins ?? {} };
	}
	return state;
}

function deny(error: string): GameActionDecision {
	return { allowed: false, error };
}
function allow(state: MsRoomState, reply?: Record<string, unknown>): GameActionDecision {
	return reply ? { allowed: true, state, reply } : { allowed: true, state };
}

/** The actor's private view of their own incoming field: union + adjacency digits + own reveals. */
function ownFieldView(state: MsRoomState, ownIdx: number): Record<string, unknown> | null {
	if (state.phase !== 'race' || !state.difficulty) return null;
	const spec = msSpec(state.difficulty);
	const cellCount = spec.size * spec.size;
	const decoded: Uint8Array[] = [];
	for (const bitset of Object.values(state.placements?.[String(ownIdx)] ?? {})) {
		const field = msDecodeBitset(bitset, cellCount);
		if (!field) return null;
		decoded.push(field);
	}
	const mines = msUnionBitsets(decoded);
	const numbers = msNumbers(mines, spec.size);
	return {
		size: spec.size,
		revealed: [...(state.clicks?.[state.roster![ownIdx]!] ?? [])],
		numbers: Array.from(numbers),
	};
}

function budgetFor(roster: string[], ownIdx: number, target: number, difficulty: MinesweeperDifficulty): number {
	const authors = roster.filter((_, index) => index !== target);
	const authorIndex = authors.indexOf(roster[ownIdx]!);
	return msContributorBudget(msSpec(difficulty).mines, authorIndex, authors.length);
}

export function msRoomGameAction(request: GameActionRequest): GameActionDecision {
	const normalized = normalizeMsRoomState(request.currentState);
	if (!normalized.ok) return deny('state_corrupt');
	const state = msAdvance(normalized.state, request.now, request.members);

	switch (request.action) {
		case 'ms_sync': {
			if (state.phase === 'race') {
				const ownIdx = state.roster?.indexOf(request.actor.memberId) ?? -1;
				if (ownIdx < 0) return deny('not_in_round');
				const view = ownFieldView(state, ownIdx);
				if (!view) return deny('state_corrupt');
				return allow(state, view);
			}
			return allow(state);
		}

		case 'ms_start': {
			if (state.phase !== 'lobby') return deny('wrong_phase');
			const roster = request.members.map((member) => member.memberId).sort();
			if (roster.length < 2) return deny('need_more_players');
			if (!request.actor.isHost && request.hasHost) return deny('host_only');
			return allow({ phase: 'vote', phaseAt: request.now, round: state.round + 1, votes: {}, wins: state.wins ?? {} });
		}

		case 'ms_vote': {
			if (state.phase !== 'vote') return deny('wrong_phase');
			const choice = msDifficulty(request.payload.v);
			if (!choice) return deny('invalid_vote');
			return allow({ ...state, votes: { ...(state.votes ?? {}), [request.actor.memberId]: choice } });
		}

		case 'ms_place': {
			if (state.phase !== 'place') return deny('wrong_phase');
			const roster = state.roster!;
			const difficulty = state.difficulty!;
			const ownIdx = roster.indexOf(request.actor.memberId);
			if (ownIdx < 0) return deny('not_in_round');
			const cellCount = msSpec(difficulty).size * msSpec(difficulty).size;
			const placements: Record<string, Record<string, string>> = {};
			for (const [target, authors] of Object.entries(state.placements ?? {})) placements[target] = { ...authors };
			let ready = [...(state.ready ?? [])];

			const cells = request.payload.c;
			if (cells !== undefined) {
				if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return deny('bad_mine_board');
				for (const [targetKey, bitset] of Object.entries(cells as Record<string, unknown>)) {
					if (!isIndexKey(targetKey) || Number(targetKey) >= roster.length || Number(targetKey) === ownIdx) return deny('bad_mine_board');
					if (typeof bitset !== 'string') return deny('bad_mine_board');
					const target = Number(targetKey);
					const budget = budgetFor(roster, ownIdx, target, difficulty);
					if (budget === 0) {
						if (bitset !== '') return deny('bad_mine_count');
					} else {
						const field = msDecodeBitset(bitset, cellCount);
						if (!field) return deny('bad_mine_board');
						if (msCountMines(field) !== budget) return deny('bad_mine_count');
						placements[targetKey] = { ...(placements[targetKey] ?? {}), [String(ownIdx)]: msEncodeBitset(field) };
					}
				}
			}

			if (request.payload.r === 1) {
				for (let target = 0; target < roster.length; target += 1) {
					if (target === ownIdx) continue;
					if (budgetFor(roster, ownIdx, target, difficulty) === 0) continue;
					if (!placements[String(target)]?.[String(ownIdx)]) return deny('placements_missing');
				}
				if (!ready.includes(request.actor.memberId)) ready = [...ready, request.actor.memberId];
			}

			const next: MsRoomState = { ...state, placements, ready };
			const allReady = roster.length >= 2 && roster.every((member) => ready.includes(member));
			return allow(allReady ? startRace(next, request.now) : next);
		}

		case 'ms_finish': {
			if (state.phase !== 'race') return deny('wrong_phase');
			const roster = state.roster!;
			const difficulty = state.difficulty!;
			const alive = state.alive ?? [];
			if (!alive.includes(request.actor.memberId)) return deny('not_racing');
			const ownIdx = roster.indexOf(request.actor.memberId);
			if (ownIdx < 0) return deny('not_in_round');
			const authorFields = Object.values(state.placements?.[String(ownIdx)] ?? {});
			const decoded: Uint8Array[] = [];
			const cellCount = msSpec(difficulty).size * msSpec(difficulty).size;
			for (const bitset of authorFields) {
				const field = msDecodeBitset(bitset, cellCount);
				if (!field) return deny('state_corrupt');
				decoded.push(field);
			}
			const mines = msUnionBitsets(decoded);
			const clicks = request.payload.c;
			if (!Array.isArray(clicks)) return deny('bad_clicks');
			const clickList: number[] = [];
			for (const cell of clicks) {
				if (!Number.isSafeInteger(cell) || Number(cell) < 0 || Number(cell) >= cellCount) return deny('bad_clicks');
				if (clickList.includes(Number(cell))) return deny('bad_clicks');
				clickList.push(Number(cell));
			}
			const replay = msReplayReveals(mines, msSpec(difficulty).size, clickList);
			if (replay.ok) {
				return allow(enterResults(state, request.now, {
					round: state.round,
					difficulty,
					winner: request.actor.memberId,
					winnerHash: request.actor.principalHash,
					reason: 'clear',
				}, true));
			}
			if (replay.error === 'incomplete') {
				// Progress ack: persist the actor's click list; the private reply
				// carries their revealed set + adjacency digits for their own field.
				const next: MsRoomState = {
					...state,
					clicks: { ...(state.clicks ?? {}), [request.actor.memberId]: clickList },
				};
				const view = ownFieldView(next, ownIdx);
				if (!view) return deny('state_corrupt');
				return allow(next, view);
			}
			return deny(replay.error);
		}

		case 'ms_die': {
			if (state.phase !== 'race') return deny('wrong_phase');
			const alive = state.alive ?? [];
			if (!alive.includes(request.actor.memberId)) return deny('not_racing');
			const rest = alive.filter((member) => member !== request.actor.memberId);
			if (rest.length > 1) return allow({ ...state, alive: rest });
			const winner = rest[0] ?? null;
			const winnerHash = winner ? request.members.find((member) => member.memberId === winner)?.principalHash ?? null : null;
			if (winner && winnerHash) {
				return allow(enterResults(state, request.now, {
					round: state.round,
					difficulty: state.difficulty!,
					winner,
					winnerHash,
					reason: 'elimination',
				}, true));
			}
			// Defensive: a last standing without a resolvable hash cannot score.
			return allow(enterResults(state, request.now, {
				round: state.round,
				difficulty: state.difficulty!,
				winner: winner,
				winnerHash: null,
				reason: winner ? 'elimination' : 'draw',
			}, false));
		}

		default:
			return deny('unknown_action');
	}
}

// ------------------------------------------------------- registered seams

registerGameActionHandler(MS_GAME_ID, msRoomGameAction);

/** Never broadcast incoming minefields — the recipient must not see them before the results. */
registerGameStateRedactor(MS_GAME_ID, (state) => {
	const value = { ...state };
	if (value.phase === 'place' || value.phase === 'race') delete value.placements;
	return value;
});

/** The DO-side attestation: did this principal win exactly this round? */
registerRoundWinVerifier(MS_GAME_ID, (rawState, request) => {
	const normalized = normalizeMsRoomState(rawState);
	if (!normalized.ok) return null;
	const results = normalized.state.results;
	if (!results || results.round !== request.round) return { ok: false };
	if (!results.winnerHash || results.winnerHash !== request.principalHash) return { ok: false };
	return { ok: true, mode: results.difficulty };
});

registerScoreVerifier(MS_GAME_ID, async (claim, player, runtime?: ScoreRuntime) => {
	const mode = msDifficulty(claim.modeId);
	if (!mode) return null;
	const proof = claim.proof as { roomCode?: unknown; round?: unknown } | null;
	if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
	if (typeof proof.roomCode !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(proof.roomCode)) return null;
	if (!Number.isSafeInteger(proof.round) || Number(proof.round) < 1) return null;
	const namespace = roomNamespace(runtime?.GAME_ROOMS);
	if (!namespace) return null;
	const principal = player.playerId ? `player:${player.playerId}` : `guest:${player.sessionId}`;
	let response: Response;
	try {
		const stub = namespace.get(namespace.idFromName(proof.roomCode));
		response = await stub.fetch(new Request('https://room/game/verify_win', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-bnji-verified-principal': principal },
			body: JSON.stringify({ gameId: MS_GAME_ID, round: Number(proof.round) }),
		}));
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const body = await response.json().catch(() => null) as { ok?: unknown; mode?: unknown } | null;
	if (!body || body.ok !== true || body.mode !== mode) return null;
	// Route-side verified increment: +1 wins on this difficulty.
	return { score: 1, tieBreak: null, increment: true };
});
