/**
 * Shared per-visitor session identity.
 *
 * ONE ephemeral cookie for the whole site, used for two jobs that happen to
 * need the same thing — a stable per-visitor key that is NOT a tracking id:
 *
 *   1. Analytics deduplication (profile views: one per session per day;
 *      reaction and link-click cooldowns).
 *   2. Security-event correlation — the enrichment beacon reports client
 *      device data a second or two after the request that logged the event,
 *      and the only way to pair the two is a key present in both.
 *
 * Why one cookie rather than one per surface: the board and the profile are
 * the same visitor, and two cookies with the same lifetime and purpose would
 * be two things to expire, two things to scrub, and two halves of every
 * correlation query. A single key also means an admin can follow one visitor
 * across both surfaces — which is exactly what abuse investigation needs.
 *
 * It is deliberately NOT a fingerprint: the value is 16 random bytes, it is
 * never derived from anything about the device, and it expires with
 * `maxAgeSeconds`. It cannot follow a person across browsers or devices.
 *
 * Cookie attributes are chosen for the same reason the profile used them:
 * HttpOnly (script cannot read it), SameSite=Lax (sent on top-level
 * navigation, not on cross-site subrequests — the beacons are same-origin
 * anyway), and no Secure flag so the value is available on http://localhost
 * during local development; the canonical origin is https in production, so
 * browsers treat it as secure there regardless.
 */
export const SESSION_CONFIG = {
	/** Cookie name. Renaming it retires every live session at once. */
	cookie: 'bnji_ps',
	/** Lifetime in seconds (30 days). */
	maxAgeSeconds: 30 * 24 * 60 * 60,
	/** SameSite attribute for the Set-Cookie header. */
	sameSite: 'Lax' as 'Lax' | 'Strict' | 'None',
	/** HttpOnly: never readable from client script. */
	httpOnly: true,
} as const;

/** A fresh random session key: 16 bytes, 32 hex characters. */
export function generateSessionKey(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Read the session key from a request's Cookie header, or null.
 *
 * Parsed by hand rather than with the Astro cookie helper because the API
 * routes receive a raw Request; a hand-rolled parse also keeps the value
 * byte-exact (no decode/re-encode round trip that could corrupt a key).
 * The value is a fixed hex alphabet, so there is nothing to unescape.
 */
export function readSessionKey(request: Request, cookieName = SESSION_CONFIG.cookie): string | null {
	const header = request.headers.get('cookie') ?? '';
	// Escape the name so a cookie name with regex metacharacters cannot
	// alter the pattern; the boundary check stops 'x' matching 'xy'.
	const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = header.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
	if (!match) return null;
	const value = match[1].trim();
	return value.length > 0 ? value : null;
}

/** Set-Cookie header value for a session key. */
export function sessionCookieHeader(key: string): string {
	const parts = [
		`${SESSION_CONFIG.cookie}=${key}`,
		'Path=/',
		`Max-Age=${SESSION_CONFIG.maxAgeSeconds}`,
		`SameSite=${SESSION_CONFIG.sameSite}`,
	];
	if (SESSION_CONFIG.httpOnly) parts.push('HttpOnly');
	return parts.join('; ');
}
