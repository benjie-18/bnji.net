/**
 * Pure, isomorphic chess rules engine for `bnji.chess`.
 *
 * One implementation serves three call sites so they can never disagree:
 *   - the browser game (legal move generation, board state, outcomes),
 *   - the GameRoom authority adapter (server-authoritative replays),
 *   - the score verifier (a submitted game record is replayed from move one).
 *
 * No imports: this file must run identically in a browser bundle, a Worker
 * isolate, and a Durable Object. Moves use coordinate notation — `e2e4`,
 * promotions as `e7e8q` — which needs no disambiguation pass and is trivial
 * to validate. Promotion is auto-queen in the UI but the engine accepts any
 * legal choice so replays stay exact.
 */

export type ChessColor = 'w' | 'b';
export type ChessPiece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
/** Uppercase pieces are White; lowercase are Black; null is an empty square. */
export type ChessBoard = (string | null)[];
export type ChessOutcome =
	| { over: false }
	| { over: true; reason: 'checkmate' | 'stalemate' | 'fifty' | 'threefold' | 'insufficient'; winner: ChessColor | 'draw' };

export type EngineState = {
	board: ChessBoard;
	turn: ChessColor;
	/** Remaining castling rights, any subset of `KQkq` (White KQ, black kq). */
	castling: string;
	/** En-passant target square index, or null. */
	ep: number | null;
	/** Half-moves since the last pawn move or capture (50-move rule). */
	halfmove: number;
};

export type CoordinateMove = { from: number; to: number; promo: ChessPiece | null };
export type ReplayFailure = { ok: false; ply: number; code: 'notation' | 'illegal' | 'after_over' };
export type ReplaySuccess = {
	ok: true;
	/** One state per ply, states[0] is the position after the first move. */
	states: EngineState[];
	/** Position keys including the initial position: keys.length === moves.length + 1. */
	keys: string[];
	outcome: ChessOutcome;
	/** Side to move in the final position. */
	turn: ChessColor;
};
export type ReplayResult = ReplaySuccess | ReplayFailure;
export type PrefixResult =
	| { ok: true; state: EngineState; keys: string[]; states: EngineState[] }
	| ReplayFailure;

export const CHESS_MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
export const CHESS_MAX_PROOF_PLIES = 600;

const KNIGHT_DELTAS: ReadonlyArray<readonly [number, number]> = [
	[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const KING_DELTAS: ReadonlyArray<readonly [number, number]> = [...ORTHOGONAL, ...DIAGONAL];

export function squareToIndex(square: string): number | null {
	if (!/^[a-h][1-8]$/.test(square)) return null;
	return (square.charCodeAt(0) - 97) + (Number(square[1]) - 1) * 8;
}

export function indexToSquare(index: number): string {
	if (!Number.isInteger(index) || index < 0 || index > 63) return '';
	return `${String.fromCharCode(97 + (index & 7))}${(index >> 3) + 1}`;
}

export function pieceColor(piece: string | null): ChessColor | null {
	if (!piece) return null;
	return piece === piece.toUpperCase() ? 'w' : 'b';
}

function inBounds(file: number, rank: number): boolean {
	return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

export function initialChessState(): EngineState {
	const back = 'rnbqkbnr';
	const board: ChessBoard = new Array(64).fill(null);
	for (let file = 0; file < 8; file += 1) {
		board[file] = back[file].toUpperCase();
		board[8 + file] = 'P';
		board[48 + file] = 'p';
		board[56 + file] = back[file];
	}
	return { board, turn: 'w', castling: 'KQkq', ep: null, halfmove: 0 };
}

/** Minimal FEN loader for tests and engine self-checks. */
export function parseFen(fen: string): EngineState | null {
	const parts = fen.trim().split(/\s+/);
	if (parts.length < 4) return null;
	const rows = parts[0].split('/');
	if (rows.length !== 8) return null;
	const board: ChessBoard = new Array(64).fill(null);
	// FEN rows run from rank 8 down to rank 1.
	for (let row = 0; row < 8; row += 1) {
		const rank = 7 - row;
		let file = 0;
		for (const char of rows[row]) {
			if (/[1-8]/.test(char)) {
				file += Number(char);
			} else if (/[prnbqkPRNBQK]/.test(char)) {
				if (file > 7) return null;
				board[rank * 8 + file] = char;
				file += 1;
			} else {
				return null;
			}
		}
		if (file !== 8) return null;
	}
	if (parts[1] !== 'w' && parts[1] !== 'b') return null;
	const castling = parts[2] === '-' ? '' : parts[2];
	if (!/^[KQkq]*$/.test(castling)) return null;
	let ep: number | null = null;
	if (parts[3] !== '-') {
		ep = squareToIndex(parts[3]);
		if (ep === null) return null;
	}
	return { board, turn: parts[1], castling, ep, halfmove: Number(parts[4] ?? '0') || 0 };
}

export function parseCoordinateMove(text: string): CoordinateMove | null {
	if (typeof text !== 'string' || !CHESS_MOVE_PATTERN.test(text)) return null;
	const from = squareToIndex(text.slice(0, 2));
	const to = squareToIndex(text.slice(2, 4));
	if (from === null || to === null || from === to) return null;
	const promoText = text.slice(4);
	const promo = promoText ? (promoText as ChessPiece) : null;
	return { from, to, promo };
}

export function formatCoordinateMove(move: CoordinateMove): string {
	const promo = move.promo ? move.promo.toLowerCase() : '';
	return `${indexToSquare(move.from)}${indexToSquare(move.to)}${promo}`;
}

export function findKing(board: ChessBoard, color: ChessColor): number | null {
	const king = color === 'w' ? 'K' : 'k';
	for (let index = 0; index < 64; index += 1) {
		if (board[index] === king) return index;
	}
	return null;
}

/** Is `square` attacked by any piece of `by`? Drives check tests and castling gates. */
export function isSquareAttacked(board: ChessBoard, square: number, by: ChessColor): boolean {
	const file = square & 7;
	const rank = square >> 3;
	// Pawns: a white pawn on (f±1, r−1) attacks (f, r); black from (f±1, r+1).
	const pawn = by === 'w' ? 'P' : 'p';
	const pawnSourceRank = rank + (by === 'w' ? -1 : 1);
	for (const df of [-1, 1]) {
		if (inBounds(file + df, pawnSourceRank) && board[pawnSourceRank * 8 + file + df] === pawn) return true;
	}
	const knight = by === 'w' ? 'N' : 'n';
	for (const [df, dr] of KNIGHT_DELTAS) {
		if (inBounds(file + df, rank + dr) && board[(rank + dr) * 8 + file + df] === knight) return true;
	}
	const king = by === 'w' ? 'K' : 'k';
	for (const [df, dr] of KING_DELTAS) {
		if (inBounds(file + df, rank + dr) && board[(rank + dr) * 8 + file + df] === king) return true;
	}
	const rook = by === 'w' ? 'R' : 'r';
	const bishop = by === 'w' ? 'B' : 'b';
	const queen = by === 'w' ? 'Q' : 'q';
	for (const [df, dr] of ORTHOGONAL) {
		let f = file + df;
		let r = rank + dr;
		while (inBounds(f, r)) {
			const piece = board[r * 8 + f];
			if (piece) {
				if (piece === rook || piece === queen) return true;
				break;
			}
			f += df;
			r += dr;
		}
	}
	for (const [df, dr] of DIAGONAL) {
		let f = file + df;
		let r = rank + dr;
		while (inBounds(f, r)) {
			const piece = board[r * 8 + f];
			if (piece) {
				if (piece === bishop || piece === queen) return true;
				break;
			}
			f += df;
			r += dr;
		}
	}
	return false;
}

export function isInCheck(state: EngineState, color: ChessColor): boolean {
	const king = findKing(state.board, color);
	if (king === null) return false;
	return isSquareAttacked(state.board, king, color === 'w' ? 'b' : 'w');
}

function pushIfTarget(board: ChessBoard, moves: CoordinateMove[], from: number, to: number, color: ChessColor): void {
	const target = board[to];
	if (!target) {
		moves.push({ from, to, promo: null });
		return;
	}
	// A king can never be captured; if this fires the incoming position was illegal.
	if (target === 'K' || target === 'k') return;
	if (pieceColor(target) !== color) moves.push({ from, to, promo: null });
}

function generatePseudoMoves(state: EngineState): CoordinateMove[] {
	const { board, turn } = state;
	const moves: CoordinateMove[] = [];
	const forward = turn === 'w' ? 8 : -8;
	const startRank = turn === 'w' ? 1 : 6;
	const promoRank = turn === 'w' ? 7 : 0;
	for (let from = 0; from < 64; from += 1) {
		const piece = board[from];
		if (!piece || pieceColor(piece) !== turn) continue;
		const kind = piece.toLowerCase();
		const file = from & 7;
		const rank = from >> 3;
		if (kind === 'p') {
			const one = from + forward;
			if (one >= 0 && one < 64 && !board[one]) {
				if ((one >> 3) === promoRank) {
					for (const promo of ['q', 'r', 'b', 'n'] as ChessPiece[]) moves.push({ from, to: one, promo });
				} else {
					moves.push({ from, to: one, promo: null });
					const two = from + forward * 2;
					if (rank === startRank && !board[two]) moves.push({ from, to: two, promo: null });
				}
			}
			for (const df of [-1, 1]) {
				const f = file + df;
				if (!inBounds(f, rank)) continue;
				const to = (rank + (turn === 'w' ? 1 : -1)) * 8 + f;
				if (to < 0 || to > 63) continue;
				const target = board[to];
				if (target && pieceColor(target) !== turn && target !== 'K' && target !== 'k') {
					if ((to >> 3) === promoRank) {
						for (const promo of ['q', 'r', 'b', 'n'] as ChessPiece[]) moves.push({ from, to, promo });
					} else {
						moves.push({ from, to, promo: null });
					}
				} else if (!target && state.ep === to) {
					const captured = turn === 'w' ? to - 8 : to + 8;
					if (captured >= 0 && captured < 64 && board[captured] === (turn === 'w' ? 'p' : 'P')) {
						moves.push({ from, to, promo: null });
					}
				}
			}
			continue;
		}
		if (kind === 'n') {
			for (const [df, dr] of KNIGHT_DELTAS) {
				const f = file + df;
				const r = rank + dr;
				if (inBounds(f, r)) pushIfTarget(board, moves, from, r * 8 + f, turn);
			}
			continue;
		}
		if (kind === 'k') {
			for (const [df, dr] of KING_DELTAS) {
				const f = file + df;
				const r = rank + dr;
				if (inBounds(f, r)) pushIfTarget(board, moves, from, r * 8 + f, turn);
			}
			continue;
		}
		const rays = kind === 'r' ? ORTHOGONAL : kind === 'b' ? DIAGONAL : [...ORTHOGONAL, ...DIAGONAL];
		for (const [df, dr] of rays) {
			let f = file + df;
			let r = rank + dr;
			while (inBounds(f, r)) {
				const to = r * 8 + f;
				const target = board[to];
				if (target) {
					if (pieceColor(target) !== turn && target !== 'K' && target !== 'k') moves.push({ from, to, promo: null });
					break;
				}
				moves.push({ from, to, promo: null });
				f += df;
				r += dr;
			}
		}
	}
	// Castling: rights in place, empty path, king not in/through/into check.
	const enemy = turn === 'w' ? 'b' : 'w';
	if (turn === 'w' && board[4] === 'K' && !isSquareAttacked(board, 4, enemy)) {
		if (state.castling.includes('K') && !board[5] && !board[6] && board[7] === 'R' &&
			!isSquareAttacked(board, 5, enemy) && !isSquareAttacked(board, 6, enemy)) {
			moves.push({ from: 4, to: 6, promo: null });
		}
		if (state.castling.includes('Q') && !board[3] && !board[2] && !board[1] && board[0] === 'R' &&
			!isSquareAttacked(board, 3, enemy) && !isSquareAttacked(board, 2, enemy)) {
			moves.push({ from: 4, to: 2, promo: null });
		}
	}
	if (turn === 'b' && board[60] === 'k' && !isSquareAttacked(board, 60, enemy)) {
		if (state.castling.includes('k') && !board[61] && !board[62] && board[63] === 'r' &&
			!isSquareAttacked(board, 61, enemy) && !isSquareAttacked(board, 62, enemy)) {
			moves.push({ from: 60, to: 62, promo: null });
		}
		if (state.castling.includes('q') && !board[59] && !board[58] && !board[57] && board[56] === 'r' &&
			!isSquareAttacked(board, 59, enemy) && !isSquareAttacked(board, 58, enemy)) {
			moves.push({ from: 60, to: 58, promo: null });
		}
	}
	return moves;
}

function applyMoveUnchecked(state: EngineState, move: CoordinateMove): EngineState {
	const board = state.board.slice();
	const piece = board[move.from];
	if (!piece) return { ...state, board };
	const kind = piece.toLowerCase();
	const color = pieceColor(piece);
	let captured = board[move.to];
	let halfmove = state.halfmove + 1;
	if (kind === 'p') halfmove = 0;
	// En-passant capture removes the pawn behind the target square.
	if (kind === 'p' && state.ep === move.to && !captured) {
		const behind = color === 'w' ? move.to - 8 : move.to + 8;
		if (behind >= 0 && behind < 64) {
			captured = board[behind];
			board[behind] = null;
			halfmove = 0;
		}
	}
	if (captured) halfmove = 0;
	// Castling: the king's two-square step carries its rook along.
	if (kind === 'k' && Math.abs((move.to & 7) - (move.from & 7)) === 2) {
		const kingSide = (move.to & 7) === 6;
		const rookFrom = color === 'w' ? (kingSide ? 7 : 0) : (kingSide ? 63 : 56);
		const rookTo = kingSide ? move.to - 1 : move.to + 1;
		board[rookTo] = board[rookFrom];
		board[rookFrom] = null;
	}
	board[move.to] = move.promo
		? (color === 'w' ? move.promo.toUpperCase() : move.promo)
		: piece;
	board[move.from] = null;
	// Castling rights: any king/rook move (or rook capture) burns the right.
	let castling = state.castling;
	if (kind === 'k') castling = color === 'w' ? castling.replace(/[KQ]/g, '') : castling.replace(/[kq]/g, '');
	if (move.from === 0 || move.to === 0) castling = castling.replace('Q', '');
	if (move.from === 7 || move.to === 7) castling = castling.replace('K', '');
	if (move.from === 56 || move.to === 56) castling = castling.replace('q', '');
	if (move.from === 63 || move.to === 63) castling = castling.replace('k', '');
	// En-passant target: only a double pawn push creates one.
	let ep: number | null = null;
	if (kind === 'p' && Math.abs(move.to - move.from) === 16) {
		ep = (move.from + move.to) / 2;
	}
	return {
		board,
		turn: color === 'w' ? 'b' : 'w',
		castling,
		ep,
		halfmove,
	};
}

/** All legal moves for the side to move (pins and check respected). */
export function legalMoves(state: EngineState): CoordinateMove[] {
	const enemy = state.turn === 'w' ? 'b' : 'w';
	return generatePseudoMoves(state).filter((move) => {
		const next = applyMoveUnchecked(state, move);
		const king = findKing(next.board, state.turn);
		return king !== null && !isSquareAttacked(next.board, king, enemy);
	});
}

/** Apply one move; null means the move is illegal in this position. */
export function applyMove(state: EngineState, move: CoordinateMove): EngineState | null {
	if (state.turn !== pieceColor(state.board[move.from])) return null;
	const allowed = legalMoves(state).some(
		(candidate) => candidate.from === move.from && candidate.to === move.to && (candidate.promo ?? null) === (move.promo ?? null),
	);
	if (!allowed) return null;
	return applyMoveUnchecked(state, move);
}

function insufficientMaterial(board: ChessBoard): boolean {
	const minors: { piece: string; square: number }[] = [];
	for (let index = 0; index < 64; index += 1) {
		const piece = board[index];
		if (!piece) continue;
		const kind = piece.toLowerCase();
		if (kind === 'p' || kind === 'r' || kind === 'q') return false;
		if (kind === 'n' || kind === 'b') minors.push({ piece, square: index });
	}
	if (minors.length === 0) return true;
	if (minors.length === 1) return true;
	// Dead position: only bishops remain and every one sits on the same
	// square colour. Any knight (K+N vs K+N, K+B+N …) keeps the game alive.
	let squareColor: boolean | null = null;
	for (const { piece, square } of minors) {
		if (piece.toLowerCase() !== 'b') return false;
		const colour = ((square & 7) + (square >> 3)) % 2 === 0;
		if (squareColor === null) squareColor = colour;
		else if (squareColor !== colour) return false;
	}
	return squareColor !== null;
}

/**
 * Position identity for threefold repetition: pieces, side to move,
 * castling rights, and the en-passant file only when a legal EP capture
 * actually exists (the FIDE criterion).
 */
export function positionKey(state: EngineState): string {
	let boardKey = '';
	for (let index = 0; index < 64; index += 1) {
		boardKey += state.board[index] ?? '.';
	}
	let epPart = '';
	if (state.ep !== null) {
		const probe: EngineState = { ...state, halfmove: state.halfmove };
		const mover = state.turn;
		const target = state.ep;
		const captures = legalMoves(probe).some((move) => {
			const piece = probe.board[move.from];
			return move.to === target && piece !== null && piece.toLowerCase() === 'p';
		});
		if (captures) epPart = ` ep${indexToSquare(target)}`;
	}
	return `${boardKey} ${state.turn} ${state.castling || '-'}${epPart}`;
}

/** Terminal check after a move: mate, stalemate, 50-move, threefold, dead position. */
export function outcomeOf(state: EngineState, keys: readonly string[]): ChessOutcome {
	const moves = legalMoves(state);
	if (moves.length === 0) {
		return isInCheck(state, state.turn)
			? { over: true, reason: 'checkmate', winner: state.turn === 'w' ? 'b' : 'w' }
			: { over: true, reason: 'stalemate', winner: 'draw' };
	}
	if (state.halfmove >= 100) return { over: true, reason: 'fifty', winner: 'draw' };
	const finalKey = keys[keys.length - 1];
	let seen = 0;
	for (const key of keys) {
		if (key === finalKey) seen += 1;
		if (seen >= 3) return { over: true, reason: 'threefold', winner: 'draw' };
	}
	if (insufficientMaterial(state.board)) return { over: true, reason: 'insufficient', winner: 'draw' };
	return { over: false };
}

/**
 * Replay a whole recorded game from the initial position. The score verifier
 * trusts nothing else: an illegal ply, a move after the game ended, or a
 * claimed result that does not match the final position all fail here.
 */
export function replayPrefix(moves: readonly string[]): PrefixResult {
	if (!Array.isArray(moves) || moves.length > CHESS_MAX_PROOF_PLIES) {
		return { ok: false, ply: 0, code: 'notation' };
	}
	let state = initialChessState();
	let keys = [positionKey(state)];
	const states: EngineState[] = [];
	let outcome: ChessOutcome = { over: false };
	for (let ply = 0; ply < moves.length; ply += 1) {
		if (outcome.over) return { ok: false, ply, code: 'after_over' };
		const text = moves[ply];
		const move = typeof text === 'string' && CHESS_MOVE_PATTERN.test(text) ? parseCoordinateMove(text) : null;
		if (!move) return { ok: false, ply, code: 'notation' };
		const next = applyMove(state, move);
		if (!next) return { ok: false, ply, code: 'illegal' };
		state = next;
		states.push(state);
		keys = [...keys, positionKey(state)];
		outcome = outcomeOf(state, keys);
	}
	return { ok: true, state, keys, states };
}

/** Full-game replay for score proofs: every move legal AND the game ends here. */
export function replayChess(moves: readonly string[]): ReplayResult {
	if (!Array.isArray(moves) || moves.length === 0) return { ok: false, ply: 0, code: 'notation' };
	const prefix = replayPrefix(moves);
	if (!prefix.ok) return prefix;
	const outcome = outcomeOf(prefix.state, prefix.keys);
	if (!outcome.over) return { ok: false, ply: moves.length, code: 'after_over' };
	return { ok: true, states: prefix.states, keys: prefix.keys, outcome, turn: prefix.state.turn };
}

/**
 * Leaderboard value for mode `fastest-mate`: fewer plies to checkmate scores
 * higher. Shared by the client claim form and the server verifier so the
 * submitted number and the verified number can never drift.
 */
export function fastestMateScore(plies: number): number {
	return Math.max(0, 100_000 - plies * 100);
}

/** Debug/test helper: standard-algebraic-ish summary of a position. */
export function boardText(state: EngineState): string {
	const rows: string[] = [];
	for (let rank = 7; rank >= 0; rank -= 1) {
		let row = '';
		for (let file = 0; file < 8; file += 1) row += state.board[rank * 8 + file] ?? '.';
		rows.push(row);
	}
	return rows.join('\n');
}

/** Debug/test helper: enumerate legal move strings. */
export function legalMoveTexts(state: EngineState): string[] {
	return legalMoves(state).map(formatCoordinateMove);
}
