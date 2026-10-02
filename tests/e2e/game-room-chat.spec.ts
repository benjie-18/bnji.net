/**
 * Chat plan Phase B — room chat (browser surface).
 *
 * The socket is mocked with `page.routeWebSocket` and room creation with
 * `page.route`, exactly like the account specs mock their APIs: these
 * assertions are about wiring — the chat panel's frames (history, dedupe,
 * tombstones, rejections), the outbound `chat` payload, the disclosure copy
 * and accessibility — while D1/DO behaviour is covered by
 * tests/room-chat.test.ts and tests/workerd/room-chat.spec.ts.
 *
 * Needs a local Playwright run (`npm run test:e2e`) before deploy; it does
 * not run in this sandbox (astro dev has no DO binding).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type WebSocketRoute } from '@playwright/test';

const ROOM_CODE = 'hT3sIstHisAroomCod3xXx'; // 22 chars, join-form constraints satisfied

const snapshotFrame = {
	v: 1,
	type: 'snapshot',
	revision: 0,
	gameId: 'bnji.glass-minesweeper',
	state: {},
	connectedMembers: 1,
	members: 1,
	capacity: 4,
	isHost: true,
	hasHost: true,
	expiresAt: Date.now() + 7_200_000,
	accepted: false,
};

test('room chat joins, renders history with dedupe and tombstones, sends frames, and surfaces rejections', async ({ page }) => {
	let socket: WebSocketRoute | null = null;
	const clientFrames: Array<Record<string, unknown>> = [];
	await page.route('**/api/games/rooms', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ roomCode: ROOM_CODE, expiresAt: Date.now() + 7_200_000, capacity: 4 }),
	}));
	await page.routeWebSocket(/\/api\/games\/rooms\/[^/?]+\/ws/, (ws) => {
		socket = ws;
		ws.onMessage((message) => {
			try { clientFrames.push(JSON.parse(String(message)) as Record<string, unknown>); } catch { /* binary */ }
		});
	});

	await page.goto('/games/');
	const note = page.locator('.room-tools__chat-note');
	await expect(note).toContainText('visible to room members');
	await expect(note).toContainText('up to 2 hours');
	await expect(note).not.toContainText('not encrypted');
	await expect(note).not.toContainText('reports are kept for review');

	await page.locator('[data-room-create]').getByRole('button', { name: 'Create a room' }).click();
	await expect.poll(() => socket !== null).toBe(true);
	socket!.send(JSON.stringify(snapshotFrame));

	const status = page.locator('[data-chat-status]');
	await expect(status).toContainText('Connected to chat.');
	const input = page.locator('#chat-input');
	await expect(input).toBeEnabled();

	// History → rendered; a duplicated n is deduped, not doubled.
	socket!.send(JSON.stringify({
		v: 1,
		type: 'chat_history',
		messages: [{ v: 1, type: 'chat', n: 1, label: 'Alice', text: 'first message', at: Date.now() - 60_000, mine: false }],
		more: false,
	}));
	socket!.send(JSON.stringify({ v: 1, type: 'chat', n: 1, label: 'Alice', text: 'first message', at: Date.now() - 60_000, mine: false }));
	const list = page.locator('[data-chat-messages]');
	await expect(list.locator('li')).toHaveCount(1);
	socket!.send(JSON.stringify({ v: 1, type: 'chat', n: 2, label: 'Bob', text: 'second message', at: Date.now(), mine: false }));
	await expect(list.locator('li')).toHaveCount(2);
	await expect(list).toContainText('second message');

	// Tombstone repaints the existing row instead of growing the list.
	socket!.send(JSON.stringify({ v: 1, type: 'chat_delete', n: 2, source: 'host' }));
	await expect(list.locator('li')).toHaveCount(2);
	await expect(list).toContainText('Room host removed a message');
	await expect(list).not.toContainText('second message');

	// Rejection copy (rate limit) lands in the status line, not as a message.
	socket!.send(JSON.stringify({ v: 1, type: 'chat_rejected', error: 'rate_limited', retryAfterMs: 4_000 }));
	await expect(status).toContainText('Slow down — try again in 4 seconds.');

	// Roster frame renders the member list.
	socket!.send(JSON.stringify({
		v: 1,
		type: 'members',
		members: [
			{ memberId: 'a'.repeat(24), label: 'You', isHost: true, isSelf: true, muted: false },
			{ memberId: 'b'.repeat(24), label: 'Bob', isHost: false, isSelf: false, muted: false },
		],
	}));
	await expect(page.locator('[data-chat-roster]')).toBeVisible();
	await expect(page.locator('[data-chat-roster]')).toContainText('Bob');

	// Submitting the form emits exactly the named client frame, then clears.
	await input.fill('hello room');
	await page.locator('[data-chat-form]').getByRole('button', { name: 'Send' }).click();
	await expect.poll(() => clientFrames.length).toBeGreaterThan(0);
	expect(clientFrames.at(-1)).toEqual({ v: 1, type: 'chat', text: 'hello room' });
	await expect(input).toHaveValue('');

	// Own message echo (mine) renders and offers Delete.
	socket!.send(JSON.stringify({ v: 1, type: 'chat', n: 3, label: 'You', text: 'hello room', at: Date.now(), mine: true }));
	await expect(list.locator('li')).toHaveCount(3);
	await expect(list.getByRole('button', { name: 'Delete' })).toBeVisible();

	// Phase C: someone else's message offers Report; the POST carries room + n.
	let reportBody: unknown = null;
	await page.route('**/api/chat/report', async (route) => {
		reportBody = route.request().postDataJSON();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
	});
	socket!.send(JSON.stringify({ v: 1, type: 'chat', n: 4, label: 'Mallory', text: 'report bait', at: Date.now(), mine: false }));
	const reportRow = list.locator('li', { hasText: 'report bait' });
	await reportRow.getByRole('button', { name: 'Report' }).click();
	await expect(status).toContainText('sent to the moderators for review');
	await expect.poll(() => reportBody).toEqual({ code: ROOM_CODE, n: 4 });

	// Admin tombstone copy (source 'admin') paints over the row.
	socket!.send(JSON.stringify({ v: 1, type: 'chat', n: 5, label: 'Mallory', text: 'bad link', at: Date.now(), mine: false }));
	await expect(list.locator('li')).toHaveCount(5);
	socket!.send(JSON.stringify({ v: 1, type: 'chat_delete', n: 5, source: 'admin' }));
	await expect(list).toContainText('An administrator removed a message');
	await expect(list).not.toContainText('bad link');

	// Blocked-term rejection copy lands in the status line.
	socket!.send(JSON.stringify({ v: 1, type: 'chat_rejected', error: 'blocked' }));
	await expect(status).toContainText('word filter');

	const results = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	expect(results.violations.map(({ id, impact, description, nodes }) => ({
		id,
		impact,
		description,
		nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
	})), 'axe detected accessibility violations').toEqual([]);
});

test('closing the room socket disables chat and explains how to resume', async ({ page }) => {
	let socket: WebSocketRoute | null = null;
	await page.route('**/api/games/rooms', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ roomCode: ROOM_CODE, expiresAt: Date.now() + 7_200_000, capacity: 4 }),
	}));
	await page.routeWebSocket(/\/api\/games\/rooms\/[^/?]+\/ws/, (ws) => {
		socket = ws;
	});

	await page.goto('/games/');
	await page.locator('[data-room-create]').getByRole('button', { name: 'Create a room' }).click();
	await expect.poll(() => socket !== null).toBe(true);
	socket!.send(JSON.stringify(snapshotFrame));
	await expect(page.locator('[data-chat-status]')).toContainText('Connected to chat.');
	await expect(page.locator('#chat-input')).toBeEnabled();

	socket!.close({ code: 4003, reason: 'Kicked by host' });
	await expect(page.locator('[data-chat-status]')).toContainText('Room connection closed.');
	await expect(page.locator('#chat-input')).toBeDisabled();
});
