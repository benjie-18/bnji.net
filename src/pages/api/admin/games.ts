/** Admin-only private game usage and score summary. */
import type { APIContext } from 'astro';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../server/admin';
import { readGameAdminData, type D1Database } from '../../../server/game-store';
import { readPlayerAdminSummary } from '../../../server/player-store';
import { serverEnvironment } from '../../../server/env';
import { clientIp } from '../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';

export const prerender = false;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 30;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();
	const env = await serverEnvironment();
	const limit = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `admin:games:${clientIp(context.request)}`, RATE_WINDOW_MS, RATE_MAX_HITS);
	if (!limit.allowed) return json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429);
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unavailable' }, 503);
	try {
		const [games, identity] = await Promise.all([readGameAdminData(db), readPlayerAdminSummary(db)]);
		return json({ ...games, identity });
	} catch {
		return json({ error: 'query_failed' }, 503);
	}
}
