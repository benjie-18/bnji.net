/**
 * Minimal client-side game contract: initialize once when foreground + in view,
 * pause/resume without a busy render loop, and release all owned resources at teardown.
 */
import { setGameShellState, type GameShellState } from './game-shell';

export type GameCapabilities = {
	keyboardEvents: boolean; pointer: boolean; touch: boolean; gamepad: boolean;
	canvas2d: boolean; webgl2: boolean; webgpu: boolean; webAudio: boolean; reducedMotion: boolean;
};
export type GameHandle = { pause?: () => void; resume?: () => void; destroy?: () => void };
export type GameModule = { init: (root: HTMLElement, capabilities: GameCapabilities) => GameHandle | Promise<GameHandle> };

export function detectGameCapabilities(): GameCapabilities {
	const canvas = document.createElement('canvas');
	let canvas2d = false;
	let webgl2 = false;
	try { canvas2d = Boolean(canvas.getContext('2d')); } catch { /* unsupported */ }
	try {
		const gl = document.createElement('canvas').getContext('webgl2');
		webgl2 = Boolean(gl);
		gl?.getExtension('WEBGL_lose_context')?.loseContext();
	} catch { /* unsupported */ }
	const nav = navigator as Navigator & { gpu?: unknown; getGamepads?: () => unknown };
	const media = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : () => ({ matches: false });
	return {
		// This describes browser event support, not the presence of a physical keyboard.
		keyboardEvents: typeof window.addEventListener === 'function',
		pointer: media('(pointer: fine)').matches,
		touch: (navigator.maxTouchPoints ?? 0) > 0 || media('(pointer: coarse)').matches,
		gamepad: typeof nav.getGamepads === 'function',
		canvas2d,
		webgl2,
		webgpu: Boolean(nav.gpu),
		webAudio: typeof window.AudioContext !== 'undefined' || 'webkitAudioContext' in window,
		reducedMotion: media('(prefers-reduced-motion: reduce)').matches,
	};
}

/** Mount a controller only after visibility is known; all async init and owned resources are torn down safely. */
export function mountGameLifecycle(root: HTMLElement, game: GameModule): () => void {
	let destroyed = false;
	let visible = document.visibilityState !== 'hidden';
	let intersectionKnown = typeof IntersectionObserver === 'undefined';
	let inView = typeof IntersectionObserver === 'undefined';
	let initializing = false;
	let initialized = false;
	let failed = false;
	let userPaused = root.dataset.gameState === 'paused';
	let finished = root.dataset.gameState === 'results';
	let resumed = false;
	let handle: GameHandle | undefined;
	const status = root.querySelector<HTMLElement>('[data-game-runtime-status]');
	const canRun = (): boolean => !destroyed && !failed && !userPaused && !finished && visible && intersectionKnown && inView;

	if (root.dataset.gameId && root.dataset.gameState === 'ready') {
		setGameShellState(root, 'loading', { focus: false });
	}
	const reportFailure = (): void => {
		failed = true;
		resumed = false;
		if (status) status.textContent = 'This game could not start in this browser. You can return to the Games catalog.';
		setGameShellState(root, 'error', { message: 'This game could not start in this browser. You can return to the Games catalog.' });
	};
	const resumeHandle = (): void => {
		if (!canRun() || !initialized || resumed || !handle) return;
		try {
			handle.resume?.();
			resumed = true;
			if (root.dataset.gameId && (root.dataset.gameState === 'loading' || root.dataset.gameState === 'paused')) {
				setGameShellState(root, 'ready', { focus: false });
			}
		} catch {
			try { handle.pause?.(); } catch { /* isolate game faults */ }
			reportFailure();
		}
	};
	const initialize = (): void => {
		if (destroyed || failed || initializing || initialized || !canRun()) return;
		initializing = true;
		void Promise.resolve()
			.then(() => destroyed ? undefined : game.init(root, detectGameCapabilities()))
			.then((created) => {
				initializing = false;
				if (!created) return;
				if (destroyed) {
					try { created.destroy?.(); } catch { /* teardown continues */ }
					return;
				}
				handle = created;
				initialized = true;
				resumeHandle();
			})
			.catch(() => {
				initializing = false;
				if (!destroyed) reportFailure();
			});
	};
	const update = (): void => {
		if (!canRun()) {
			if (resumed) {
				resumed = false;
				try { handle?.pause?.(); } catch { /* isolate game faults */ }
				if (!userPaused && !finished && root.dataset.gameState === 'ready') {
					setGameShellState(root, 'paused', { focus: false });
				}
			}
			return;
		}
		if (initialized) resumeHandle();
		else initialize();
	};
	const onPause = (): void => { userPaused = true; update(); };
	const onResume = (): void => { userPaused = false; update(); };
	const onStateChange = (event: Event): void => {
		const state = (event as CustomEvent<{ state?: GameShellState }>).detail?.state;
		if (state === 'results') { finished = true; update(); }
	};
	root.addEventListener('bnji:game-pause', onPause);
	root.addEventListener('bnji:game-resume', onResume);
	root.addEventListener('bnji:game-statechange', onStateChange);
	const onVisibility = (): void => {
		visible = document.visibilityState !== 'hidden';
		update();
	};
	document.addEventListener('visibilitychange', onVisibility);
	let observer: IntersectionObserver | undefined;
	if (typeof IntersectionObserver !== 'undefined') {
		observer = new IntersectionObserver((entries) => {
			intersectionKnown = true;
			inView = Boolean(entries[0]?.isIntersecting);
			root.dataset.gameInView = String(inView);
			update();
		}, { threshold: 0.01 });
		observer.observe(root);
	} else {
		root.dataset.gameInView = 'true';
		update();
	}
	return () => {
		if (destroyed) return;
		destroyed = true;
		if (resumed) {
			resumed = false;
			try { handle?.pause?.(); } catch { /* teardown continues */ }
		}
		observer?.disconnect();
		document.removeEventListener('visibilitychange', onVisibility);
		root.removeEventListener('bnji:game-pause', onPause);
		root.removeEventListener('bnji:game-resume', onResume);
		root.removeEventListener('bnji:game-statechange', onStateChange);
		try { handle?.destroy?.(); } catch { /* teardown continues */ }
	};
}

export type SessionTelemetry = {
	kind: 'start' | 'heartbeat' | 'end'; activeMs: number;
	screenClass: 'compact' | 'standard' | 'large' | 'unknown';
	inputClass: 'touch' | 'fine-pointer' | 'mixed' | 'unknown';
};
function screenClass(): SessionTelemetry['screenClass'] {
	const width = Math.min(window.screen?.width ?? 0, window.innerWidth || 0);
	if (!width) return 'unknown';
	return width < 600 ? 'compact' : width < 1200 ? 'standard' : 'large';
}
function inputClass(): SessionTelemetry['inputClass'] {
	const touch = navigator.maxTouchPoints > 0;
	const pointer = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
	return touch && pointer ? 'mixed' : touch ? 'touch' : pointer ? 'fine-pointer' : 'unknown';
}

/** Report foreground, visible, in-view activity. A two-minute idle window prevents background/abandoned tabs accruing playtime. */
function createGameRunId(): string {
	try {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
		if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
			const bytes = new Uint8Array(16);
			crypto.getRandomValues(bytes);
			return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
		}
	} catch { /* a run key is telemetry, never a gameplay dependency */ }
	const random = (): string => Math.floor(Math.random() * 0x1_0000).toString(16).padStart(4, '0');
	return `${random()}${random()}-${random()}-4${random().slice(1)}-8${random().slice(1)}-${random()}${random()}${random()}`;
}

export function mountGameSession(root: HTMLElement, gameId: string): () => void {
	const IDLE_LIMIT_MS = 120_000;
	const runId = createGameRunId();
	let disposed = false;
	let isActive = false;
	let started = false;
	let counting = false;
	let activeSince = 0;
	let lastActivityAt = 0;
	let pendingActiveMs = 0;
	let interval = 0;
	const screen = screenClass();
	const input = inputClass();
	const send = (kind: SessionTelemetry['kind'], activeMs: number): void => {
		const payload: SessionTelemetry & { gameId: string; runId: string } = {
			gameId, runId, kind, activeMs: Math.min(65_000, Math.max(0, Math.floor(activeMs))), screenClass: screen, inputClass: input,
		};
		const encoded = JSON.stringify(payload);
		try {
			if (kind === 'end' && navigator.sendBeacon && navigator.sendBeacon('/api/games/session', new Blob([encoded], { type: 'application/json' }))) return;
			void fetch('/api/games/session', {
				method: 'POST', credentials: 'same-origin', cache: 'no-store',
				headers: { 'content-type': 'application/json' }, body: encoded, keepalive: kind === 'end',
			}).catch(() => {});
		} catch { /* tracking must never surface an error to the player */ }
	};
	const account = (): void => {
		if (!isActive || !counting) return;
		const now = performance.now();
		const stopAt = Math.min(now, lastActivityAt + IDLE_LIMIT_MS);
		if (stopAt > activeSince) pendingActiveMs = Math.min(65_000, pendingActiveMs + stopAt - activeSince);
		activeSince = stopAt;
		if (now >= lastActivityAt + IDLE_LIMIT_MS) counting = false;
	};
	const flush = (): void => {
		account();
		if (pendingActiveMs > 0) { send('heartbeat', pendingActiveMs); pendingActiveMs = 0; }
		if (!counting) { window.clearInterval(interval); interval = 0; }
	};
	const start = (): void => {
		if (disposed || isActive || document.visibilityState === 'hidden' || root.dataset.gameInView === 'false') return;
		isActive = true;
		started = true;
		send('start', 0);
	};
	const markActivity = (): void => {
		if (!isActive) return;
		account();
		lastActivityAt = performance.now();
		activeSince = lastActivityAt;
		counting = true;
		if (!interval) interval = window.setInterval(flush, 60_000);
	};
	root.addEventListener('pointerdown', markActivity);
	root.addEventListener('touchstart', markActivity, { passive: true });
	root.addEventListener('keydown', markActivity);
	root.addEventListener('bnji:game-activity', markActivity);
	const stop = (): void => {
		if (!isActive) return;
		account();
		isActive = false;
		window.clearInterval(interval);
		interval = 0;
		if (started) send('end', pendingActiveMs);
		pendingActiveMs = 0;
		counting = false;
		started = false;
	};
	const onVisibility = (): void => document.visibilityState === 'hidden' ? stop() : start();
	document.addEventListener('visibilitychange', onVisibility);
	let observer: IntersectionObserver | undefined;
	if (typeof IntersectionObserver !== 'undefined') {
		observer = new IntersectionObserver((entries) => {
			root.dataset.gameInView = String(Boolean(entries[0]?.isIntersecting));
			root.dataset.gameInView === 'true' ? start() : stop();
		}, { threshold: 0.01 });
		observer.observe(root);
	} else { root.dataset.gameInView = 'true'; start(); }
	const onPageHide = (): void => teardown();
	window.addEventListener('pagehide', onPageHide, { once: true });
	function teardown(): void {
		if (disposed) return;
		stop();
		disposed = true;
		window.clearInterval(interval);
		observer?.disconnect();
		document.removeEventListener('visibilitychange', onVisibility);
		window.removeEventListener('pagehide', onPageHide);
		root.removeEventListener('pointerdown', markActivity);
		root.removeEventListener('touchstart', markActivity);
		root.removeEventListener('keydown', markActivity);
		root.removeEventListener('bnji:game-activity', markActivity);
	}
	return teardown;
}

const LAB_GAME_IDS: Record<string, string> = {
	'glass-minesweeper': 'bnji.glass-minesweeper',
	'memory-pairs': 'bnji.memory-pairs',
	'stack-game': 'bnji.isometric-stack',
	'bubble-pop': 'bnji.bubble-pop',
	'reaction-timer': 'bnji.reaction-timer',
};
const trackedLabRoots = new WeakSet<HTMLElement>();
/** Track existing Lab entries by reference only; their gameplay remains in its current component. */
export function initLabGameTracking(): void {
	for (const root of document.querySelectorAll<HTMLElement>('[data-lab-experiment]')) {
		const gameId = LAB_GAME_IDS[root.dataset.labExperiment ?? ''];
		if (!gameId || trackedLabRoots.has(root)) continue;
		trackedLabRoots.add(root);
		mountGameSession(root, gameId);
	}
}
