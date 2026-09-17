/**
 * BNJI.NET — theme runtime.
 *
 * Two themes, one attribute: <html data-theme="dark|light">. The attribute is
 * set BEFORE first paint by the inline pre-paint script in BaseHead.astro
 * (stored preference, else THEME_CONFIG.defaultTheme), so there is never a
 * flash of the wrong theme. This module only owns the runtime toggle:
 *
 *   - every [data-theme-toggle] button flips the theme and stays in sync
 *     (aria-pressed + title), so several toggles can coexist;
 *   - the preference persists in localStorage (key from THEME_CONFIG);
 *   - <meta name="theme-color"> follows the active theme so the browser UI
 *     matches the page;
 *   - a 'bnji:themechange' CustomEvent lets theme-aware modules (starfield,
 *     message board, cursor) react without polling the DOM.
 *
 * All visual differences live in CSS tokens (styles/tokens.css); no component
 * branches on the theme in JavaScript except where a *behaviour* differs
 * (starfield resting in light mode, board element shapes).
 */
import { THEME_CONFIG } from '../config/access.config';
import { SITE } from '../data/site';

export type Theme = 'dark' | 'light';

let toggleStarted = false;

export function currentTheme(): Theme {
	const stored = document.documentElement.dataset.theme;
	return stored === 'light' || stored === 'dark' ? stored : THEME_CONFIG.defaultTheme;
}

export function applyTheme(next: Theme, persist = true): void {
	document.documentElement.dataset.theme = next;
	if (persist) {
		try {
			localStorage.setItem(THEME_CONFIG.storageKey, next);
		} catch {
			/* private mode / blocked storage: theme still applies for now */
		}
	}
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (meta) meta.content = next === 'light' ? SITE.themeColorLight : SITE.themeColor;
	window.dispatchEvent(new CustomEvent<Theme>('bnji:themechange', { detail: next }));
}

export function toggleTheme(): Theme {
	const next: Theme = currentTheme() === 'light' ? 'dark' : 'light';
	applyTheme(next);
	return next;
}

/** Bind every [data-theme-toggle] control and keep their state in sync. */
export function initThemeToggle(): void {
	if (toggleStarted) return;
	toggleStarted = true;

	const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]'));
	if (buttons.length === 0) return;

	const sync = () => {
		const light = currentTheme() === 'light';
		for (const button of buttons) {
			button.setAttribute('aria-pressed', String(light));
			button.title = light ? 'Switch to the dark space theme' : 'Switch to the light aero theme';
		}
	};

	for (const button of buttons) {
		button.addEventListener('click', () => {
			toggleTheme();
			sync();
		});
	}
	sync();
}
