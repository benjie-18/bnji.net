/**
 * BNJI.NET — theme runtime.
 *
 * Two themes, one attribute: <html data-theme="dark|light">. The attribute is
 * set BEFORE first paint by the inline pre-paint script in BaseHead.astro
 * (which reads the settings store's localStorage key), so there is never a
 * flash of the wrong theme.
 *
 * The theme is ONE FIELD of the central settings store (scripts/settings.ts)
 * — this module no longer owns persistence or a toggle button. It owns:
 *
 *   - applying the theme: <html data-theme>, <meta name="theme-color">, and
 *     the 'bnji:themechange' CustomEvent theme-aware modules can listen to;
 *   - initTheme(): apply the stored theme at boot (idempotent with pre-paint)
 *     and re-apply whenever the store's theme field changes — from the
 *     Settings overlay or any future surface.
 *
 * The old standalone toggle ([data-theme-toggle], localStorage 'bnji-theme')
 * is gone: the control now lives in the Settings overlay, and the legacy
 * storage key is migrated by the settings store on first read.
 *
 * All visual differences live in CSS tokens (styles/tokens.css); no component
 * branches on the theme in JavaScript except where a *behaviour* differs
 * (starfield resting in light mode, board element shapes).
 */
import { THEME_CONFIG } from '../config/access.config';
import { SITE } from '../data/site';
import { getSettings, subscribeSettings } from './settings';

export type Theme = 'dark' | 'light';

export function currentTheme(): Theme {
	const stored = document.documentElement.dataset.theme;
	return stored === 'light' || stored === 'dark' ? stored : THEME_CONFIG.defaultTheme;
}

/** Apply the theme to the document. Persistence belongs to the settings store. */
export function applyTheme(next: Theme): void {
	document.documentElement.dataset.theme = next;
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (meta) meta.content = next === 'light' ? SITE.themeColorLight : SITE.themeColor;
	window.dispatchEvent(new CustomEvent<Theme>('bnji:themechange', { detail: next }));
}

let themeStarted = false;

/** Boot entry: apply the stored theme, then follow the settings store. */
export function initTheme(): void {
	if (themeStarted) return;
	themeStarted = true;

	let applied = getSettings().theme;
	applyTheme(applied);
	subscribeSettings((settings) => {
		if (settings.theme === applied) return;
		applied = settings.theme;
		applyTheme(applied);
	});
}
