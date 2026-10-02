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
 *   (background parallax needs no opt-in: it publishes --bg-parallax-* to
 *    :root and the CSS decides which layers consume them)
 *   [data-glass]        liquid-glass surface (writes --mouse-x / --mouse-y)
 *   [data-magnetic]     small pointer attraction wrapper
 *   [data-nav-toggle] / [data-nav-panel]  mobile navigation disclosure
 *   [data-nav-group] / [data-nav-dropdown-trigger] / [data-nav-dropdown]
 *                               header dropdown groups (touch included —
 *                               the nav disclosures are the pointer-only
 *                               rule's deliberate exception)
 *
 * Teardown: every binding is registered as it is created, so
 * teardownInteractions() detaches the whole module and resets its guards.
 * Nothing on the current site calls it — the document boots once and this
 * module lives for the page — but it makes the module safe to re-initialise.
 */

import { clamp, createFrameScheduler, hasFinePointer, prefersReducedMotion } from './environment';
import { getSettings, subscribeSettings } from './settings';

/** Guards, so importing this module twice can never double-bind listeners. */
let cursorGlowStarted = false;
let parallaxStarted = false;
let glassTrackingStarted = false;
let magneticStarted = false;
let navToggleStarted = false;
let navDropdownsStarted = false;

/* --------------------------------------------------------------------------
   Teardown
   --------------------------------------------------------------------------
   Every listener, subscription and media-query binding this module creates is
   registered as a disposer the moment it is created. teardownInteractions()
   then undoes the entire module in one call and clears the guards, so the
   module can be re-initialised afterwards.

   The site currently boots once per document load and never tears this module
   down, so none of this is on the hot path — it exists so that a future
   client-side navigation, a test harness, or a hot reload can get a clean
   document without leaking listeners into the next page.
   -------------------------------------------------------------------------- */

const teardowns: Array<() => void> = [];

/** addEventListener + the matching removal, registered for teardown. */
function listen<E extends Event>(
	target: EventTarget,
	type: string,
	handler: (event: E) => void,
	options?: boolean | AddEventListenerOptions,
): void {
	target.addEventListener(type, handler as EventListener, options);
	teardowns.push(() => target.removeEventListener(type, handler as EventListener, options));
}

/** subscribeSettings + the returned unsubscribe, registered for teardown. */
function watchSettings(listener: Parameters<typeof subscribeSettings>[0]): void {
	teardowns.push(subscribeSettings(listener));
}

/** Media-query change binding, with the Safari < 14 fallback in one place. */
function watchMedia(query: MediaQueryList, handler: () => void): void {
	if (typeof query.addEventListener === 'function') {
		query.addEventListener('change', handler);
		teardowns.push(() => query.removeEventListener('change', handler));
	} else {
		// Safari < 14 fallback.
		query.addListener(handler);
		teardowns.push(() => query.removeListener(handler));
	}
}

/**
 * Remove every listener, subscription, media-query binding and pending
 * animation frame this module created, and reset the guards so the module can
 * be initialised again from a clean slate.
 *
 * One failing disposer must not strand the rest, so each is run in isolation.
 */
export function teardownInteractions(): void {
	while (teardowns.length) {
		const undo = teardowns.pop();
		try {
			undo?.();
		} catch (error) {
			console.warn('[interactions] teardown step failed', error);
		}
	}
	cursorGlowStarted = false;
	parallaxStarted = false;
	glassTrackingStarted = false;
	magneticStarted = false;
	navToggleStarted = false;
	navDropdownsStarted = false;
}

/* -------------------------------------------------------------------------- */
/* Cursor glow                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A small, restrained halo centred on the pointer. It is one composited
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

	// Settings-store gate: the halo is a cursor effect, so cursorEffects=off
	// or reducedEffects=on keeps it hidden. Listeners stay attached and the
	// flag is checked per event, so toggling in the Settings overlay works
	// live in both directions without re-initialising anything. (CSS mirrors
	// this pre-paint: CursorGlow.astro hides the element on the same flags.)
	let cursorOn = getSettings().cursorEffects && !getSettings().reducedEffects;
	glow.hidden = !cursorOn;

	let targetX = 0;
	let targetY = 0;
	let currentX = 0;
	let currentY = 0;
	let visible = false;
	let pressed = false;
	let frame = 0;

	const settle = () => {
		// Pinned to the pointer (t = 1). The old 0.22 smoothing made the halo
		// trail behind the cursor, so it never looked centred while moving.
		// The loop is kept for the fade in/out and the pressed scale.
		const t = 1;
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

	watchSettings((settings) => {
		const next = settings.cursorEffects && !settings.reducedEffects;
		if (next === cursorOn) return;
		cursorOn = next;
		glow.hidden = !next;
		if (!next) {
			// Fade the halo out where it stands instead of freezing it mid-air.
			visible = false;
			kick();
		}
	});

	// The settle loop is the module's only other live resource; stop it when
	// the element is torn away so it cannot keep a rAF alive.
	teardowns.push(() => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		glow.style.transform = '';
		glow.style.opacity = '';
	});

	listen<PointerEvent>(window, 'pointermove',
		(event) => {
			// Ignore pen/touch so a stylus tap does not spawn a cursor halo.
			if (event.pointerType !== 'mouse' || !cursorOn) return;
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

	listen<PointerEvent>(window, 'pointerdown',
		(event) => {
			if (event.pointerType !== 'mouse') return;
			pressed = true;
			kick();
		},
		{ passive: true },
	);

	listen<PointerEvent>(window, 'pointerup',
		() => {
			pressed = false;
			kick();
		},
		{ passive: true },
	);

	// Leaving the window: fade out instead of parking a halo on the edge.
	listen<Event>(document, 'pointerleave', () => {
		visible = false;
		kick();
	});
}

/* -------------------------------------------------------------------------- */
/* Background parallax                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pointer-driven drift for the painted background layers: the cloud plane and
 * sun bloom in the light theme, the aurora sheet in the dark one. All of them
 * read --bg-parallax-x / --bg-parallax-y and nothing else.
 *
 * This used to be a tail on initCursorGlow's pointermove handler, which was
 * wrong twice over. It tied an ambient background effect to a cursor
 * affordance — any page without [data-cursor-glow] got no parallax at all, and
 * turning cursor effects off in Settings silently switched the sky off with it.
 * And it wrote two custom properties synchronously inside the event, while
 * pointermove fires far more often than the display refreshes, so most of
 * those style writes were thrown away before they were ever painted.
 *
 * Now it is its own feature with its own listener, and the writes are
 * coalesced through createFrameScheduler: a burst of events costs at most one
 * pair of property writes per frame.
 */
export function initBackgroundParallax(): void {
	if (parallaxStarted) return;
	parallaxStarted = true;
	if (!hasFinePointer() || prefersReducedMotion()) return;

	const root = document.documentElement;
	// The same +/-10px bound the old inline code used: enough to read as depth,
	// small enough that the background never appears to slide out from under
	// the content sitting on top of it.
	const MAX_OFFSET = 10;

	let pendingX = 0;
	let pendingY = 0;

	const flush = createFrameScheduler(() => {
		root.style.setProperty('--bg-parallax-x', `${pendingX.toFixed(1)}px`);
		root.style.setProperty('--bg-parallax-y', `${pendingY.toFixed(1)}px`);
	});

	// Park the layers back on their neutral offset when the module goes away.
	teardowns.push(() => {
		root.style.removeProperty('--bg-parallax-x');
		root.style.removeProperty('--bg-parallax-y');
	});

	listen<PointerEvent>(window, 'pointermove',
		(event) => {
			// Ignore pen/touch, matching the rest of this module.
			if (event.pointerType !== 'mouse') return;
			const cx = window.innerWidth / 2;
			const cy = window.innerHeight / 2;
			pendingX = clamp(((event.clientX - cx) / cx) * MAX_OFFSET, -MAX_OFFSET, MAX_OFFSET);
			pendingY = clamp(((event.clientY - cy) / cy) * MAX_OFFSET, -MAX_OFFSET, MAX_OFFSET);
			flush();
		},
		{ passive: true },
	);
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

	// The tracked specular lives in [data-glass]::after, which glass.css
	// removes entirely when advancedGlass is off — writing --mouse-x/--mouse-y
	// then would be work for nothing. Flag-checked per event, so the overlay
	// toggle applies live.
	let trackingOn = getSettings().advancedGlass;
	watchSettings((settings) => {
		trackingOn = settings.advancedGlass;
	});

	let pending: HTMLElement | null = null;
	let pendingX = 0;
	let pendingY = 0;

	const flush = createFrameScheduler(() => {
		if (!pending) return;
		const box = pending.getBoundingClientRect();
		pending.style.setProperty('--mouse-x', `${Math.round(pendingX - box.left)}px`);
		pending.style.setProperty('--mouse-y', `${Math.round(pendingY - box.top)}px`);
	});

	listen<PointerEvent>(document, 'pointermove',
		(event) => {
			if (!trackingOn) return;
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

		listen<PointerEvent>(element, 'pointerenter', (event) => {
			if (event.pointerType !== 'mouse') return;
			element.classList.add('is-magnetised');
		});

		listen<PointerEvent>(element, 'pointermove',
			(event) => {
				if (event.pointerType !== 'mouse') return;
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

		listen<Event>(element, 'pointerleave', release);
		listen<PointerEvent>(element, 'pointercancel', release);

		// A pending frame outliving its element would write a transform into a
		// detached node every frame until it settles.
		teardowns.push(() => {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
		});
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

	listen<MouseEvent>(toggle, 'click', () => setOpen(!isOpen()));

	listen<MouseEvent>(panel, 'click', (event) => {
		// Navigating away must close the sheet, otherwise a back-navigation
		// returns to a page with the menu already open.
		if ((event.target as Element | null)?.closest('a')) setOpen(false);
	});

	listen<KeyboardEvent>(document, 'keydown', (event) => {
		if (event.key !== 'Escape' || !isOpen()) return;
		setOpen(false);
		toggle.focus();
	});

	listen<PointerEvent>(document, 'pointerdown',
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
	watchMedia(desktop, () => {
		if (desktop.matches) setOpen(false);
	});
}

/* -------------------------------------------------------------------------- */
/* Header dropdown groups                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Disclosure dropdowns for the header pill (Projects ▾, Me ▾).
 *
 * Pattern: a real <button> trigger with aria-expanded/aria-controls plus a
 * glass panel of links — the APG disclosure-navigation pattern, extended with
 * the keyboard affordances the brief asks for:
 *
 *   - ArrowDown/ArrowUp move through the panel's links (from the trigger:
 *     open first, focus first/last); Home/End jump;
 *   - Escape closes and returns focus to the trigger — stopPropagation keeps
 *     the mobile sheet's own document-level Escape handler from also closing
 *     the sheet underneath;
 *   - Tab is trapped: while a group is open, focus cycles trigger → links →
 *     trigger and never leaks to the page behind;
 *   - focusout that leaves the group closes it (blur dismissal);
 *   - pointerdown anywhere outside closes every group (tap-outside, and the
 *     same listener serves mouse clicks — no separate click handler);
 *   - the trigger click toggles, which covers touch taps, mouse clicks and
 *     keyboard Enter/Space on the <button> in one code path;
 *   - edge-aware placement: on every open (desktop only — inside the mobile
 *     sheet panels are position:static and cannot overflow) the panel is
 *     measured against the right viewport edge and flips to right-aligned
 *     when it would render off-screen; a resize re-places any open panel;
 *   - breakpoint changes close everything, mirroring initNavToggle.
 *
 * Progressive enhancement: without JS the panel never gets .is-open, and a
 * no-JS stylesheet in Header.astro lays the links out inline instead.
 */
export function initNavDropdowns(): void {
	if (navDropdownsStarted) return;
	navDropdownsStarted = true;

	const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-nav-group]'));
	if (roots.length === 0) return;

	type DropdownGroup = {
		root: HTMLElement;
		trigger: HTMLButtonElement;
		panel: HTMLElement;
		links: HTMLElement[];
	};

	const groups: DropdownGroup[] = [];
	for (const root of roots) {
		const trigger = root.querySelector<HTMLButtonElement>('[data-nav-dropdown-trigger]');
		const panel = root.querySelector<HTMLElement>('[data-nav-dropdown]');
		if (!trigger || !panel) continue;
		groups.push({
			root,
			trigger,
			panel,
			links: Array.from(panel.querySelectorAll<HTMLElement>('a[href]')),
		});
	}
	if (groups.length === 0) return;

	const desktop = matchMedia('(min-width: 900px)');
	const isOpen = (group: DropdownGroup) => group.root.classList.contains('is-open');

	const closeGroup = (group: DropdownGroup, restoreFocus = false) => {
		if (!isOpen(group)) return;
		group.root.classList.remove('is-open');
		group.trigger.setAttribute('aria-expanded', 'false');
		if (restoreFocus) group.trigger.focus();
	};

	const closeAll = (except?: DropdownGroup) => {
		for (const group of groups) {
			if (group !== except) closeGroup(group);
		}
	};

	/** Right-edge check. visibility:hidden panels still have layout, so the
	 *  measurement works before the panel becomes visible. */
	const place = (group: DropdownGroup) => {
		group.panel.classList.remove('nav-dropdown--flip');
		if (!desktop.matches) return; // static accordion inside the sheet
		const EDGE_MARGIN = 8;
		const triggerRect = group.trigger.getBoundingClientRect();
		const panelWidth = group.panel.offsetWidth || 208; // 13rem fallback
		if (triggerRect.left + panelWidth > window.innerWidth - EDGE_MARGIN) {
			group.panel.classList.add('nav-dropdown--flip');
		}
	};

	const openGroup = (group: DropdownGroup) => {
		closeAll(group);
		place(group);
		group.root.classList.add('is-open');
		group.trigger.setAttribute('aria-expanded', 'true');
	};

	for (const group of groups) {
		// One toggle path for mouse click, touch tap and button activation.
		listen<MouseEvent>(group.trigger, 'click', () => {
			if (isOpen(group)) closeGroup(group);
			else openGroup(group);
		});

		listen<KeyboardEvent>(group.root, 'keydown', (event) => {
			const focusables = [group.trigger, ...group.links];
			const active = document.activeElement as HTMLElement | null;
			const index = active ? focusables.indexOf(active) : -1;

			if (event.key === 'Escape') {
				if (!isOpen(group)) return;
				// Keep the mobile sheet open: its Escape handler sits on
				// document, and this bubble-phase stop runs first.
				event.stopPropagation();
				closeGroup(group, true);
				return;
			}

			if (!isOpen(group)) {
				// Closed: arrows open (focus first/last link); Enter/Space are
				// native button activation and arrive as click.
				if (event.key === 'ArrowDown' && active === group.trigger) {
					event.preventDefault();
					openGroup(group);
					group.links[0]?.focus();
				} else if (event.key === 'ArrowUp' && active === group.trigger) {
					event.preventDefault();
					openGroup(group);
					group.links[group.links.length - 1]?.focus();
				}
				return;
			}

			switch (event.key) {
				case 'ArrowDown': {
					event.preventDefault();
					const next = index < 0 ? 0 : (index + 1) % focusables.length;
					focusables[next]?.focus();
					break;
				}
				case 'ArrowUp': {
					event.preventDefault();
					const prev = index <= 0 ? focusables.length - 1 : index - 1;
					focusables[prev]?.focus();
					break;
				}
				case 'Home': {
					event.preventDefault();
					group.links[0]?.focus();
					break;
				}
				case 'End': {
					event.preventDefault();
					group.links[group.links.length - 1]?.focus();
					break;
				}
				case 'Tab': {
					// Focus trap: cycle within trigger + links while open.
					const last = focusables.length - 1;
					if (index < 0) {
						// Focus is somewhere inside the panel but not on an item
						// (e.g. the panel container): pull it into the cycle.
						event.preventDefault();
						focusables[event.shiftKey ? last : 0]?.focus();
					} else if (!event.shiftKey && index === last) {
						event.preventDefault();
						focusables[0]?.focus();
					} else if (event.shiftKey && index === 0) {
						event.preventDefault();
						focusables[last]?.focus();
					}
					break;
				}
				default:
					break;
			}
		});

		// Blur dismissal: focus left the group entirely.
		listen<FocusEvent>(group.root, 'focusout', (event) => {
			const next = event.relatedTarget as Node | null;
			if (next && group.root.contains(next)) return;
			closeGroup(group);
		});

		// Navigating away closes the panel so a back-navigation never lands on
		// a stale open dropdown (same rule as the mobile sheet).
		listen<MouseEvent>(group.panel, 'click', (event) => {
			if ((event.target as Element | null)?.closest('a')) closeGroup(group);
		});
	}

	// Tap/click outside every group closes them all.
	listen<PointerEvent>(document, 'pointerdown',
		(event) => {
			const target = (event.composedPath?.()?.[0] ?? event.target) as Element | null;
			if (target?.closest?.('[data-nav-group]')) return;
			closeAll();
		},
		{ passive: true },
	);

	// Leaving phone widths with a panel open would leave stale state behind.
	watchMedia(desktop, () => closeAll());

	// Re-check the edge flip while a panel is open (rotation, window resize).
	listen<UIEvent>(window, 'resize', () => {
		for (const group of groups) {
			if (isOpen(group)) place(group);
		}
	});
}
