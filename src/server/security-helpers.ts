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
import type { SecurityEvent } from './security-store';

/**
 * Extract Cloudflare metadata from a request.
 * CF-Connecting-IP is set by Cloudflare and is the real client IP.
 * cf-* headers are Cloudflare-specific and may be absent outside the Worker.
 *
 * Cloudflare exposes precise geolocation via cf.latitude and cf.longitude
 * when the feature is enabled on the account. These are the visitor's
 * approximate coordinates based on their IP address.
 */
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
	const ip =
		request.headers.get('cf-connecting-ip') ??
		(request as Request & { cf?: { connectingIp?: string } }).cf?.connectingIp ??
		'unknown';
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
 * Build a SecurityEvent from a request. The caller provides the profile
 * slug, endpoint name, and session key. All other fields are extracted
 * from Cloudflare headers.
 */
export async function buildSecurityEvent(
	request: Request,
	profileSlug: string,
	endpoint: string,
	sessionKey?: string,
): Promise<SecurityEvent> {
	const { ip, ua, country, city, asn, latitude, longitude, referrer } = extractSecurityMetadata(request);
	const fingerprint = await computeFingerprint(ua, asn, country);
	return {
		profileSlug,
		endpoint,
		ipAddress: ip,
		userAgent: ua,
		cfCountry: country,
		cfCity: city,
		cfAsn: asn,
		fingerprint,
		sessionKey,
		createdAt: Date.now(),
		geoLatitude: latitude,
		geoLongitude: longitude,
		referrer: referrer?.slice(0, 2048),
	};
}