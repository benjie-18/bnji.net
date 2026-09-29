/**
 * BNJI.NET — global site-wide page view tracking API.
 *
 *   POST /api/track  { path, referrer? } -> 200 { recorded: boolean }
 *
 * Deduplication: a page view is counted once per (path, session, day).
 * Session key comes from cookie `bnji_ps` / `bnji_session`.
 * Non-blocking: fired asynchronously on page boot.
 */
import { getProfileStore } from '../../server/profile-store';
import { getSecurityStore } from '../../server/security-store';
import { buildSecurityEvent } from '../../server/security-helpers';
import { serverEnvironment } from '../../server/env';
import { generateSessionKey, readSessionKey, sessionCookieHeader } from '../../config/session.config';
import type { APIContext } from 'astro';

export const prerender = false;

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

	const rawPath = (body as Record<string, unknown>)?.path;
	const path = typeof rawPath === 'string' && rawPath.length > 0 && rawPath.length <= 128
		? rawPath
		: '/';

	const env = await serverEnvironment();
	const store = getProfileStore(env);

	let sessionKey = readSessionKey(context.request);
	const needsCookie = !sessionKey;
	if (!sessionKey) {
		sessionKey = generateSessionKey();
	}

	try {
		let recorded = false;
		if (store) {
			recorded = await store.recordView(path, sessionKey, todayKey(), Date.now());
		}

		const headers: Record<string, string> = {};
		if (needsCookie) {
			headers['set-cookie'] = sessionCookieHeader(sessionKey);
		}

		// Security logging for global traffic (non-blocking).
		const secStore = getSecurityStore(env);
		if (secStore) {
			const event = await buildSecurityEvent(context.request, {
				surface: 'profile',
				endpoint: 'page-view',
				profileSlug: path,
				targetId: path,
				sessionKey,
			});
			secStore.recordEvent(event).catch(() => {});
		}

		return json({ recorded }, 200, headers);
	} catch (error) {
		console.warn('[bnji] global track failed:', error);
		return json({ recorded: false, reason: 'error' });
	}
}
