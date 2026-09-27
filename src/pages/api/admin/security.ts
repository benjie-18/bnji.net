/**
 * BNJI.NET — admin security events endpoint.
 *
 *   GET /api/admin/security?limit=50
 *   Authorization: Bearer <ACCESS_TOKEN>
 *
 * Returns recent security events (newest first) from the security_events
 * table. Requires the ACCESS_TOKEN environment variable to be set and
 * a matching Bearer token in the Authorization header.
 *
 * ⚠️ STOPGAP AUTH — this is NOT a real admin system. It relies on a
 * single shared secret (ACCESS_TOKEN) and does not implement session
 * management, CSRF protection, or role-based access. It is intended
 * as the smallest workable gate until a proper admin surface is built
 * (see src/server/access.ts for the existing auth primitives).
 *
 * If ACCESS_TOKEN is not configured, this endpoint returns 503.
 *
 * SECURITY: the response contains IP addresses and user-agent strings
 * which are personal information under Quebec Law 25 and PIPEDA. This
 * endpoint must never be accessible without authentication.
 *
 * Retention: the store triggers lazy cleanup of rows older than 60 days
 * when the row count exceeds 5000.
 */
import { getSecurityStore } from '../../../server/security-store';
import { secretEnv } from '../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		},
	});
}

export async function GET(context: APIContext): Promise<Response> {
	const env = secretEnv();
	const token = env.ACCESS_TOKEN;
	if (!token) {
		return json({ error: 'admin_not_configured' }, 503);
	}

	// Authenticate: require Bearer token matching ACCESS_TOKEN.
	const header = context.request.headers.get('authorization') ?? '';
	const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
	if (!bearer || bearer.length < 8) {
		return json({ error: 'unauthorized' }, 401);
	}

	// Constant-time comparison.
	if (bearer.length !== token.length) {
		return json({ error: 'unauthorized' }, 401);
	}
	let diff = 0;
	for (let i = 0; i < bearer.length; i++) {
		diff |= bearer.charCodeAt(i) ^ token.charCodeAt(i);
	}
	if (diff !== 0) {
		return json({ error: 'unauthorized' }, 401);
	}

	// Resolve the store.
	const bindings = await (async () => {
		try {
			const mod = (await import(/* @vite-ignore */ 'cloudflare:workers')) as unknown as {
				env?: Record<string, unknown>;
			};
			return mod.env ?? {};
		} catch {
			return {};
		}
	})();
	const fullEnv = { ...bindings, ...env };
	const store = getSecurityStore(fullEnv);
	if (!store) {
		return json({ error: 'storage_unavailable' }, 503);
	}

	const limitParam = context.url.searchParams.get('limit');
	const limit = Math.min(Math.max(1, Number(limitParam) || 50), 500);

	try {
		// Sequential, not Promise.all: listRecent triggers the lazy retention
		// purge, so the count must be read AFTER it or the response reports a
		// stale total on exactly the read that deleted rows.
		const events = await store.listRecent(limit);
		const total = await store.countEvents();
		return json({ events, total, retentionDays: 60 });
	} catch (error) {
		console.warn('[bnji] admin security query failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}