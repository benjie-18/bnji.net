/**
 * BNJI.NET — security event extraction helpers.
 *
 * Extracts request metadata for security logging from Cloudflare headers.
 * Used by the profile API endpoints (view, react, link) to log security
 * events without coupling the endpoint logic to the storage layer.
 *
 * Server-side extraction captures: IP, user-agent, country, city, ASN,
 * precise geo coordinates (cf.latitude/cf.longitude), and referrer URL.
 *
 * Client-side enrichment (screen, hardware, timezone, WebGL) is handled
 * separately via the /api/profile/security/enrich endpoint.
 *
 * The fingerprint is a lightweight hash of the user-agent + ASN + country.
 * The client may send a richer device_fingerprint based on screen + hardware.
 *
 * Privacy: the extraction itself stores nothing — it only produces a
 * SecurityEvent object that the caller passes to the security store.
 */
import type { SecurityEvent, SecuritySurface } from './security-store';

/**
 * Extract Cloudflare metadata from a request.
 * CF-Connecting-IP is set by Cloudflare and is the real client IP.
 * cf-* headers are Cloudflare-specific and may be absent outside the Worker.
 *
 * Cloudflare exposes precise geolocation via cf.latitude and cf.longitude
 * when the feature is enabled on the account. These are the visitor's
 * approximate coordinates based on their IP address.
 */
/**
 * The caller's IP address, from ONE place.
 *
 * Header first, then the Request.cf object. Cloudflare sets
 * `cf-connecting-ip` itself and overwrites any client-supplied value, so
 * reading the header is not trusting the client; `cf.connectingIp` is the
 * same value and is kept as a fallback for the rare path where the header
 * is absent.
 *
 * Why the header is first rather than cf: the local dev server
 * (`wrangler dev`) synthesises a placeholder `cf` object whose connectingIp
 * is not the caller's. A cf-first reader therefore sees a different "client"
 * on every local request, which silently breaks every IP-keyed control —
 * rate limits stop limiting and per-IP de-duplication stops de-duplicating,
 * so local testing passes while production behaves differently. Header-first
 * is what makes the local environment exercise the real code path.
 *
 * Five routes used to carry their own copy of this. They did not all agree
 * on the order, so the IP written to security_events could differ from the
 * IP a rate limit or a de-duplication key was derived from — the same
 * request producing two different identities. One function, one answer.
 */
export function clientIp(request: Request): string {
	return (
		request.headers.get('cf-connecting-ip') ??
		(request as Request & { cf?: { connectingIp?: string } }).cf?.connectingIp ??
		'unknown'
	);
}

export function extractSecurityMetadata(request: Request): {
	ip: string;
	ua: string | undefined;
	country: string | undefined;
	city: string | undefined;
	asn: string | undefined;
	latitude: number | undefined;
	longitude: number | undefined;
	referrer: string | undefined;
} {
	const ip = clientIp(request);
	const ua = request.headers.get('user-agent') ?? undefined;
	const country = request.headers.get('cf-ipcountry') ?? undefined;
	const city =
		(request as Request & { cf?: { city?: string } }).cf?.city ??
		request.headers.get('cf-city') ??
		undefined;
	const asn =
		(request as Request & { cf?: { asn?: number } }).cf?.asn?.toString() ??
		undefined;

	// Precise geolocation from Cloudflare.
	const cfObj = (request as Request & { cf?: { latitude?: string; longitude?: string } }).cf;
	const latitude = parseFloat(cfObj?.latitude ?? request.headers.get('cf-latitude') ?? '') || undefined;
	const longitude = parseFloat(cfObj?.longitude ?? request.headers.get('cf-longitude') ?? '') || undefined;

	// Referrer URL (may contain sensitive query parameters or browsing history).
	const referrer = request.headers.get('referer') ?? undefined;

	return { ip, ua, country, city, asn, latitude, longitude, referrer };
}

/**
 * Compute a lightweight fingerprint hash from available request metadata.
 * This is NOT a full device fingerprint — it hashes the combination of
 * user-agent + ASN + country to produce a coarse grouping key. Two visitors
 * on the same network with the same browser may share a fingerprint, which
 * is acceptable for abuse-detection (we'd rather over-group than track
 * individuals).
 *
 * Returns a 16-character hex string, or undefined if crypto is unavailable.
 */
export async function computeFingerprint(
	ua: string | undefined,
	asn: string | undefined,
	country: string | undefined,
): Promise<string | undefined> {
	const seed = [ua ?? '', asn ?? '', country ?? ''].join('|');
	if (!seed || seed === '||') return undefined;
	try {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
		return Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.slice(0, 16);
	} catch {
		return undefined;
	}
}

/**
 * Build a SecurityEvent from a request.
 *
 * The caller supplies the surface, the endpoint name, and optionally a
 * profile slug (profile events only), a target id (the row the request acted
 * on — a board message, a link), and the session key. Everything else comes
 * from Cloudflare headers.
 *
 * For board and dm events, profileSlug is intentionally left undefined: the
 * security_events column is NULL for those surfaces, because "which profile?"
 * has no honest answer for the message board.
 */
export async function buildSecurityEvent(
	request: Request,
	options: {
		surface?: SecuritySurface;
		endpoint: string;
		profileSlug?: string;
		targetId?: string;
		sessionKey?: string;
	},
): Promise<SecurityEvent> {
	const { ip, ua, country, city, asn, latitude, longitude, referrer } = extractSecurityMetadata(request);
	const fingerprint = await computeFingerprint(ua, asn, country);
	const surface = options.surface ?? 'profile';
	return {
		surface,
		// Only profile events carry a slug. Stripping it elsewhere keeps a
		// careless caller from labelling a board event with a profile.
		...(surface === 'profile' && options.profileSlug
			? { profileSlug: options.profileSlug }
			: {}),
		endpoint: options.endpoint,
		...(options.targetId ? { targetId: options.targetId } : {}),
		ipAddress: ip,
		userAgent: ua,
		cfCountry: country,
		cfCity: city,
		cfAsn: asn,
		fingerprint,
		sessionKey: options.sessionKey,
		createdAt: Date.now(),
		geoLatitude: latitude,
		geoLongitude: longitude,
		referrer: referrer?.slice(0, 2048),
	};
}