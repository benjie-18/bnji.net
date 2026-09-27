/**
 * BNJI.NET — the admin system.
 *
 * ONE module, ONE answer to "is this request an admin". Everything the admin
 * surface needs lives here: the token check, session issuance and
 * verification, the guard, the token rotation, and the uniform failure
 * responses. Routes stay thin because there is nowhere else for the logic to
 * hide.
 *
 * WHAT THIS ABSORBED
 * ------------------
 * The groundwork already existed and was reused rather than replaced:
 *   - src/config/access.config.ts  — declares which routes are protected;
 *     the middleware in src/middleware.ts enforces it, and the build-time
 *     check in scripts/verify-access.mjs proves no protected page is
 *     prerendered (a prerendered page is served without running any Worker
 *     code, so the rule would silently not exist).
 *   - src/server/access.ts         — the generic HMAC primitives. Still used
 *     for non-admin rules and by the middleware; the admin-specific session
 *     logic below sits on top of them rather than beside them.
 *
 * THE CREDENTIAL
 * --------------
 * One shared access token, stored as sha256(token) in `admin_credentials`
 * (migrations/0005_admin_credentials.sql). The plaintext token is never
 * stored and never appears in code. This is deliberately not a user system:
 * no roles, no per-operator identity, no password reset. One operator, one
 * secret, and a login rate limit (10 attempts / 15 min / IP) standing between
 * that secret and a six-digit guess.
 *
 * SESSIONS
 * --------
 * `bnji_session` — HMAC-SHA256 signed, 8h, HttpOnly, SameSite=Strict, Secure.
 * HttpOnly is what lets the token be discarded by the browser after the
 * exchange: the dashboard's own JavaScript never sees it, so there is no
 * token sitting in a JS global to be read from the console or an XSS.
 *
 * A browser cannot attach an Authorization header to a top-level navigation,
 * which is the only reason a cookie exists: without it the /admin PAGE could
 * not be gated, only the data it fetches. The bearer path (Authorization:
 * Bearer <token>) is kept for curl and scripts.
 *
 * Sessions are bound to the token they were minted under. The payload
 * carries a fingerprint of the token hash, so rotating the token invalidates
 * every outstanding session immediately rather than letting old ones run for
 * up to eight more hours.
 *
 * FAIL CLOSED
 * -----------
 * No credential row, no session secret, or an access rule that no longer
 * declares this surface: every request is denied. An unconfigured guard must
 * never be an open guard. `adminNotConfigured()` distinguishes "you are not
 * allowed" (401) from "this is not set up" (503), because the fixes are
 * completely different.
 */
import {
	SESSION_COOKIE_NAME,
	sessionPatternOf,
	verifySessionCookieValue,
	issueSession,
} from './access';
import { ACCESS_RULES, type RouteAccessRule } from '../config/access.config';
import { secretEnv, serverEnvironment } from './env';
import type { APIContext } from 'astro';

export const ADMIN_SESSION_MAX_AGE_SECONDS = 8 * 3600;

/**
 * Login floor. The seeded token is five characters, so an eight-character
 * minimum (which this used to impose) locked the owner out of their own site
 * immediately after the migration. Four is the floor for ATTEMPTING a login;
 * `changeAdminToken` holds newly chosen tokens to a much higher bar.
 */
const MIN_LOGIN_TOKEN_LENGTH = 4;

/** Minimum for a token the admin CHOOSES — see changeAdminToken. */
export const MIN_NEW_TOKEN_LENGTH = 8;

/**
 * The access rule that guards the admin API, read from ACCESS_RULES rather
 * than reconstructed here.
 *
 * A session cookie is bound to exactly one pattern, so every party in the
 * exchange has to agree on it: this module, the session route, the middleware
 * and both access rules. Reading the rule out of the config is what stops them
 * from drifting — a hand-written duplicate would be correct only until
 * someone edited the rule, and the failure would be silent: the panel would
 * load and then 401 on every fetch it makes.
 */
const ADMIN_API_RULE: RouteAccessRule =
	ACCESS_RULES.find((rule) => rule.pattern === '/api/admin') ??
	({ pattern: '/api/admin', auth: 'token' } as RouteAccessRule);

/** True while the admin guard is still declared in ACCESS_RULES. */
const ADMIN_RULE_DECLARED = ACCESS_RULES.some((rule) => rule.pattern === '/api/admin');

/** The pattern admin session cookies are signed for, taken from that rule. */
export const ADMIN_PATTERN = sessionPatternOf(ADMIN_API_RULE);

/**
 * The rule the session route must use to mint a cookie.
 * Exposed so that route cannot hardcode a pattern that has drifted from config.
 */
export function adminSessionRule(): RouteAccessRule {
	return ADMIN_API_RULE;
}

type D1Database = {
	prepare(query: string): {
		bind(...values: unknown[]): {
			first<T>(column?: string): Promise<T | null>;
			run(): Promise<unknown>;
		};
	};
};

/* --- the credential ------------------------------------------------------ */

/** sha256 hex of a token. Also used to build the session fingerprint. */
export async function hashAdminToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * A short, non-reversible tag for a token hash, embedded in session payloads
 * so a session can be tied to the credential that minted it. 16 hex chars of
 * SHA-256 is far more than enough to detect "this is not the same token" and
 * reveals nothing on its own.
 */
export function tokenFingerprint(tokenHash: string): string {
	return tokenHash.slice(0, 16);
}

/** The stored token hash, or null when the store is absent or unseeded. */
export async function readAdminTokenHash(): Promise<string | null> {
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return null;
	try {
		const row = await db
			.prepare('SELECT token_hash FROM admin_credentials WHERE id = 1')
			.bind()
			.first<string>('token_hash');
		return row ?? null;
	} catch (error) {
		console.error('[bnji] admin credential read failed:', error);
		return null;
	}
}

/**
 * Verify a presented access token against the stored hash.
 *
 * Length is checked first (cheap rejection of obvious junk), then the
 * candidate is hashed and compared in constant time. A missing row is a
 * false, never a pass.
 */
export async function verifyAdminToken(token: string): Promise<boolean> {
	if (typeof token !== 'string') return false;
	const candidate = token.trim();
	if (candidate.length < MIN_LOGIN_TOKEN_LENGTH) return false;
	const stored = await readAdminTokenHash();
	if (!stored) return false;
	const presented = await hashAdminToken(candidate);
	// Constant-time compare; both sides are fixed-length hex.
	if (presented.length !== stored.length) return false;
	let diff = 0;
	for (let i = 0; i < presented.length; i++) diff |= presented.charCodeAt(i) ^ stored.charCodeAt(i);
	return diff === 0;
}

/** True when the admin surface can authenticate anyone at all. */
export async function adminConfigured(): Promise<boolean> {
	return Boolean(await readAdminTokenHash());
}

/* --- the guard ------------------------------------------------------------ */

/**
 * The minimum a request context must expose to be gated.
 *
 * Deliberately narrow — `{ request, cookies }` — so the SAME function can
 * gate an API route (where Astro hands the handler an APIContext), a
 * server-rendered page (an AstroContext), and the middleware (a plain
 * request). Those all share these two properties and nothing else this gate
 * needs, so a structural type here is what lets /board decide whether to
 * render moderation controls without a cast.
 */
export type AdminGateContext = {
	request: Request;
	cookies: { get(name: string): { value: string } | undefined };
};

/**
 * THE guard. The single source of truth for "is this request an admin".
 *
 * Accepts either the session cookie (browser) or a bearer token (curl,
 * scripts). Every admin page, every admin API, and the middleware all call
 * this — there is no second implementation to drift.
 */
export async function isAdminRequest(context: AdminGateContext): Promise<boolean> {
	// The guard was unhooked from the middleware config: deny rather than
	// serve. A route that outlived its access rule must never be the thing
	// that decides who gets in.
	if (!ADMIN_RULE_DECLARED) return false;

	const env = secretEnv();
	const stored = await readAdminTokenHash();
	// No stored credential => no admin. Deny before doing any other work.
	if (!stored) return false;
	const fingerprint = tokenFingerprint(stored);

	const cookie = context.cookies.get(SESSION_COOKIE_NAME)?.value;
	if (cookie) {
		// Pass the fingerprint, so a session minted under a previous token
		// stops verifying the instant the token is rotated.
		if (await verifySessionCookieValue(cookie, env.ACCESS_SECRET, ADMIN_PATTERN, fingerprint)) {
			return true;
		}
	}

	const header = context.request.headers.get('authorization') ?? '';
	const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
	if (bearer) {
		const presented = await hashAdminToken(bearer);
		if (presented.length === stored.length) {
			let diff = 0;
			for (let i = 0; i < presented.length; i++) {
				diff |= presented.charCodeAt(i) ^ stored.charCodeAt(i);
			}
			if (diff === 0) return true;
		}
	}
	return false;
}

/**
 * Mint a session cookie bound to the CURRENT token.
 *
 * Returns null when the signing secret is missing: the token was accepted
 * but there is no way to prove it to the next request, and handing back a
 * cookie-less success would be a lie.
 */
export async function issueAdminSession(): Promise<string | null> {
	const stored = await readAdminTokenHash();
	if (!stored) return null;
	return issueSession(ADMIN_API_RULE, secretEnv(), tokenFingerprint(stored));
}

/* --- rotation ------------------------------------------------------------- */

export type ChangeTokenResult =
	| { ok: true }
	| { ok: false; error: 'too_short' | 'not_configured' | 'storage_unavailable' };

/**
 * Replace the access token.
 *
 * Callers MUST have already run `isAdminRequest` AND separately verified the
 * CURRENT token: being logged in is not sufficient authority to rotate the
 * credential, because a stolen cookie would otherwise be enough to lock the
 * owner out permanently. Requiring the current token is what makes rotation
 * a deliberate act by whoever holds the credential, not something an
 * unattended session can trigger.
 *
 * The new token is stored hashed, exactly like the seed. There is no way to
 * read the current token back — by design — and no recovery path except
 * re-seeding the row, which is why the panel asks for confirmation.
 */
export async function changeAdminToken(newToken: string): Promise<ChangeTokenResult> {
	const token = typeof newToken === 'string' ? newToken.trim() : '';
	if (token.length < MIN_NEW_TOKEN_LENGTH) return { ok: false, error: 'too_short' };

	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return { ok: false, error: 'storage_unavailable' };
	const stored = await readAdminTokenHash();
	if (!stored) return { ok: false, error: 'not_configured' };

	const hash = await hashAdminToken(token);
	try {
		await db
			.prepare('UPDATE admin_credentials SET token_hash = ?1, updated_at = ?2 WHERE id = 1')
			.bind(hash, Date.now())
			.run();
	} catch (error) {
		console.error('[bnji] admin token update failed:', error);
		return { ok: false, error: 'storage_unavailable' };
	}
	return { ok: true };
}

/** When the current token was last rotated (0 = never, i.e. the seed). */
export async function adminTokenUpdatedAt(): Promise<number> {
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return 0;
	try {
		const row = await db
			.prepare('SELECT updated_at FROM admin_credentials WHERE id = 1')
			.bind()
			.first<number>('updated_at');
		return Number(row ?? 0);
	} catch {
		return 0;
	}
}

/* --- uniform responses ---------------------------------------------------- */

/**
 * The 401 every admin route answers with. Uniform body so a client can
 * branch on one shape, and `no-store` so a credentialed response is never
 * cached by anything in between.
 */
export function adminUnauthorized(message = 'unauthorized'): Response {
	return new Response(JSON.stringify({ error: message }), {
		status: 401,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

/**
 * 503 when the admin surface is not usable. This is a MISCONFIGURATION, not a
 * denial — the caller is told the truth rather than being told "no", because
 * the fix (run the migration) is completely different from the fix (get the
 * credential right).
 */
export function adminNotConfigured(): Response {
	return new Response(JSON.stringify({ error: 'admin_not_configured' }), {
		status: 503,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

/**
 * Whether this request arrived over TLS.
 *
 * Checks the request URL first, then `X-Forwarded-Proto`. The second check is
 * not optional: behind a TLS-terminating proxy or a tunnel the Worker only
 * ever sees plain HTTP, so `request.url` reports `http:` even when the browser
 * is on a real HTTPS origin — and the reverse is true for some preview
 * set-ups. Trusting the forwarded header is what makes the decision match
 * what the browser actually did.
 */
export function isSecureRequest(request: Request): boolean {
	if (new URL(request.url).protocol === 'https:') return true;
	const forwarded = request.headers.get('x-forwarded-proto');
	if (forwarded) {
		// A chain appends: "https, http" — the first hop is the client-facing one.
		return forwarded.split(',')[0]!.trim() === 'https';
	}
	return false;
}

/**
 * The Set-Cookie header for an admin session.
 *
 * `Secure` is set whenever the request actually arrived over TLS, and omitted
 * otherwise. It is tempting to make it unconditional — the cookie IS the
 * credential, and production Cloudflare is always HTTPS — but a browser
 * *silently discards* a `Secure` cookie sent over plain HTTP. That failure is
 * invisible: the login returns 200, the page navigates to /admin, the
 * middleware finds no cookie, and the operator is bounced back to a login form
 * that shows no error at all. A preview or tunnel served over HTTP hit exactly
 * that.
 *
 * So the flag follows the transport. On a real HTTPS deployment — which is
 * every production deployment — `isSecureRequest` is true and this is
 * identical to the unconditional version. HttpOnly and SameSite=Strict are
 * unconditional because they are safe on any transport.
 */
export function adminSessionCookie(
	value: string,
	secure: boolean,
	maxAge = ADMIN_SESSION_MAX_AGE_SECONDS,
): string {
	return [
		`${SESSION_COOKIE_NAME}=${value}`,
		'Path=/',
		`Max-Age=${maxAge}`,
		'HttpOnly',
		'SameSite=Strict',
		...(secure ? ['Secure'] : []),
	].join('; ');
}

/** The Set-Cookie header that clears the session. */
export function clearAdminSessionCookie(secure: boolean): string {
	return adminSessionCookie('', secure, 0);
}

export type { APIContext };
