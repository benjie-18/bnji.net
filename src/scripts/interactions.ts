/**
 * BNJI.NET — pointer interactions.
 *
 * Everything in this module is driven by the pointer and is therefore
 * desktop-only by design: each init() bails out unless the device reports a
 * fine, hovering pointer. Touch visitors get the same site without a simulated
 * cursor, which is both cheaper and more honest.
 *
 * Cost model: one delegated `pointermove` listener per feature, each coalesced
 * into a single animation frame. No listener does layout work inside the event
 * dispatch; the only reads are one getBoundingClientRect per frame.
 *
 * Wiring lives in scripts/boot.ts. Markup opts in with data attributes:
 *   [data-cursor-glow]  the soft cursor halo element
 *   [data-glass]        liquid-glass surface (writes --mouse-x / --mouse-y)
 *   [data-magnetic]     small pointer attraction wrapper
 *   [data-nav-toggle] / [data-nav-panel]  mobile navigation disclosure
 */

import { clamp, createFrameScheduler, hasFinePointer, prefersReducedMotion } from './environment';

/** Guards, so importing this module twice can never double-bind listeners. */
let cursorGlowStarted = false;
let glassTrackingStarted = false;
let magneticStarted = false;
let navToggleStarted = false;

/* -------------------------------------------------------------------------- */
/* Cursor glow                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A small, restrained halo that trails the pointer. It is one composited
 * element moved with translate3d — no filters, no repaints of the page.
 * The rAF loop only runs while the pointer is moving or still settling.
 */
export function initCursorGlow(): void {
	if (cursorGlowStarted) return;
	cursorGlowStarted = true;

	const glow = document.querySelector<HTMLElement>('[data-cursor-glow]');
	if (!glow) return;

	// Reduced motion: leave the element hidden (CSS also removes it) rather than
	// animating something the visitor asked us not to animate.
	if (prefersReducedMotion() || !hasFinePointer()) {
		glow.hidden = true;
		return;
	}

	let targetX = 0;
	let targetY = 0;
	let currentX = 0;
	let currentY = 0;
	let visible = false;
	let pressed = false;
	let frame = 0;

	const settle = () => {
		// Frame-rate independent smoothing: ~0.22 per 60fps frame.
		const t = 0.22;
		currentX += (targetX - currentX) * t;
		currentY += (targetY - currentY) * t;

		glow.style.transform = `translate3d(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px, 0) scale(${
			pressed ? 0.82 : 1
		})`;
		glow.style.opacity = visible ? '1' : '0';

		const settled =
			Math.abs(targetX - currentX) < 0.2 && Math.abs(targetY - currentY) < 0.2 && visible;
		if (settled) {
			currentX = targetX;
			currentY = targetY;
			glow.style.transform = `translate3d(${currentX}px, ${currentY}px, 0) scale(${
				pressed ? 0.82 : 1
			})`;
			frame = 0;
			return;
		}
		if (!visible && Number(glow.style.opacity || 0) === 0) {
			frame = 0;
			return;
		}
		frame = requestAnimationFrame(settle);
	};

	const kick = () => {
		if (!frame) frame = requestAnimationFrame(settle);
	};

	window.addEventListener(
		'pointermove',
		(event) => {
			// Ignore pen/touch so a stylus tap does not spawn a cursor halo.
			if (event.pointerType !== 'mouse') return;
			targetX = event.clientX;
			targetY = event.clientY;
			if (!visible) {
				currentX = targetX;
				currentY = targetY;
				visible = true;
			}
			kick();
		},
		{ passive: true },
	);

	window.addEventListener(
		'pointerdown',
		(event) => {
			if (event.pointerType !== 'mouse') return;
			pressed = true;
			kick();
		},
		{ passive: true },
	);

	window.addEventListener(
		'pointerup',
		() => {
			pressed = false;
			kick();
		},
		{ passive: true },
	);

	// Leaving the window: fade out instead of parking a halo on the edge.
	document.addEventListener('pointerleave', () => {
		visible = false;
		kick();
	});
}

/* -------------------------------------------------------------------------- */
/* Liquid-glass pointer tracking                                              */
/* -------------------------------------------------------------------------- */

/**
 * Writes --mouse-x / --mouse-y on whichever [data-glass] surface the pointer is
 * over. Delegated (one listener for the whole document) so panels added later —
 * Lab experiments, for instance — work without re-binding, and so twenty cards
 * do not mean twenty listeners.
 *
 * glass.css turns those variables into the radial highlight; the CSS owns the
 * fade, this module only publishes coordinates.
 */
export function initGlassTracking(): void {
	if (glassTrackingStarted) return;
	glassTrackingStarted = true;
	if (!hasFinePointer()) return;

	let pending: HTMLElement | null = null;
	let pendingX = 0;
	let pendingY = 0;

	const flush = createFrameScheduler(() => {
		if (!pending) return;
		const box = pending.getBoundingClientRect();
		pending.style.setProperty('--mouse-x', `${Math.round(pendingX - box.left)}px`);
		pending.style.setProperty('--mouse-y', `${Math.round(pendingY - box.top)}px`);
	});

	document.addEventListener(
		'pointermove',
		(event) => {
			const target = event.target as Element | null;
			const surface = target?.closest?.('[data-glass]') as HTMLElement | null;
			if (!surface) return;
			pending = surface;
			pendingX = event.clientX;
			pendingY = event.clientY;
			flush();
		},
		{ passive: true },
	);
}

/* -------------------------------------------------------------------------- */
/* Magnetic controls                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Small pointer attraction for [data-magnetic] wrappers.
 *
 * The displacement is deliberately tiny (max ~9px by default) and the transform
 * is applied to a wrapper element, never to the button itself: the hit target
 * and the label stay exactly where the pointer expects them, so the effect can
 * never cost anyone a precise click.
 *
 * data-magnetic="0.3" overrides the pull factor; data-magnetic-max="6" the cap.
 */
export function initMagnetic(): void {
	if (magneticStarted) return;
	magneticStarted = true;
	if (!hasFinePointer() || prefersReducedMotion()) return;

	const DEFAULT_STRENGTH = 0.24;
	const DEFAULT_MAX = 9;

	document.querySelectorAll<HTMLElement>('[data-magnetic]').forEach((element) => {
		const strength = Number(element.dataset.magnetic) || DEFAULT_STRENGTH;
		const max = Number(element.dataset.magneticMax) || DEFAULT_MAX;

		let frame = 0;
		let pointerX = 0;
		let pointerY = 0;

		// One rect read + one transform write per frame, only while hovered.
		// Reading inside the frame (instead of caching on pointerenter) keeps the
		// math correct when the page scrolls or animates under the pointer.
		const apply = () => {
			frame = 0;
			const rect = element.getBoundingClientRect();
			const dx = pointerX - (rect.left + rect.width / 2);
			const dy = pointerY - (rect.top + rect.height / 2);
			const x = clamp(dx * strength, -max, max);
			const y = clamp(dy * strength, -max, max);
			element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
		};

		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(apply);
		};

		element.addEventListener('pointerenter', (event) => {
			if ((event as PointerEvent).pointerType !== 'mouse') return;
			element.classList.add('is-magnetised');
		});

		element.addEventListener(
			'pointermove',
			(event) => {
				if ((event as PointerEvent).pointerType !== 'mouse') return;
				pointerX = event.clientX;
				pointerY = event.clientY;
				schedule();
			},
			{ passive: true },
		);

		const release = () => {
			if (frame) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
			// CSS supplies the spring back once .is-magnetised is removed.
			element.classList.remove('is-magnetised');
			element.style.transform = '';
		};

		element.addEventListener('pointerleave', release);
		element.addEventListener('pointercancel', release);
	});
}

/* -------------------------------------------------------------------------- */
/* Mobile navigation disclosure                                               */
/* -------------------------------------------------------------------------- */

/**
 * Progressive enhancement only: the markup renders the nav panel closed with
 * `visibility: hidden`, and a no-JS stylesheet keeps the links permanently
 * visible. This function adds the toggle behaviour, aria state, and the
 * close-on-Escape / close-on-outside-click / close-on-navigate conveniences.
 */
export function initNavToggle(): void {
	if (navToggleStarted) return;
	navToggleStarted = true;

	const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
	const panel = document.querySelector<HTMLElement>('[data-nav-panel]');
	if (!toggle || !panel) return;

	const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

	const setOpen = (open: boolean) => {
		toggle.setAttribute('aria-expanded', String(open));
		panel.classList.toggle('is-open', open);
		document.documentElement.classList.toggle('nav-is-open', open);
	};

	toggle.addEventListener('click', () => setOpen(!isOpen()));

	panel.addEventListener('click', (event) => {
		// Navigating away must close the sheet, otherwise a back-navigation
		// returns to a page with the menu already open.
		if ((event.target as Element | null)?.closest('a')) setOpen(false);
	});

	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape' || !isOpen()) return;
		setOpen(false);
		toggle.focus();
	});

	document.addEventListener(
		'pointerdown',
		(event) => {
			if (!isOpen()) return;
			const target = event.target as Element | null;
			if (target?.closest('[data-nav-toggle]') || target?.closest('[data-nav-panel]')) return;
			setOpen(false);
		},
		{ passive: true },
	);

	// Leaving phone widths with the sheet open would leave a stale class behind.
	const desktop = matchMedia('(min-width: 900px)');
	const onBreakpointChange = () => {
		if (desktop.matches) setOpen(false);
	};
	if (typeof desktop.addEventListener === 'function') {
		desktop.addEventListener('change', onBreakpointChange);
	} else {
		// Safari < 14 fallback.
		desktop.addListener(onBreakpointChange);
	}
}
