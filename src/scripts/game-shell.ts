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
	return () => {
		root.removeEventListener('click', onClick);
		delete root.dataset.gameShellInitialized;
	};
}

/** Component scripts call this after Astro's SSR markup is in the document. */
export function initGameShells(scope: ParentNode = document): () => void {
	const cleanups = Array.from(scope.querySelectorAll<HTMLElement>('[data-game-shell]'), initGameShell);
	return () => cleanups.forEach((cleanup) => cleanup());
}
