/**
 * BNJI.NET — the settings store. ONE source of truth.
 *
 * Every visitor-tunable preference on the site lives in this single module:
 * theme, intro, audio, UI scale, performance, effects, density, glass. No
 * component keeps its own copy — they read `getSettings()`, change values
 * with `setSetting()`, and react through `subscribeSettings()`. The overlay
 * (scripts/settings-overlay.ts) is just one view onto this store; anything
 * else that later needs a setting imports the same three functions.
 *
 * Persistence
 * -----------
 * One localStorage key (`bnji-settings-v1`) holds the whole object, written
 * synchronously on every change (tiny payload, no debounce needed). Reads are
 * validated field-by-field against the defaults, so a corrupt or partial
 * blob — or a blob from an older schema — degrades to defaults per field
 * instead of poisoning the app. The legacy standalone theme key
 * (`bnji-theme`, THEME_CONFIG.storageKey) is migrated on first read and the
 * migrated value persisted under the new key.
 *
 * No-flash contract (the important part)
 * --------------------------------------
 * 1. BEFORE first paint: the inline blocking script in BaseHead.astro reads
 *    the same localStorage key synchronously and applies <html data-theme>
 *    plus the effects-state data attributes. Nothing waits for this bundle.
 * 2. AT IMPORT: this module hydrates its state synchronously from
 *    localStorage, so the first `getSettings()` any boot script sees is
 *    already the persisted one — intro.ts, for example, decides whether to
 *    start from the stored value, never from a default it has to correct
 *    later.
 * 3. AT BOOT: `applySettingsToRoot()` re-mirrors every flag onto <html>
 *    (idempotent with the pre-paint script) and keeps doing so on every
 *    change, so CSS can gate effects on data attributes from frame one.
 *
 * Wiring status: every field drives real behaviour.
 *   theme          → scripts/theme.ts (data-theme, theme-color meta)
 *   introEnabled   → scripts/intro.ts + html[data-intro] (pre-paint)
 *   volume/muted   → scripts/music.ts (player transport, two-way with the
 *                    player's own slider/mute button)
 *   uiScale        → --ui-scale on <html> (pre-paint + runtime); global.css
 *                    multiplies the root font-size, so the rem-based scale
 *                    tokens move the whole layout
 *   starDensity    → scripts/starfield.ts population (0 = empty sky)
 *   performanceMode→ starfield cost knobs (fps cap, dpr, meteors) + the aero
 *                    environment layer is dropped (aero.css)
 *   reducedEffects → calm lever: parallax/reveals off (scroll.ts), ambient
 *                    motion frozen (animations.css, aero.css), starfield
 *                    static, cursor halo off
 *   cursorEffects  → cursor glow + starfield pointer response (interactions.ts,
 *                    starfield.ts), CSS gate in CursorGlow.astro
 *   advancedGlass  → glass.css drops blur/optics/specular to the flat
 *                    fallback surface; interactions.ts skips pointer tracking
 */
import { THEME_CONFIG, INTRO_CONFIG } from '../config/access.config';
import { MUSIC_SOURCE } from '../config/music.config';

export type Settings = {
	/** Active colour theme. Applied pre-paint and by scripts/theme.ts. */
	theme: 'dark' | 'light';
	/** Homepage scroll intro. Read pre-paint and by scripts/intro.ts. */
	introEnabled: boolean;
	/** Audio mute. Consumed by the music player (scripts/music.ts). */
	muted: boolean;
	/** Audio volume 0..1, seeded from MUSIC_SOURCE.defaultVolume. scripts/music.ts. */
	volume: number;
	/** UI scale, percent (80..130). Root font-size multiplier via --ui-scale. */
	uiScale: number;
	/** Performance mode: cheaper rendering (starfield caps, no aero layer). */
	performanceMode: boolean;
	/** Reduced visual effects: calms decorative motion site-wide. */
	reducedEffects: boolean;
	/** Star/particle density 0..1 → starfield population (scripts/starfield.ts). */
	starDensity: number;
	/** Cursor effects: halo + starfield pointer response on/off. */
	cursorEffects: boolean;
	/** Advanced glass effects: blur/optics/specular vs flat fallback surface. */
	advancedGlass: boolean;
};

/** Single persistence key for the whole store. */
export const SETTINGS_STORAGE_KEY = 'bnji-settings-v1';

/** Defaults: seeded from the public config files, per repo convention. */
export const SETTINGS_DEFAULTS: Settings = {
	theme: THEME_CONFIG.defaultTheme,
	introEnabled: INTRO_CONFIG.enabled,
	muted: false,
	volume: MUSIC_SOURCE.defaultVolume,
	uiScale: 100,
	performanceMode: false,
	reducedEffects: false,
	starDensity: 1,
	cursorEffects: true,
	advancedGlass: true,
};

type Listener = (settings: Settings) => void;

const listeners = new Set<Listener>();

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
};

/** Validate an arbitrary parsed blob field-by-field against the defaults. */
function sanitize(raw: unknown): Settings {
	const r = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
	const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
	return {
		theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : SETTINGS_DEFAULTS.theme,
		introEnabled: bool(r.introEnabled, SETTINGS_DEFAULTS.introEnabled),
		muted: bool(r.muted, SETTINGS_DEFAULTS.muted),
		volume: clampNumber(r.volume, 0, 1, SETTINGS_DEFAULTS.volume),
		uiScale: Math.round(clampNumber(r.uiScale, 80, 130, SETTINGS_DEFAULTS.uiScale)),
		performanceMode: bool(r.performanceMode, SETTINGS_DEFAULTS.performanceMode),
		reducedEffects: bool(r.reducedEffects, SETTINGS_DEFAULTS.reducedEffects),
		starDensity: clampNumber(r.starDensity, 0, 1, SETTINGS_DEFAULTS.starDensity),
		cursorEffects: bool(r.cursorEffects, SETTINGS_DEFAULTS.cursorEffects),
		advancedGlass: bool(r.advancedGlass, SETTINGS_DEFAULTS.advancedGlass),
	};
}

/**
 * Synchronous hydration at module load — this is what makes "no flash"
 * possible for JS behaviour (the CSS side is the pre-paint script).
 * Migrates the legacy 'bnji-theme' key when the new key is absent.
 */
function hydrate(): Settings {
	try {
		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
		if (raw) return sanitize(JSON.parse(raw));
		const legacy = localStorage.getItem(THEME_CONFIG.storageKey);
		if (legacy === 'light' || legacy === 'dark') {
			const migrated: Settings = { ...SETTINGS_DEFAULTS, theme: legacy };
			persist(migrated);
			return migrated;
		}
	} catch {
		/* storage blocked (private mode): run on defaults, changes stay in-memory */
	}
	return { ...SETTINGS_DEFAULTS };
}

function persist(settings: Settings): void {
	try {
		localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
	} catch {
		/* blocked storage: the session still works, nothing persists */
	}
}

let state: Settings = hydrate();

/** Current snapshot. Treat as read-only; change via setSetting(). */
export function getSettings(): Settings {
	return state;
}

/** Change one setting: validate → state → persist → notify. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
	const next = sanitize({ ...state, [key]: value });
	if (Object.keys(next).every((k) => next[k as keyof Settings] === state[k as keyof Settings])) {
		return; // no actual change — don't churn listeners or storage
	}
	state = next;
	persist(state);
	for (const listener of listeners) listener(state);
	// Loose-coupling hook, mirroring the repo's 'bnji:themechange' idiom.
	window.dispatchEvent(new CustomEvent<Settings>('bnji:settingschange', { detail: state }));
}

export function subscribeSettings(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Mirror the effects-state flags onto <html> so CSS (and any future script)
 * reads the right state without waiting on anything. data-theme is owned by
 * scripts/theme.ts; everything else lives here. Idempotent with the pre-paint
 * inline script in BaseHead.astro, which sets the same attributes earlier.
 */
export function applySettingsToRoot(settings: Settings = state): void {
	const root = document.documentElement;
	const onoff = (b: boolean) => (b ? 'on' : 'off');
	root.dataset.intro =
		!settings.introEnabled ||
		(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
			? 'off'
			: 'on';
	if (root.dataset.intro === 'off') {
		root.dataset.introState = 'done';
	}
	// Root font-size multiplier for the uiScale setting (global.css:
	// html { font-size: calc(100% * var(--ui-scale, 1)) }). Set pre-paint by
	// BaseHead's inline script; this keeps it in sync on live changes.
	root.style.setProperty('--ui-scale', String(settings.uiScale / 100));
	root.dataset.cursorEffects = onoff(settings.cursorEffects);
	root.dataset.reducedEffects = onoff(settings.reducedEffects);
	root.dataset.performanceMode = onoff(settings.performanceMode);
	root.dataset.advancedGlass = onoff(settings.advancedGlass);
}

let settingsStarted = false;

/** Boot entry: mirror once, then keep <html> in sync with every change. */
export function initSettings(): void {
	if (settingsStarted) return;
	settingsStarted = true;
	applySettingsToRoot();
	subscribeSettings(applySettingsToRoot);
}
