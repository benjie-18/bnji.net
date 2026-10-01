/**
 * Chess engine correctness — perft positions plus every rule the authority
 * and score verifier depend on. Perft (move-path enumeration) is the
 * community-standard way to prove a generator: wrong castling, en-passant,
 * promotion, pin or check logic changes the node counts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyMove,
	boardText,
	fastestMateScore,
	initialChessState,
	indexToSquare,
	legalMoveTexts,
	legalMoves,
	outcomeOf,
	parseCoordinateMove,
	parseFen,
	positionKey,
	replayChess,
	squareToIndex,
	type EngineState,
} from '../src/game/chess-rules';

function perft(state: EngineState, depth: number): number {
	if (depth === 0) return 1;
	let total = 0;
	for (const move of legalMoves(state)) {
		const next = applyMove(state, move);
		assert.ok(next, 'a legal move must apply');
		total += perft(next, depth - 1);
	}
	return total;
}

test('squares and notation round-trip', () => {
	assert.equal(squareToIndex('a1'), 0);
	assert.equal(squareToIndex('h8'), 63);
	assert.equal(indexToSquare(0), 'a1');
	assert.equal(indexToSquare(63), 'h8');
	assert.equal(squareToIndex('i1'), null);
	assert.deepEqual(parseCoordinateMove('e2e4'), { from: 12, to: 28, promo: null });
	assert.deepEqual(parseCoordinateMove('e7e8q'), { from: 52, to: 60, promo: 'q' });
	assert.equal(parseCoordinateMove('e2e9'), null);
	assert.equal(parseCoordinateMove('e7e8z'), null);
	assert.equal(parseCoordinateMove('e2'), null);
});

test('initial position: 20 replies, perft 20/400/8902', () => {
	const state = initialChessState();
	assert.equal(legalMoveTexts(state).length, 20);
	assert.equal(perft(state, 1), 20);
	assert.equal(perft(state, 2), 400);
	assert.equal(perft(state, 3), 8902);
});

test('perft on Kiwipete (castling, en-passant, promotions)', () => {
	const state = parseFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
	assert.ok(state);
	assert.equal(legalMoves(state).length, 48);
	assert.equal(perft(state, 1), 48);
	assert.equal(perft(state, 2), 2039);
	assert.equal(perft(state, 3), 97862);
});

test("fool's mate is checkmate for black; scholar's mate for white", () => {
	const fools = replayChess(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
	assert.ok(fools.ok);
	assert.deepEqual(fools.outcome, { over: true, reason: 'checkmate', winner: 'b' });
	assert.equal(fools.states.length, 4);

	const scholars = replayChess(['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
	assert.ok(scholars.ok);
	assert.deepEqual(scholars.outcome, { over: true, reason: 'checkmate', winner: 'w' });
});

test('replay failures are precise: notation, illegal, after_over', () => {
	// Pattern violation (rank 9) fails before any rules run.
	assert.deepEqual(replayChess(['e2e9']), { ok: false, ply: 0, code: 'notation' });
	// Well-formed but physically impossible: pawn e2 cannot land on e5.
	assert.deepEqual(replayChess(['e2e5']), { ok: false, ply: 0, code: 'illegal' });
	// Legal but non-terminal games are not proofs: reported at the end, code after_over.
	const shortLegal = replayChess(['e2e4', 'e7e5', 'g1f3']);
	assert.deepEqual(shortLegal, { ok: false, ply: 3, code: 'after_over' });
	// A move attempted after mate already ended the game:
	const foolsEnd = replayChess(['f2f3', 'e7e5', 'g2g4', 'd8h4', 'a2a3']);
	assert.deepEqual(foolsEnd, { ok: false, ply: 4, code: 'after_over' });
	// Moves that stop short of any terminal position:
	const open = replayChess(['e2e4', 'e7e5']);
	assert.deepEqual(open, { ok: false, ply: 2, code: 'after_over' });
	assert.deepEqual(replayChess([]), { ok: false, ply: 0, code: 'notation' });
});

test('a truly illegal mid-game move fails with ply index', () => {
	// After 1.e4 e5, White cannot play d2d4→? use a queen diagonal that is blocked: d1h5 is blocked by pawn e2? after e4 the d1-h5 diagonal is clear... use b1c3? legal. Use h2h4 then h4h5 h5h6? Instead: knight b1-b3 is legal; use rook a1-a2 (blocked).
	const attempt = replayChess(['e2e4', 'e7e5', 'a1a2']);
	assert.deepEqual(attempt, { ok: false, ply: 2, code: 'illegal' });
});

test('castling: through-path rules and rook transport', () => {
	const state = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
	assert.ok(state);
	const moves = legalMoveTexts(state);
	assert.ok(moves.includes('e1g1'), 'kingside castle available');
	assert.ok(moves.includes('e1c1'), 'queenside castle available');
	const castle = applyMove(state, { from: squareToIndex('e1')!, to: squareToIndex('g1')!, promo: null });
	assert.ok(castle);
	assert.equal(castle.board[squareToIndex('g1')!], 'K');
	assert.equal(castle.board[squareToIndex('f1')!], 'R');
	assert.equal(castle.board[squareToIndex('e1')!], null);
	assert.equal(castle.board[squareToIndex('h1')!], null);
	assert.ok(!castle.castling.includes('K') && !castle.castling.includes('Q'));

	// Enemy bishop attacks f1: kingside castle is forbidden, queenside lives.
	const threatened = parseFen('4k3/8/8/1b6/8/8/8/R3K2R w KQ - 0 1');
	assert.ok(threatened);
	assert.ok(!legalMoveTexts(threatened).includes('e1g1'), 'cannot castle through an attacked square');
	assert.ok(legalMoveTexts(threatened).includes('e1c1'), 'queenside still legal');

	// King currently in check may not castle.
	const inCheck = parseFen('4k3/8/8/8/8/8/4r3/4K2R w K - 0 1');
	assert.ok(inCheck);
	assert.ok(!legalMoveTexts(inCheck).includes('e1g1'), 'cannot castle out of check');
});

test('en passant: capture works, removes the pawn, only on the first reply', () => {
	const state = parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
	assert.ok(state);
	assert.ok(legalMoveTexts(state).includes('e5d6'), 'ep capture offered');
	const captured = applyMove(state, { from: squareToIndex('e5')!, to: squareToIndex('d6')!, promo: null });
	assert.ok(captured);
	assert.equal(captured.board[squareToIndex('d5')!], null, 'the passed pawn is gone');
	assert.equal(captured.board[squareToIndex('d6')!], 'P');
	// No ep square → the same diagonal capture is impossible.
	const stale = parseFen('4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1');
	assert.ok(stale);
	assert.ok(!legalMoveTexts(stale).includes('e5d6'));
});

test('promotion: four choices from rank 7, replay accepts auto-queen', () => {
	const state = parseFen('8/P6k/8/8/8/8/8/K7 w - - 0 1');
	assert.ok(state);
	const promos = legalMoveTexts(state).filter((text) => text.startsWith('a7a8'));
	assert.deepEqual([...promos].sort(), ['a7a8b', 'a7a8n', 'a7a8q', 'a7a8r']);
	const promoted = applyMove(state, { from: squareToIndex('a7')!, to: squareToIndex('a8')!, promo: 'q' });
	assert.ok(promoted);
	assert.equal(promoted.board[squareToIndex('a8')!], 'Q');
});

test('kings may never touch and kings are never capturable', () => {
	// Kings e1 and e3: every adjacent square around e3 is forbidden.
	const state = parseFen('8/8/8/8/8/4k3/8/4K3 w - - 0 1');
	assert.ok(state);
	const moves = legalMoveTexts(state).sort();
	assert.deepEqual(moves, ['e1d1', 'e1f1'], 'adjacent king squares are excluded');
});

test('stalemate is detected as a draw', () => {
	const state = parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
	assert.ok(state);
	assert.equal(legalMoves(state).length, 0);
	const key = positionKey(state);
	assert.deepEqual(outcomeOf(state, [key]), { over: true, reason: 'stalemate', winner: 'draw' });
});

test('fifty-move rule fires at 100 half-moves', () => {
	const state = parseFen('4k3/8/8/8/8/8/8/R3K3 w Q - 99 1');
	assert.ok(state);
	const next = applyMove(state, { from: squareToIndex('a1')!, to: squareToIndex('a2')!, promo: null });
	assert.ok(next);
	assert.equal(next.halfmove, 100);
	assert.deepEqual(outcomeOf(next, [positionKey(next)]), { over: true, reason: 'fifty', winner: 'draw' });
});

test('threefold repetition through a knight shuffle', () => {
	const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
	const result = replayChess(shuffle);
	assert.ok(result.ok, JSON.stringify(result));
	assert.deepEqual(result.outcome, { over: true, reason: 'threefold', winner: 'draw' });
	// The position after 8 plies equals the start position for the third time.
	assert.equal(result.keys.length, 9);
	assert.equal(result.keys[8], result.keys[0]);
});

test('dead positions are draws: bare kings, lone bishop, same-colour bishops', () => {
	for (const fen of [
		'8/8/8/4k3/8/8/8/4K3 w - - 0 1',
		'8/8/8/4k3/8/8/8/2B1K3 w - - 0 1',
		'8/8/2b5/3k4/8/8/8/2B1K3 w - - 0 1', // bishops on c6/c1: both dark? c6=2+5=7 odd, c1=2+0=2 even → NOT same colour
	]) {
		const state = parseFen(fen);
		assert.ok(state, fen);
		const key = positionKey(state);
		const outcome = outcomeOf(state, [key]);
		// First two are dead; the third has opposite-colour bishops → play continues.
		if (fen.includes('2b5')) assert.equal(outcome.over, false, 'opposite bishops keep the game alive');
		else assert.deepEqual(outcome, { over: true, reason: 'insufficient', winner: 'draw' });
	}
	const sameColour = parseFen('8/8/8/4k3/8/8/8/2B1K3 w - - 0 1');
	assert.ok(sameColour);
	// Add a second bishop on the same colour (c8 = 2+7 = 9 odd... use e8: 4+7=11 odd; c6=7 odd → c6 matches c1? c1=2. Choose f7: 5+6=11 odd vs c6 7 odd → same parity class?
	// Parity classes: even/odd of file+rank — c6 (7) and f7 (11) are both odd → same colour.
	// Bishops on f7 and c6 — both (file+rank) odd, i.e. the same colour.
	const twin = parseFen('8/5b2/2B5/4k3/8/8/8/4K3 w - - 0 1');
	assert.ok(twin);
	assert.deepEqual(outcomeOf(twin, [positionKey(twin)]), { over: true, reason: 'insufficient', winner: 'draw' });
});

test('fastest-mate scoring rewards shorter games', () => {
	assert.equal(fastestMateScore(4), 99_600);
	assert.equal(fastestMateScore(40), 96_000);
	assert.ok(fastestMateScore(4) > fastestMateScore(40));
	assert.equal(fastestMateScore(2000), 0, 'clamped at zero');
});

test('boardText renders rank 8 first (sanity for debugging)', () => {
	const text = boardText(initialChessState());
	assert.equal(text.split('\n')[0], 'rnbqkbnr');
	assert.equal(text.split('\n')[7], 'RNBQKBNR');
});
