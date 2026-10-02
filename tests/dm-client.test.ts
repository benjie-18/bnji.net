/**
 * Chat plan Phase D — /messages/ browser-surface integration (user report
 * 2026-10-01: "tried locally… it didn't work although I could sign in").
 *
 * The e2e spec needs Playwright; this file closes the gap in between: the
 * REAL markup parsed from src/pages/messages.astro, the REAL client module
 * (mountMessages), and the REAL route handlers over the real migration SQL —
 * driven through the same event sequence a browser performs (form submits,
 * clicks, WebSocket frames). jsdom is a dev-only dependency (Tier A,
 * DEPENDENCY-POLICY) and never ships.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { JSDOM } from 'jsdom';
import { createTestD1 } from './support/d1.mjs';
import { decodedBase64ByteLength, mountMessages } from '../src/scripts/messages-ui';
import { DM_CONFIG } from '../src/config/dm.config';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const accountApi = await import('../src/pages/api/games/account.ts');
const conversationsApi = await import('../src/pages/api/dm/conversations.ts');
const messagesApi = await import('../src/pages/api/dm/messages.ts');
const readApi = await import('../src/pages/api/dm/read.ts');
const hideApi = await import('../src/pages/api/dm/hide.ts');
const reportApi = await import('../src/pages/api/dm/report.ts');
const attachmentsApi = await import('../src/pages/api/dm/attachments.ts');

const ORIGIN = 'http://localhost:8787';

/* ------------------------------------------------------------- harness */

type PushedFrame = { frame: Record<string, unknown> };

function database() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	const pushes: PushedFrame[] = [];
	(globalThis as Record<string, unknown>).__BNJI_TEST_BINDINGS__ = {
		BOARD_DB: db,
		DM_CONVERSATIONS: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (request: Request) => {
					pushes.push(await request.json() as PushedFrame);
					return new Response('{}', { status: 200 });
				},
			}),
		},
	};
	(globalThis as Record<string, unknown>).__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'dm-client-secret' };
	return { db, pushes };
}

function requestContext(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string; query?: string } = {}): APIContext {
	const url = `http://localhost${path}${options.query ?? ''}`;
	const headers = new Headers({ origin: options.origin ?? 'http://localhost' });
	if (options.cookie) headers.set('cookie', options.cookie);
	if (options.ip) headers.set('cf-connecting-ip', options.ip);
	if (options.body !== undefined) headers.set('content-type', 'application/json');
	const body = options.body === undefined ? undefined : JSON.stringify(options.body);
	const request = new Request(url, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
	return { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
}

function cookieValue(response: Response, name: string): string {
	const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
	const cookie = list.find((item) => item.startsWith(`${name}=`));
	assert.ok(cookie, `missing ${name} Set-Cookie`);
	return cookie!.slice(name.length + 1).split(';', 1)[0];
}

async function createAccount(guest: string, name: string, ip: string): Promise<string> {
	const response = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: `bnji_ps=${guest}`, body: { action: 'create', displayName: name }, ip }));
	assert.equal(response.status, 201, await response.clone().text());
	return `bnji_ps=${guest}; bnji_ga=${cookieValue(response, 'bnji_ga')}`;
}

async function claimHandle(cookie: string, handle: string, ip: string): Promise<void> {
	const response = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie, body: { action: 'set-handle', handle }, ip }));
	assert.equal(response.status, 200, await response.clone().text());
}

/** Phase E (plan D7): open-by-handle needs an accepted friendship first. */
function makeFriends(db: { raw: ReturnType<typeof createTestD1>['raw'] }, nameA: string, nameB: string): void {
	const ids = db.raw.prepare('SELECT id FROM game_players WHERE display_name IN (?, ?)').all(nameA, nameB) as Array<{ id: string }>;
	assert.equal(ids.length, 2, 'both accounts exist');
	const [a, b] = ids.map((row) => row.id).sort();
	db.raw.prepare(
		"INSERT INTO player_friends (player_a, player_b, state, requested_by, created_at, updated_at) VALUES (?, ?, 'accepted', ?, ?, ?)",
	).run(a, b, a, Date.now(), Date.now());
}

/* ------------------------------------------------- DOM + transport fakes */

/** Parsed from the real page source — the wiring contract is the markup itself. */
function realMessagesDom(query = ''): JSDOM {
	const source = readFileSync(new URL('../src/pages/messages.astro', import.meta.url), 'utf8');
	const parts = source.split('---');
	const markup = parts.length >= 3 ? parts[2] : source;
	return new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, { url: `${ORIGIN}/messages/${query}` });
}

type FakeSocket = {
	url: string;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	closed: boolean;
	send(payload: string): void;
	close(): void;
};

let sockets: FakeSocket[] = [];

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	readyState = 1;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	private closed = false;
	private readonly me: FakeSocket;

	constructor(url: string) {
		const self = this as unknown as FakeSocket & FakeWebSocket;
		this.me = self;
		(self as { url: string }).url = url;
		sockets.push(self);
		// The route accepted the upgrade: greet like the real DO does.
		setTimeout(() => {
			if (this.closed) return;
			this.onopen?.({});
			this.onmessage?.({ data: JSON.stringify({ t: 'dm_ready', v: 1 }) });
		}, 0);
	}

	send(_payload: string): void { /* client only sends ping */ }

	close(): void {
		if (this.closed) return;
		this.closed = true;
		(this.me as { closed: boolean }).closed = true;
		this.onclose?.({});
	}
}

let activeCookie: string | null = null;

/** Dispatch the client's relative fetches to the real route handlers. */
async function fetchShim(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
	const url = new URL(raw, ORIGIN);
	const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	headers.set('origin', ORIGIN);
	if (activeCookie) headers.set('cookie', activeCookie);
	const body = typeof init?.body === 'string' ? init.body : undefined;
	const context = (): APIContext => {
		const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
		return { request, url, params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
	};
	const path = url.pathname;
	if (path === '/api/games/account' && method === 'GET') return accountApi.GET(context());
	if (path === '/api/dm/conversations' && method === 'GET') return conversationsApi.GET(context());
	if (path === '/api/dm/conversations' && method === 'POST') return conversationsApi.POST(context());
	if (path === '/api/dm/messages' && method === 'GET') return messagesApi.GET(context());
	if (path === '/api/dm/messages' && method === 'POST') return messagesApi.POST(context());
	if (path === '/api/dm/read' && method === 'POST') return readApi.POST(context());
	if (path === '/api/dm/hide' && method === 'POST') return hideApi.POST(context());
	if (path === '/api/dm/report' && method === 'POST') return reportApi.POST(context());
	if (path === '/api/dm/attachments' && method === 'POST') return attachmentsApi.POST(context());
	throw new Error(`unrouted fetch in dm-client test: ${method} ${path}`);
}

function installGlobals(dom: JSDOM): void {
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	g.WebSocket = FakeWebSocket;
	g.fetch = fetchShim;
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, timeoutMs = 1_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await tick(5);
	return check();
}

async function mountFreshDom(query = ''): Promise<JSDOM> {
	const dom = realMessagesDom(query);
	installGlobals(dom);
	sockets = [];
	const root = dom.window.document.querySelector('[data-messages-root]');
	assert.ok(root, 'the page carries data-messages-root');
	await mountMessages(root as unknown as HTMLElement);
	await tick();
	return dom;
}

const byAttr = (dom: JSDOM, name: string): HTMLElement => {
	const node = dom.window.document.querySelector(`[data-${name}]`);
	assert.ok(node, `missing [data-${name}] in real markup`);
	return node as unknown as HTMLElement;
};

/** Make canvas normalization deterministic without relying on jsdom's canvas implementation. */
function mockCanvasOutput(dom: JSDOM, output: Uint8Array, onDecode: () => void = () => {}): () => void {
	const prototype = dom.window.HTMLCanvasElement.prototype;
	const contextDescriptor = Object.getOwnPropertyDescriptor(prototype, 'getContext');
	const blobDescriptor = Object.getOwnPropertyDescriptor(prototype, 'toBlob');
	const originalCreateImageBitmap = globalThis.createImageBitmap;
	globalThis.createImageBitmap = (async () => {
		onDecode();
		return { width: 1, height: 1, close() {} };
	}) as unknown as typeof createImageBitmap;
	Object.defineProperty(prototype, 'getContext', { configurable: true, value: () => ({ drawImage() {} }) });
	Object.defineProperty(prototype, 'toBlob', {
		configurable: true,
		value: (callback: BlobCallback) => callback(new Blob([output.slice().buffer as ArrayBuffer], { type: 'image/webp' })),
	});
	return () => {
		globalThis.createImageBitmap = originalCreateImageBitmap;
		if (contextDescriptor) Object.defineProperty(prototype, 'getContext', contextDescriptor);
		else Reflect.deleteProperty(prototype, 'getContext');
		if (blobDescriptor) Object.defineProperty(prototype, 'toBlob', blobDescriptor);
		else Reflect.deleteProperty(prototype, 'toBlob');
	};
}

const GUEST_ONE = '11111111111111111111111111111111';
const GUEST_TWO = '22222222222222222222222222222222';

async function createUnreadConversation(input: {
	nameA: string; handleA: string; nameB: string; handleB: string; ipSuffix: string;
}): Promise<{ db: ReturnType<typeof database>['db']; alice: string; bob: string; conversationId: string; mySide: 'lo' | 'hi'; partnerSide: 'lo' | 'hi' }> {
	const { db } = database();
	const ipA = `203.0.113.${input.ipSuffix}`;
	const ipB = `203.0.114.${input.ipSuffix}`;
	const alice = await createAccount(GUEST_ONE, input.nameA, ipA);
	const bob = await createAccount(GUEST_TWO, input.nameB, ipB);
	await claimHandle(alice, input.handleA, ipA);
	await claimHandle(bob, input.handleB, ipB);
	makeFriends(db, input.nameA, input.nameB);
	const opened = await conversationsApi.POST(requestContext('/api/dm/conversations', {
		method: 'POST', cookie: alice, body: { handle: input.handleB },
	}));
	assert.equal(opened.status, 200, await opened.clone().text());
	const { conversation } = await opened.json() as { conversation: { id: string; mySide: 'lo' | 'hi' } };
	const first = await messagesApi.POST(requestContext('/api/dm/messages', {
		method: 'POST', cookie: bob, body: { conversation: conversation.id, body: 'incoming message' },
	}));
	assert.equal(first.status, 200, await first.clone().text());
	return {
		db, alice, bob, conversationId: conversation.id, mySide: conversation.mySide,
		partnerSide: conversation.mySide === 'lo' ? 'hi' : 'lo',
	};
}

/* ---------------------------------------------------------------- tests */

test('signed-out visitors only get the account gate', async () => {
	database();
	activeCookie = null;
	const dom = await mountFreshDom();
	assert.match(byAttr(dom, 'dm-status').textContent ?? '', /Sign in to see your messages\./);
	assert.equal(byAttr(dom, 'dm-signin').hidden, false, 'sign-in panel visible');
	assert.equal(byAttr(dom, 'dm-signed-in').hidden, true, 'signed-in surface stays hidden');
	assert.equal(dom.window.document.querySelector('[data-dm-composer]')!.hasAttribute('hidden'), true);
});

test('the full local flow: boot → start by handle → open → send → live frames → hide → report', async () => {
	const { db } = database();
	// The user's exact scenario: test1 starts a conversation with test2.
	const alice = await createAccount(GUEST_ONE, 'Test One', '203.0.113.1');
	const bob = await createAccount(GUEST_TWO, 'Test Two', '203.0.113.2');
	await claimHandle(alice, 'test1', '203.0.113.1');
	await claimHandle(bob, 'test2', '203.0.113.2');
	// Phase E (plan D7 answer): open-by-handle is friends-only from E on.
	makeFriends(db, 'Test One', 'Test Two');
	activeCookie = alice;

	const dom = await mountFreshDom();
	const win = dom.window;

	// Boot: signed in, empty list, disclosure present.
	assert.match(byAttr(dom, 'dm-status').textContent ?? '', /Signed in as Test One\. No conversations yet\./);
	assert.equal(byAttr(dom, 'dm-signed-in').hidden, false);
	assert.match(byAttr(dom, 'dm-disclosure').textContent ?? '', /60 days/);
	assert.match(byAttr(dom, 'dm-disclosure').textContent ?? '', /The two people in a conversation can read them/);
	assert.doesNotMatch(byAttr(dom, 'dm-disclosure').textContent ?? '', /Moderators only read|end-to-end encryption/);
	assert.equal((win.document.querySelector('[data-dm-list]') as HTMLElement).childElementCount, 0);

	// Start by exact handle — the flow that always failed for the user.
	const handleInput = byAttr(dom, 'dm-new-handle') as HTMLInputElement;
	handleInput.value = 'test2';
	(byAttr(dom, 'dm-new-form') as HTMLFormElement).dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
	assert.equal(await until(() => !byAttr(dom, 'dm-thread-head').hidden), true, 'opening should render the thread without a fixed sleep');

	// Whose side is whose depends on the stored player ids — read it back.
	const aliceRow = db.raw.prepare("SELECT id FROM game_players WHERE display_name = 'Test One'").get() as { id: string };
	const convRow = db.raw.prepare('SELECT id, member_lo FROM dm_conversations').get() as { id: string; member_lo: string } | undefined;
	assert.ok(convRow, 'starting by handle creates the conversation row server-side');
	const aliceSide = aliceRow.id === convRow!.member_lo ? 'lo' : 'hi';
	const partnerSide = aliceSide === 'lo' ? 'hi' : 'lo';

	const status = (): string => byAttr(dom, 'dm-status').textContent ?? '';
	const openStatus = (): string => byAttr(dom, 'dm-new-status').textContent ?? '';
	assert.equal(await until(() => /Conversation with Test Two open\./.test(openStatus())), true, `thread did not open, status was: ${openStatus()}`);
	assert.match(openStatus(), /Conversation with Test Two open\./, `thread did not open, status was: ${openStatus()}`);
	assert.equal(status(), '', 'opening a thread clears stale composer feedback');
	assert.equal(byAttr(dom, 'dm-thread-head').hidden, false);
	assert.equal(byAttr(dom, 'dm-composer').hidden, false);
	assert.match(byAttr(dom, 'dm-partner').textContent ?? '', /Test Two @test2/);
	// The list gains the just-started conversation even though the server
	// hides empty rows (§7.1) — this is the d0d0d9e contract.
	const listButtons = win.document.querySelectorAll('[data-dm-list] [data-dm-open]');
	assert.equal(listButtons.length, 1, 'the just-started conversation is listable');
	// The socket opened against the right conversation.
	assert.equal(sockets.length, 1);
	assert.match(sockets[0].url, /\/api\/dm\/ws\?conversation=[0-9a-f]{64}$/);
	assert.equal(await until(() => /Connected\./.test(byAttr(dom, 'dm-conn').textContent ?? '')), true, 'the client socket opens');

	// Send the first message.
	const textInput = byAttr(dom, 'dm-text') as HTMLTextAreaElement;
	textInput.value = '  hello there  ';
	(byAttr(dom, 'dm-composer') as HTMLFormElement).dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
	assert.equal(await until(() => /Message sent\./.test(status())), true, `send failed, status was: ${status()}`);
	assert.match(status(), /Message sent\./, `send failed, status was: ${status()}`);
	const mine = win.document.querySelector('[data-dm-n="1"]');
	assert.ok(mine, 'the sent message renders');
	assert.match(mine!.className, /dm-msg--me/);
	assert.match(mine!.textContent ?? '', /hello there/, 'sanitised body renders as textContent');
	const timeLabel = mine!.querySelector('.dm-msg__meta > span')?.textContent ?? '';
	assert.doesNotMatch(timeLabel, /:\d{2}:\d{2}/, 'message timestamps display to the minute, not the second');
	// Server state: one row, sanitised, conversation now listable server-side.
	const row = db.raw.prepare('SELECT body FROM dm_messages').get() as { body: string };
	assert.equal(row.body, 'hello there');
	const listed = await conversationsApi.GET(requestContext('/api/dm/conversations', { cookie: alice }));
	const listedBody = await listed.json() as { conversations: Array<{ preview: { body: string } | null }> };
	assert.equal(listedBody.conversations[0].preview?.body, 'hello there');

	// The partner REALLY sends n 2 through the route (persisted), then the DO
	// fanout delivers the frame to this socket — both halves, like production.
	const bobSend = await messagesApi.POST(requestContext('/api/dm/messages', {
		method: 'POST', cookie: bob, body: { conversation: convRow!.id, body: 'reply from test2' },
	}));
	assert.equal(bobSend.status, 200, await bobSend.clone().text());
	sockets[0].onmessage?.({ data: JSON.stringify({ t: 'dm_new', v: 1, m: { n: 2, senderSide: partnerSide, body: 'reply from test2', imageId: null, at: Date.now() } }) });
	await tick(10);
	const theirs = win.document.querySelector('[data-dm-n="2"]');
	assert.ok(theirs, 'the live frame rendered');
	assert.doesNotMatch(theirs!.className, /dm-msg--me/);
	assert.match(theirs!.textContent ?? '', /reply from test2/);

	// My message was reported-read by the partner → seen marker appears.
	sockets[0].onmessage?.({ data: JSON.stringify({ t: 'dm_read', v: 1, side: partnerSide, seq: 2 }) });
	await tick(10);
	const seen = win.document.querySelector('[data-dm-seen="1"]') as HTMLElement | null;
	assert.ok(seen, 'seen marker exists on my message');
	assert.equal(seen!.hidden, false, 'seen visible after partner watermark passes it');

	// Report the received message first (§12.5 flow) …
	const reportButton = win.document.querySelector('[data-dm-report="2"]') as HTMLButtonElement;
	assert.ok(reportButton, 'received messages carry a report control');
	reportButton.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
	await tick(30);
	assert.match(status(), /sent to the moderators for review/, `report failed, status was: ${status()}`);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_reports').get() as { n: number }).n, 1);

	// … then delete-for-me (D12) removes only here.
	const hideButton = win.document.querySelector('[data-dm-hide="2"]') as HTMLButtonElement;
	hideButton.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
	await tick(30);
	assert.equal(win.document.querySelector('[data-dm-n="2"]'), null, 'hidden message removed from this view');
	assert.match(status(), /Removed from your view\./, `hide failed, status was: ${status()}`);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_messages').get() as { n: number }).n, 2, 'the row itself survives');

	// Re-opening from the list keeps working (row exists server-side now).
	activeCookie = bob; // partner observes unread + preview
	const bobView = await conversationsApi.GET(requestContext('/api/dm/conversations', { cookie: bob }));
	const bobBody = await bobView.json() as { conversations: Array<{ unread: number }> };
	assert.equal(bobBody.conversations[0].unread >= 1, true, 'partner has unread');
});


test('unread stays visible until the mark-read request succeeds', async () => {
	const fixture = await createUnreadConversation({ nameA: 'Unread One', handleA: 'unread_one', nameB: 'Unread Two', handleB: 'unread_two', ipSuffix: '91' });
	activeCookie = fixture.alice;
	const dom = await mountFreshDom();
	assert.equal(dom.window.document.querySelector('[data-dm-unread]')?.textContent, '1');

	const originalFetch = globalThis.fetch;
	let failRead = true;
	globalThis.fetch = async (input, init) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (new URL(raw, ORIGIN).pathname === '/api/dm/read' && failRead) {
			return new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 });
		}
		return fetchShim(input, init);
	};
	try {
		dom.window.document.querySelector<HTMLButtonElement>('[data-dm-open]')!.click();
		await tick(30);
		assert.equal(dom.window.document.querySelector('[data-dm-unread]')?.textContent, '1', 'failed read must not clear the local unread badge');
		const before = fixture.db.raw.prepare('SELECT read_seq_lo, read_seq_hi FROM dm_conversations WHERE id = ?').get(fixture.conversationId) as { read_seq_lo: number; read_seq_hi: number };
		assert.equal(before[fixture.mySide === 'lo' ? 'read_seq_lo' : 'read_seq_hi'], 0, 'the durable watermark also remains unchanged');

		failRead = false;
		dom.window.document.querySelector<HTMLButtonElement>('[data-dm-open]')!.click();
		await tick(30);
		assert.equal(dom.window.document.querySelector('[data-dm-unread]'), null, 'successful read clears the badge');
		const after = fixture.db.raw.prepare('SELECT read_seq_lo, read_seq_hi FROM dm_conversations WHERE id = ?').get(fixture.conversationId) as { read_seq_lo: number; read_seq_hi: number };
		assert.equal(after[fixture.mySide === 'lo' ? 'read_seq_lo' : 'read_seq_hi'], 1, 'the successful request advances the durable watermark');
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('live DM frames preserve scrollback unless the reader is near the bottom', async () => {
	const fixture = await createUnreadConversation({ nameA: 'Scroll One', handleA: 'scroll_one', nameB: 'Scroll Two', handleB: 'scroll_two', ipSuffix: '92' });
	activeCookie = fixture.alice;
	const dom = await mountFreshDom();
	const thread = byAttr(dom, 'dm-thread') as HTMLOListElement;
	Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => thread.children.length * 200 });
	Object.defineProperty(thread, 'clientHeight', { configurable: true, value: 100 });
	dom.window.document.querySelector<HTMLButtonElement>('[data-dm-open]')!.click();
	await tick(35);
	assert.equal(thread.children.length, 1);
	thread.scrollTop = 0;

	const second = await messagesApi.POST(requestContext('/api/dm/messages', {
		method: 'POST', cookie: fixture.bob, body: { conversation: fixture.conversationId, body: 'second incoming' },
	}));
	assert.equal(second.status, 200, await second.clone().text());
	const secondMessage = (await second.json() as { message: { n: number; at: number; body: string; imageId: string | null } }).message;
	sockets[0]!.onmessage?.({ data: JSON.stringify({ t: 'dm_new', v: 1, m: { ...secondMessage, senderSide: fixture.partnerSide } }) });
	await tick(30);
	assert.equal(thread.scrollTop, 0, 'an incoming message does not pull a reader away from older messages');

	thread.scrollTop = thread.scrollHeight - thread.clientHeight;
	const third = await messagesApi.POST(requestContext('/api/dm/messages', {
		method: 'POST', cookie: fixture.bob, body: { conversation: fixture.conversationId, body: 'third incoming' },
	}));
	assert.equal(third.status, 200, await third.clone().text());
	const thirdMessage = (await third.json() as { message: { n: number; at: number; body: string; imageId: string | null } }).message;
	sockets[0]!.onmessage?.({ data: JSON.stringify({ t: 'dm_new', v: 1, m: { ...thirdMessage, senderSide: fixture.partnerSide } }) });
	await tick(30);
	assert.equal(thread.scrollTop, thread.scrollHeight, 'a reader at the bottom follows new messages');
});

test('normalized base64 size accounting subtracts padding exactly', () => {
	assert.equal(decodedBase64ByteLength('YQ=='), 1);
	assert.equal(decodedBase64ByteLength('YWI='), 2);
	assert.equal(decodedBase64ByteLength('YWJj'), 3);
});

test('a larger source image is allowed when normalization brings it under the upload ceiling', async () => {
	const fixture = await createUnreadConversation({ nameA: 'Image One', handleA: 'image_one', nameB: 'Image Two', handleB: 'image_two', ipSuffix: '93' });
	activeCookie = fixture.alice;
	const dom = await mountFreshDom();
	dom.window.document.querySelector<HTMLButtonElement>('[data-dm-open]')!.click();
	assert.equal(await until(() => !byAttr(dom, 'dm-thread-head').hidden), true, 'the image conversation opens');
	const imageInput = byAttr(dom, 'dm-image-input') as HTMLInputElement;
	const file = new dom.window.File([new Uint8Array(DM_CONFIG.images.maxDecodedBytes + 1)], 'large-source.png', { type: 'image/png' });
	Object.defineProperty(imageInput, 'files', { configurable: true, value: [file] as unknown as FileList });
	let decodes = 0;
	const smallWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
	const restore = mockCanvasOutput(dom, smallWebp, () => { decodes += 1; });
	try {
		imageInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		assert.equal(await until(() => byAttr(dom, 'dm-status').textContent === 'Image ready — add a note and send.'), true, 'the normalized image uploads');
		assert.equal(decodes, 1, 'a source over 1.4 MB reaches browser normalization');
		assert.equal(byAttr(dom, 'dm-image-chip').hidden, false, 'the successfully uploaded image is staged');
		assert.equal((fixture.db.raw.prepare('SELECT COUNT(*) AS n FROM dm_attachments').get() as { n: number }).n, 1);
	} finally {
		restore();
	}
});

test('normalized output over the upload ceiling is rejected before upload', async () => {
	const fixture = await createUnreadConversation({ nameA: 'Image Three', handleA: 'image_three', nameB: 'Image Four', handleB: 'image_four', ipSuffix: '94' });
	activeCookie = fixture.alice;
	const dom = await mountFreshDom();
	dom.window.document.querySelector<HTMLButtonElement>('[data-dm-open]')!.click();
	assert.equal(await until(() => !byAttr(dom, 'dm-thread-head').hidden), true, 'the image conversation opens');
	const imageInput = byAttr(dom, 'dm-image-input') as HTMLInputElement;
	const file = new dom.window.File([new Uint8Array([1, 2, 3])], 'small-source.png', { type: 'image/png' });
	Object.defineProperty(imageInput, 'files', { configurable: true, value: [file] as unknown as FileList });
	const oversizedOutput = new Uint8Array(DM_CONFIG.images.maxDecodedBytes + 1);
	oversizedOutput.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
	let decodes = 0;
	const restore = mockCanvasOutput(dom, oversizedOutput, () => { decodes += 1; });
	try {
		imageInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		assert.equal(await until(() => byAttr(dom, 'dm-status').textContent === 'That image is too large.'), true, 'the normalized-byte ceiling is enforced');
		assert.equal(decodes, 1, 'size is checked after normalization');
		assert.equal(byAttr(dom, 'dm-image-chip').hidden, true, 'oversized output is not staged');
		assert.equal((fixture.db.raw.prepare('SELECT COUNT(*) AS n FROM dm_attachments').get() as { n: number }).n, 0, 'no oversized attachment is uploaded');
	} finally {
		restore();
	}
});

test('send failures stay below the composer while open failures stay below the handle field', async () => {
	const { db } = database();
	const alice = await createAccount(GUEST_ONE, 'Status One', '203.0.113.61');
	const bob = await createAccount(GUEST_TWO, 'Status Two', '203.0.113.62');
	await claimHandle(alice, 'status_one', '203.0.113.61');
	await claimHandle(bob, 'status_two', '203.0.113.62');
	makeFriends(db, 'Status One', 'Status Two');
	activeCookie = alice;

	const dom = await mountFreshDom();
	const win = dom.window;
	const sendStatus = byAttr(dom, 'dm-status');
	const openStatus = byAttr(dom, 'dm-new-status');
	const composer = byAttr(dom, 'dm-composer');
	const newForm = byAttr(dom, 'dm-new-form');
	const handle = byAttr(dom, 'dm-new-handle') as HTMLInputElement;
	const text = byAttr(dom, 'dm-text') as HTMLTextAreaElement;
	const submit = (form: HTMLElement) => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));

	assert.equal(sendStatus.previousElementSibling, composer, 'send status follows the composer in the real markup');
	assert.equal(openStatus.parentElement, newForm, 'open status is in the exact-handle form');
	assert.equal(handle.getAttribute('aria-describedby'), openStatus.id);
	assert.equal(text.getAttribute('aria-describedby'), sendStatus.id);
	for (const status of [sendStatus, openStatus]) {
		assert.equal(status.getAttribute('role'), 'status');
		assert.equal(status.getAttribute('aria-live'), 'polite');
		assert.equal(status.getAttribute('aria-atomic'), 'true');
	}

	handle.value = 'status_two';
	submit(newForm);
	await tick(30);
	assert.equal(openStatus.textContent, 'Conversation with Status Two open.');

	text.value = 'x'.repeat(2_001);
	submit(composer);
	await tick(30);
	assert.equal(sendStatus.textContent, 'That message is too long.');
	assert.equal(openStatus.textContent, 'Conversation with Status Two open.', 'sending does not overwrite handle feedback');
	assert.equal(text.value.length, 2_001, 'the failed send preserves the draft');
	assert.equal((byAttr(dom, 'dm-send') as HTMLButtonElement).disabled, false, 'the composer is usable after a failed send');

	handle.value = 'missing_handle';
	submit(newForm);
	await tick(30);
	assert.equal(openStatus.textContent, 'No account uses that handle.');
	assert.equal(sendStatus.textContent, 'That message is too long.', 'a failed new conversation does not overwrite send feedback');

	// Opening from the list can fail at the history read, not just at the
	// exact-handle POST. Both failures belong to the open-status line.
	globalThis.fetch = async (input, init) => {
		if (typeof input === 'string' && input.startsWith('/api/dm/messages?')) {
			return new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503 });
		}
		return fetchShim(input, init);
	};
	try {
		const button = win.document.querySelector('[data-dm-open]') as HTMLButtonElement;
		assert.ok(button);
		button.click();
		await tick(30);
		assert.equal(openStatus.textContent, 'The server is unavailable right now.');
		assert.equal(sendStatus.textContent, 'That message is too long.', 'history failure does not overwrite composer feedback');
	} finally {
		globalThis.fetch = fetchShim;
	}

	text.value = '';
	submit(composer);
	assert.equal(sendStatus.textContent, 'Write something first.', 'client-side send validation also uses composer feedback');
	assert.equal(openStatus.textContent, 'The server is unavailable right now.');
});

test('a friends-only deep-link failure is reported below the handle, not the composer', async () => {
	database();
	const alice = await createAccount(GUEST_ONE, 'Unlinked One', '203.0.113.71');
	const bob = await createAccount(GUEST_TWO, 'Unlinked Two', '203.0.113.72');
	await claimHandle(bob, 'unlinked_two', '203.0.113.72');
	activeCookie = alice;

	const dom = await mountFreshDom('?handle=unlinked_two');
	await tick(30);
	assert.match(byAttr(dom, 'dm-new-status').textContent ?? '', /You can only message friends/);
	assert.equal(byAttr(dom, 'dm-status').textContent, 'Signed in as Unlinked One. No conversations yet.');
	assert.equal(byAttr(dom, 'dm-composer').hidden, true);
});

test('deep link: /messages/?handle= opens that conversation once and cleans the URL', async () => {
	const { db } = database();
	const alice = await createAccount(GUEST_ONE, 'Deep One', '203.0.113.51');
	const bob = await createAccount(GUEST_TWO, 'Deep Two', '203.0.113.52');
	await claimHandle(alice, 'deep_one', '203.0.113.51');
	await claimHandle(bob, 'deep_two', '203.0.113.52');
	makeFriends(db, 'Deep One', 'Deep Two');
	activeCookie = alice;

	const dom = await mountFreshDom('?handle=deep_two');
	assert.equal(await until(() => !byAttr(dom, 'dm-thread-head').hidden), true, 'deep link eventually opens the thread');

	// The thread opened without touching the form…
	assert.equal(byAttr(dom, 'dm-thread-head').hidden, false, 'deep link opens the thread');
	assert.match(byAttr(dom, 'dm-partner').textContent ?? '', /Deep Two @deep_two/);
	// …and the parameter is removed so a refresh does not re-fire it.
	assert.equal(dom.window.location.search, '', 'URL cleaned after consumption');
	assert.equal(dom.window.location.pathname, '/messages/');
});

test('incoming WebSocket message does not snap thread.scrollTop to bottom if user is scrolled up', async () => {
	const { db } = database();
	const alice = await createAccount(GUEST_ONE, 'Scroll One', '203.0.113.81');
	const bob = await createAccount(GUEST_TWO, 'Scroll Two', '203.0.113.82');
	await claimHandle(alice, 'scroll_one', '203.0.113.81');
	await claimHandle(bob, 'scroll_two', '203.0.113.82');
	makeFriends(db, 'Scroll One', 'Scroll Two');
	activeCookie = alice;
	const opened = await conversationsApi.POST(requestContext('/api/dm/conversations', {
		method: 'POST', cookie: alice, body: { handle: 'scroll_two' },
	}));
	assert.equal(opened.status, 200, await opened.clone().text());
	const { conversation } = await opened.json() as { conversation: { mySide: 'lo' | 'hi' } };
	const incomingSide = conversation.mySide === 'lo' ? 'hi' : 'lo';

	const dom = await mountFreshDom('?handle=scroll_two');
	await tick(40);

	const thread = byAttr(dom, 'dm-thread') as HTMLOListElement;
	Object.defineProperty(thread, 'scrollHeight', { value: 1000, configurable: true });
	Object.defineProperty(thread, 'clientHeight', { value: 300, configurable: true });
	thread.scrollTop = 200;

	sockets[0].onmessage?.({
		data: JSON.stringify({
			t: 'dm_new',
			v: 1,
			m: { n: 10, senderSide: incomingSide, body: 'incoming while scrolled up', imageId: null, at: Date.now() },
		}),
	});
	await tick(10);

	assert.equal(thread.scrollTop, 200, 'scrollTop remains at 200 while reading history');
});
