/**
 * BNJI.NET — shared capability detection and scheduling helpers.
 *
 * Every pointer/animation module asks this file whether the current device can
 * afford an effect, so "supports pointer effects" means the same thing in
 * starfield.ts, interactions.ts and scroll.ts.
 */

/** True when the visitor asked the OS to reduce motion. */
export function prefersReducedMotion(): boolean {
	return (
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/**
 * True only for devices with a real hovering pointer (mouse/trackpad/stylus).
 * Touch phones report false, which is how the spec's "no pointer effects on
 * mobile" rule is enforced — nothing has to sniff the user agent.
 */
export function hasFinePointer(): boolean {
	return (
		typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches
	);
}

/** True when the tab is visible; used to stop rAF loops in background tabs. */
export function isPageVisible(): boolean {
	return typeof document === 'undefined' || document.hidden === false;
}

export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

/** Linear interpolation. t is expected in 0..1. */
export function lerp(from: number, to: number, t: number): number {
	return from + (to - from) * t;
}

/**
 * Coalesces a high-frequency handler (pointermove, scroll, resize) into at most
 * one call per animation frame. The handler must read the *latest* state itself
 * rather than relying on the event object, which is the point: no work happens
 * inside the event dispatch.
 */
export function createFrameScheduler(callback: () => void): () => void {
	let queued = false;
	return () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			callback();
		});
	};
}

/** Debounce for one-shot work such as regenerating a star field on resize. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (...args: A) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), wait);
	};
}
