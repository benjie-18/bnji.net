/**
 * Access control, theme and intro — CONFIGURATION.
 *
 * ── Access control (future auth/authz) ─────────────────────────────────
 * ACCESS_RULES is the single place that declares which routes are protected
 * and how. Enforcement happens server-side in src/middleware.ts +
 * src/server/access.ts. Important, honest limitations:
 *
 *   - Prerendered (static) pages CANNOT be protected: static assets are served
 *     by the edge without running Worker code. A route that must be private
 *     must set `export const prerender = false;` in its page file so every
 *     request runs the middleware.
 *   - Client-side hiding is NOT security and is never used as such here.
 *   - With an empty rule list (the default) every current page stays public.
 *
 * Secrets used by the guard (environment only, never in this file):
 *   ACCESS_TOKEN        shared bearer token for auth: 'token' rules
 *   ACCESS_PASSWORD_SHA sha256 hex of the password for auth: 'password' rules
 *   ACCESS_SECRET       signing key for the session cookie (HMAC)
 *
 * ── Theme ───────────────────────────────────────────────────────────────
 * THEME_CONFIG.defaultTheme SEEDS the central settings store
 * (scripts/settings.ts) — the visitor's actual choice lives in the store's
 * localStorage key ('bnji-settings-v1'), is controlled from the Settings
 * overlay, and is applied pre-paint by the inline script in BaseHead.astro,
 * so there is no flash of the wrong theme. `storageKey` ('bnji-theme') is
 * the LEGACY standalone key, kept only as a one-time migration source.
 *
 * ── Intro ───────────────────────────────────────────────────────────────
 * INTRO_CONFIG.enabled SEEDS the settings store's introEnabled field — the
 * per-visitor switch lives in the store (Settings overlay), and the intro
 * reads it from there. `enabled: false` here remains the site-wide kill
 * switch: it removes the intro markup at build time. The sequence is always
 * skipped for prefers-reduced-motion visitors. The former on-screen Skip
 * button and per-session flag were removed with the settings-store move.
 */
export type RouteAccessRule = {
	/** Prefix match on pathname, e.g. '/admin' matches '/admin' and below. */
	pattern: string;
	auth: 'token' | 'password';
	/** Where to send unauthenticated requests (default: 401 JSON). */
	redirectTo?: string;
};

export const ACCESS_RULES: RouteAccessRule[] = [
	// ▼▼▼ CONFIGURE HERE — example (keep commented until a real route exists):
	// { pattern: '/admin', auth: 'password', redirectTo: '/' },
	// { pattern: '/monitoring', auth: 'token' },
	// ▲▲▲ CONFIGURE HERE
];

export const THEME_CONFIG = {
	/** Theme applied when the visitor has no stored preference. */
	defaultTheme: 'dark' as 'dark' | 'light',
	/** LEGACY localStorage key — migration source for the settings store. */
	storageKey: 'bnji-theme',
};

export const INTRO_CONFIG = {
	/** Site-wide kill switch AND the settings-store default for introEnabled.
	 *  false removes the intro markup at build time; per-visitor control lives
	 *  in the settings store (scripts/settings.ts). */
	enabled: true,
	/** Scroll distance of the sequence, in viewport heights. */
	scrollHeights: 3.2,
};
