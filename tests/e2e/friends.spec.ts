/**
 * Chat plan Phase E — /friends/ (browser surface).
 *
 * Mocked APIs with `page.route` and the live presence socket with
 * `page.routeWebSocket`, exactly like tests/e2e/messages.spec.ts: these
 * assertions are about wiring — the account gate, the disclosure copy, list
 * rendering, the exact POST/DELETE bodies for every action, error copy,
 * online dots fed by the Presence socket, and the header badge — while D1
 * behaviour is locked by tests/friends.test.ts and the DO by
 * tests/workerd/presence.spec.ts.
 *
 * Needs a local Playwright run (`npm run test:e2e`); it does not run in this
 * sandbox (astro dev has no DO/D1 bindings — everything here is mocked).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type WebSocketRoute } from '@playwright/test';

const NOW = 1_760_000_000_000;

const listsFixture = {
	incoming: [{ handle: 'pending_one', displayName: 'Pending One', since: NOW }],
	friends: [{ handle: 'pal_one', displayName: 'Pal One', since: NOW }],
	outgoing: [{ handle: 'sent_one', displayName: 'Sent One', since: NOW }],
	blocked: [],
	config: { maxFriends: 500, maxPendingOutgoing: 100 },
};

function mockFriendsApi(page: import('@playwright/test').Page, options: { authenticated?: boolean; failPost?: number; failError?: string } = {}): {
	postBodies: Array<Record<string, unknown>>;
	deleteBodies: Array<Record<string, unknown>>;
} {
	const authenticated = options.authenticated ?? true;
	const postBodies: Array<Record<string, unknown>> = [];
	const deleteBodies: Array<Record<string, unknown>> = [];

	void page.route('**/api/games/account', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(authenticated ? { authenticated: true, displayName: 'Player One', saveCount: 0, handle: 'me_two' } : { authenticated: false }),
	}));

	void page.route('**/api/friends', (route) => {
		const method = route.request().method();
		if (method === 'POST' || method === 'DELETE') {
			const body = route.request().postDataJSON() as Record<string, unknown>;
			(method === 'POST' ? postBodies : deleteBodies).push(body);
			if (options.failPost) {
				void route.fulfill({
					status: options.failPost,
					contentType: 'application/json',
					body: JSON.stringify({ error: options.failError ?? 'rate_limited' }),
				});
				return;
			}
			// Happy path: accept moves the row, everything else echoes the fixture.
			const lists = structuredClone(listsFixture) as typeof listsFixture;
			if (body.action === 'accept' && typeof body.handle === 'string') {
				lists.incoming = lists.incoming.filter((row) => row.handle !== body.handle);
				lists.friends = [...lists.friends, { handle: body.handle, displayName: 'Pending One', since: NOW }];
			}
			if (body.action === 'request' && typeof body.handle === 'string') {
				lists.outgoing = [...lists.outgoing, { handle: body.handle, displayName: body.handle, since: NOW }];
			}
			void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ changed: String(body.action ?? 'ok'), ...lists }) });
			return;
		}
		if (!authenticated) {
			void route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'authentication_required' }) });
			return;
		}
		void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listsFixture) });
	});
	return { postBodies, deleteBodies };
}

test('the friends page discloses, lists, and sends the exact action bodies', async ({ page }) => {
	const { postBodies, deleteBodies } = mockFriendsApi(page);
	await page.goto('/friends/');

	// The saved account data is identified before any interaction.
	const disclosure = page.locator('.friends-disclosure');
	await expect(disclosure).toHaveText('Friend requests and blocks are saved to your account.');
	await expect(disclosure).not.toContainText('included in your account export');
	await expect(disclosure).not.toContainText('friend list is private');

	// Lists render from GET — three sections populated, empty states hidden.
	await expect(page.locator('[data-friends-list="incoming"] li')).toHaveCount(1);
	await expect(page.locator('[data-friends-list="friends"] li')).toHaveCount(1);
	await expect(page.locator('[data-friends-list="outgoing"] li')).toHaveCount(1);
	await expect(page.locator('[data-friends-empty="incoming"]')).toBeHidden();

	// Request by exact handle → the exact POST body (plan §10 vocabulary).
	await page.locator('[data-friends-request-handle]').fill('new_pal');
	await page.locator('[data-friends-request-form] button[type="submit"]').click();
	await expect.poll(() => postBodies.find((body) => body.action === 'request')).toEqual({ action: 'request', handle: 'new_pal' });

	// Accept on the incoming row → exact body, row moves into Friends.
	await page.locator('[data-friends-list="incoming"] [data-friend-action="accept"]').click();
	await expect.poll(() => postBodies.filter((body) => body.action === 'accept')).toEqual([{ action: 'accept', handle: 'pending_one' }]);

	// Remove on a friend row → DELETE body.
	await page.locator('[data-friends-list="friends"] [data-friend-action="remove"]').first().click();
	await expect.poll(() => deleteBodies).toEqual([{ action: 'remove', handle: 'pal_one' }]);

	// Cancel on an outgoing request → DELETE remove (the sender's cancel leg).
	await page.locator('[data-friends-list="outgoing"] [data-friend-action="remove"]').click();
	await expect.poll(() => deleteBodies.filter((body) => body.handle === 'sent_one')).toEqual([
		{ action: 'remove', handle: 'sent_one' },
	]);

	const violations = await new AxeBuilder({ page }).analyze();
	expect(violations.violations.map((violation) => violation.id), 'axe detected accessibility violations').toEqual([]);
});

test('action failures surface the client error copy, not a spinner', async ({ page }) => {
	mockFriendsApi(page, { failPost: 429, failError: 'rate_limited' });
	await page.goto('/friends/');
	await page.locator('[data-friends-request-handle]').fill('somebody');
	await page.locator('[data-friends-request-form] button[type="submit"]').click();
	await expect(page.locator('[data-friends-status]')).toContainText('Slow down a little and try again.');
});

test('signed-out visitors get the account gate and no friend surface', async ({ page }) => {
	mockFriendsApi(page, { authenticated: false });
	await page.goto('/friends/');
	await expect(page.locator('[data-friends-signin]')).toBeVisible();
	await expect(page.locator('[data-friends-signed-in]')).toBeHidden();
	const violations = await new AxeBuilder({ page }).analyze();
	expect(violations.violations.map((violation) => violation.id), 'axe detected accessibility violations').toEqual([]);
});

test('online dots follow the presence socket: snapshot in, change updates', async ({ page }) => {
	mockFriendsApi(page);
	let socket: WebSocketRoute | null = null;
	await page.routeWebSocket(/\/api\/presence/, (ws) => { socket = ws; });

	await page.goto('/friends/');
	expect(socket, 'the page dials presence after the lists load').not.toBeNull();

	const dot = page.locator('[data-friend-online="pal_one"]');
	await expect(dot).toBeHidden();
	// Snapshot: pal_one is online among MY friends (§8.1 visibility, server-minted).
	await socket!.send(JSON.stringify({ t: 'presence_snapshot', v: 1, handles: ['pal_one'] }));
	await expect(dot).toBeVisible();
	await expect(dot).toHaveAttribute('aria-label', 'pal_one is online');

	// A later change flips just that handle.
	await socket!.send(JSON.stringify({ t: 'presence_change', v: 1, handle: 'pal_one', online: false }));
	await expect(dot).toBeHidden();
	// The client's keep-alive ping gets a pong (no server heartbeat, §8.2).
	await socket!.send(JSON.stringify({ t: 'pong' }));
});

test('the header badge shows one honest total and deep-links to the right page', async ({ page }) => {
	mockFriendsApi(page);
	await page.route('**/api/notifications', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ unreadMessages: 2, pendingFriendRequests: 1 }),
	}));
	await page.goto('/friends/');

	const badge = page.locator('[data-notif-badge]');
	await expect(badge).toBeVisible();
	await expect(badge).toContainText('3');
	await expect(badge).toHaveAttribute('href', '/friends/');
	await expect(badge).toHaveAttribute('aria-label', 'Notifications: 2 unread messages, 1 pending friend request');

	// Zero → hidden: the badge never claims unwired or stale counts (§8.3).
	await page.unroute('**/api/notifications');
	await page.route('**/api/notifications', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify({ unreadMessages: 0, pendingFriendRequests: 0 }),
	}));
	await page.goto('/messages/');
	await page.reload();
	await expect(badge).toBeHidden();
});
