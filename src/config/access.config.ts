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
 * THEME_CONFIG picks the default theme for first paint. The visitor's choice
 * is stored in localStorage ('bnji-theme') and applied by an inline pre-paint
 * script in BaseHead.astro, so there is no flash of the wrong theme.
 *
 * ── Intro ───────────────────────────────────────────────────────────────
 * INTRO_CONFIG controls the scroll-driven opening sequence on the homepage.
 * It is always skipped for prefers-reduced-motion visitors and can be skipped
 * by anyone via the on-screen button or the session flag.
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
	/** localStorage key. */
	storageKey: 'bnji-theme',
};

export const INTRO_CONFIG = {
	/** Show the scroll intro on the homepage. */
	enabled: true,
	/** Scroll distance of the sequence, in viewport heights. */
	scrollHeights: 3.2,
	/** sessionStorage flag: visitors who skipped/completed it once per session
	 *  are not forced through it again. */
	sessionKey: 'bnji-intro-done',
};
