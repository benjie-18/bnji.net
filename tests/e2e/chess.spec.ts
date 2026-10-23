/**
 * `bnji.chess` browser surface (user-machine Playwright run).
 *
 * Sockets and APIs are mocked like the other specs — these assertions are
 * about client wiring: the practice board plays full legal games through the
 * shared engine, the claim panel appears only on a real checkmate, room
 * frames drive the board (seats, revisions, resign) and rejections land in
 * the status line. Server truth is covered by tests/chess-adapter.test.ts
 * (authority + verifier) and tests/workerd/chess.spec.ts (real DO).
 *
 * Run locally with `npm run test:e2e` — it does not run in the sandbox.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

const ROOM_CODE = 'cH3ssR00mC0d3FoRTest!!'; // 22 chars, join-form constraints satisfied
const MY_ID = 'a'.repeat(24);
const OPPONENT_ID = 'b'.repeat(24);

const chessSnapshot = (revision: number, state: Record<string, unknown>) => ({
	v: 1,
	type: 'snapshot',
	revision,
	gameId: 'bnji.chess',
	state,
	connectedMembers: 1,
	isHost: true,
	hasHost: true,
});

async function clickSquare(page: Page, square: string): Promise<void> {
	await page.locator(`[data-square="${square}"]`).click();
}

test('practice mode plays a full legal game and offers the verified checkmate claim', async ({ page }) => {
	await page.route('**/api/games/scores', (route) => route.fulfill({
		status: 201,
		contentType: 'application/json',
		body: JSON.stringify({ ok: true, score: 99_600 }),
	}));
	await page.goto('/projects/games/chess/');

	const board = page.locator('[data-chess-board]');
	await expect(board).toBeVisible();
	await expect(board.locator('button')).toHaveCount(64);
	await expect(page.locator('[data-chess-mode]')).toContainText('Practice mode');
	await expect(page.locator('[data-chess-status]')).toContainText('White to move');

	// Initial labels come from the engine's starting position.
	await expect(page.locator('[data-square="e2"]')).toHaveAttribute('aria-label', 'e2, white pawn');
	await expect(page.locator('[data-chess-claim]')).toBeHidden();

	// Fool's mate: f3 e5 g4 Qh4#
	await clickSquare(page, 'f2');
	await clickSquare(page, 'f3');
	await expect(page.locator('[data-chess-status]')).toContainText('Black to move');
	await expect(page.locator('[data-square="f2"]')).toHaveAttribute('aria-label', 'f2, empty');
	await clickSquare(page, 'e7');
	await clickSquare(page, 'e5');
	await clickSquare(page, 'g2');
	await clickSquare(page, 'g4');
	await clickSquare(page, 'd8');
	await clickSquare(page, 'h4');

	await expect(page.locator('[data-chess-status]')).toContainText('Checkmate — Black wins.');
	const moves = page.locator('[data-chess-moves]');
	await expect(moves.locator('li')).toHaveCount(4);
	await expect(moves).toContainText('1. f2f3 e7e5');
	await expect(moves).toContainText('2. g2g4 d8h4');

	// Terminal results: the shell switches to its results slot with the claim.
	const claim = page.locator('[data-chess-claim]');
	await expect(page.locator('[data-chess-result-note]')).toContainText('Checkmate — Black wins.');
	await expect(claim).toBeVisible();
	await expect(page.locator('[data-chess-claim-note]')).toContainText('Black won in 4 plies');
	await expect(page.locator('[data-chess-claim-note]')).toContainText('99,600');
	await claim.locator('[name="displayName"]').fill('Mating Me');
	await claim.getByRole('button', { name: 'Submit checkmate claim' }).click();
	await expect(page.locator('[data-chess-claim-status]')).toContainText('Score recorded: 99,600');

	// Back to the board: final position stays reviewable; claim entry hides.
	await page.locator('[data-chess-results-back]').click();
	await expect(page.locator('[data-chess-board]')).toBeVisible();
	await expect(page.locator('[data-chess-claim-open]')).toBeHidden();

	// Reset returns a fresh board with an empty move list.
	await page.locator('[data-chess-reset]').click();
	await expect(page.locator('[data-chess-status]')).toContainText('New practice game — White to move.');
	await expect(moves.locator('li')).toHaveCount(0);
	await expect(claim).toBeHidden();
});

test('room mode: server frames drive the board, moves ship as CAS proposals, rejections surface', async ({ page }) => {
	let socket: WebSocketRoute | null = null;
	const clientFrames: Array<Record<string, unknown>> = [];
	await page.route('**/api/games/rooms', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ roomCode: ROOM_CODE, expiresAt: Date.now() + 7_200_000, capacity: 8 }),
	}));
	await page.routeWebSocket(/\/api\/games\/rooms\/[^/?]+\/ws/, (ws) => {
		socket = ws;
		ws.onMessage((message) => {
			try { clientFrames.push(JSON.parse(String(message)) as Record<string, unknown>); } catch { /* binary */ }
		});
	});

	await page.goto('/projects/games/chess/');
	await page.locator('[data-room-create]').getByRole('button', { name: 'Create a room' }).click();
	await expect.poll(() => socket !== null).toBe(true);

	// Fresh chess room: empty state at revision 0, plus our membership.
	socket!.send(JSON.stringify(chessSnapshot(0, { seats: { white: null, black: null }, moves: [], turn: 'w', status: 'active' })));
	socket!.send(JSON.stringify({
		v: 1,
		type: 'members',
		members: [{ memberId: MY_ID, label: 'You', isHost: true, isSelf: true, muted: false }],
	}));
	await expect(page.locator('[data-chess-mode]')).toContainText('Room mode');
	await expect(page.locator('[data-chess-seats]')).toContainText('White: (open — first move claims it)');
	await expect(page.locator('[data-chess-resign]')).toBeHidden(); // no seat yet

	// First move claims white and ships as a CAS state proposal.
	await clickSquare(page, 'e2');
	await clickSquare(page, 'e4');
	await expect.poll(() => clientFrames.filter((frame) => frame.type === 'state').length).toBe(1);
	const first = clientFrames.find((frame) => frame.type === 'state') as { baseRevision: number; state: { moves: string[]; seats: Record<string, string | null> } };
	expect(first.baseRevision).toBe(0);
	expect(first.state.moves).toEqual(['e2e4']);
	expect(first.state.seats.white).toBe(MY_ID);

	// Authority ack: revision advances, seat held, resign becomes available.
	socket!.send(JSON.stringify({
		v: 1, type: 'state', revision: 1, connectedMembers: 1,
		state: { seats: { white: MY_ID, black: null }, moves: ['e2e4'], turn: 'b', status: 'active' },
	}));
	await expect(page.locator('[data-chess-status]')).toContainText('Black to move');
	await expect(page.locator('[data-chess-seats]')).toContainText('White: you');
	await expect(page.locator('[data-chess-resign]')).toBeVisible();
	await expect(page.locator('[data-square="e4"]')).toHaveAttribute('aria-label', 'e4, white pawn');

	// A rejection lands in the status line, not as a crash or silent drop.
	socket!.send(JSON.stringify({ v: 1, type: 'state_rejected', error: 'not_your_turn' }));
	await expect(page.locator('[data-chess-status]')).toContainText('Not your turn — wait for the other seat.');

	// Resign ships its own proposal shape.
	await page.locator('[data-chess-resign]').click();
	await expect.poll(() => clientFrames.some((frame) => frame.type === 'state' && (frame.state as Record<string, unknown>)?.resign === 'white')).toBe(true);
});

test('a room for a different game keeps the chess board read-only', async ({ page }) => {
	let socket: WebSocketRoute | null = null;
	await page.route('**/api/games/rooms', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ roomCode: ROOM_CODE, expiresAt: Date.now() + 7_200_000, capacity: 8 }),
	}));
	await page.routeWebSocket(/\/api\/games\/rooms\/[^/?]+\/ws/, (ws) => {
		socket = ws;
	});
	await page.goto('/projects/games/chess/');
	await page.locator('[data-room-join] [name="roomCode"]').fill(ROOM_CODE);
	await page.locator('[data-room-join]').getByRole('button', { name: 'Join or reconnect' }).click();
	await expect.poll(() => socket !== null).toBe(true);
	socket!.send(JSON.stringify(chessSnapshot(3, { hello: 'world' })).replace('"bnji.chess"', '"bnji.glass-minesweeper"'));

	await expect(page.locator('[data-chess-mode]')).toContainText('different game');
	await expect(page.locator('[data-chess-status]')).toContainText('not a chess room');
	// Selection is refused entirely.
	await clickSquare(page, 'e2');
	await expect(page.locator('[data-square="e2"]')).not.toHaveClass(/is-selected/);
});
