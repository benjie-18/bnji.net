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
	/**
	 * Exact pathnames this rule does NOT apply to, even though they match the
	 * prefix. Needed for a login page living under its own protected prefix:
	 * `pattern: '/admin'` would otherwise match '/admin/login' and bounce it
	 * back to itself forever. Comparison is exact on the pathname (ignoring a
	 * trailing slash), so a crafted path cannot slip past.
	 */
	exclude?: readonly string[];
	/**
	 * The pattern the session cookie is signed for. Defaults to `pattern`.
	 *
	 * A session is bound to exactly one pattern — that binding is what stops a
	 * cookie minted for one protected area from opening another. It also
	 * means a surface whose PAGE and DATA live under different prefixes needs
	 * a shared binding: '/admin' and '/api/admin' are separate rules (each
	 * matches a different set of paths) but must accept the SAME cookie, or
	 * the dashboard would load and every fetch it makes would 401.
	 *
	 * Set this only when the rules are one logical surface. It is a widening
	 * of cookie scope, so it must never point two unrelated areas at a shared
	 * value.
	 */
	sessionPattern?: string;
};

export const ACCESS_RULES: RouteAccessRule[] = [
	// The admin surface. `prerender = false` on /admin and on every
	// /api/admin/* route is what makes these rules reachable at all: the
	// middleware only runs on requests that execute Worker code, so a
	// prerendered admin page would be served without ever being checked.
	// scripts/verify-access.mjs asserts that at build time.
	//
	// The dashboard's HTML and its data are gated by the same credential.
	// Both rules carry sessionPattern: '/admin' so ONE cookie opens both: the
	// page rule and the API rule have different path prefixes, but a session
	// is bound to a single pattern, so without this the browser would load
	// /admin/ and then get 401 on every /api/admin/* fetch it makes.
	{ pattern: '/admin', auth: 'token', redirectTo: '/admin/login', exclude: ['/admin/login'], sessionPattern: '/admin' },
	// /api/admin/session is excluded because it IS the credential exchange:
	// it takes the token in a JSON body, which the middleware cannot see —
	// the middleware only knows about Bearer headers and cookies. Gating it
	// would mean you must already hold a session to obtain a session. The
	// route does its own verification (constant-time compare, plus a
	// rate limit), so the exclusion moves the check rather than removing it.
	{ pattern: '/api/admin', auth: 'token', exclude: ['/api/admin/session'], sessionPattern: '/admin' },
	// The Stella prompts surface. Same credential and session as /admin:
	// there is exactly one operator credential, and the prompts are private,
	// so the page and its data share the admin login rather than growing a
	// second one. Both rules carry sessionPattern: '/admin' so the cookie
	// the login mints opens both — without it the page would load and every
	// prompt fetch would 401. The page rule redirects to the login; the API
	// rule answers 401 JSON, like /api/admin. verify-access.mjs pass 3 also
	// requires these two 'stella' rules to agree on sessionPattern.
	{ pattern: '/projects/stella', auth: 'token', redirectTo: '/admin/login', sessionPattern: '/admin' },
	{ pattern: '/api/stella', auth: 'token', sessionPattern: '/admin' },
	// ▼▼▼ CONFIGURE HERE — example (keep commented until a real route exists):
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
