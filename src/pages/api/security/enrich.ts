/**
 * BNJI.NET — security event enrichment endpoint.
 *
 *   POST /api/profile/security/enrich  {
 *     surface, endpoint, slug?,              // surface: 'profile' | 'board' | 'dm'
 *     screenWidth, screenHeight, screenPixelRatio,
 *     hardwareConcurrency, deviceMemory, platform,
 *     timezone, language, webglRenderer, touchSupport
 *   }  -> 204 (always)
 *
 * One endpoint for every surface. Two-phase collection: phase one is the
 * server logging request metadata on the action itself (see
 * src/server/security-helpers.ts); phase two is the browser reporting what
 * only a browser knows, folded into the row written moments earlier.
 *
 * Shared by the profile pages and the message board. Keeping it single is not
 * tidiness for its own sake — a second endpoint would mean a second rate
 * limit, a second validation surface, and a second chance to get the match
 * window wrong. The only difference between surfaces is the `surface` tag.
 *
 * Matching: the most recent security_event sharing (session_key, surface,
 * endpoint) — plus profile_slug for profile events — created within the last
 * 10 seconds. Misses are discarded silently.
 *
 * Design notes
 * ------------
 *  - The device fingerprint is derived HERE, not accepted from the client. A
 *    client-supplied fingerprint is just a caller-chosen string; hashing
 *    screen + hardware + platform + timezone + user-agent server-side
 *    produces a value the visitor cannot forge without changing their
 *    device. The raw seed is never stored — only the 24-char hash.
 *  - Enrichment only ever fills NULL columns (COALESCE), so it can never
 *    overwrite a server-observed value with a client-asserted one.
 *  - Rate limited per IP so this write path cannot be used to hammer D1.
 *
 * PRIVACY: every field here is personal information under Quebec Law 25
 * and PIPEDA (device identifiers, precise geolocation, browsing referrers).
 * The data lands only in security_events, which is server-only and
 * readable exclusively through the admin surface. This endpoint returns no
 * data — it only writes.
 */
import { getSecurityStore, SECURITY_SURFACES, type SecuritySurface } from '../../../server/security-store';
import { getProfileBySlug } from '../../../data/profiles';
import { serverEnvironment } from '../../../server/env';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import { readSessionKey } from '../../../config/session.config';
import { clientIp } from '../../../server/security-helpers';
import type { APIContext } from 'astro';

export const prerender = false;

/**
 * Which endpoints on each surface may carry client enrichment. An allowlist,
 * not a free-text field: the value is interpolated into no SQL here, but it
 * IS the match key, and an open value would let a caller aim an enrichment at
 * an endpoint that does not exist (harmless) or — far worse — at a future
 * endpoint that does, without the person who added it considering this.
 */
const ENRICHABLE_ENDPOINTS: Record<SecuritySurface, readonly string[]> = {
	profile: ['view', 'react', 'link-click', 'link-redirect'],
	board: ['board-view', 'board-post', 'board-report'],
	// The DM form is a POST with no following page load to piggyback on, so
	// it is listed for completeness but nothing client-side enriches it yet.
	dm: ['dm-post'],
};

/** How far back an event may be and still be enriched. */
const ENRICHMENT_WINDOW_MS = 10_000;

/** Per-IP ceiling: one page load or one action sends one beacon, so this is generous. */
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_MAX_HITS = 30;

/** SHA-256 of a string, as lowercase hex. */
async function sha256Hex(value: string): Promise<string | undefined> {
	try {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
		return Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	} catch {
		return undefined;
	}
}

/** Finite number in a sane range, or undefined. Guards against NaN/Infinity from JSON. */
function boundedNumber(value: unknown, min: number, max: number): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
	if (value < min || value > max) return undefined;
	return value;
}

/** String field trimmed to a maximum length, or undefined when empty. */
function boundedString(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.slice(0, max).trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export async function POST(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();

	// Throttle before touching D1. Fails open if the KV binding is missing.
	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const limit = await rateLimit(kv, `enrich:${clientIp(context.request)}`, RATE_WINDOW_MS, RATE_MAX_HITS);
	if (!limit.allowed) {
		return new Response(null, { status: 204 });
	}

	// No session cookie means there is no event row to match against.
	const sessionKey = readSessionKey(context.request);
	if (!sessionKey) {
		return new Response(null, { status: 204 });
	}

	let body: unknown;
	try {
		body = await context.request.json();
	} catch {
		return new Response(null, { status: 204 });
	}
	if (!body || typeof body !== 'object') {
		return new Response(null, { status: 204 });
	}

	const p = body as Record<string, unknown>;
	const surface = typeof p.surface === 'string' ? p.surface : 'profile';
	const endpoint = typeof p.endpoint === 'string' ? p.endpoint : '';
	const slug = typeof p.slug === 'string' ? p.slug : '';

	if (!(SECURITY_SURFACES as readonly string[]).includes(surface)) {
		return new Response(null, { status: 204 });
	}
	if (!ENRICHABLE_ENDPOINTS[surface as SecuritySurface].includes(endpoint)) {
		return new Response(null, { status: 204 });
	}
	// Profile events are tied to a real profile; board/dm events are not, and
	// a slug sent alongside them is ignored rather than trusted.
	let profileSlug: string | undefined;
	if (surface === 'profile') {
		if (!getProfileBySlug(slug)) {
			return new Response(null, { status: 204 });
		}
		profileSlug = slug;
	}

	const screenWidth = boundedNumber(p.screenWidth, 0, 20_000);
	const screenHeight = boundedNumber(p.screenHeight, 0, 20_000);
	const screenPixelRatio = boundedNumber(p.screenPixelRatio, 0, 20);
	const hardwareConcurrency = boundedNumber(p.hardwareConcurrency, 0, 1_024);
	const deviceMemory = boundedNumber(p.deviceMemory, 0, 1_024);
	const platform = boundedString(p.platform, 128);
	const timezone = boundedString(p.timezone, 64);
	const language = boundedString(p.language, 32);
	const webglRenderer = boundedString(p.webglRenderer, 256);
	const touchSupport = typeof p.touchSupport === 'boolean' ? p.touchSupport : undefined;

	// Server-derived device fingerprint: the browser cannot choose this value,
	// only change it by changing its device. The seed itself is never stored.
	const userAgent = context.request.headers.get('user-agent') ?? '';
	const seedParts = [
		userAgent,
		String(screenWidth ?? ''),
		String(screenHeight ?? ''),
		String(screenPixelRatio ?? ''),
		String(hardwareConcurrency ?? ''),
		String(deviceMemory ?? ''),
		platform ?? '',
		timezone ?? '',
		webglRenderer ?? '',
	];
	if (seedParts.every((part) => part === '')) {
		return new Response(null, { status: 204 });
	}
	const deviceFingerprint = (await sha256Hex(seedParts.join('|')))?.slice(0, 24);

	const store = getSecurityStore(env);
	if (!store) {
		return new Response(null, { status: 204 });
	}

	try {
		await store.enrichEvent(
			{ sessionKey, surface: surface as SecuritySurface, profileSlug, endpoint, since: Date.now() - ENRICHMENT_WINDOW_MS },
			{
				screenWidth,
				screenHeight,
				screenPixelRatio,
				hardwareConcurrency,
				deviceMemory,
				platform,
				timezone,
				language,
				webglRenderer,
				touchSupport,
				deviceFingerprint,
			},
		);
	} catch (error) {
		console.warn('[bnji] security enrichment failed:', error);
	}

	return new Response(null, { status: 204 });
}
