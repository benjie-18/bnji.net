/**
 * Shared game shell controller: the lifecycle state (loading/ready/paused/
 * error/results), the fullscreen request for a game surface, and the
 * `:fullscreen` class the pages need because a document root cannot be styled
 * from a component's scoped CSS.
 */
export type GameShellState = 'loading' | 'ready' | 'paused' | 'error' | 'results';

type StateOptions = { message?: string; focus?: boolean };

const defaultMessage = (root: HTMLElement, state: GameShellState): string => {
	const title = root.dataset.gameTitle || 'Game';
	switch (state) {
		case 'loading': return `Loading ${title}.`;
		case 'ready': return `${title} is ready.`;
		case 'paused': return `${title} is paused.`;
		case 'error': return `${title} could not start.`;
		case 'results': return `${title} results are ready.`;
	}
};

/* --------------------------------------------------------------- fullscreen */

type FullscreenElement = HTMLElement & {
	webkitRequestFullscreen?: () => Promise<void> | void;
	webkitFullscreenElement?: Element | null;
};

function fullscreenHost(): Element | null {
	const element = document as Document & { webkitFullscreenElement?: Element | null; webkitIsFullscreen?: boolean };
	return element.fullscreenElement ?? element.webkitFullscreenElement ?? (element.webkitIsFullscreen ? document.documentElement : null);
}

/** Every surface registered as a game shell, so one key press picks the right one. */
const surfaces: HTMLElement[] = [];

export function gameSurfaceFor(root: HTMLElement): HTMLElement | null {
	return root.querySelector<HTMLElement>('[data-game-shell-surface]');
}

export function isGameFullscreen(root: HTMLElement): boolean {
	const surface = gameSurfaceFor(root);
	return Boolean(surface) && fullscreenHost() === surface;
}

/**
 * Ask the browser for real fullscreen; report whether it took. A rejected or
 * absent request is a normal outcome (embedded webviews, unsupported elements),
 * which is why the caller must not assume the state changed.
 */
export async function requestSurfaceFullscreen(surface: HTMLElement): Promise<boolean> {
	const element = surface as FullscreenElement;
	try {
		if (surface.requestFullscreen) await surface.requestFullscreen({ navigationUI: 'hide' });
		else if (element.webkitRequestFullscreen) await element.webkitRequestFullscreen();
		else return false;
	} catch {
		return false;
	}
	return fullscreenHost() === surface;
}

export async function exitSurfaceFullscreen(): Promise<void> {
	const documentExit = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
	try {
		if (document.exitFullscreen) await document.exitFullscreen();
		else if (documentExit.webkitExitFullscreen) await documentExit.webkitExitFullscreen();
	} catch { /* already out of fullscreen */ }
}

/**
 * `:fullscreen` cannot be written in a component's scoped CSS (a document root
 * has no scope attribute), so the shell marks the host element instead and the
 * page styles `[data-game-fullscreen]`.
 */
function paintFullscreenState(): void {
	const host = fullscreenHost();
	for (const surface of surfaces) {
		const active = Boolean(host) && (host === surface || surface.contains(host as Node));
		const root = rootFor(surface);
		if (root) root.dataset.gameFullscreen = active ? 'true' : 'false';
		surface.dataset.gameFullscreen = active ? 'true' : 'false';
	}
}

function rootFor(surface: HTMLElement): HTMLElement | null {
	return surface.closest<HTMLElement>('[data-game-shell]');
}

/** Bind the fullscreen control for one shell. Returns a teardown. */
export function initGameFullscreen(root: HTMLElement): () => void {
	const surface = gameSurfaceFor(root);
	// Qualified to a button: the state attribute below uses the same name on the
	// root and surface, and an unqualified selector would find the surface first.
	const button = root.querySelector<HTMLButtonElement>('button[data-game-fullscreen]');
	if (!surface || !button) return () => {};
	const supported = typeof surface.requestFullscreen === 'function' || typeof (surface as FullscreenElement).webkitRequestFullscreen === 'function';
	if (!supported) {
		// No API: the control would be a lie, so it is absent. (The button ships
		// `hidden` and only JavaScript ever shows it, so a no-JS page never shows
		// a control that cannot work.)
		button.hidden = true;
		return () => {};
	}
	button.hidden = false;
	surfaces.push(surface);
	const paint = (): void => {
		paintFullscreenState();
		const active = isGameFullscreen(root);
		button.setAttribute('aria-pressed', String(active));
		button.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
	};
	const onClick = (): void => {
		if (isGameFullscreen(root)) void exitSurfaceFullscreen().then(paint);
		else void requestSurfaceFullscreen(surface).then(paint);
	};
	button.addEventListener('click', onClick);
	document.addEventListener('fullscreenchange', paint);
	document.addEventListener('webkitfullscreenchange', paint);
	paint();
	return () => {
		button.removeEventListener('click', onClick);
		document.removeEventListener('fullscreenchange', paint);
		document.removeEventListener('webkitfullscreenchange', paint);
		const index = surfaces.indexOf(surface);
		if (index >= 0) surfaces.splice(index, 1);
		delete root.dataset.gameFullscreen;
		delete surface.dataset.gameFullscreen;
	};
}

/**
 * Measure the ready panel and publish its height as `--game-shell-reserve` on
 * the surface, so the shorter paused/results/error panels occupy the same box.
 *
 * The observer watches the panel's CONTENT rather than the panel itself: the
 * property it reads back is the panel's own min-height, so observing the panel
 * would feed the measurement into itself. A hidden content box reports zero,
 * which is why the last known height is kept — swapping to the results panel
 * must reuse the height the game had, not collapse to nothing.
 */
export function initShellHeightReserve(root: HTMLElement): () => void {
	const surface = gameSurfaceFor(root);
	const ready = root.querySelector<HTMLElement>('[data-game-shell-panel="ready"]');
	if (!surface || !ready) return () => {};
	const content = ready.querySelector<HTMLElement>('.game-shell__content') ?? ready;
	const paint = (): void => {
		const height = content.offsetHeight;
		if (!height) return;
		const chrome = Math.max(0, ready.offsetHeight - height);
		const reserve = `${Math.round(height + chrome)}px`;
		if (surface.style.getPropertyValue('--game-shell-reserve') !== reserve) {
			surface.style.setProperty('--game-shell-reserve', reserve);
		}
	};
	if (typeof ResizeObserver === 'undefined') {
		window.addEventListener('resize', paint);
		paint();
		return () => window.removeEventListener('resize', paint);
	}
	const observer = new ResizeObserver(paint);
	observer.observe(content);
	paint();
	return () => observer.disconnect();
}

/** Update the shared game shell without requiring a game-specific UI framework. */
export function setGameShellState(root: HTMLElement, state: GameShellState, options: StateOptions = {}): void {
	const previous = root.dataset.gameState;
	root.dataset.gameState = state;
	if (typeof root.querySelectorAll === 'function') {
		for (const panel of root.querySelectorAll<HTMLElement>('[data-game-shell-panel]')) {
			panel.hidden = panel.dataset.gameShellPanel !== state;
		}
	}

	const status = root.querySelector<HTMLElement>('[data-game-shell-status]');
	if (status) {
		status.setAttribute('role', state === 'error' ? 'alert' : 'status');
		status.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
		status.textContent = options.message || defaultMessage(root, state);
	}

	if (options.focus !== false && previous !== state) {
		let target: HTMLElement | null = null;
		if (state === 'paused') target = root.querySelector<HTMLElement>('[data-game-resume]');
		else if (state === 'ready') target = root.querySelector<HTMLElement>('[data-game-pause]');
		else if (state === 'error' || state === 'results') target = root.querySelector<HTMLElement>(`[data-game-shell-panel="${state}"] [data-game-shell-focus]`);
		target?.focus({ preventScroll: true });
	}

	if (previous !== state && typeof CustomEvent !== 'undefined' && typeof root.dispatchEvent === 'function') {
		root.dispatchEvent(new CustomEvent('bnji:game-statechange', { bubbles: true, detail: { state } }));
	}
}

/** Bind the semantic pause/resume controls once; native buttons provide Enter/Space operation. */
export function initGameShell(root: HTMLElement): () => void {
	if (root.dataset.gameShellInitialized === 'true') return () => {};
	root.dataset.gameShellInitialized = 'true';
	const onClick = (event: Event): void => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (target.closest('[data-game-pause]')) {
			setGameShellState(root, 'paused');
			root.dispatchEvent(new CustomEvent('bnji:game-pause', { bubbles: true }));
		} else if (target.closest('[data-game-resume]')) {
			setGameShellState(root, 'ready');
			root.dispatchEvent(new CustomEvent('bnji:game-resume', { bubbles: true }));
		}
	};
	root.addEventListener('click', onClick);
	const teardownFullscreen = initGameFullscreen(root);
	const teardownReserve = initShellHeightReserve(root);
	return () => {
		root.removeEventListener('click', onClick);
		teardownFullscreen();
		teardownReserve();
		delete root.dataset.gameShellInitialized;
	};
}

/** Component scripts call this after Astro's SSR markup is in the document. */
export function initGameShells(scope: ParentNode = document): () => void {
	const cleanups = Array.from(scope.querySelectorAll<HTMLElement>('[data-game-shell]'), initGameShell);
	return () => cleanups.forEach((cleanup) => cleanup());
}
