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
import {
	initBackgroundParallax,
	initCursorGlow,
	initGlassTracking,
	initMagnetic,
	initNavDropdowns,
	initNavToggle,
} from './interactions';
import { initMusicPlayer } from './music';
import { initNavScrollState, initParallax, initReveal } from './scroll';
import { initSettings } from './settings';
import { initSettingsOverlay } from './settings-overlay';
import { initTheme } from './theme';
import { initLiquidGlass } from './liquid-glass';
import { initImageConverter } from './tools-image';
import { initTelemetry } from './telemetry';

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
	// Settings first: the store hydrates synchronously at import, and
	// initSettings mirrors the persisted flags onto <html> (idempotent with
	// the pre-paint script) before anything consults them.
	start('settings', initSettings);
	start('theme', initTheme);
	start('liquid-glass', initLiquidGlass);
	start('settings-overlay', initSettingsOverlay);
	start('music-player', initMusicPlayer);
	start('starfield', initStarfield);
	start('cursor-glow', initCursorGlow);
	start('background-parallax', initBackgroundParallax);
	start('glass-tracking', initGlassTracking);
	start('magnetic', initMagnetic);
	start('nav-toggle', initNavToggle);
	start('nav-dropdowns', initNavDropdowns);
	start('nav-scroll-state', initNavScrollState);
	start('reveal', initReveal);
	start('parallax', initParallax);
	// Global traffic & interaction telemetry
	start('telemetry', initTelemetry);
	// The tool is a no-op on every other page: the init bails unless its
	// subtree is in the document, so it costs one querySelector elsewhere.
	start('image-converter', initImageConverter);
}
