/**
 * BNJI.NET — public endpoint to record secret code usages.
 *
 *   POST /api/code/use -> 200 { ok: true }
 */
import { serverEnvironment } from '../../../server/env';
import { getSecretCodeStore } from '../../../server/secret-code-store';
import { clientIp } from '../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import type { APIContext } from 'astro';

export const prerender = false;

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 30;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export async function POST(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();
	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const limit = await rateLimit(kv, `code-use:${clientIp(context.request)}`, RATE_WINDOW_MS, RATE_MAX_HITS);
	if (!limit.allowed) {
		return json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429);
	}

	try {
		const payload: unknown = await context.request.json();
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			return json({ error: 'invalid_json' }, 400);
		}

		const rawCode = (payload as { code?: unknown }).code;
		if (typeof rawCode !== 'string' || !rawCode.trim()) {
			return json({ error: 'missing_code' }, 400);
		}

		const code = rawCode.trim().toLowerCase().replace(/\s+/g, ' ');
		if (code.length > 100) {
			return json({ error: 'code_too_long' }, 400);
		}

		const store = getSecretCodeStore(env);
		if (store) {
			await store.recordCodeUse(code, Date.now());
		}

		return json({ ok: true });
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}
}
