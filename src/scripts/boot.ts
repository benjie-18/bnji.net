/**
 * BNJI.NET — client entry point.
 *
 * One module, one bundle, one call site (src/layouts/Layout.astro). The site is
 * Astro-first: this file plus starfield/interactions/scroll is the entire
 * client-side JavaScript for every page. No framework is shipped to the browser.
 *
 * Each feature is started inside its own guard so that a failure in one (a
 * missing element, an unsupported API, an experiment gone wrong) degrades that
 * feature only — the rest of the page keeps working and the failure is logged
 * rather than silently swallowed.
 *
 * The Lab imports engines from these modules directly and does NOT go through
 * boot(), which is why every init() is idempotent.
 */

import { initStarfield } from './starfield';
import { initCursorGlow, initGlassTracking, initMagnetic, initNavToggle } from './interactions';
import { initNavScrollState, initParallax, initReveal } from './scroll';
import { initThemeToggle } from './theme';

function start(name: string, init: () => void): void {
	try {
		init();
	} catch (error) {
		// Non-fatal by design: the page is still fully readable and navigable
		// without any of these effects.
		console.warn(`[bnji] ${name} did not start:`, error);
	}
}

export function boot(): void {
	// Background first, then surfaces, then scroll choreography.
	start('theme-toggle', initThemeToggle);
	start('starfield', initStarfield);
	start('cursor-glow', initCursorGlow);
	start('glass-tracking', initGlassTracking);
	start('magnetic', initMagnetic);
	start('nav-toggle', initNavToggle);
	start('nav-scroll-state', initNavScrollState);
	start('reveal', initReveal);
	start('parallax', initParallax);
}
