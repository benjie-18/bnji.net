import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountPlayerTools } from '../src/scripts/game-player-ui';

const ORIGIN = 'http://localhost:8787';
const tick = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function playerToolsDom(): JSDOM {
	const html = `<!doctype html>
<html>
<body>
	<div data-player-root>
		<p data-player-live></p>
		<div data-player-guest>
			<form data-player-create>
				<input name="displayName" value="Test Player" />
				<button type="submit">Create Account</button>
			</form>
			<form data-player-login>
				<input name="recoveryCode" value="BNJI-TEST123456789012345678901234" />
				<button type="submit">Sign In</button>
			</form>
		</div>
		<div data-player-account hidden>
			<p data-player-greeting></p>
			<p data-handle-status></p>
			<form data-player-handle>
				<input name="handle" value="test_handle" />
				<button type="submit">Save Handle</button>
			</form>
			<button data-rotate-recovery type="button">Rotate Code</button>
			<button data-player-signout type="button">Sign Out</button>
			<button data-player-delete type="button">Delete</button>
			<button data-player-sync type="button">Sync</button>
			<button data-player-export type="button">Export</button>
		</div>
		<div data-recovery-panel hidden>
			<span data-recovery-code></span>
			<button data-copy-recovery type="button">Copy</button>
			<button data-download-recovery type="button">Download</button>
			<button data-recovery-dismiss type="button">Dismiss</button>
		</div>
		<div data-player-saves hidden>
			<div data-save-list></div>
		</div>
	</div>
</body>
</html>`;
	return new JSDOM(html, { url: `${ORIGIN}/games/` });
}

type Call = { url: string; method: string; body: unknown };

function install(dom: JSDOM, handler: (call: Call) => { status?: number; body: unknown }) {
	const calls: Call[] = [];
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	g.FormData = dom.window.FormData;
	Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
	g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const call: Call = {
			url,
			method: (init?.method ?? 'GET').toUpperCase(),
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
		};
		calls.push(call);
		const result = handler(call);
		return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return calls;
}

test('mountPlayerTools reads FormData before disabling inputs on account creation', async (t) => {
	const dom = playerToolsDom();
	t.after(() => dom.window.close());
	const calls = install(dom, (call) => {
		if (call.url === '/api/games/account' && call.method === 'GET') {
			return { body: { authenticated: false } };
		}
		if (call.url === '/api/games/account' && call.method === 'POST') {
			return { body: { authenticated: true, displayName: 'Test Player', recoveryCode: 'BNJI-NEWCODE' } };
		}
		return { body: {} };
	});

	const root = dom.window.document.querySelector('[data-player-root]') as HTMLElement;
	await mountPlayerTools(root);
	await tick();

	const createForm = dom.window.document.querySelector('[data-player-create]') as HTMLFormElement;
	createForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
	await tick();

	const postCall = calls.find((c) => c.method === 'POST' && c.url === '/api/games/account');
	assert.ok(postCall, 'Form submission should make a POST to /api/games/account');
	assert.deepEqual(postCall.body, { action: 'create', displayName: 'Test Player' }, 'displayName was read from FormData before disabling inputs');
});

test('mountPlayerTools reads FormData before disabling inputs on handle save', async (t) => {
	const dom = playerToolsDom();
	t.after(() => dom.window.close());
	const calls = install(dom, (call) => {
		if (call.url === '/api/games/account' && call.method === 'GET') {
			return { body: { authenticated: true, displayName: 'Test Player', handle: null } };
		}
		if (call.url === '/api/games/account' && call.method === 'POST') {
			return { body: { handle: 'test_handle' } };
		}
		return { body: {} };
	});

	const root = dom.window.document.querySelector('[data-player-root]') as HTMLElement;
	await mountPlayerTools(root);
	await tick();

	const handleForm = dom.window.document.querySelector('[data-player-handle]') as HTMLFormElement;
	handleForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
	await tick();

	const postCall = calls.find((c) => c.method === 'POST' && (c.body as { action?: string })?.action === 'set-handle');
	assert.ok(postCall, 'Handle submission should POST set-handle action');
	assert.deepEqual(postCall.body, { action: 'set-handle', handle: 'test_handle' }, 'handle was read from FormData before setBusy disabled inputs');
});
