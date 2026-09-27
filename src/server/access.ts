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

/**
 * The pattern a rule's session cookie is signed for.
 *
 * Defaults to the rule's own `pattern`. Rules that belong to one logical
 * surface (a page and the API that backs it) set `sessionPattern` so a single
 * cookie opens both — see RouteAccessRule.sessionPattern.
 */
export function sessionPatternOf(rule: RouteAccessRule): string {
	return rule.sessionPattern ?? rule.pattern;
}

/** True when the request carries a valid session signature for THIS rule. */
async function hasValidSession(
	ctx: AccessContext,
	secret: string,
	rule: RouteAccessRule,
): Promise<boolean> {
	const cookie = ctx.cookies.get(SESSION_COOKIE)?.value;
	if (!cookie) return false;
	return verifySessionCookieValue(cookie, secret, sessionPatternOf(rule));
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

/**
 * Issue a signed session cookie value for a rule (8h expiry).
 *
 * `credential` binds the session to a specific credential: the payload
 * carries its fingerprint, so changing the credential silently invalidates
 * every session minted under the old one. See verifySessionCookieValue.
 */
export async function issueSession(
	rule: RouteAccessRule,
	env: Record<string, string | undefined>,
	credential = '',
): Promise<string | null> {
	const secret = env.ACCESS_SECRET;
	if (!secret) return null;
	const parts = [sessionPatternOf(rule), String(Math.floor(Date.now() / 1000) + 8 * 3600)];
	if (credential) parts.push(credential);
	const payload = parts.join(':');
	const signature = await hmacHex(secret, payload);
	return `${payload}.${signature}`;
}

/**
 * Verify a session cookie VALUE for a specific rule pattern.
 *
 * Split out of hasValidSession so callers that already hold the raw cookie
 * string — the admin data routes, which see a bare Request rather than an
 * Astro cookies object — validate with the exact same scheme that signed it.
 *
 * It MUST re-derive the HMAC over the PRESENTED payload and compare
 * signatures. Re-issuing a fresh session and comparing payloads does not work
 * here: the payload embeds an absolute expiry timestamp, so a newly issued
 * one carries a different expiry and could never equal the old value.
 *
 * PAYLOAD = "<rulePattern>:<expiryEpochSeconds>[:<credentialFingerprint>]"
 *
 * The optional third field binds a session to the credential that minted it.
 * When the caller supplies `credentialFingerprint`, a cookie without that
 * field — or with a different one — is rejected. That is what makes "change
 * the access token" take effect immediately instead of at the next 8-hour
 * expiry: every session signed under the old token stops verifying the
 * moment the hash behind it changes. Callers that pass no fingerprint keep
 * the previous, unbound behaviour.
 */
export async function verifySessionCookieValue(
	cookieValue: string,
	secret: string | undefined,
	pattern: string,
	credentialFingerprint?: string,
): Promise<boolean> {
	if (!secret) return false;
	const [payload, signature, ...rest] = cookieValue.split('.');
	if (!payload || !signature || rest.length > 0) return false;
	const expected = await hmacHex(secret, payload);
	if (!timingSafeEqual(expected, signature)) return false;
	const [payloadPattern, expiry, payloadFingerprint] = payload.split(':');
	const expires = Number(expiry);
	if (!Number.isFinite(expires) || expires < Date.now() / 1000) return false;
	// A session issued for one rule must never authorize another.
	if (payloadPattern === undefined) return false;
	if (!timingSafeEqual(payloadPattern, pattern)) return false;
	if (credentialFingerprint !== undefined) {
		if (payloadFingerprint === undefined) return false;
		return timingSafeEqual(payloadFingerprint, credentialFingerprint);
	}
	return true;
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
