/**
 * BNJI.NET — admin session bootstrap and token rotation.
 *
 *   POST   /api/admin/session  { token }        ->  200 { ok } + session cookie
 *   POST   /api/admin/session  { current, new } ->  200 { ok }  (rotate token)
 *   DELETE /api/admin/session                   ->  204 (clears the cookie)
 *
 * Exchanging the operator's access token for a signed, HttpOnly session cookie
 * is what lets the /admin panel be a normal page load: a browser cannot send
 * an Authorization header on a top-level navigation, which is the entire
 * reason the cookie exists.
 *
 * The token is verified against its stored hash by verifyAdminToken() and is
 * never logged, echoed, or retained — the server sets the cookie and the
 * browser forgets the token entirely, because the cookie is HttpOnly and the
 * dashboard's JavaScript never sees it.
 *
 * Rotation lives on the same route because it is the same concern: "the
 * credential, and the sessions derived from it". It demands BOTH a valid
 * session AND the current token. Being logged in is not authority enough —
 * a stolen cookie could otherwise rotate the token and lock the owner out
 * forever. A successful rotation leaves the caller's existing session
 * invalid (sessions are bound to the token that minted them), so the
 * response re-issues a fresh cookie signed under the new token; the client
 * can simply sign in again.
 */
import {
	ADMIN_SESSION_MAX_AGE_SECONDS,
	MIN_NEW_TOKEN_LENGTH,
	adminConfigured,
	adminNotConfigured,
	adminSessionCookie,
	adminTokenUpdatedAt,
	changeAdminToken,
	clearAdminSessionCookie,
	isAdminRequest,
	isSecureRequest,
	issueAdminSession,
	verifyAdminToken,
} from '../../../server/admin';
import { serverEnvironment } from '../../../server/env';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import { clientIp } from '../../../server/security-helpers';
import type { APIContext } from 'astro';

export const prerender = false;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Brute-force budget. An 8h session is a long-lived credential, so guessing
 * the token must be expensive: 10 attempts per IP per 15 minutes. KV-backed
 * so the limit is shared across isolates.
 *
 * Only FAILURES are charged. The gate below peeks without spending, and the
 * budget is spent after a wrong token — otherwise ten successful sign-ins in
 * a window would lock the owner out of their own site, which is the wrong
 * thing for a throttle to do. See rateLimit()'s `consume` option.
 *
 * The limiter fails OPEN (see src/server/ratelimit.ts) — a KV outage must not
 * lock the owner out of their own site. That is safe here only because the
 * token is hashed at rest: an offline attacker who can copy the database
 * does not need this endpoint.
 */
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX_ATTEMPTS = 10;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
	});
}

/** Strip control characters and normalise whitespace out of a PRESENTED token. */
function cleanToken(value: unknown): string {
	if (typeof value !== 'string') return '';
	return value.replace(CONTROL_CHARS, '').trim();
}

/**
 * Normalise a token the admin is CHOOSING.
 *
 * Only surrounding whitespace is removed — interior characters are left
 * exactly as typed. cleanToken() is right for a presented token (a pasted
 * one often carries a trailing newline) but wrong here: silently deleting
 * characters from a value the operator is about to save would store a
 * different token than the one they think they set, and there is no way to
 * read it back to notice.
 */
function cleanNewToken(value: unknown): string {
	return typeof value === 'string' ? value.replace(CONTROL_CHARS, '').trim() : '';
}

export async function POST(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();

	const env = await serverEnvironment();
	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const rateKey = `admin:login:${clientIp(context.request)}`;
	// Read once, used for every Set-Cookie on this request. See
	// isSecureRequest(): a Secure cookie sent over plain HTTP is dropped by the
	// browser without a word, which looks exactly like a broken login.
	const secure = isSecureRequest(context.request);

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}
	const body = (payload ?? {}) as { token?: unknown; newToken?: unknown };

	/* --- rotation --------------------------------------------------------- */
	// Detected by the presence of newToken, and authorised separately from
	// login: the caller must already hold a session AND prove they know the
	// CURRENT token.
	if (body.newToken !== undefined) {
		const isAdmin = await isAdminRequest(context);
		if (!isAdmin) return json({ error: 'unauthorized' }, 401);

		const current = cleanToken(body.token);
		// Re-verify the current token on every rotation, not just the session.
		if (!(await verifyAdminToken(current))) {
			return json({ error: 'current_token_invalid' }, 403);
		}

		const result = await changeAdminToken(cleanNewToken(body.newToken));
		if (!result.ok) {
			if (result.error === 'too_short') {
				return json({ error: 'token_too_short', minLength: MIN_NEW_TOKEN_LENGTH }, 422);
			}
			if (result.error === 'not_configured') return adminNotConfigured();
			return json({ error: 'storage_unavailable' }, 503);
		}

		// The old cookie no longer verifies (it is bound to the previous
		// token), so mint a new one signed under the token just set. The admin
		// stays signed in through the rotation instead of being dropped.
		const session = await issueAdminSession();
		return json(
			{ ok: true, rotatedAt: Date.now(), expiresIn: ADMIN_SESSION_MAX_AGE_SECONDS },
			200,
			session ? { 'set-cookie': adminSessionCookie(session, secure) } : {},
		);
	}

	/* --- login ------------------------------------------------------------ */
	const gate = await rateLimit(kv, rateKey, RATE_WINDOW_MS, RATE_MAX_ATTEMPTS, { consume: false });
	if (!gate.allowed) {
		return json(
			{ error: 'rate_limited', retryAfter: gate.retryAfter },
			429,
			// Standard header, so a client does not have to parse the body to
			// know when to try again.
			{ 'retry-after': String(gate.retryAfter) },
		);
	}

	const token = cleanToken(body.token);
	if (!(await verifyAdminToken(token))) {
		// This attempt costs budget. Charging here rather than at the gate is
		// what makes the budget a budget for guesses.
		await rateLimit(kv, rateKey, RATE_WINDOW_MS, RATE_MAX_ATTEMPTS);
		// One shape for every failure: a wrong token, a short one and a
		// missing one are indistinguishable to the caller.
		return json({ error: 'unauthorized' }, 401);
	}

	const session = await issueAdminSession();
	if (!session) {
		// ACCESS_SECRET missing: the token was correct but there is no way to
		// sign a session. Say so plainly rather than handing back a
		// cookie-less 200.
		return adminNotConfigured();
	}

	return json(
		{ ok: true, expiresIn: ADMIN_SESSION_MAX_AGE_SECONDS, tokenRotatedAt: await adminTokenUpdatedAt() },
		200,
		{ 'set-cookie': adminSessionCookie(session, secure) },
	);
}

export function DELETE(context: APIContext): Response {
	return new Response(null, {
		status: 204,
		headers: { 'set-cookie': clearAdminSessionCookie(isSecureRequest(context.request)) },
	});
}
