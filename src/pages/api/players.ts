/**
 * Exact-match handle lookup (chat plan Phase A, §4 and §10).
 *
 *   GET /api/players?handle=some_name →
 *       { found: true,  handle, displayName }  — exists
 *       { found: false }                       — unknown (200, not 404: the
 *         whole point of the endpoint is existence checks, and a 404-vs-200
 *         split would be indistinguishable anyway)
 *
 * The response carries ONLY the two public labels — never a player id, never
 * a session reference (plan D8: "never internal IDs"). Per-IP D1 window
 * (game_auth_attempts, prefixed hash) throttles enumeration; validation
 * failure returns before spending budget.
 */
import type { APIContext } from 'astro';
import { NAMES_CONFIG } from '../../config/names.config';
import { serverEnvironment } from '../../server/env';
import { isValidHandle } from '../../server/display-name';
import { findPlayerByHandle, reserveAuthAttempt, sha256Hex } from '../../server/player-store';
import { clientIp } from '../../server/security-helpers';
import type { D1Database } from '../../server/game-store';

export const prerender = false;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: new Headers(JSON_HEADERS) });
}
function dbBinding(value: unknown): D1Database | null {
	return value && typeof (value as D1Database).prepare === 'function' ? value as D1Database : null;
}

export async function GET(context: APIContext): Promise<Response> {
	const handle = (new URL(context.request.url).searchParams.get('handle') ?? '').trim().toLowerCase();
	if (!isValidHandle(handle)) return json({ error: 'invalid_handle' }, 400);
	const env = await serverEnvironment();
	const db = dbBinding(env.BOARD_DB);
	if (!db) return json({ error: 'storage_unavailable' }, 503);
	const now = Date.now();
	try {
		const ipHash = await sha256Hex(`bnji-handle-search:${clientIp(context.request)}`);
		const attempt = await reserveAuthAttempt(db, ipHash, now, {
			windowMs: NAMES_CONFIG.limits.handleAttemptWindowMs,
			maxAttempts: NAMES_CONFIG.limits.handleAttemptMax,
		});
		if (!attempt.allowed) {
			const response = json({ error: 'rate_limited', retryAfter: attempt.retryAfter }, 429);
			response.headers.set('retry-after', String(attempt.retryAfter));
			return response;
		}
	} catch { return json({ error: 'storage_unavailable' }, 503); }
	try {
		const match = await findPlayerByHandle(db, handle);
		return json(match ? { found: true, handle: match.handle, displayName: match.display_name } : { found: false });
	} catch {
		return json({ error: 'storage_unavailable' }, 503);
	}
}
