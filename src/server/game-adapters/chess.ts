/**
 * `bnji.chess` server adapters — the first registered game on both seams.
 *
 *   Room state authority: every board change is replayed server-side from
 *   move one inside the GameRoom Durable Object; the DO persists only the
 *   state this module returns, never a client's word. Seats (member → colour)
 *   are claimed on the first move and then enforce whose turn it is.
 *
 *   Score verifier: a leaderboard claim is a full game record. The verifier
 *   replays it with the same engine and only credits a genuine checkmate of
 *   the claimed colour; the score is recomputed server-side.
 *
 * Importing this module registers both. It is imported once per isolate by
 * `game-room-do.ts` (authority, inside the DO) and by the scores route
 * (verifier, inside the Worker). ES-module caching makes duplicate
 * registration impossible without an explicit second specifier.
 *
 * Mode contract: `fastest-mate` — score = 100000 − 100·plies (fewer plies to
 * mate scores higher), tie-break = plies ascending. Resignations end room
 * games but are never leaderboard-eligible: a resign cannot be replayed.
 */
import { registerRoomStateAuthority } from '../room-authority';
import { registerScoreVerifier } from '../score-verifiers';
import {
	CHESS_MAX_PROOF_PLIES,
	CHESS_MOVE_PATTERN,
	applyMove,
	fastestMateScore,
	outcomeOf,
	parseCoordinateMove,
	positionKey,
	replayChess,
	replayPrefix,
	type ChessColor,
} from '../../game/chess-rules';

export const CHESS_GAME_ID = 'bnji.chess';
export const CHESS_MODE_ID = 'fastest-mate';
export const CHESS_MAX_ROOM_PLIES = 450;

const MEMBER_PATTERN = /^[a-f0-9]{24}$/;
export type ChessRoomSeat = 'white' | 'black';
export type ChessRoomState = {
	seats: Record<ChessRoomSeat, string | null>;
	moves: string[];
	turn: ChessColor;
	status: 'active' | 'over';
	over?: { winner: ChessRoomSeat | 'draw'; reason: 'checkmate' | 'stalemate' | 'fifty' | 'threefold' | 'insufficient' | 'resign' };
};

function colorSeat(color: ChessColor): ChessRoomSeat {
	return color === 'w' ? 'white' : 'black';
}

function winnerFromOutcome(winner: ChessColor | 'draw'): ChessRoomSeat | 'draw' {
	return winner === 'draw' ? 'draw' : colorSeat(winner);
}

/** Canonical empty state — a fresh room's `state_json` is `{}`. */
export function initialChessRoomState(): ChessRoomState {
	return { seats: { white: null, black: null }, moves: [], turn: 'w', status: 'active' };
}

/**
 * Read stored state defensively. Anything unrecognised collapses to the
 * initial state only when the store is untouched (`{}`); a corrupt non-empty
 * state fails closed via the caller.
 */
export function normalizeChessRoomState(raw: unknown): { ok: true; state: ChessRoomState } | { ok: false } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
	const value = raw as Record<string, unknown>;
	if (Object.keys(value).length === 0) return { ok: true, state: initialChessRoomState() };
	const seatsRaw = value.seats;
	if (!seatsRaw || typeof seatsRaw !== 'object' || Array.isArray(seatsRaw)) return { ok: false };
	const seatsSource = seatsRaw as Record<string, unknown>;
	const seats = { white: null, black: null } as Record<ChessRoomSeat, string | null>;
	for (const seat of ['white', 'black'] as const) {
		const member = seatsSource[seat];
		if (member === null) continue;
		if (typeof member === 'string' && MEMBER_PATTERN.test(member)) seats[seat] = member;
		else return { ok: false };
	}
	if (!Array.isArray(value.moves) || value.moves.length > CHESS_MAX_ROOM_PLIES) return { ok: false };
	const moves: string[] = [];
	for (const move of value.moves) {
		if (typeof move !== 'string' || !CHESS_MOVE_PATTERN.test(move)) return { ok: false };
		moves.push(move);
	}
	const turn = value.turn;
	if (turn !== 'w' && turn !== 'b') return { ok: false };
	const status = value.status;
	if (status !== 'active' && status !== 'over') return { ok: false };
	const state: ChessRoomState = { seats, moves, turn, status };
	if (status === 'over') {
		const over = value.over;
		if (!over || typeof over !== 'object' || Array.isArray(over)) return { ok: false };
		const winner = (over as Record<string, unknown>).winner;
		const reason = (over as Record<string, unknown>).reason;
		if (winner !== 'white' && winner !== 'black' && winner !== 'draw') return { ok: false };
		if (reason !== 'checkmate' && reason !== 'stalemate' && reason !== 'fifty' &&
			reason !== 'threefold' && reason !== 'insufficient' && reason !== 'resign') return { ok: false };
		state.over = { winner, reason };
	}
	return { ok: true, state };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function seatsEqual(a: Record<ChessRoomSeat, string | null>, b: Record<ChessRoomSeat, string | null>): boolean {
	return a.white === b.white && a.black === b.black;
}

/**
 * The room authority. Proposals are either `moves + [one new coordinate move]`
 * (optionally claiming an empty seat) or `moves + resign:<claimed colour>`.
 * Every path replays the record; the returned state is always canonical.
 */
export function chessRoomAuthority(transition: {
	gameId: string;
	actor: { principalHash: string; memberId: string; isHost: boolean };
	baseRevision: number;
	currentRevision: number;
	currentState: Record<string, unknown>;
	proposedState: Record<string, unknown>;
}): { allowed: true; state?: Record<string, unknown> } | { allowed: false; error?: string } {
	const current = normalizeChessRoomState(transition.currentState);
	if (!current.ok) return { allowed: false, error: 'state_corrupt' };
	const room = current.state;
	if (room.status === 'over') return { allowed: false, error: 'game_over' };
	const proposed = transition.proposedState;
	if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) return { allowed: false, error: 'bad_proposal' };
	const proposedMovesRaw = (proposed as Record<string, unknown>).moves;
	if (!isStringArray(proposedMovesRaw) || proposedMovesRaw.length > CHESS_MAX_ROOM_PLIES) return { allowed: false, error: 'bad_proposal' };
	const proposedSeatsRaw = (proposed as Record<string, unknown>).seats;
	if (!proposedSeatsRaw || typeof proposedSeatsRaw !== 'object' || Array.isArray(proposedSeatsRaw)) return { allowed: false, error: 'bad_proposal' };
	const proposedSeats = proposedSeatsRaw as Record<string, unknown>;
	const resignRaw = (proposed as Record<string, unknown>).resign;

	// Seats in the proposal must match the stored ones except for one claim by
	// the actor on an empty seat; any other drift is forged state.
	const candidateSeats: Record<ChessRoomSeat, string | null> = { white: null, black: null };
	for (const seat of ['white', 'black'] as const) {
		const member = proposedSeats[seat];
		if (member === null) candidateSeats[seat] = null;
		else if (typeof member === 'string' && MEMBER_PATTERN.test(member)) candidateSeats[seat] = member;
		else return { allowed: false, error: 'bad_seats' };
	}
	const claimedSeat: ChessRoomSeat | null = (['white', 'black'] as const).find(
		(seat) => room.seats[seat] === null && candidateSeats[seat] !== null,
	) as ChessRoomSeat | null ?? null;
	if (claimedSeat !== null) {
		if (candidateSeats[claimedSeat] !== transition.actor.memberId) return { allowed: false, error: 'bad_seats' };
		const other: ChessRoomSeat = claimedSeat === 'white' ? 'black' : 'white';
		if (candidateSeats[other] !== room.seats[other]) return { allowed: false, error: 'bad_seats' };
	} else if (!seatsEqual(candidateSeats, room.seats)) {
		return { allowed: false, error: 'bad_seats' };
	}

	const prefix = replayPrefix(room.moves);
	if (!prefix.ok) return { allowed: false, error: 'state_corrupt' };
	const sameLength = proposedMovesRaw.length === room.moves.length;
	const samePrefix = sameLength && proposedMovesRaw.every((move, index) => move === room.moves[index]);
	if (sameLength && samePrefix && resignRaw !== undefined) {
		// Resignation: the resigning colour must be the actor's own seat.
		if (resignRaw !== 'white' && resignRaw !== 'black') return { allowed: false, error: 'bad_proposal' };
		if (room.seats[resignRaw] !== transition.actor.memberId) return { allowed: false, error: 'not_your_seat' };
		if (!seatsEqual(candidateSeats, room.seats)) return { allowed: false, error: 'bad_seats' };
		const winner: ChessRoomSeat = resignRaw === 'white' ? 'black' : 'white';
		return {
			allowed: true,
			state: { ...room, status: 'over', over: { winner, reason: 'resign' } } satisfies ChessRoomState,
		};
	}
	if (proposedMovesRaw.length !== room.moves.length + 1) return { allowed: false, error: 'bad_proposal' };
	if (!proposedMovesRaw.slice(0, room.moves.length).every((move, index) => move === room.moves[index])) {
		return { allowed: false, error: 'bad_proposal' };
	}

	const moveText = proposedMovesRaw[proposedMovesRaw.length - 1];
	if (!CHESS_MOVE_PATTERN.test(moveText)) return { allowed: false, error: 'notation' };
	const move = parseCoordinateMove(moveText);
	if (!move) return { allowed: false, error: 'notation' };

	// Turn and seat: whose move is it, and is the actor entitled to play it?
	const moverColor = prefix.state.turn;
	const seat = colorSeat(moverColor);
	if (room.seats[seat] !== null && room.seats[seat] !== transition.actor.memberId) {
		return { allowed: false, error: 'not_your_turn' };
	}
	const next = applyMove(prefix.state, move);
	if (!next) return { allowed: false, error: 'illegal_move' };
	const keys = [...prefix.keys, positionKey(next)];
	const outcome = outcomeOf(next, keys);
	const moves = proposedMovesRaw.slice();
	if (moves.length > CHESS_MAX_ROOM_PLIES) return { allowed: false, error: 'move_limit' };
	const canonical: ChessRoomState = {
		seats: candidateSeats,
		moves,
		turn: next.turn,
		status: outcome.over ? 'over' : 'active',
	};
	if (outcome.over) canonical.over = { winner: winnerFromOutcome(outcome.winner), reason: outcome.reason };
	return { allowed: true, state: canonical satisfies ChessRoomState };
}

/**
 * Leaderboard verifier: the proof is the whole game. Replayed from the
 * initial position; only a terminal checkmate in the claimed colour scores.
 */
export async function chessScoreVerifier(claim: {
	gameId: string;
	modeId: string;
	score: number;
	tieBreak: number | null;
	displayName: string;
	idempotencyKey: string;
	proof: unknown;
}): Promise<{ score: number; tieBreak: number | null } | null> {
	if (claim.gameId !== CHESS_GAME_ID || claim.modeId !== CHESS_MODE_ID) return null;
	const proof = claim.proof;
	if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
	const moves = (proof as Record<string, unknown>).moves;
	const color = (proof as Record<string, unknown>).color;
	if (color !== 'white' && color !== 'black') return null;
	if (!isStringArray(moves) || moves.length === 0 || moves.length > CHESS_MAX_PROOF_PLIES) return null;
	for (const move of moves) {
		if (!CHESS_MOVE_PATTERN.test(move)) return null;
	}
	const replay = replayChess(moves);
	if (!replay.ok) return null;
	if (!replay.outcome.over || replay.outcome.reason !== 'checkmate') return null;
	const winner = replay.outcome.winner === 'draw' ? null : replay.outcome.winner;
	if (winner === null || colorSeat(winner) !== color) return null;
	return { score: fastestMateScore(moves.length), tieBreak: moves.length };
}

registerRoomStateAuthority(CHESS_GAME_ID, chessRoomAuthority);
registerScoreVerifier(CHESS_GAME_ID, chessScoreVerifier);
