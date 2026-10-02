/**
 * /friends/ browser surface: the REAL markup from `src/pages/friends.astro`
 * driven by the REAL `mountFriends`, with the API answered by canned JSON.
 *
 * The API's own rules (who may request whom, blocks, limits) are covered by
 * the route tests; what this file protects is the client contract: tab
 * switching, count badges, the people search (debounced, fragment-only), the
 * mutation vocabulary (POST vs DELETE), and the one rule that keeps a friend
 * list from being an XSS delivery route — every row is escaped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountFriends } from '../src/scripts/friends-ui';

const ORIGIN = 'http://localhost:8787';
const tick = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Lists = {
	friends: Array<{ handle: string; displayName: string; since: number }>;
	incoming: Array<{ handle: string; displayName: string; since: number }>;
	outgoing: Array<{ handle: string; displayName: string; since: number }>;
	blocked: Array<{ handle: string; displayName: string; since: number }>;
	changed?: string;
	error?: string;
};

function emptyLists(): Lists {
	return { friends: [], incoming: [], outgoing: [], blocked: [] };
}

function friendsDom(): JSDOM {
	const source = readFileSync(new URL('../src/pages/friends.astro', import.meta.url), 'utf8');
	const parts = source.split('---');
	let markup = parts.length >= 3 ? parts[2]! : source;
	markup = markup.split('<style>')[0]!;
	markup = markup.split('<script>')[0]!;
	// Render the directory gate the way Astro would with the feature on.
	markup = markup.replace('{directoryOn && (', '').replace(/\n\t+\)\}\n/, '\n');
	markup = markup.replaceAll('{DIRECTORY_CONFIG.minQueryLength}', '3').replaceAll('{DIRECTORY_CONFIG.maxQueryLength}', '20');
	return new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, { url: `${ORIGIN}/friends/` });
}

type Call = { url: string; method: string; body: unknown; headers: Headers };
function install(dom: JSDOM, handler: (call: Call) => { status?: number; body: unknown }) {
	const calls: Call[] = [];
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	g.requestAnimationFrame = (callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 0));
	g.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
	g.WebSocket = class {
		static readonly OPEN = 1;
		readyState = 0;
		close(): void { /* presence socket: not under test here */ }
		addEventListener(): void { /* no frames */ }
	} as unknown as typeof WebSocket;
	g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const call: Call = {
			url,
			method: (init?.method ?? 'GET').toUpperCase(),
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
			headers: new Headers(init?.headers),
		};
		calls.push(call);
		const result = handler(call);
		return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return calls;
}

function mountWith(t: { after(fn: () => void): void }, dom: JSDOM): HTMLElement {
	t.after(() => dom.window.close());
	const root = dom.window.document.querySelector('[data-friends-root]');
	assert.ok(root, 'friends.astro must carry data-friends-root');
	return root as unknown as HTMLElement;
}

const q = (dom: JSDOM, selector: string): HTMLElement => {
	const node = dom.window.document.querySelector(selector);
	assert.ok(node, `missing ${selector}`);
	return node as unknown as HTMLElement;
};

const entry = (handle: string, displayName: string): { handle: string; displayName: string; since: number } => ({ handle, displayName, since: Date.now() - 86_400_000 });

test('signed-out visitors are offered the account gate and nothing else', async (t) => {
	const dom = friendsDom();
	install(dom, () => ({ status: 401, body: { error: 'authentication_required' } }));
	const root = mountWith(t, dom);
	mountFriends(root);
	await tick(15);
	assert.equal(q(dom, '[data-friends-signin]').hasAttribute('hidden'), false);
	assert.equal(q(dom, '[data-friends-signed-in]').hasAttribute('hidden'), true);
});

test('lists render escaped rows with count badges, and only the incoming panel is open first', async (t) => {
	const dom = friendsDom();
	const hostile = '<img src=x onerror="window.__pwned=1">';
	install(dom, () => ({
		body: {
			...emptyLists(),
			incoming: [entry('bob_', hostile)],
			friends: [entry('carol', 'Carol')],
			outgoing: [entry('dave', 'Dave')],
			blocked: [entry('eve', 'Eve')],
		},
	}));
	const root = mountWith(t, dom);
	mountFriends(root);
	await tick(15);

	assert.equal(q(dom, '[data-friends-panel="incoming"]').hasAttribute('hidden'), false);
	assert.equal(q(dom, '[data-friends-panel="friends"]').hasAttribute('hidden'), true);
	assert.equal(q(dom, '[data-friends-count="incoming"]').textContent, '1');
	assert.equal(q(dom, '[data-friends-count="friends"]').textContent, '1');

	const hostileRow = q(dom, '[data-friends-list="incoming"] li');
	assert.equal(hostileRow.querySelectorAll('img').length, 0, 'a display name is escaped, never markup');
	assert.equal(q(dom, '[data-friends-list="incoming"] .friends-row__name').textContent, hostile);
	// Handle-scoped labels: "Accept" alone is ambiguous in a list.
	assert.match(hostileRow.querySelector('[data-friend-action="accept"]')!.getAttribute('aria-label')!, /Accept friend request from bob_/);
	// Presence dots exist for friends and start hidden until a snapshot arrives.
	const dot = q(dom, '[data-friends-list="friends"] [data-friend-online="carol"]');
	assert.equal(dot.hasAttribute('hidden'), true);

	// Tabs: one panel at a time, aria-selected mirrors it.
	q(dom, '[data-friends-tab="friends"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick();
	assert.equal(q(dom, '[data-friends-panel="friends"]').hasAttribute('hidden'), false);
	assert.equal(q(dom, '[data-friends-panel="incoming"]').hasAttribute('hidden'), true);
	assert.equal(q(dom, '[data-friends-tab="friends"]').getAttribute('aria-selected'), 'true');
	assert.equal(q(dom, '[data-friends-tab="incoming"]').getAttribute('aria-selected'), 'false');
});

test('a request form posts the exact-handle vocabulary and clears the field', async (t) => {
	const dom = friendsDom();
	const calls = install(dom, (call) => call.url === '/api/friends'
		? { body: { ...emptyLists(), outgoing: [entry('bob_', 'Bob')], changed: 'requested' } }
		: { body: emptyLists() });
	const root = mountWith(t, dom);
	mountFriends(root);
	await tick(15);

	const form = q(dom, '[data-friends-request-form]') as unknown as HTMLFormElement;
	q(dom, '[data-friends-request-handle]').setAttribute('value', 'BOB_');
	(q(dom, '[data-friends-request-handle]') as unknown as HTMLInputElement).value = 'BOB_';
	form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
	await tick(15);

	const post = calls.find((call) => call.url === '/api/friends' && call.method === 'POST');
	assert.ok(post, 'the form POSTs to /api/friends');
	assert.deepEqual(post!.body, { action: 'request', handle: 'bob_' }, 'handles are lower-cased before they leave the browser');
	assert.equal((q(dom, '[data-friends-request-handle]') as unknown as HTMLInputElement).value, '');
	assert.match(q(dom, '[data-friends-status]').textContent ?? '', /Request sent to bob_\./);
	assert.equal(q(dom, '[data-friends-count="outgoing"]').textContent, '1');
});

test('people search refuses fragments under the configured minimum and explains an empty result', async (t) => {
	const dom = friendsDom();
	const calls = install(dom, (call) => call.url.startsWith('/api/people') ? { body: { people: [], truncated: false } } : { body: emptyLists() });
	const root = mountWith(t, dom);
	mountFriends(root);
	await tick(15);

	const input = q(dom, '[data-people-query]') as unknown as HTMLInputElement;
	input.value = 'ab';
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await tick(400);
	assert.match(q(dom, '[data-people-status]').textContent ?? '', /Type at least 3 characters\./);
	assert.equal(calls.filter((call) => call.url.startsWith('/api/people')).length, 0, 'no request for a fragment that cannot match');

	input.value = 'zzz';
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await tick(450);
	assert.equal(calls.filter((call) => call.url.startsWith('/api/people')).length, 1);
	assert.match(q(dom, '[data-people-status]').textContent ?? '', /No handles match that fragment\./);
});

test('search results offer the action that matches the caller’s own relationship', async (t) => {
	const dom = friendsDom();
	const calls = install(dom, (call) => {
		if (call.url.startsWith('/api/people')) {
			return {
				body: {
					people: [
						{ handle: 'ada', displayName: 'Ada Lovelace', friendState: 'none' },
						{ handle: 'bob_', displayName: 'Bob', friendState: 'pending_in' },
						{ handle: 'carol', displayName: 'Carol', friendState: 'pending_out' },
						{ handle: 'dave', displayName: 'Dave', friendState: 'friends' },
					],
					truncated: false,
				},
			};
		}
		if (call.url === '/api/friends' && call.method === 'POST') return { body: { ...emptyLists(), changed: 'requested' } };
		return { body: emptyLists() };
	});
	const root = mountWith(t, dom);
	mountFriends(root);
	await tick(15);

	const input = q(dom, '[data-people-query]') as unknown as HTMLInputElement;
	// The fixture answers every query with the same four relationships; the
	// fragment only has to clear the configured minimum.
	input.value = 'ada';
	input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await tick(450);

	const rows = q(dom, '[data-people-results]').querySelectorAll('li');
	assert.equal(rows.length, 4);
	assert.ok(rows[0]!.querySelector('[data-people-add]'), 'a stranger gets Add friend');
	assert.ok(rows[1]!.querySelector('[data-people-accept]'), 'an incoming request gets Accept');
	assert.match(rows[2]!.textContent!, /Request sent/);
	assert.match(rows[3]!.textContent!, /Already friends/);

	rows[0]!.querySelector('[data-people-add]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(20);
	const post = calls.find((call) => call.url === '/api/friends' && call.method === 'POST');
	assert.deepEqual(post?.body, { action: 'request', handle: 'ada' });
});

test('declines, removes and unblocks use the route’s method vocabulary, and errors keep their copy', async (t) => {
	const dom = friendsDom();
	const calls = install(dom, (call) => {
		if (call.url === '/api/people') return { body: { people: [], truncated: false } };
		if (call.method === 'POST') return { status: 403, body: { error: 'blocked' } };
		return { body: { ...emptyLists(), blocked: [], changed: 'unblocked' } };
	});
	const root = mountWith(t, dom);
	mountFriends(root);
	await tick(15);

	// POST mutations: decline on an incoming row.
	const incoming = q(dom, '[data-friends-list="incoming"]');
	incoming.innerHTML = '<li class="friends-row" data-handle="bob_"><span class="friends-row__actions"><button type="button" class="glass-button" data-friend-action="decline" aria-label="Decline friend request from bob_">Decline</button></span></li>';
	incoming.querySelector('[data-friend-action="decline"]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(20);
	const decline = calls.find((call) => call.body && (call.body as { action: string }).action === 'decline');
	assert.equal(decline?.method, 'POST');
	assert.match(q(dom, '[data-friends-status]').textContent ?? '', /You cannot be friends with that account\./);
	assert.equal(q(dom, '[data-friends-status]').getAttribute('data-tone'), 'error');

	// DELETE mutations: unblock on a blocked row.
	const blocked = q(dom, '[data-friends-list="blocked"]');
	blocked.innerHTML = '<li class="friends-row" data-handle="eve"><span class="friends-row__actions"><button type="button" class="glass-button" data-friend-action="unblock" aria-label="Unblock eve">Unblock</button></span></li>';
	blocked.querySelector('[data-friend-action="unblock"]')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(20);
	const unblock = calls.find((call) => call.body && (call.body as { action: string }).action === 'unblock');
	assert.equal(unblock?.method, 'DELETE');
	assert.match(q(dom, '[data-friends-status]').textContent ?? '', /eve unblocked\./);
});
