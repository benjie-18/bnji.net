/**
 * `bnji.chess` browser client.
 *
 * Two modes share one board renderer:
 *   - practice: local hot-seat against the shared rules engine (no room),
 *   - room: the room socket is the source of truth. Every move ships as a
 *     state proposal (CAS on `baseRevision`) and the server authority
 *     replays it; the client never assumes a move stuck until a `state`
 *     frame with a new revision arrives.
 *
 * Leaderboard claims recompute the score with the same shared function the
 * server verifier uses, so client and server can never disagree.
 */
import {
	type ChessColor,
	type CoordinateMove,
	type EngineState,
	applyMove,
	formatCoordinateMove,
	fastestMateScore,
	initialChessState,
	legalMoves,
	outcomeOf,
	parseCoordinateMove,
	positionKey,
	replayPrefix,
	indexToSquare,
} from '../../game/chess-rules';
import type { GameModule } from '../game-runtime';
import type { RoomNotice } from '../game-rooms';
import { setGameShellState } from '../game-shell';

const CHESS_GAME_ID = 'bnji.chess';
const CHESS_MODE_ID = 'fastest-mate';
const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

type Seat = 'white' | 'black';
type OverInfo = { winner: Seat | 'draw'; reason: string };
type ChessRoomView = {
	seats: Record<Seat, string | null>;
	moves: string[];
	turn: ChessColor;
	status: 'active' | 'over';
	over?: OverInfo;
};
type PracticeState = { board: (string | null)[]; turn: ChessColor; moves: string[]; over: OverInfo | null; keys: string[] };

function seatOf(color: ChessColor): Seat {
	return color === 'w' ? 'white' : 'black';
}
function normalizeRoomState(raw: unknown): ChessRoomView | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	const seatsRaw = (value.seats && typeof value.seats === 'object' ? value.seats : {}) as Record<string, unknown>;
	const seats: Record<Seat, string | null> = {
		white: typeof seatsRaw.white === 'string' ? seatsRaw.white : null,
		black: typeof seatsRaw.black === 'string' ? seatsRaw.black : null,
	};
	const moves = Array.isArray(value.moves) ? value.moves.filter((move): move is string => typeof move === 'string') : [];
	const turn: ChessColor = value.turn === 'b' ? 'b' : 'w';
	const status: 'active' | 'over' = value.status === 'over' ? 'over' : 'active';
	const view: ChessRoomView = { seats, moves, turn, status };
	if (status === 'over' && value.over && typeof value.over === 'object') {
		const over = value.over as Record<string, unknown>;
		const winner = over.winner === 'white' || over.winner === 'black' || over.winner === 'draw' ? over.winner : 'draw';
		view.over = { winner, reason: typeof over.reason === 'string' ? over.reason : '' };
	}
	return view;
}
function reasonText(reason: string): string {
	switch (reason) {
		case 'checkmate': return 'Checkmate';
		case 'stalemate': return 'Stalemate — draw';
		case 'fifty': return 'Fifty-move rule — draw';
		case 'threefold': return 'Threefold repetition — draw';
		case 'insufficient': return 'Insufficient material — draw';
		case 'resign': return 'Resignation';
		default: return reason ? `Game over (${reason})` : 'Game over';
	}
}
function randomIdempotencyKey(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
}

export type ChessGame = ReturnType<typeof createChessGame>;

export function createChessGame() {
	// ------------------------------------------------------------- page refs
	const boardEl = document.querySelector<HTMLElement>('[data-chess-board]');
	const statusEl = document.querySelector<HTMLElement>('[data-chess-status]');
	const modeEl = document.querySelector<HTMLElement>('[data-chess-mode]');
	const seatsEl = document.querySelector<HTMLElement>('[data-chess-seats]');
	const movesEl = document.querySelector<HTMLOListElement>('[data-chess-moves]');
	const resignButton = document.querySelector<HTMLButtonElement>('[data-chess-resign]');
	const resetButton = document.querySelector<HTMLButtonElement>('[data-chess-reset]');
	const claimForm = document.querySelector<HTMLFormElement>('[data-chess-claim]');
	const claimOpen = document.querySelector<HTMLButtonElement>('[data-chess-claim-open]');
	const claimBack = document.querySelector<HTMLButtonElement>('[data-chess-results-back]');
	const resultNote = document.querySelector<HTMLElement>('[data-chess-result-note]');
	const claimNote = document.querySelector<HTMLElement>('[data-chess-claim-note]');
	const claimStatus = document.querySelector<HTMLElement>('[data-chess-claim-status]');
	const claimName = claimForm?.querySelector<HTMLInputElement>('[name="displayName"]') ?? null;
	const squares = new Map<string, HTMLButtonElement>();

	// -------------------------------------------------------------- game state
	let practice: PracticeState = freshPractice();
	let roomView: ChessRoomView | null = null;
	let roomRevision = 0;
	let activeGameId: string | null = null;
	let socket: WebSocket | null = null;
	let myMemberId: string | null = null;
	let memberLabels = new Map<string, string>();
	let selected: number | null = null;
	let inputLocked = false;
	let claimColor: Seat | null = null;
	let claimDone = false;
	let resultsAcknowledged = false;
	let pending: { base: number; state: Record<string, unknown> } | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let viewCache: { key: string; pieces: (string | null)[] } | null = null;

	function freshPractice(): PracticeState {
		const state = initialChessState();
		return { board: state.board, turn: 'w', moves: [], over: null, keys: [positionKey(state)] };
	}
	function say(message: string): void { if (statusEl) statusEl.textContent = message; }
	function modeSay(message: string): void { if (modeEl) modeEl.textContent = message; }
	function showShell(state: 'ready' | 'results'): void {
		const shell = document.querySelector<HTMLElement>('[data-game-shell]');
		if (shell && shell.dataset.gameState !== state) setGameShellState(shell, state);
	}

	// ------------------------------------------------------------------ rendering
	function viewPieces(): (string | null)[] {
		const key = roomView ? `room:${roomRevision}:${roomView.moves.length}` : `practice:${practice.moves.length}:${practice.over ? 'over' : 'on'}`;
		if (viewCache?.key === key) return viewCache.pieces;
		let pieces: (string | null)[];
		if (roomView) {
			const replay = replayPrefix(roomView.moves);
			pieces = replay.ok ? replay.state.board : [];
		} else {
			pieces = practice.board;
		}
		viewCache = { key, pieces };
		return pieces;
	}
	function sideToMove(): ChessColor {
		return roomView ? roomView.turn : practice.turn;
	}
	function currentOver(): OverInfo | null {
		return roomView ? (roomView.over ?? null) : practice.over;
	}
	function currentMoves(): string[] {
		return roomView ? roomView.moves : practice.moves;
	}
	function boardLocked(): boolean {
		if (inputLocked) return true;
		if (activeGameId !== null && activeGameId !== CHESS_GAME_ID) return true;
		if (roomView) {
			if (roomView.status === 'over') return true;
			const seat = seatOf(sideToMove());
			if (roomView.seats[seat] !== null && roomView.seats[seat] !== myMemberId) return true;
			return myMemberId === null;
		}
		if (practice.over) return true;
		return false;
	}
	function render(): void {
		if (!boardEl) return;
		const pieces = viewPieces();
		const legal = boardLocked() ? [] : legalMovesForSide();
		const legalTargets = new Set(legal.filter((move) => move.from === selected).map((move) => move.to));
		for (let index = 0; index < 64; index += 1) {
			const square = squares.get(indexToSquare(index));
			if (!square) continue;
			const piece = pieces[index];
			const name = piece
				? `${pieceColorName(piece)} ${pieceKindName(piece)}`
				: 'empty';
			square.setAttribute('aria-label', `${indexToSquare(index)}, ${name}`);
			square.textContent = piece ? GLYPH[piece.toLowerCase()] ?? '' : '';
			square.classList.toggle('is-white', Boolean(piece && piece === piece.toUpperCase()));
			square.classList.toggle('is-selected', selected === index);
			square.classList.toggle('is-target', legalTargets.has(index));
		}
		// Status / seats / moves
		const over = currentOver();
		const mySeat = myMemberId
			? (roomView?.seats.white === myMemberId ? 'white' : roomView?.seats.black === myMemberId ? 'black' : null)
			: null;
		if (seatsEl) {
			if (roomView) {
				const describe = (seat: Seat): string => {
					const id = roomView!.seats[seat];
					if (!id) return `${seatTitle(seat)}: (open — first move claims it)`;
					if (id === myMemberId) return `${seatTitle(seat)}: you`;
					return `${seatTitle(seat)}: ${memberLabels.get(id) ?? 'opponent'}`;
				};
				seatsEl.textContent = `${describe('white')} · ${describe('black')}`;
			} else {
				seatsEl.textContent = 'Practice mode: you control both sides.';
			}
		}
		if (movesEl) {
			const moves = currentMoves();
			movesEl.replaceChildren();
			for (let i = 0; i < moves.length; i += 2) {
				const item = document.createElement('li');
				const number = Math.floor(i / 2) + 1;
				const white = moves[i] ?? '';
				const black = moves[i + 1];
				item.textContent = black ? `${number}. ${white} ${black}` : `${number}. ${white}`;
				movesEl.appendChild(item);
			}
		}
		if (over) {
			const winner = over.winner === 'draw' ? 'Draw' : `${seatTitle(over.winner)} wins`;
			say(`${reasonText(over.reason)} — ${winner}.`);
		}
		// Resign visibility: seated in an active room game.
		if (resignButton) {
			resignButton.hidden = !(roomView && roomView.status === 'active' && mySeat);
		}
		// Claim panel: only a genuine checkmate can be claimed, winner's side.
		let claimable = false;
		if (claimForm && !claimDone) {
			claimable = Boolean(over && over.reason === 'checkmate' && over.winner !== 'draw' &&
				(!roomView || mySeat === over.winner));
			claimForm.hidden = !claimable;
			if (claimable && over) {
				claimColor = over.winner as Seat;
				if (claimNote) {
					const plies = currentMoves().length;
					claimNote.textContent = `${seatTitle(claimColor)} won in ${plies} plies · leaderboard value ${fastestMateScore(plies).toLocaleString()} (fewer plies ranks higher).`;
				}
			} else {
				claimColor = null;
			}
		}
		if (claimOpen) claimOpen.hidden = !(claimable && !claimDone && over);
		// Terminal results flow (recipe): announce through the shell's results
		// slot once per game; "Back to the board" returns to the ready panel.
		if (over && !resultsAcknowledged && !claimDone && document.querySelector<HTMLElement>('[data-game-shell]')?.dataset.gameState === 'ready') {
			if (resultNote) {
				const winner = over.winner === 'draw' ? 'Draw' : `${seatTitle(over.winner)} wins`;
				resultNote.textContent = `${reasonText(over.reason)} — ${winner}. ${currentMoves().length} moves played.`;
			}
			showShell('results');
		}
	}
	function pieceColorName(piece: string): string { return piece === piece.toUpperCase() ? 'white' : 'black'; }
	function pieceKindName(piece: string): string {
		switch (piece.toLowerCase()) {
			case 'k': return 'king';
			case 'q': return 'queen';
			case 'r': return 'rook';
			case 'b': return 'bishop';
			case 'n': return 'knight';
			default: return 'pawn';
		}
	}
	function seatTitle(seat: Seat): string { return seat === 'white' ? 'White' : 'Black'; }
	function legalMovesForSide(): CoordinateMove[] {
		if (roomView) {
			const replay = replayPrefix(roomView.moves);
			return replay.ok ? legalMoves(replay.state) : [];
		}
		return legalMoves(practiceEngine);
	}
	// Practice keeps the full engine state (castling rights, en-passant target).
	let practiceEngine: EngineState = initialChessState();

	// ---------------------------------------------------------------- interaction
	function onSquare(index: number): void {
		if (boardLocked()) {
			if (roomView && roomView.status === 'active') say('Waiting for your turn…');
			return;
		}
		const pieces = viewPieces();
		const piece = pieces[index];
		const turn = sideToMove();
		if (selected === null) {
			if (piece && pieceColorName(piece) === (turn === 'w' ? 'white' : 'black')) {
				selected = index;
				render();
			}
			return;
		}
		if (selected === index) { selected = null; render(); return; }
		if (piece && pieceColorName(piece) === (turn === 'w' ? 'white' : 'black')) {
			selected = index;
			render();
			return;
		}
		const candidates = legalMovesForSide().filter((move) => move.from === selected && move.to === index);
		if (candidates.length === 0) {
			say('That piece cannot move there.');
			selected = null;
			render();
			return;
		}
		// Auto-queen: the engine requires an explicit choice on promotion.
		const pawn = pieces[selected!];
		const promotes = pawn !== null && pawn.toLowerCase() === 'p' && (index >> 3) === (turn === 'w' ? 7 : 0);
		const move = candidates[0]!;
		const coordinate = `${formatCoordinateMove({ from: move.from, to: move.to, promo: null })}${promotes ? 'q' : ''}`;
		selected = null;
		if (roomView) sendRoomMove(coordinate);
		else applyPracticeMove(coordinate);
	}
	function applyPracticeMove(coordinate: string): void {
		const parsed = parseCoordinateMove(coordinate);
		if (!parsed) return;
		const next = applyMove(practiceEngine, parsed);
		if (!next) { say('That move is not legal.'); return; }
		practiceEngine = next;
		practice = {
			board: next.board,
			turn: next.turn,
			moves: [...practice.moves, coordinate],
			keys: [...practice.keys, positionKey(next)],
			over: null,
		};
		const outcome = outcomeOf(next, practice.keys);
		if (outcome.over) {
			practice.over = { winner: outcome.winner === 'draw' ? 'draw' : (outcome.winner === 'w' ? 'white' : 'black'), reason: outcome.reason };
		}
		render();
		if (!practice.over) say(`${sideToMove() === 'w' ? 'White' : 'Black'} to move.`);
	}
	function sendRoomMove(coordinate: string): void {
		if (!roomView || !socket || socket.readyState !== WebSocket.OPEN || myMemberId === null) {
			say('The room connection is not ready yet.');
			return;
		}
		const seats = { ...roomView.seats };
		const turnSeat = seatOf(roomView.turn);
		if (seats[turnSeat] === null) seats[turnSeat] = myMemberId;
		const proposal: Record<string, unknown> = {
			seats,
			moves: [...roomView.moves, coordinate],
			turn: roomView.turn === 'w' ? 'b' : 'w',
			status: 'active',
		};
		pending = { base: roomRevision, state: proposal };
		flushPending();
		say('Sending move…');
	}
	function flushPending(): void {
		if (!pending || !socket || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify({ v: 1, type: 'state', baseRevision: pending.base, state: pending.state }));
	}
	function sendResign(): void {
		if (!roomView || !socket || socket.readyState !== WebSocket.OPEN || !myMemberId || roomView.status !== 'active') return;
		const seat = roomView.seats.white === myMemberId ? 'white' : roomView.seats.black === myMemberId ? 'black' : null;
		if (!seat) return;
		pending = {
			base: roomRevision,
			state: { seats: { ...roomView.seats }, moves: roomView.moves, turn: roomView.turn, status: 'active', resign: seat },
		};
		flushPending();
		say('Resigning…');
	}

	// ----------------------------------------------------------- room frames
	function onFrame(message: RoomNotice): void {
		if (message.type === 'members' && Array.isArray(message.members)) {
			memberLabels = new Map(message.members.map((member) => [member.memberId, member.label]));
			const self = message.members.find((member) => member.isSelf);
			myMemberId = self ? self.memberId : null;
			render();
			return;
		}
		if (message.type === 'snapshot') {
			activeGameId = typeof message.gameId === 'string' && message.gameId ? message.gameId : null;
			if (activeGameId !== CHESS_GAME_ID) {
				roomView = null;
				modeSay(socket ? 'Connected room is running a different game.' : 'Connected (no game).');
				if (activeGameId) say('That room is not a chess room — the board stays read-only.');
				render();
				return;
			}
			modeSay('Room mode — moves are validated by the server.');
			adoptRoomState(message.state, message.revision);
			return;
		}
		if (activeGameId !== CHESS_GAME_ID) return;
		if (message.type === 'state' || message.type === 'conflict') {
			adoptRoomState(message.state, message.revision);
			return;
		}
		if (message.type === 'rate_limited') {
			if (pending) {
				const wait = Math.max(150, Number(message.retryAfterMs ?? 1000));
				if (retryTimer) clearTimeout(retryTimer);
				retryTimer = setTimeout(() => { flushPending(); }, wait);
				say(`Board sync paced by the room (retrying in ${Math.ceil(wait / 1000)}s)…`);
			}
			return;
		}
		if (message.type === 'state_rejected') {
			pending = null;
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			const error = message.error ?? '';
			say(
				error === 'illegal_move' ? 'That move is not legal in this position.'
				: error === 'not_your_turn' ? 'Not your turn — wait for the other seat.'
				: error === 'game_over' ? 'The game is already over.'
				: error === 'seat_taken' || error === 'bad_seats' ? 'That seat is already claimed.'
				: error === 'not_your_seat' ? 'Only the seated player can do that.'
				: error === 'state_corrupt' ? 'Room state needs a refresh — rejoin the room.'
				: 'The server rejected that change.',
			);
			render();
		}
	}
	function adoptRoomState(raw: unknown, revision: number | undefined): void {
		const view = normalizeRoomState(raw);
		if (!view) return;
		roomView = view;
		if (typeof revision === 'number') roomRevision = revision;
		pending = null;
		if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
		selected = null;
		render();
		if (view.status === 'active') say(`${view.turn === 'w' ? 'White' : 'Black'} to move.`);
	}
	function onSocket(next: WebSocket | null): void {
		socket = next;
		pending = null;
		if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
		if (next) {
			modeSay('Room mode — join confirmed, syncing board…');
		} else {
			activeGameId = null;
			roomView = null;
			myMemberId = null;
			modeSay('Practice mode — play both sides locally, or connect a room below.');
			say('Practice: White to move.');
		}
		render();
	}

	// ------------------------------------------------------------------ claim
	async function submitClaim(): Promise<void> {
		if (!claimColor || claimDone || !claimForm) return;
		const moves = currentMoves();
		const plies = moves.length;
		if (claimStatus) claimStatus.textContent = 'Submitting…';
		const submit = claimForm.querySelector<HTMLButtonElement>('button[type="submit"]');
		if (submit) submit.disabled = true;
		try {
			const response = await fetch('/api/games/scores', {
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					gameId: CHESS_GAME_ID,
					mode: CHESS_MODE_ID,
					score: fastestMateScore(plies),
					tieBreak: plies,
					displayName: claimName?.value.trim() ?? '',
					idempotencyKey: randomIdempotencyKey(),
					proof: { moves, color: claimColor },
				}),
			});
			const body = await response.json().catch(() => ({})) as { error?: string; score?: number };
			if (response.ok) {
				claimDone = true;
				if (claimStatus) claimStatus.textContent = `Score recorded: ${Number(body.score ?? fastestMateScore(plies)).toLocaleString()}. The leaderboard is on the Games page.`;
				claimForm.hidden = true;
				render();
				return;
			}
			if (claimStatus) {
				claimStatus.textContent =
					body.error === 'invalid_display_name' ? 'Enter a display name (1–24 characters).'
					: body.error === 'score_rejected' ? 'The server could not verify this game record.'
					: body.error === 'rate_limited' ? 'Too many claims right now — try again shortly.'
					: body.error === 'invalid_mode' || body.error === 'unknown_game' ? 'Leaderboard submission is unavailable right now.'
					: 'The claim could not be verified. Try again in a moment.';
			}
		} catch {
			if (claimStatus) claimStatus.textContent = 'Could not reach the server. Try again when online.';
		} finally {
			if (submit) submit.disabled = false;
		}
	}

	// ------------------------------------------------------------------ build
	if (boardEl) {
		const frag = document.createDocumentFragment();
		// Render rank 8 at the top; White always at the bottom in v1.
		for (let rank = 7; rank >= 0; rank -= 1) {
			for (let file = 0; file < 8; file += 1) {
				const index = rank * 8 + file;
				const button = document.createElement('button');
				button.type = 'button';
				button.dataset.square = indexToSquare(index);
				button.className = `chess-square ${(file + rank) % 2 === 0 ? 'is-light' : 'is-dark'}`;
				button.addEventListener('click', () => onSquare(index));
				squares.set(indexToSquare(index), button);
				frag.appendChild(button);
			}
		}
		boardEl.appendChild(frag);
	}
	resignButton?.addEventListener('click', sendResign);
	resetButton?.addEventListener('click', () => {
		if (roomView) { say('Leave the room to return to practice mode.'); return; }
		practice = freshPractice();
		practiceEngine = initialChessState();
		selected = null;
		claimDone = false;
		resultsAcknowledged = false;
		inputLocked = false;
		if (claimForm) claimForm.hidden = true;
		if (claimStatus) claimStatus.textContent = '';
		if (resultNote) resultNote.textContent = '';
		showShell('ready');
		say('New practice game — White to move.');
		render();
	});
	claimForm?.addEventListener('submit', (event) => { event.preventDefault(); void submitClaim(); });
	claimOpen?.addEventListener('click', () => { resultsAcknowledged = false; render(); });
	claimBack?.addEventListener('click', () => { resultsAcknowledged = true; showShell('ready'); render(); });
	modeSay('Practice mode — play both sides locally, or connect a room below.');
	say('White to move.');
	render();

	const module: GameModule = {
		init(root: HTMLElement) {
			root.dataset.chessReady = 'true';
			const lock = (locked: boolean): void => { inputLocked = locked; render(); };
			return {
				pause: () => lock(true),
				resume: () => lock(false),
				destroy: () => { if (retryTimer) clearTimeout(retryTimer); },
			};
		},
	};

	return { module, onFrame, onSocket };
}
