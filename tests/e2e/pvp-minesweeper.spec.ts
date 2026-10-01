/**
 * `bnji.pvp-minesweeper` browser surface (user-machine Playwright run).
 *
 * Sockets and APIs are mocked like the other specs — these assertions are
 * about client wiring: phases swap panels, placement budgets drive the
 * editor, race clicks ship full click lists, `action_result` field views
 * stay actor-only, a `hit_mine` denial reports the player out, and the
 * results screen claims an attested win. Server truth lives in
 * tests/pvp-minesweeper-adapter.test.ts (authority + redaction + verifier)
 * and tests/workerd/pvp-minesweeper.spec.ts (real DO).
 *
 * Run locally with `npm run test:e2e` — it does not run in the sandbox.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { msEncodeBitset, msSetMine } from '../../src/game/minesweeper-rules';

const ROOM_CODE = 'msR00mC0d3FoRTest!!!x'; // 22 chars, join-form constraints satisfied
const MY_ID = 'a'.repeat(24);
const OPPONENT_ID = 'b'.repeat(24);

const msSnapshot = (revision: number, state: Record<string, unknown>, gameId = 'bnji.pvp-minesweeper') => ({
	v: 1,
	type: 'snapshot',
	revision,
	gameId,
	state,
	connectedMembers: 2,
	isHost: true,
	hasHost: true,
});

const membersFrame = {
	v: 1,
	type: 'members',
	members: [
		{ memberId: MY_ID, label: 'You', isHost: true, isSelf: true, muted: false },
		{ memberId: OPPONENT_ID, label: 'Rival', isHost: false, isSelf: false, muted: false },
	],
};

/** Canonical quick-field bitset (5 bytes → base64) for mocked result reveals. */
const bitsetFor = (mines: number[]): string => {
	const field = new Uint8Array(5);
	for (const mine of mines) msSetMine(field, mine);
	return msEncodeBitset(field);
};

/** 6×6 quick field: mine at index 7 only, digits for the rest. */
const quickNumbers = (mines: number[]): number[] => {
	const counts = Array.from({ length: 36 }, () => -1);
	for (const mine of mines) counts[mine] = 1;
	return counts;
};

async function connectMockedRoom(page: Page, sockets: { current: WebSocketRoute | null }, frames: Array<Record<string, unknown>>): Promise<void> {
	await page.route('**/api/games/rooms', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ roomCode: ROOM_CODE, expiresAt: Date.now() + 7_200_000, capacity: 8 }),
	}));
	await page.routeWebSocket(/\/api\/games\/rooms\/[^/?]+\/ws/, (ws) => {
		sockets.current = ws;
		ws.onMessage((message) => {
			try { frames.push(JSON.parse(String(message)) as Record<string, unknown>); } catch { /* binary */ }
		});
	});
	await page.goto('/games/pvp-minesweeper/');
	await page.locator('[data-room-create]').getByRole('button', { name: 'Create a room' }).click();
	await expect.poll(() => sockets.current !== null).toBe(true);
}

test('boots into the lobby panel with a 36-cell board and a room-first status', async ({ page }) => {
	await page.goto('/games/pvp-minesweeper/');
	await expect(page.locator('[data-ms-board] button')).toHaveCount(36);
	await expect(page.locator('[data-ms-phase]')).toContainText('Not connected');
	await expect(page.locator('[data-ms-status]')).toContainText('needs a room');
	await expect(page.locator('[data-ms-start]')).toBeHidden();
	await expect(page.locator('[data-ms-panel="lobby"]')).toBeVisible();
});

test('room flow: start → vote → place budgets → race clicks → mine hit → results', async ({ page }) => {
	const sockets: { current: WebSocketRoute | null } = { current: null };
	const frames: Array<Record<string, unknown>> = [];
	await connectMockedRoom(page, sockets, frames);

	// Fresh lobby: the host's start button appears with the membership frame.
	sockets.current!.send(JSON.stringify(msSnapshot(0, { phase: 'lobby', phaseAt: Date.now(), round: 0, wins: {} })));
	sockets.current!.send(JSON.stringify(membersFrame));
	await expect(page.locator('[data-ms-phase]')).toContainText('Lobby');
	const start = page.locator('[data-ms-start]');
	await expect(start).toBeVisible();
	await start.click();
	await expect.poll(() => frames.some((frame) => frame.type === 'action' && frame.action === 'ms_start')).toBe(true);

	// Vote phase: three difficulty buttons, rival's vote broadcast, my vote ships as an action.
	sockets.current!.send(JSON.stringify({
		v: 1, type: 'action', action: 'ms_start', actor: MY_ID, revision: 1, connectedMembers: 2,
		state: { phase: 'vote', phaseAt: Date.now(), round: 1, votes: {}, wins: {} },
	}));
	await expect(page.locator('[data-ms-panel="vote"]')).toBeVisible();
	await page.locator('[data-ms-vote="quick"]').click();
	await expect.poll(() => frames.some((frame) => frame.type === 'action' && frame.action === 'ms_vote')).toBe(true);

	// Placement: the redacted broadcast never carries the opponent's mines; budgets are exact.
	sockets.current!.send(JSON.stringify({
		v: 1, type: 'action', action: 'ms_vote', actor: OPPONENT_ID, revision: 2, connectedMembers: 2,
		state: {
			phase: 'place', phaseAt: Date.now(), round: 1, difficulty: 'quick',
			roster: [MY_ID, OPPONENT_ID], ready: [], wins: {},
			votes: { [MY_ID]: 'quick', [OPPONENT_ID]: 'quick' },
		},
	}));
	await expect(page.locator('[data-ms-panel="place"]')).toBeVisible();
	await expect(page.locator('[data-ms-place-count]')).toContainText('0 / 5');
	const submit = page.locator('[data-ms-place-submit]');
	await expect(submit).toBeDisabled(); // budget not met yet
	const cells = page.locator('[data-ms-board] button');
	for (let cell = 1; cell <= 5; cell += 1) await cells.nth(cell).click();
	await expect(page.locator('[data-ms-place-count]')).toContainText('5 / 5');
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect.poll(() => frames.some((frame) => frame.type === 'action' && frame.action === 'ms_place')).toBe(true);
	expect(JSON.stringify(frames.find((frame) => frame.type === 'action' && frame.action === 'ms_place'))).toContain('"r":1');

	// Race opens (redacted state — no placements key) and the client asks for its private field view.
	sockets.current!.send(JSON.stringify({
		v: 1, type: 'action', action: 'ms_place', actor: OPPONENT_ID, revision: 3, connectedMembers: 2,
		state: { phase: 'race', phaseAt: Date.now(), round: 1, difficulty: 'quick', roster: [MY_ID, OPPONENT_ID], alive: [MY_ID, OPPONENT_ID], clicks: {}, wins: {} },
	}));
	await expect.poll(() => frames.some((frame) => frame.type === 'action' && frame.action === 'ms_sync')).toBe(true);
	sockets.current!.send(JSON.stringify({
		v: 1, type: 'action_result', action: 'ms_sync', revision: 3,
		reply: { size: 6, revealed: [], numbers: quickNumbers([7]) },
	}));
	await expect(page.locator('[data-ms-race-note]')).toContainText('safe cells left');

	// A safe click ships the full list and comes back acked with digits.
	await cells.nth(0).click();
	await expect.poll(() => frames.some((frame) => frame.type === 'action' && frame.action === 'ms_finish')).toBe(true);
	sockets.current!.send(JSON.stringify({
		v: 1, type: 'action_result', action: 'ms_finish', revision: 3,
		reply: { size: 6, revealed: [0], numbers: quickNumbers([7]) },
	}));
	await expect(cells.nth(0)).toHaveClass(/is-revealed/);

	// Clicking the mine: the denial turns the cell red and self-reports the elimination.
	await cells.nth(7).click();
	await expect.poll(() => frames.some((frame) => frame.type === 'action' && frame.action === 'ms_finish' && JSON.stringify(frame).includes('[0,7]'))).toBe(true);
	sockets.current!.send(JSON.stringify({ v: 1, type: 'action_rejected', action: 'ms_finish', error: 'hit_mine' }));
	await expect(page.locator('[data-ms-status]')).toContainText('Boom');
	await expect.poll(() => frames.some((frame) => frame.type === 'action' && frame.action === 'ms_die')).toBe(true);

	// Results (opponent eliminated me): minefields revealed, claim hidden for the loser.
	sockets.current!.send(JSON.stringify({
		v: 1, type: 'action', action: 'ms_die', actor: MY_ID, revision: 4, connectedMembers: 2,
		state: {
			phase: 'results', phaseAt: Date.now(), round: 1, difficulty: 'quick',
			roster: [MY_ID, OPPONENT_ID], wins: { [OPPONENT_ID]: 1 },
			results: {
				round: 1, difficulty: 'quick', winner: OPPONENT_ID, winnerHash: 'f'.repeat(64), reason: 'elimination',
				mineCells: { '0': bitsetFor([7]), '1': bitsetFor([]) },
			},
		},
	}));
	await expect(page.locator('[data-ms-result-note]')).toContainText('Rival won');
	await expect(page.locator('[data-ms-result-note]')).toContainText('last one standing');
	await expect(page.locator('[data-ms-claim]')).toBeHidden();
	await expect(cells.nth(7)).toHaveClass(/is-mine/);
});

test('winning results offer the attested leaderboard claim', async ({ page }) => {
	await page.route('**/api/games/scores', (route) => route.fulfill({
		status: 201,
		contentType: 'application/json',
		body: JSON.stringify({ ok: true, score: 3 }),
	}));
	const sockets: { current: WebSocketRoute | null } = { current: null };
	const frames: Array<Record<string, unknown>> = [];
	await connectMockedRoom(page, sockets, frames);
	sockets.current!.send(JSON.stringify(msSnapshot(0, { phase: 'lobby', phaseAt: Date.now(), round: 0, wins: {} })));
	sockets.current!.send(JSON.stringify(membersFrame));
	await expect(page.locator('[data-ms-start]')).toBeVisible();

	sockets.current!.send(JSON.stringify({
		v: 1, type: 'action', action: 'ms_finish', actor: MY_ID, revision: 7, connectedMembers: 2,
		state: {
			phase: 'results', phaseAt: Date.now(), round: 3, difficulty: 'normal',
			roster: [MY_ID, OPPONENT_ID], wins: { [MY_ID]: 2 },
			results: {
				round: 3, difficulty: 'normal', winner: MY_ID, winnerHash: 'e'.repeat(64), reason: 'clear',
				mineCells: { '0': bitsetFor([3, 4]), '1': bitsetFor([10]) },
			},
		},
	}));
	await expect.poll(() => page.locator('[data-game-shell]').getAttribute('data-game-state')).toBe('results');
	const claim = page.locator('[data-ms-claim]');
	await expect(claim).toBeVisible();
	await expect(page.locator('[data-ms-claim-note]')).toContainText('win 3');
	await claim.locator('[name="displayName"]').fill('Mine Mapper');
	await claim.getByRole('button', { name: 'Submit win claim' }).click();
	await expect(page.locator('[data-ms-claim-status]')).toContainText('Win recorded: 3');
});
