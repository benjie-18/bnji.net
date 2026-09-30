import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { detectGameCapabilities, mountGameLifecycle, type GameHandle, type GameModule } from '../src/scripts/game-runtime';
import { setGameShellState, type GameShellState } from '../src/scripts/game-shell';

type Listener = (event?: unknown) => void;
class EventHost {
	listeners = new Map<string, Set<Listener>>();
	addEventListener(type: string, listener: Listener): void {
		const current = this.listeners.get(type) ?? new Set<Listener>();
		current.add(listener);
		this.listeners.set(type, current);
	}
	removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
	fire(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
}

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
let activeEnvironment: ReturnType<typeof createEnvironment> | undefined;
function installGlobal(name: string, value: unknown): void {
	if (!originalDescriptors.has(name)) originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
function restoreGlobals(): void {
	for (const [name, descriptor] of originalDescriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else delete (globalThis as unknown as Record<string, unknown>)[name];
	}
	originalDescriptors.clear();
	activeEnvironment = undefined;
}
afterEach(restoreGlobals);

function createEnvironment(support: { canvas2d?: boolean; webgl2?: boolean; webgpu?: boolean; audio?: boolean; keyboard?: boolean; touch?: number; gamepad?: boolean; reducedMotion?: boolean } = {}) {
	const doc = new EventHost() as EventHost & { visibilityState: DocumentVisibilityState; createElement: (tag: string) => HTMLCanvasElement };
	doc.visibilityState = 'visible';
	doc.createElement = () => ({
		getContext(kind: string) {
			if (kind === '2d' && support.canvas2d) return {} as CanvasRenderingContext2D;
			if (kind === 'webgl2' && support.webgl2) return { getExtension: () => ({ loseContext() {} }) } as unknown as WebGL2RenderingContext;
			return null;
		},
	} as HTMLCanvasElement);
	const media = (query: string) => ({ matches: query.includes('prefers-reduced-motion') ? Boolean(support.reducedMotion) : query.includes('pointer: coarse') ? Boolean(support.touch) : false });
	const browserWindow = Object.assign(new EventHost(), {
		matchMedia: media,
		...(support.audio ? { AudioContext: class AudioContext {} } : {}),
		...(support.keyboard === false ? { addEventListener: undefined } : {}),
	});
	const nav = {
		maxTouchPoints: support.touch ?? 0,
		...(support.webgpu ? { gpu: {} } : {}),
		...(support.gamepad ? { getGamepads() { return []; } } : {}),
	};
	const observers: FakeObserver[] = [];
	class FakeObserver {
		static instances: FakeObserver[] = observers;
		disconnected = false;
		private callback: IntersectionObserverCallback;
		constructor(callback: IntersectionObserverCallback) { this.callback = callback; observers.push(this); }
		observe(): void {}
		disconnect(): void { this.disconnected = true; }
		trigger(isIntersecting: boolean): void {
			this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
		}
	}
	installGlobal('document', doc);
	installGlobal('window', browserWindow);
	installGlobal('navigator', nav);
	installGlobal('IntersectionObserver', FakeObserver);
	return { doc, browserWindow, observers };
}
function makeRoot(): HTMLElement {
	const root = new EventHost() as EventHost & { dataset: Record<string, string>; querySelector: () => HTMLElement | null };
	root.dataset = {};
	root.querySelector = () => null;
	return root as unknown as HTMLElement;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('shared shell updates one live region, state panels, and state-specific focus', () => {
	const states: GameShellState[] = ['loading', 'ready', 'paused', 'error', 'results'];
	const panels = states.map((state) => ({ dataset: { gameShellPanel: state }, hidden: true }));
	const status = { attributes: new Map<string, string>(), textContent: '', setAttribute(name: string, value: string) { this.attributes.set(name, value); } };
	const targets: Record<string, { focus(): void }> = {
		'[data-game-pause]': { focus() { focused = 'pause'; } },
		'[data-game-resume]': { focus() { focused = 'resume'; } },
		'[data-game-shell-panel="error"] [data-game-shell-focus]': { focus() { focused = 'error'; } },
		'[data-game-shell-panel="results"] [data-game-shell-focus]': { focus() { focused = 'results'; } },
	};
	let focused = '';
	const root = {
		dataset: { gameTitle: 'Shell test', gameState: 'ready' },
		querySelectorAll: () => panels,
		querySelector: (selector: string) => selector === '[data-game-shell-status]' ? status : targets[selector] ?? null,
	} as unknown as HTMLElement;

	setGameShellState(root, 'loading', { focus: false });
	assert.equal(panels.find((panel) => panel.dataset.gameShellPanel === 'loading')?.hidden, false);
	assert.equal(status.textContent, 'Loading Shell test.');
	assert.equal(status.attributes.get('aria-live'), 'polite');
	assert.equal(focused, '');
	setGameShellState(root, 'paused');
	assert.equal(focused, 'resume');
	assert.equal(status.textContent, 'Shell test is paused.');
	setGameShellState(root, 'error', { message: 'Could not load.' });
	assert.equal(status.attributes.get('role'), 'alert');
	assert.equal(status.attributes.get('aria-live'), 'assertive');
	assert.equal(status.textContent, 'Could not load.');
	assert.equal(focused, 'error');
	setGameShellState(root, 'results');
	assert.equal(focused, 'results');
	assert.equal(status.attributes.get('aria-live'), 'polite');
	setGameShellState(root, 'ready');
	assert.equal(focused, 'pause');
	assert.equal(panels.filter((panel) => !panel.hidden).length, 1);
});


test('capability detection reports APIs instead of assuming input or GPU/audio support', () => {
	activeEnvironment = createEnvironment({ reducedMotion: true });
	const unsupported = detectGameCapabilities();
	assert.equal(unsupported.keyboardEvents, true);
	assert.equal(unsupported.pointer, false);
	assert.equal(unsupported.touch, false);
	assert.equal(unsupported.gamepad, false);
	assert.equal(unsupported.canvas2d, false);
	assert.equal(unsupported.webgl2, false);
	assert.equal(unsupported.webgpu, false);
	assert.equal(unsupported.webAudio, false);
	assert.equal(unsupported.reducedMotion, true);

	activeEnvironment = createEnvironment({ canvas2d: true, webgl2: true, webgpu: true, audio: true, gamepad: true, keyboard: false, touch: 1 });
	const supported = detectGameCapabilities();
	assert.equal(supported.keyboardEvents, false);
	assert.equal(supported.touch, true);
	assert.equal(supported.gamepad, true);
	assert.equal(supported.canvas2d, true);
	assert.equal(supported.webgl2, true);
	assert.equal(supported.webgpu, true);
	assert.equal(supported.webAudio, true);
});

test('lifecycle waits for the first intersection result, then pauses, resumes, and tears down once', async () => {
	activeEnvironment = createEnvironment();
	const root = makeRoot();
	let initCount = 0;
	let pauseCount = 0;
	let resumeCount = 0;
	let destroyCount = 0;
	const game: GameModule = { init: () => { initCount += 1; return {
		pause() { pauseCount += 1; }, resume() { resumeCount += 1; }, destroy() { destroyCount += 1; },
	}; } };
	const teardown = mountGameLifecycle(root, game);
	assert.equal(initCount, 0, 'must not initialize before IntersectionObserver establishes visibility');
	activeEnvironment.observers[0]!.trigger(false);
	await tick();
	assert.equal(initCount, 0, 'offscreen roots must not initialize');
	activeEnvironment.observers[0]!.trigger(true);
	await tick();
	assert.equal(initCount, 1);
	assert.equal(resumeCount, 1);
	activeEnvironment.observers[0]!.trigger(false);
	assert.equal(pauseCount, 1);
	activeEnvironment.observers[0]!.trigger(true);
	assert.equal(resumeCount, 2);
	teardown();
	teardown();
	assert.equal(pauseCount, 2);
	assert.equal(destroyCount, 1);
	assert.equal(activeEnvironment.observers[0]!.disconnected, true);
	assert.equal((activeEnvironment.doc as unknown as EventHost).listeners.get('visibilitychange')?.size ?? 0, 0);
});

test('shared shell pause/resume events stop and resume the existing game handle', async () => {
	activeEnvironment = createEnvironment();
	const root = makeRoot();
	let pauses = 0;
	let resumes = 0;
	const teardown = mountGameLifecycle(root, { init: () => ({ pause() { pauses += 1; }, resume() { resumes += 1; } }) });
	activeEnvironment.observers[0]!.trigger(true);
	await tick();
	assert.equal(resumes, 1);
	(root as unknown as EventHost).fire('bnji:game-pause');
	assert.equal(pauses, 1);
	(root as unknown as EventHost).fire('bnji:game-resume');
	assert.equal(resumes, 2);
	teardown();
	assert.equal(pauses, 2);
});

test('a pause while async init is pending prevents an unwanted resume until visibility returns', async () => {
	activeEnvironment = createEnvironment();
	const pending = deferred<GameHandle>();
	let resumes = 0;
	let pauses = 0;
	const game: GameModule = { init: async () => pending.promise };
	const teardown = mountGameLifecycle(makeRoot(), game);
	activeEnvironment.observers[0]!.trigger(true);
	await tick();
	activeEnvironment.doc.visibilityState = 'hidden';
	activeEnvironment.doc.fire('visibilitychange');
	pending.resolve({ resume() { resumes += 1; }, pause() { pauses += 1; } });
	await tick();
	assert.equal(resumes, 0, 'resolution of an init promise must not override a later pause');
	activeEnvironment.doc.visibilityState = 'visible';
	activeEnvironment.doc.fire('visibilitychange');
	assert.equal(resumes, 1, 'the initialized handle resumes when all gates become active');
	teardown();
	assert.equal(pauses, 1);
});

test('teardown during async init destroys the eventual handle without resuming it', async () => {
	activeEnvironment = createEnvironment();
	const pending = deferred<GameHandle>();
	let resumes = 0;
	let destroys = 0;
	const game: GameModule = { init: async () => pending.promise };
	const teardown = mountGameLifecycle(makeRoot(), game);
	activeEnvironment.observers[0]!.trigger(true);
	await tick();
	teardown();
	pending.resolve({ resume() { resumes += 1; }, destroy() { destroys += 1; } });
	await tick();
	assert.equal(resumes, 0);
	assert.equal(destroys, 1, 'handle created after teardown must be destroyed exactly once');
});
