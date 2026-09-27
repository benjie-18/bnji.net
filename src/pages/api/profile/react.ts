/**
 * BNJI.NET — profile reactions API.
 *
 *   POST /api/profile/react  { slug, reaction } -> 201 { counts }
 *   GET  /api/profile/react?slug=X              -> 200 { counts }
 *
 * Security:
 *   - Server-side validation of slug and reaction value.
 *   - Per-session, per-reaction cooldown (5 min default).
 *   - Session key from cookie (bnji_ps); generated if missing.
 *   - Reactions are data-driven via PROFILE_CONFIG.allowedReactions.
 *   - Security event logged for abuse-detection (separate table, never exposed).
 *
 * Non-blocking: the profile page gracefully degrades if this endpoint
 * is unavailable (reactions show 0 counts, reaction buttons still render).
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

function sessionCookieHeader(key: string): string {
	return `${PROFILE_CONFIG.sessionCookie}=${key}; Path=/; Max-Age=${PROFILE_CONFIG.sessionCookieMaxAge}; SameSite=${PROFILE_CONFIG.sessionCookieSameSite}; HttpOnly`;
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

export async function GET(context: APIContext): Promise<Response> {
	const slug = context.url.searchParams.get('slug');
	if (!slug || slug.length > 64) {
		return json({ error: 'invalid_slug' }, 400);
	}

	const env = await serverEnvironment();
	const store = getProfileStore(env);
	if (!store) {
		return json({ counts: {} });
	}

	try {
		const counts = await store.getReactionCounts(slug);
		return json({ counts });
	} catch (error) {
		console.warn('[bnji] profile reaction counts failed:', error);
		return json({ counts: {} });
	}
}

export async function POST(context: APIContext): Promise<Response> {
	let body: unknown;
	try {
		body = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}

	const payload = (body ?? {}) as { slug?: unknown; reaction?: unknown };
	const { slug, reaction } = payload;

	if (typeof slug !== 'string' || slug.length === 0 || slug.length > 64) {
		return json({ error: 'invalid_slug' }, 400);
	}
	if (typeof reaction !== 'string') {
		return json({ error: 'invalid_reaction' }, 422);
	}
	if (!PROFILE_CONFIG.allowedReactions.includes(reaction)) {
		return json({ error: 'invalid_reaction', allowed: PROFILE_CONFIG.allowedReactions }, 422);
	}

	const env = await serverEnvironment();
	const store = getProfileStore(env);
	if (!store) {
		return json({ error: 'storage_unavailable' }, 503);
	}

	let sessionKey = getSessionKey(context.request);
	const needsCookie = !sessionKey;
	if (!sessionKey) {
		sessionKey = generateSessionKey();
	}

	try {
		// Check cooldown: can this session react with this emoji again?
		const since = Date.now() - PROFILE_CONFIG.reactionCooldownMs;
		const hasRecent = await store.getRecentReaction(slug, reaction, sessionKey, since);
		if (hasRecent) {
			const headers: Record<string, string> = {};
			if (needsCookie) {
				headers['set-cookie'] = sessionCookieHeader(sessionKey);
			}
			return json(
				{
					error: 'cooldown',
					retryAfter: Math.ceil(PROFILE_CONFIG.reactionCooldownMs / 1000),
				},
				429,
				headers,
			);
		}

		await store.addReaction(slug, reaction, sessionKey, Date.now());

		// Security logging (non-blocking, fire-and-forget).
		const secStore = getSecurityStore(env);
		if (secStore) {
			const event = await buildSecurityEvent(context.request, slug, 'react', sessionKey);
			secStore.recordEvent(event).catch(() => {});
		}

		// Return updated counts
		const counts = await store.getReactionCounts(slug);
		const headers: Record<string, string> = {};
		if (needsCookie) {
			headers['set-cookie'] = sessionCookieHeader(sessionKey);
		}
		return json({ counts }, 201, headers);
	} catch (error) {
		console.warn('[bnji] profile reaction failed:', error);
		return json({ error: 'storage_unavailable' }, 503);
	}
}