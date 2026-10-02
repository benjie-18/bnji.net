/**
 * The open-lobby panel in the browser (`src/scripts/game-room-ui.ts`).
 *
 * Markup comes from the REAL `RoomPanel.astro` source, and the script is the
 * real `mountGameRooms`, so the test fails if either side of the hook contract
 * drifts. What it protects:
 *
 *   - the list is a courtesy, never a dependency: a failed read must leave
 *     room creation and code-join untouched;
 *   - a row must mean "clicking this puts you in a room" — the join button
 *     opens the same socket the code path uses;
 *   - a refused socket explains itself (kick = 4003, not a generic hiccup),
 *     because the lockout is durable and "try again" would be a lie.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountGameRooms } from '../src/scripts/game-room-ui';

const ORIGIN = 'http://localhost:8787';
const CODE = 'a'.repeat(22);
const tick = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type FakeSocket = {
	url: string;
	closed: boolean;
	close(code?: number, reason?: string): void;
	send(payload: string): void;
};
let sockets: FakeSocket[] = [];

class FakeWebSocket {
	static readonly OPEN = 1;
	readyState = 0;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	private listeners = new Map<string, Array<(event: unknown) => void>>();
	readonly me: FakeSocket;

	constructor(url: string) {
		const self = this as unknown as FakeSocket & FakeWebSocket;
		this.me = self;
		(self as { url: string }).url = url;
		(self as { closed: boolean }).closed = false;
		(self as { send: (payload: string) => void }).send = () => { /* display-only in these tests */ };
		(self as { close: (code?: number, reason?: string) => void }).close = (code = 1000, reason = '') => {
			(self as { closed: boolean }).closed = true;
			this.emit('close', { code, reason });
		};
		sockets.push(self);
		setTimeout(() => {
			this.readyState = 1;
			this.emit('open', {});
			this.emit('message', { data: JSON.stringify({ v: 1, type: 'snapshot', gameId: 'bnji.chess', revision: 0, connectedMembers: 1, isHost: true, hasHost: true }) });
		}, 0);
	}
	addEventListener(type: string, listener: (event: unknown) => void): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}
	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

function panelDom(): JSDOM {
	const source = readFileSync(new URL('../src/components/RoomPanel.astro', import.meta.url), 'utf8');
	const parts = source.split('---');
	const markup = parts.length >= 3 ? parts[2]!.split('<style>')[0]! : source;
	// Render the server-side substitutions needed by this browser-hook test.
	// Astro itself is exercised by the project build.
	const rendered = markup
		.replace('value={gameId}', 'value="bnji.chess"')
		.replace(/(aria-labelledby|id|for)=\{`\$\{panelId\}-([^`]+)`\}/g, (_match, attribute: string, suffix: string) => `${attribute}="room-test-${suffix}"`)
		.replace('Start a {roomNoun} room', 'Start a chess room');
	const dom = new JSDOM(`<!doctype html><html><body>${rendered}</body></html>`, { url: `${ORIGIN}/games/chess/` });
	// jsdom defaults to a hidden document; ordinary tests model a foreground tab.
	Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
	return dom;
}

type LobbyHandler = (url: string) => { status?: number; body: unknown };
const intervalPeriods: number[] = [];
const intervalIds: number[] = [];
const clearedIntervals = new Set<number>();
function install(dom: JSDOM, handler: LobbyHandler) {
	const calls: string[] = [];
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	g.WebSocket = FakeWebSocket;
	g.requestAnimationFrame = (callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 0));
	g.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
	g.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		const result = handler(url);
		return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	// The panel polls. Record the requested period and never fire the timer:
	// the interval's EXISTENCE and its floor are the contract here.
	dom.window.setInterval = ((_handler: TimerHandler, timeout?: number) => {
		const id = intervalIds.length + 1;
		intervalIds.push(id);
		intervalPeriods.push(timeout ?? 0);
		return id;
	}) as unknown as typeof setInterval;
	dom.window.clearInterval = ((id: number) => { clearedIntervals.add(id); }) as typeof clearInterval;
	return calls;
}

function mountWith(t: { after(fn: () => void): void }, dom: JSDOM): HTMLElement {
	// A jsdom window owns timers and listeners; the runner must not outlive it.
	t.after(() => dom.window.close());
	return mount(dom);
}

function mount(dom: JSDOM): HTMLElement {
	const root = dom.window.document.querySelector('[data-room-tools]');
	assert.ok(root, 'RoomPanel.astro must carry data-room-tools');
	mountGameRooms(root as unknown as HTMLElement);
	return root as unknown as HTMLElement;
}
const byAttr = (dom: JSDOM, name: string): HTMLElement => {
	const node = dom.window.document.querySelector(`[data-${name}]`);
	assert.ok(node, `missing [data-${name}]`);
	return node as unknown as HTMLElement;
};

test.beforeEach(() => { sockets = []; intervalPeriods.length = 0; intervalIds.length = 0; clearedIntervals.clear(); });

test('rows show the game, seats and time left, and Join opens the room socket', async (t) => {
	const dom = panelDom();
	const calls = install(dom, (url) => url.startsWith('/api/games/lobbies')
		? {
			body: {
				lobbies: [
					{ roomCode: CODE, gameId: 'bnji.chess', players: 3, capacity: 8, createdAt: Date.now(), expiresAt: Date.now() + 600_000, revision: 4 },
				],
				refreshAfterSeconds: 10,
			},
		}
		: { body: {} });
	mountWith(t, dom);
	await tick(20);

	assert.ok(calls.some((url) => url.startsWith('/api/games/lobbies')), 'the panel reads the lobby endpoint');
	const list = byAttr(dom, 'lobby-list');
	assert.equal(list.children.length, 1);
	const row = list.children[0]!;
	assert.match(row.textContent ?? '', /Chess/);
	assert.match(row.textContent ?? '', /3\/8 players/);
	assert.match(row.textContent ?? '', /min left/);
	assert.match(byAttr(dom, 'lobby-status').textContent ?? '', /1 open room · anyone may join/);

	const join = row.querySelector('button');
	assert.ok(join);
	join!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(10);
	assert.equal(sockets.length, 1, 'Join must open the room, not just link to it');
	assert.match(sockets[0]!.url, new RegExp(`/api/games/rooms/${CODE}/ws$`));
	assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('[data-chat-form] [name="text"]'), 'joining moves keyboard focus into room chat');
});


test('RoomPanel labels point to unique generated IDs', (t) => {
	const dom = panelDom();
	mountWith(t, dom);
	const ids = [...dom.window.document.querySelectorAll('[id]')].map((element) => element.id);
	assert.equal(new Set(ids).size, ids.length, 'the panel does not introduce duplicate IDs');
	for (const label of dom.window.document.querySelectorAll<HTMLLabelElement>('label[for]')) {
		assert.ok(dom.window.document.getElementById(label.htmlFor), `label target ${label.htmlFor} exists`);
	}
	const root = dom.window.document.querySelector('[data-room-tools]')!;
	assert.equal(root.getAttribute('aria-labelledby'), root.querySelector('h2')!.id);
});

test('lobby polling pauses while hidden and refreshes when the page becomes visible', async (t) => {
	const dom = panelDom();
	let visibility: DocumentVisibilityState = 'hidden';
	Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibility });
	const calls = install(dom, () => ({ body: { lobbies: [], refreshAfterSeconds: 10 } }));
	mountWith(t, dom);
	await tick(20);
	const lobbyReads = (): number => calls.filter((url) => url.startsWith('/api/games/lobbies')).length;
	assert.equal(lobbyReads(), 0, 'an initially hidden tab does not fetch lobbies');
	assert.equal(intervalPeriods.length, 0, 'an initially hidden tab does not create a timer');

	visibility = 'visible';
	dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
	await tick(20);
	assert.equal(lobbyReads(), 1, 'becoming visible triggers an immediate read');
	assert.deepEqual(intervalPeriods, [15_000], 'the timer respects the server/cache floor');

	visibility = 'hidden';
	dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
	assert.ok(clearedIntervals.has(intervalIds[0]!), 'hiding the document clears the active interval');
	await tick(20);
	assert.equal(lobbyReads(), 1, 'no lobby requests are made while hidden');

	visibility = 'visible';
	dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
	await tick(20);
	assert.equal(lobbyReads(), 2, 'returning to the foreground refreshes the list immediately');
	assert.equal(intervalPeriods.length, 2, 'polling resumes with one timer');
});

test('a network error does not start polling, but an explicit refresh can recover', async (t) => {
	const dom = panelDom();
	let fail = true;
	const calls = install(dom, (url) => {
		if (url.startsWith('/api/games/lobbies') && fail) throw new Error('network offline');
		return { body: { lobbies: [], refreshAfterSeconds: 10 } };
	});
	mountWith(t, dom);
	await tick(20);
	const lobbyReads = (): number => calls.filter((url) => url.startsWith('/api/games/lobbies')).length;
	assert.equal(lobbyReads(), 1);
	assert.match(byAttr(dom, 'lobby-status').textContent ?? '', /could not be loaded/);
	assert.equal(intervalPeriods.length, 0, 'a rejected initial request must not start a polling timer');

	fail = false;
	byAttr(dom, 'lobby-refresh').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(20);
	assert.equal(lobbyReads(), 2, 'the refresh button permits an explicit retry');
	assert.equal(intervalPeriods.length, 1, 'polling resumes after a successful retry');
});

test('a non-OK refresh clears its timer and a later manual retry can restart it', async (t) => {
	const dom = panelDom();
	let reads = 0;
	install(dom, (url) => {
		if (!url.startsWith('/api/games/lobbies')) return { body: {} };
		reads += 1;
		return reads === 2
			? { status: 503, body: { error: 'storage_unavailable' } }
			: { body: { lobbies: [], refreshAfterSeconds: 10 } };
	});
	mountWith(t, dom);
	await tick(20);
	assert.deepEqual(intervalPeriods, [15_000]);

	const refresh = byAttr(dom, 'lobby-refresh');
	refresh.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(20);
	assert.equal(reads, 2);
	assert.ok(clearedIntervals.has(intervalIds[0]!), 'the failing response stops the interval');
	assert.equal(intervalPeriods.length, 1, 'the failed response does not recreate the timer');
	assert.match(byAttr(dom, 'lobby-status').textContent ?? '', /unavailable right now/);

	refresh.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(20);
	assert.equal(reads, 3);
	assert.equal(intervalPeriods.length, 2, 'a later successful manual retry restores polling');
});

test('an empty list says so without disabling the code path', async (t) => {
	const dom = panelDom();
	install(dom, () => ({ body: { lobbies: [], refreshAfterSeconds: 10 } }));
	mountWith(t, dom);
	await tick(20);
	assert.match(byAttr(dom, 'lobby-list').textContent ?? '', /No open rooms right now/);
	assert.equal(byAttr(dom, 'lobby-status').textContent, '');
	assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-room-join] button')!.disabled, false);
});

test('a failed read degrades to a note and stops polling; the code join still works', async (t) => {
	const dom = panelDom();
	const calls = install(dom, (url) => url.startsWith('/api/games/lobbies')
		? { status: 503, body: { error: 'storage_unavailable' } }
		: { body: {} });
	mountWith(t, dom);
	await tick(20);
	assert.match(byAttr(dom, 'lobby-status').textContent ?? '', /unavailable right now — use a room code to join/);
	// The panel gives up rather than hammering a failing endpoint...
	const reads = calls.filter((url) => url.startsWith('/api/games/lobbies')).length;
	assert.equal(reads, 1);
	// ...and joining by hand is untouched.
	const input = dom.window.document.querySelector<HTMLInputElement>('[name="roomCode"]')!;
	input.value = CODE;
	dom.window.document.querySelector<HTMLFormElement>('[data-room-join]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
	await tick(10);
	assert.equal(sockets.length, 1);
});

test('lobby_disabled is explained as a switch, not a failure', async (t) => {
	const dom = panelDom();
	install(dom, (url) => url.startsWith('/api/games/lobbies') ? { status: 404, body: { error: 'lobby_disabled' } } : { body: {} });
	mountWith(t, dom);
	await tick(20);
	assert.match(byAttr(dom, 'lobby-status').textContent ?? '', /turned off right now/);
});

test('the room asks for its own game, and the panel follows the game picker when there is one', async (t) => {
	const dom = panelDom();
	const calls = install(dom, () => ({ body: { lobbies: [], refreshAfterSeconds: 10 } }));
	mountWith(t, dom);
	await tick(20);
	assert.ok(calls.some((url) => url.includes('gameId=bnji.chess')), 'a game page asks only for its own game');
});

test('a kicked socket says why instead of blaming the connection', async (t) => {
	const dom = panelDom();
	install(dom, (url) => url.startsWith('/api/games/lobbies') ? { body: { lobbies: [], refreshAfterSeconds: 10 } } : { body: {} });
	mountWith(t, dom);
	await tick(20);
	const input = dom.window.document.querySelector<HTMLInputElement>('[name="roomCode"]')!;
	input.value = CODE;
	dom.window.document.querySelector<HTMLFormElement>('[data-room-join]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
	await tick(10);
	assert.equal(sockets.length, 1);

	// The DO closes a kicked member with 4003/`Kicked by host`.
	sockets[0]!.close(4003, 'Kicked by host');
	await tick(10);
	const copy = byAttr(dom, 'room-live').textContent ?? '';
	assert.match(copy, /The host removed you from this room/);
	assert.doesNotMatch(copy, /re-enter the code/);
	assert.match(byAttr(dom, 'chat-status').textContent ?? '', /The host removed you from this room/);
});

test('an expired room close asks for a new code, and a replaced connection is not an error', async (t) => {
	const dom = panelDom();
	install(dom, (url) => url.startsWith('/api/games/lobbies') ? { body: { lobbies: [], refreshAfterSeconds: 10 } } : { body: {} });
	mountWith(t, dom);
	await tick(20);
	const join = (): void => {
		const input = dom.window.document.querySelector<HTMLInputElement>('[name="roomCode"]')!;
		input.value = CODE;
		dom.window.document.querySelector<HTMLFormElement>('[data-room-join]')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
	};
	join();
	await tick(10);
	sockets[0]!.close(4002, 'Room expired');
	await tick(10);
	assert.match(byAttr(dom, 'room-live').textContent ?? '', /has expired/);

	join();
	await tick(10);
	sockets[1]!.close(4001, 'Reconnected on another connection');
	await tick(10);
	assert.match(byAttr(dom, 'room-live').textContent ?? '', /another tab or window/);
});
