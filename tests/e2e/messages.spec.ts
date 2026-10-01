/**
 * Chat plan Phase D — /messages/ (browser surface).
 *
 * Mocked APIs with `page.route` and the live socket with `page.routeWebSocket`,
 * exactly like the account specs and tests/e2e/game-room-chat.spec.ts: these
 * assertions are about wiring — the disclosure copy, the account gate, list +
 * thread rendering (textContent-only), the exact POST bodies for send / read /
 * hide / report / start-by-handle, live-frame handling — while D1 behaviour is
 * locked by tests/dm-messaging.test.ts and the DO by
 * tests/workerd/dm-conversation.spec.ts.
 *
 * Needs a local Playwright run (`npm run test:e2e`); it does not run in this
 * sandbox (astro dev has no DO/D1 bindings — everything here is mocked).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type WebSocketRoute } from '@playwright/test';

const CONV_ID = 'ab'.repeat(32);
const CONV_ID_2 = 'cd'.repeat(32);
const NOW = 1_760_000_000_000;

const config = {
	retentionDays: 60,
	maxTextLength: 2_000,
	images: { enabled: true, maxEdge: 1600, maxDecodedBytes: 1_400_000, allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] },
};

const conversationsFixture = [
	{
		id: CONV_ID,
		partner: { handle: 'friend_one', displayName: 'Friend One' },
		mySide: 'lo',
		lastSeq: 2,
		myReadSeq: 1,
		partnerReadSeq: 0,
		unread: 1,
		updatedAt: NOW,
		preview: { body: 'See this', hasImage: false, fromMe: false, at: NOW },
	},
];

const historyFixture = {
	messages: [
		{ n: 1, from: 'me', body: 'hello there', imageId: null, at: NOW - 60_000 },
		{ n: 2, from: 'them', body: 'See this', imageId: null, at: NOW },
	],
	myReadSeq: 1,
	partnerReadSeq: 0,
	lastSeq: 2,
};

function mockDmApi(page: import('@playwright/test').Page, options: { authenticated?: boolean } = {}): {
	sentBodies: Array<Record<string, unknown>>;
	readBodies: Array<Record<string, unknown>>;
	hideBodies: Array<Record<string, unknown>>;
	reportBodies: Array<Record<string, unknown>>;
	openBodies: Array<Record<string, unknown>>;
} {
	const authenticated = options.authenticated ?? true;
	const sentBodies: Array<Record<string, unknown>> = [];
	const readBodies: Array<Record<string, unknown>> = [];
	const hideBodies: Array<Record<string, unknown>> = [];
	const reportBodies: Array<Record<string, unknown>> = [];
	const openBodies: Array<Record<string, unknown>> = [];

	void page.route('**/api/games/account', (route) => route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(authenticated
			? { authenticated: true, displayName: 'Player One', saveCount: 0, handle: 'me_two' }
			: { authenticated: false }),
	}));
	void page.route('**/api/dm/conversations*', (route) => {
		if (route.request().method() === 'POST') {
			const body = route.request().postDataJSON() as Record<string, unknown>;
			openBodies.push(body);
			void route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					conversation: {
						id: CONV_ID_2,
						mySide: 'lo',
						partner: { handle: String(body.handle ?? ''), displayName: 'Friend Two' },
						exists: false,
					},
				}),
			});
			return;
		}
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ conversations: conversationsFixture, config }),
		});
	});
	void page.route('**/api/dm/messages*', (route) => {
		const url = new URL(route.request().url());
		if (route.request().method() === 'POST') {
			const body = route.request().postDataJSON() as Record<string, unknown>;
			sentBodies.push(body);
			void route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					message: {
						n: 3,
						from: 'me',
						body: typeof body.body === 'string' ? body.body : '',
						imageId: typeof body.imageId === 'string' ? body.imageId : null,
						at: NOW + 1_000,
					},
				}),
			});
			return;
		}
		const conversation = url.searchParams.get('conversation');
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(conversation === CONV_ID_2
				? { messages: [], myReadSeq: 0, partnerReadSeq: 0, lastSeq: 0 }
				: historyFixture),
		});
	});
	void page.route('**/api/dm/read', (route) => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		readBodies.push(body);
		void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ readSeq: 2 }) });
	});
	void page.route('**/api/dm/hide', (route) => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		hideBodies.push(body);
		void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hidden: true }) });
	});
	void page.route('**/api/dm/report', (route) => {
		const body = route.request().postDataJSON() as Record<string, unknown>;
		reportBodies.push(body);
		void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reported: true, reportCount: 1 }) });
	});
	return { sentBodies, readBodies, hideBodies, reportBodies, openBodies };
}

test('the messages page discloses, lists, threads, sends, and handles live frames', async ({ page }) => {
	const posts = mockDmApi(page);
	let socket: WebSocketRoute | null = null;
	await page.routeWebSocket(/\/api\/dm\/ws/, (ws) => {
		socket = ws;
	});

	await page.goto('/messages/');
	await expect(page.locator('[data-dm-status]')).toContainText('Signed in as Player One. 1 conversation(s).');

	// §12.6 + owner answer D10: what is stored, who can read it, no E2E implication.
	const disclosure = page.locator('[data-dm-disclosure]');
	await expect(disclosure).toContainText('60 days');
	await expect(disclosure).toContainText('Moderators only read a message if it is reported');
	await expect(disclosure).toContainText('does not use end-to-end encryption');

	// List: partner identity as handle + label, preview, unread badge.
	const item = page.locator('[data-dm-list] button');
	await expect(item).toHaveCount(1);
	await expect(item).toContainText('Friend One @friend_one');
	await expect(item).toContainText('See this');
	await expect(item.locator('[data-dm-unread]')).toHaveText('1');

	// Open the thread: history rendered as me/them, seen hidden (partner at 0).
	await item.click();
	await expect(page.locator('[data-dm-thread] li')).toHaveCount(2);
	await expect(page.locator('[data-dm-n="1"]')).toHaveClass(/dm-msg--me/);
	await expect(page.locator('[data-dm-n="2"]')).not.toHaveClass(/dm-msg--me/);
	await expect(page.locator('[data-dm-n="1"] .dm-msg__body')).toHaveText('hello there');
	await expect(page.locator('[data-dm-seen]')).toBeHidden();
	await expect(page.locator('[data-dm-partner]')).toContainText('Friend One @friend_one');
	await expect.poll(() => posts.readBodies.length).toBeGreaterThan(0);
	expect(posts.readBodies[0]).toEqual({ conversation: CONV_ID });

	// Live socket connects and reports status.
	await expect.poll(() => socket !== null).toBe(true);
	socket!.send(JSON.stringify({ t: 'dm_ready', v: 1 }));
	await expect(page.locator('[data-dm-conn]')).toContainText('Connected.');

	// Send: exact POST body, optimistic append, status copy.
	await page.locator('[data-dm-text]').fill('hi back');
	await page.locator('[data-dm-send]').click();
	await expect(page.locator('[data-dm-n="3"]')).toHaveClass(/dm-msg--me/);
	await expect(page.locator('[data-dm-status]')).toContainText('Message sent.');
	expect(posts.sentBodies[0]).toEqual({ conversation: CONV_ID, body: 'hi back' });

	// Incoming live frame appends for the partner side.
	socket!.send(JSON.stringify({ t: 'dm_new', v: 1, m: { n: 4, senderSide: 'hi', body: 'live frame', imageId: null, at: NOW + 2_000 } }));
	await expect(page.locator('[data-dm-n="4"]')).toHaveText(/live frame/);
	await expect(page.locator('[data-dm-n="4"]')).not.toHaveClass(/dm-msg--me/);

	// Read frame refreshes the seen indicator.
	socket!.send(JSON.stringify({ t: 'dm_read', v: 1, side: 'hi', seq: 4 }));
	await expect(page.locator('[data-dm-seen="1"]')).toBeVisible();

	// Report: non-author only, POST shape + §12.5-adjacent status copy.
	await page.locator('[data-dm-report="2"]').click();
	await expect(page.locator('[data-dm-status]')).toContainText('sent to the moderators for review');
	expect(posts.reportBodies[0]).toEqual({ conversation: CONV_ID, n: 2 });

	// Delete-for-me removes from this viewer only (D12).
	await page.locator('[data-dm-hide="1"]').click();
	await expect(page.locator('[data-dm-n="1"]')).toHaveCount(0);
	await expect(page.locator('[data-dm-status]')).toContainText('Removed from your view.');
	expect(posts.hideBodies[0]).toEqual({ conversation: CONV_ID, n: 1 });

	// Attach control exists and is wired (config-driven; canvas path is unit-covered).
	await expect(page.locator('[data-dm-image-input]')).toBeAttached();

	// New conversation: exact handle only, no directory.
	await page.locator('[data-dm-new-handle]').fill('friend_two');
	await page.locator('[data-dm-new-form]').evaluate((form) => (form as HTMLFormElement).requestSubmit());
	await expect.poll(() => posts.openBodies.length).toBe(1);
	expect(posts.openBodies[0]).toEqual({ handle: 'friend_two' });
	await expect(page.locator('[data-dm-partner]')).toContainText('Friend Two');
	await expect(page.locator('[data-dm-thread] li')).toHaveCount(0);

	const violations = await new AxeBuilder({ page }).analyze();
	expect(violations.violations.map((violation) => ({
		id: violation.id,
		nodes: violation.nodes.map((node) => node.target),
	})), 'axe detected accessibility violations').toEqual([]);
});

test('signed-out visitors get the account gate and no conversation surface', async ({ page }) => {
	mockDmApi(page, { authenticated: false });
	await page.goto('/messages/');
	await expect(page.locator('[data-dm-status]')).toContainText('Sign in to see your messages.');
	await expect(page.locator('[data-dm-signin]')).toBeVisible();
	await expect(page.locator('[data-dm-signin]')).toContainText('Create one on the Games page');
	await expect(page.locator('[data-dm-signed-in]')).toBeHidden();

	const violations = await new AxeBuilder({ page }).analyze();
	expect(violations.violations.map((violation) => violation.id), 'axe detected accessibility violations').toEqual([]);
});
