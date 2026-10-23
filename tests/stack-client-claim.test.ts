/**
 * `bnji.isometric-stack` client claim flow — the game-over auto-submit path.
 *
 * The regression pinned here: `autoSubmitRunForRun` used to mark the claim as
 * done and hide every claim control as soon as the client DECIDED to submit,
 * even when the POST failed (`503 verifier_unavailable`, `rejected`,
 * `unreachable`). A finished run then vanished: nothing stored, no way to
 * claim it, no message. The contract now is:
 *
 *   - the controls disappear ONLY when the run is on the board (`stored`,
 *     `duplicate`);
 *   - a failed auto-submit keeps the manual form, the panel button and the
 *     overlay button visible and says the run is NOT on the leaderboard;
 *   - the manual retry reuses the run's stable idempotency key, so it is the
 *     SAME submission (`409 duplicate_submission` at worst, never a second row);
 *   - a `guest` standing never auto-submits and keeps the form (unchanged).
 *
 * The module is imported directly and driven against the same shim DOM the
 * music player and lab games use: a virtual clock feeds `requestAnimationFrame`
 * AND `performance.now()` (the module reads both), so block movement is
 * deterministic — each `advance(100)` is one frame of exactly 15.5px at the
 * locked 155px/s, the same arithmetic `tests/lab-games.test.ts` relies on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './support/dom.mjs';
import { createStackGame } from '../src/scripts/games/stack';
import { resetGameScoresCache } from '../src/scripts/game-scores';

/** The shim, kept deliberately loose: `tests/support/dom.mjs` is untyped JS support code. */
type Shim = { document: any; clock: { now: number; advance(ms: number): void }; advance(ms: number): void; uninstall(): void };
type Call = { url: string; path: string; method: string; body: Record<string, unknown> | undefined };
type FakeResponse = { status: number; body: unknown };

const ACCOUNT = { authenticated: true, displayName: 'Auto Alice', handle: null };
const ACCOUNT_STANDING = { scope: 'account', best: null, rank: null, entries: 0 };
const GUEST_STANDING = { scope: 'guest', best: null, rank: null, entries: 0 };

/** URL-routed fake fetch with a call log; `installTestDom`'s uninstall removes it. */
function installFetch(handler: (call: Call) => FakeResponse): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const call: Call = { url, path: url.split('?')[0] ?? url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined };
		calls.push(call);
		const response = handler(call);
		return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	return calls;
}

/** The `[data-stack-*]` fixture, mirroring src/pages/projects/games/stack.astro. */
function buildStackFixture(shim: Shim) {
	const document = shim.document;
	const make = (selector: string, tag = 'p') => {
		const node = document.createElement(tag);
		node.setAttribute(selector, '');
		document.body.appendChild(node);
		return node;
	};
	const canvas = make('data-stack-canvas', 'canvas');
	canvas.width = 640;
	canvas.height = 520;
	(canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
		() => ({ width: 640, height: 520 }) as DOMRect;
	const gradient = { addColorStop() {} };
	const context = new Proxy({}, {
		get: (target, prop) => {
			if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
			return prop in target ? (target as Record<PropertyKey, unknown>)[prop] : () => {};
		},
		set: (target, prop, value) => { (target as Record<PropertyKey, unknown>)[prop] = value; return true; },
	}) as unknown as CanvasRenderingContext2D;
	(canvas as unknown as { getContext: () => unknown }).getContext = () => context;

	const score = make('data-stack-score', 'span');
	const best = make('data-stack-best', 'span');
	const combo = make('data-stack-combo', 'div');
	const comboCount = make('data-stack-combo-count', 'span');
	const status = make('data-stack-status');
	const overlay = make('data-stack-overlay', 'div');
	const overlayTitle = make('data-stack-overlay-title', 'h3');
	const overlayDesc = make('data-stack-overlay-desc');
	const startButton = make('data-stack-start', 'button');
	const againButton = make('data-stack-again', 'button');
	const overlayClaim = make('data-stack-overlay-claim', 'button');
	const resetButton = make('data-stack-reset', 'button');
	const soundButton = make('data-stack-sound', 'button');
	const claimOpen = make('data-stack-claim-open', 'button');
	const claimBack = make('data-stack-results-back', 'button');
	const claimNote = make('data-stack-claim-note');
	const claimStatus = make('data-stack-claim-status');
	const resultNote = make('data-stack-result-note');
	const resultsAgain = make('data-stack-results-again', 'button');
	const claimForm = make('data-stack-claim', 'form');
	const nameInput = document.createElement('input');
	nameInput.setAttribute('name', 'displayName');
	claimForm.appendChild(nameInput);
	const submitButton = document.createElement('button');
	submitButton.setAttribute('type', 'submit');
	claimForm.appendChild(submitButton);

	return {
		canvas, score, best, combo, comboCount, status, overlay, overlayTitle, overlayDesc,
		startButton, againButton, overlayClaim, resetButton, soundButton,
		claimOpen, claimBack, claimNote, claimStatus, resultNote, resultsAgain,
		claimForm, nameInput, submitButton,
	};
}

type StackTest = ReturnType<typeof startStackTest>;

/**
 * Install the shim + fixture + fetch, patch `performance.now()` to the virtual
 * clock (the module seeds `lastTime` from it; the clock feeds rAF timestamps),
 * mount the game, and return a driver whose `advance(n)` is n frames of
 * exactly 15.5px of block travel each.
 */
function startStackTest(handler: (call: Call) => FakeResponse) {
	const shim = installTestDom() as unknown as Shim;
	const realPerformance = globalThis.performance;
	globalThis.performance = { now: () => shim.clock.now } as unknown as typeof performance;
	const calls = installFetch(handler);
	const els = buildStackFixture(shim);
	// The stack client's init ignores both arguments (the mount root and the
	// capability facts), but the shared GameModule contract carries them.
	const handle = createStackGame().module.init(shim.document.body, shim.document.body);
	const dropAt = (target: number): void => {
		// From a fresh spawn the block sits at -170; every 100ms frame moves it
		// 15.5px (dt clamps at 0.1s), so 11 frames land on 0.5 — a perfect drop.
		const frames = Math.round((target + 170) / 15.5);
		for (let index = 0; index < frames; index += 1) shim.advance(100);
		els.canvas.dispatchEvent({ type: 'pointerdown', preventDefault() {}, stopPropagation() {} });
	};
	const playScoringRun = (): void => {
		els.startButton.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
		dropAt(0); // perfect → score 1
		dropAt(0); // perfect → score 3
		dropAt(0); // perfect → score 6, four layers
		dropAt(140); // 140 ≥ width 140 → the fatal miss ends the run
	};
	return {
		shim, els, calls, playScoringRun,
		claimByText(name: string): void {
			els.nameInput.value = name;
			els.claimForm.dispatchEvent({ type: 'submit', preventDefault() {}, stopPropagation() {} });
		},
		scorePosts(): Call[] {
			return calls.filter((call) => call.path === '/api/games/scores' && call.method === 'POST');
		},
		async settle(): Promise<void> {
			// Yield to the real event loop (the shim's virtual clock does not own
			// setImmediate), so the fetch stub's Response bodies are consumed and
			// the whole auto-submit chain — standing read → account read → POST →
			// outcome handling → renderClaimable — completes before asserting.
			for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
		},
		async cleanup(): Promise<void> {
			// `init` is typed to possibly return a Promise; in practice it is sync.
			// Destroy BEFORE uninstalling: the handle's teardown cancels animation
			// frames through globals the shim owns.
			const mounted = await Promise.resolve(handle);
			mounted.destroy?.();
			globalThis.performance = realPerformance;
			shim.uninstall();
		},
	};
}

function withStackTest(handler: (call: Call) => FakeResponse, run: (t: StackTest) => Promise<void>): Promise<void> {
	const t = startStackTest(handler);
	return run(t).then(() => t.cleanup());
}

test('a failed automatic submit keeps the claim controls and the run claimable', async () => {
	resetGameScoresCache();
	let scorePostCount = 0;
	await withStackTest((call) => {
		if (call.path === '/api/games/scores/my') return { status: 200, body: ACCOUNT_STANDING };
		if (call.path === '/api/games/account') return { status: 200, body: ACCOUNT };
		if (call.path === '/api/games/scores') {
			scorePostCount += 1;
			// The first POST hits the production bug (no verifier wired → 503);
			// the manual retry reaches a healthy server and is stored.
			return scorePostCount === 1
				? { status: 503, body: { error: 'verifier_unavailable' } }
				: { status: 201, body: { ok: true, score: 6, tieBreak: 995 } };
		}
		throw new Error(`unexpected fetch: ${call.url}`);
	}, async (t) => {
		t.playScoringRun();
		await t.settle();

		// The auto-submit was attempted (and failed with the production bug's 503).
		assert.equal(t.scorePosts().length, 1, 'the run must be auto-submitted once');
		// THE FIX: nothing was stored, so every claim affordance stays up.
		assert.equal(t.els.claimForm.hidden, false, 'the manual claim form must stay visible after a failed auto-submit');
		assert.equal(t.els.claimOpen.hidden, false, 'the panel claim button must stay visible');
		assert.equal(t.els.overlayClaim.hidden, false, 'the overlay claim button must stay visible');
		assert.match(t.els.claimStatus.textContent ?? '', /NOT on the leaderboard/);

		// Recovery: the manual claim reuses the SAME run key — one submission.
		t.claimByText('Claim Carl');
		await t.settle();
		const posts = t.scorePosts();
		assert.equal(posts.length, 2, 'the manual retry posts once');
		assert.equal(posts[1]?.body?.idempotencyKey, posts[0]?.body?.idempotencyKey, 'the retry must reuse the run idempotency key');
		assert.equal(posts[1]?.body?.displayName, 'Claim Carl');
		assert.equal(t.els.claimForm.hidden, true, 'a stored manual claim closes the form');
		assert.match(t.els.claimStatus.textContent ?? '', /Score recorded: 6/);
	});
});

test('a stored automatic submit closes every claim control', async () => {
	resetGameScoresCache();
	await withStackTest((call) => {
		if (call.path === '/api/games/scores/my') return { status: 200, body: ACCOUNT_STANDING };
		if (call.path === '/api/games/account') return { status: 200, body: ACCOUNT };
		if (call.path === '/api/games/scores') return { status: 201, body: { ok: true, score: 6, tieBreak: 995 } };
		throw new Error(`unexpected fetch: ${call.url}`);
	}, async (t) => {
		t.playScoringRun();
		await t.settle();
		assert.equal(t.scorePosts().length, 1);
		assert.equal(t.els.claimForm.hidden, true, 'a stored run must close the claim form');
		assert.equal(t.els.claimOpen.hidden, true);
		assert.equal(t.els.overlayClaim.hidden, true);
		assert.match(t.els.overlayDesc.textContent ?? '', /submitted to the Isometric Stack leaderboard/);
		assert.match(t.els.claimStatus.textContent ?? '', /Score recorded: 6/);
	});
});

test('a guest standing never auto-submits and keeps the manual form', async () => {
	resetGameScoresCache();
	await withStackTest((call) => {
		if (call.path === '/api/games/scores/my') return { status: 200, body: GUEST_STANDING };
		if (call.path === '/api/games/account') throw new Error('guests must not be asked for an account during auto-submit');
		if (call.path === '/api/games/scores') return { status: 201, body: { ok: true, score: 6, tieBreak: 995 } };
		throw new Error(`unexpected fetch: ${call.url}`);
	}, async (t) => {
		t.playScoringRun();
		await t.settle();
		assert.equal(t.scorePosts().length, 0, 'guest runs are never auto-submitted');
		assert.equal(t.els.claimForm.hidden, false);
		assert.match(t.els.claimStatus.textContent ?? '', /Guest runs are claimed with a display name below/);
		t.claimByText('Guest Gus');
		await t.settle();
		assert.equal(t.scorePosts().length, 1);
		assert.equal(t.els.claimForm.hidden, true);
	});
});
