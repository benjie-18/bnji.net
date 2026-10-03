/**
 * BNJI.NET — client entry point.
 *
 * One entry module and one call site (src/layouts/Layout.astro). The site is
 * Astro-first: this file plus starfield/interactions/scroll is the entire
 * shared client-side entry for every page; optional features are loaded only on the pages that use them. No framework is shipped to the browser.
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
import { initNotificationsBadge } from './notifications-ui';
import { initNavScrollState, initParallax, initReveal } from './scroll';
import { initSettings } from './settings';
import { initSettingsOverlay } from './settings-overlay';
import { initTheme } from './theme';
import { initLiquidGlass } from './liquid-glass';
import { initImageConverter } from './tools-image';
import { initDateDifferenceCalculator } from './tools-date-difference';
import { initCookingConverter } from './tools-cooking';
import { initScreenDpiCalculator } from './tools-screen-dpi';
import { initTelemetry } from './telemetry';
import { initVerityBalls } from './verity-balls';

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
	// Phase E §8.3: header badge polls /api/notifications while pages are open.
	start('notifications-badge', initNotificationsBadge);
	// Tools: no-op on every other page as each init bails unless its subtree is in the document.
	start('image-converter', initImageConverter);
	start('date-calculator', initDateDifferenceCalculator);
	start('cooking-converter', initCookingConverter);
	start('screen-calculator', initScreenDpiCalculator);
	// Restore verity balls on navigation if active in sessionStorage
	start('verity-balls', initVerityBalls);
	// Keep game session tracking out of the shared client chunk and skip the
	// lazy module request entirely on pages without Lab experiments.
	if (document.querySelector('[data-lab-experiment]')) {
		void import('./game-runtime')
			.then(({ initLabGameTracking }) => start('lab-game-tracking', initLabGameTracking))
			.catch((error) => console.warn('[bnji] lab-game-tracking did not start:', error));
	}
}
