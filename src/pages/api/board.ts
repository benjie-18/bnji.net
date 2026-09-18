/**
 * BNJI.NET — public message board API boundary.
 *
 *   GET  /api/board?limit=N   newest-first messages, N clamped to pageSize
 *        /api/board?all=1     up to 200 messages (the "full list" view)
 *   POST /api/board           { text, image? } -> 201 { message }
 *
 * This endpoint is NOT prerendered: it runs in the Worker on every request so
 * it can read environment bindings (storage) and enforce rate limits.
 *
 * Safety contract for user-generated content:
 *   - text: trimmed, control characters stripped, hard length cap;
 *     rendered client-side via textContent only (never innerHTML);
 *   - image: accepted ONLY as a data: URL of an allowed MIME type under the
 *     size cap; re-validated here (never trust the client); stored as-is and
 *     rendered in an <img> with no scripting surface;
 *   - rate limit: one post per cooldown per client address, plus an hourly cap;
 *   - no credentials ever flow to the client; storage secrets live in env.
 */
import { BOARD_CONFIG } from '../../config/board.config';
import { getBoardStore, type BoardMessage } from '../../server/board-store';
import { rateLimit, retryAfterSeconds } from '../../server/ratelimit';
import { serverEnvironment } from '../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function clientKey(request: Request): string {
	const cf = (request as Request & { cf?: { connectingIp?: string } }).cf;
	return cf?.connectingIp ?? request.headers.get('cf-connecting-ip') ?? 'unknown';
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json',
			// Board data is never cached by the edge: visitors must see fresh
			// messages, and POST responses must not be replayed.
			'cache-control': 'no-store',
		},
	});
}

/** Re-validate an attached image data URL. Returns the URL or undefined. */
function sanitizeImage(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined;
	const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(value);
	if (!match) return undefined;
	if (!BOARD_CONFIG.allowedImageTypes.includes(match[1])) return undefined;
	// base64 length -> bytes (3/4 ratio), must fit the configured cap.
	const bytes = Math.floor((match[2].length * 3) / 4);
	if (bytes > BOARD_CONFIG.maxImageBytes) return undefined;
	return value;
}

export async function GET(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();
	const store = getBoardStore(env);

	const wantsAll = context.url.searchParams.get('all') === '1';
	const requested = Number(context.url.searchParams.get('limit') ?? BOARD_CONFIG.defaultVisible);
	const limit = wantsAll
		? 200
		: Math.min(Math.max(1, Number.isFinite(requested) ? requested : BOARD_CONFIG.defaultVisible), BOARD_CONFIG.pageSize);

	try {
		const messages = await store.list(limit);
		return json({ messages, provider: store.kind, limit });
	} catch (error) {
		console.error('[bnji] board list failed:', error);
		return json({ error: 'storage_unavailable', messages: [] }, 503);
	}
}

export async function POST(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();
	const store = getBoardStore(env);
	const key = clientKey(context.request);

	// Abuse protection: cooldown + hourly cap, per client address.
	if (!rateLimit(`board:post:${key}`, BOARD_CONFIG.postCooldownSeconds * 1000, 1)) {
		return json(
			{
				error: 'rate_limited',
				retryAfter: retryAfterSeconds(`board:post:${key}`, BOARD_CONFIG.postCooldownSeconds * 1000),
			},
			429,
		);
	}
	if (!rateLimit(`board:hour:${key}`, 3_600_000, 20)) {
		return json({ error: 'rate_limited', retryAfter: 60 }, 429);
	}

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}
	const body = (payload ?? {}) as { text?: unknown; image?: unknown };

	const text = typeof body.text === 'string' ? body.text.replace(CONTROL_CHARS, '').trim() : '';
	if (text.length === 0) return json({ error: 'empty_text' }, 422);
	if (text.length > BOARD_CONFIG.maxTextLength) {
		return json({ error: 'text_too_long', maxLength: BOARD_CONFIG.maxTextLength }, 422);
	}
	const image = sanitizeImage(body.image);

	const message: BoardMessage = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		text,
		...(image ? { image } : {}),
		// Stable tint seed, derived once so every visitor sees the same hue.
		hue: Math.floor(Math.random() * 360),
		createdAt: Date.now(),
	};

	try {
		await store.add(message);
		return json({ message, provider: store.kind }, 201);
	} catch (error) {
		console.error('[bnji] board add failed:', error);
		return json({ error: 'storage_unavailable' }, 503);
	}
}
