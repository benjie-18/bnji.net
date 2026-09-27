/**
 * BNJI.NET — profile view tracking API.
 *
 *   POST /api/profile/view  { slug } -> 200 { recorded: boolean }
 *
 * Deduplication: a view is counted once per (slug, session, day). The
 * session key comes from a cookie (bnji_ps); a new key is generated if
 * missing. This is NOT a fingerprint — it is an ephemeral random value
 * that exists only to prevent inflating view counts via repeated refreshes.
 *
 * Non-blocking: the profile page sends this as a beacon after render.
 * A failure never affects page display.
 *
 * Security logging: records a security_event for abuse-detection. The
 * security event is written to a separate table and never exposed.
 */
import { getProfileStore } from '../../../server/profile-store';
import { getSecurityStore } from '../../../server/security-store';
import { buildSecurityEvent } from '../../../server/security-helpers';
import { serverEnvironment } from '../../../server/env';
import { PROFILE_CONFIG } from '../../../config/profile.config';
import type { APIContext } from 'astro';

export const prerender = false;

function generateSessionKey(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getSessionKey(request: Request): string | null {
	const cookie = request.headers.get('cookie') ?? '';
	const match = cookie.match(new RegExp(`${PROFILE_CONFIG.sessionCookie}=([^;]+)`));
	return match ? match[1] : null;
}

function todayKey(): string {
	return new Date().toISOString().slice(0, 10);
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			...extraHeaders,
		},
	});
}

export async function POST(context: APIContext): Promise<Response> {
	let body: unknown;
	try {
		body = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}

	const slug = (body as Record<string, unknown>)?.slug;
	if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64) {
		return json({ error: 'invalid_slug' }, 400);
	}

	const env = await serverEnvironment();
	const store = getProfileStore(env);
	if (!store) {
		return json({ recorded: false, reason: 'storage_unavailable' });
	}

	let sessionKey = getSessionKey(context.request);
	const needsCookie = !sessionKey;
	if (!sessionKey) {
		sessionKey = generateSessionKey();
	}

	try {
		const recorded = await store.recordView(slug, sessionKey, todayKey(), Date.now());
		const headers: Record<string, string> = {};
		if (needsCookie) {
			headers['set-cookie'] = `${PROFILE_CONFIG.sessionCookie}=${sessionKey}; Path=/; Max-Age=${PROFILE_CONFIG.sessionCookieMaxAge}; SameSite=${PROFILE_CONFIG.sessionCookieSameSite}; HttpOnly`;
		}

		// Security logging (non-blocking, fire-and-forget).
		const secStore = getSecurityStore(env);
		if (secStore) {
			const event = await buildSecurityEvent(context.request, slug, 'view', sessionKey);
			secStore.recordEvent(event).catch(() => {});
		}

		return json({ recorded }, 200, headers);
	} catch (error) {
		console.warn('[bnji] profile view tracking failed:', error);
		return json({ recorded: false, reason: 'error' });
	}
}