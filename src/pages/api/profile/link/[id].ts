/**
 * BNJI.NET — profile link click tracking with redirect.
 *
 *   GET /api/profile/link/<link-id>?slug=gizlyy -> 302 -> link destination
 *
 * Records the click event and immediately redirects to the real link URL.
 * The link ID must match a link defined in the profile's data — this
 * prevents open redirects (an attacker cannot supply an arbitrary URL).
 *
 * The session key is read from the bnji_ps cookie if present, but
 * link-click recording is best-effort (failure still redirects).
 *
 * Security: only known (profile_slug, link_id) pairs produce a redirect.
 * Unknown IDs return 404. The redirect target is always the URL from the
 * profile data, never a user-supplied value.
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

export async function GET(context: APIContext): Promise<Response> {
	const linkId = context.params.id;
	const slug = context.url.searchParams.get('slug');

	if (!linkId || typeof linkId !== 'string') {
		return new Response('Not found', { status: 404 });
	}
	if (!slug || slug.length > 64) {
		return new Response('Bad request', { status: 400 });
	}

	// Validate: the link must exist in the profile's data (prevents open redirects).
	const profile = getProfileBySlug(slug);
	if (!profile) {
		return new Response('Not found', { status: 404 });
	}
	const link = profile.links.find((l) => l.id === linkId);
	if (!link) {
		return new Response('Not found', { status: 404 });
	}

	const env = await serverEnvironment();
	const sessionKey = getSessionKey(context.request) ?? '';

	// Record the click (best-effort, non-blocking).
	if (sessionKey) {
		try {
			const store = getProfileStore(env);
			if (store) {
				await store.recordLinkClick(slug, linkId, sessionKey, Date.now());
			}
		} catch (error) {
			console.warn('[bnji] link click tracking failed:', error);
		}
	}

	// Security logging (non-blocking, fire-and-forget).
	const secStore = getSecurityStore(env);
	if (secStore) {
		const event = await buildSecurityEvent(context.request, slug, 'link-redirect', sessionKey || undefined);
		secStore.recordEvent(event).catch(() => {});
	}

	// Redirect to the real destination.
	return new Response(null, {
		status: 302,
		headers: {
			location: link.href,
			'cache-control': 'no-store',
		},
	});
}