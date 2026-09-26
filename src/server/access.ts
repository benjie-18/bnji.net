/**
 * BNJI.NET — server-side access-control primitives.
 *
 * The honest model:
 *   - src/config/access.config.ts DECLARES which routes are protected and how.
 *   - src/middleware.ts ENFORCES those rules on every request that actually
 *     runs Worker code (i.e. non-prerendered routes).
 *   - Prerendered static pages CANNOT be protected (the edge serves them
 *     without running code). A route that must be private sets
 *     `export const prerender = false;` in its page file.
 *   - Client-side hiding is never used as protection, anywhere.
 *
 * Credentials (environment only — never in the repo):
 *   ACCESS_TOKEN          shared bearer token for auth: 'token' rules
 *   ACCESS_PASSWORD_SHA   sha256(hex) of the password for auth: 'password'
 *   ACCESS_SECRET         HMAC key signing the session cookie
 *
 * With an empty ACCESS_RULES list (the default) every current page remains
 * public and this module is a no-op. Nothing here fakes security: checks are
 * constant-time, sessions are signed, and failures log without leaking why.
 */
import type { RouteAccessRule } from '../config/access.config';

type AccessContext = {
	request: Request;
	cookies: { get(name: string): { value: string } | undefined };
};

const SESSION_COOKIE = 'bnji_session';

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function hmacHex(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** True when the request carries a valid session signature for THIS rule. */
async function hasValidSession(
	ctx: AccessContext,
	secret: string,
	rule: RouteAccessRule,
): Promise<boolean> {
	const cookie = ctx.cookies.get(SESSION_COOKIE)?.value;
	if (!cookie) return false;
	const [payload, signature] = cookie.split('.');
	if (!payload || !signature) return false;
	const expected = await hmacHex(secret, payload);
	if (!timingSafeEqual(expected, signature)) return false;
	// payload = "<rulePattern>:<expiryEpochSeconds>"
	const [pattern, expiry] = payload.split(':');
	const expires = Number(expiry);
	if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
	// The session must have been issued for the rule being enforced: one
	// rule's session never authorizes another rule's routes. (issueSession
	// bakes rule.pattern into the signed payload; without this comparison a
	// valid signature for ANY pattern passed EVERY rule.)
	if (pattern === undefined) return false;
	return timingSafeEqual(pattern, rule.pattern);
}

/**
 * Verify a presented credential against the rule. Used by (future) login
 * endpoints; the middleware itself only checks bearer tokens and sessions.
 */
export async function verifyCredential(
	rule: RouteAccessRule,
	credential: string,
	env: Record<string, string | undefined>,
): Promise<boolean> {
	if (rule.auth === 'token') {
		const expected = env.ACCESS_TOKEN;
		return expected ? timingSafeEqual(credential, expected) : false;
	}
	const expectedSha = env.ACCESS_PASSWORD_SHA;
	if (!expectedSha) return false;
	const presented = await sha256Hex(credential);
	return timingSafeEqual(presented, expectedSha);
}

/** Issue a signed session cookie value for a rule (8h expiry). */
export async function issueSession(
	rule: RouteAccessRule,
	env: Record<string, string | undefined>,
): Promise<string | null> {
	const secret = env.ACCESS_SECRET;
	if (!secret) return null;
	const payload = `${rule.pattern}:${Math.floor(Date.now() / 1000) + 8 * 3600}`;
	const signature = await hmacHex(secret, payload);
	return `${payload}.${signature}`;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

/** Middleware entry: is this request authorized for the matched rule? */
export async function isAuthorized(
	ctx: AccessContext,
	rule: RouteAccessRule,
	env: Record<string, string | undefined>,
): Promise<boolean> {
	// No credentials configured => the rule cannot pass. Failing closed is
	// the only honest behaviour: an unconfigured guard must not open the door.
	if (!env.ACCESS_SECRET && !env.ACCESS_TOKEN && !env.ACCESS_PASSWORD_SHA) return false;

	if (env.ACCESS_SECRET && (await hasValidSession(ctx, env.ACCESS_SECRET, rule))) return true;

	if (rule.auth === 'token' && env.ACCESS_TOKEN) {
		const header = ctx.request.headers.get('authorization') ?? '';
		const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
		return timingSafeEqual(bearer, env.ACCESS_TOKEN);
	}
	return false;
}
