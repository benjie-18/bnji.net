/**
 * BNJI.NET — profile link click beacon endpoint.
 *
 *   POST /api/profile/link/click  { slug, linkId } -> 204
 *
 * Receives link-click events from the client beacon (sendBeacon).
 * The actual link navigation happens via the <a> href — this endpoint
 * only records the click for analytics.
 *
 * The link ID is validated against the profile's data to prevent
 * injection of arbitrary link identifiers.
 *
 * Security logging: records a security_event for abuse-detection.
 */
import { getProfileStore } from '../../../../server/profile-store';
import { getSecurityStore } from '../../../../server/security-store';
import { buildSecurityEvent } from '../../../../server/security-helpers';
import { serverEnvironment } from '../../../../server/env';
import { getProfileBySlug } from '../../../../data/profiles';
import { PROFILE_CONFIG } from '../../../../config/profile.config';
import type { APIContext } from 'astro';

export const prerender = false;

function getSessionKey(request: Request): string | null {
	const cookie = request.headers.get('cookie') ?? '';
	const match = cookie.match(new RegExp(`${PROFILE_CONFIG.sessionCookie}=([^;]+)`));
	return match ? match[1] : null;
}

export async function POST(context: APIContext): Promise<Response> {
	let body: unknown;
	try {
		body = await context.request.json();
	} catch {
		return new Response(null, { status: 400 });
	}

	const payload = (body ?? {}) as { slug?: unknown; linkId?: unknown };
	const { slug, linkId } = payload;

	if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64) {
		return new Response(null, { status: 400 });
	}
	if (typeof linkId !== 'string' || linkId.length === 0 || linkId.length > 64) {
		return new Response(null, { status: 400 });
	}

	// Validate that the link exists in the profile's data.
	const profile = getProfileBySlug(slug);
	if (!profile || !profile.links.find((l) => l.id === linkId)) {
		return new Response(null, { status: 404 });
	}

	const env = await serverEnvironment();
	const store = getProfileStore(env);
	const sessionKey = getSessionKey(context.request) ?? '';

	if (store && sessionKey) {
		try {
			await store.recordLinkClick(slug, linkId, sessionKey, Date.now());
		} catch (error) {
			console.warn('[bnji] link click beacon failed:', error);
		}
	}

	// Security logging (non-blocking, fire-and-forget).
	const secStore = getSecurityStore(env);
	if (secStore) {
		const event = await buildSecurityEvent(context.request, slug, 'link-click', sessionKey || undefined);
		secStore.recordEvent(event).catch(() => {});
	}

	return new Response(null, { status: 204 });
}