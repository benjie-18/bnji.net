/**
 * BNJI.NET — public message board API boundary.
 *
 *   GET  /api/board?limit=N[&cursor=C]
 *        newest-first page of PUBLIC messages (visible/reported only),
 *        N clamped to BOARD_CONFIG.pageSize. Response carries `nextCursor`
 *        for the next (older) page, or null when exhausted.
 *   GET  /api/board?all=1[&cursor=C]
 *        archive first page (up to archivePageSize) and cursor walking —
 *        same contract, bigger page.
 *   Every GET list response carries a weak ETag; a matching If-None-Match
 *   answers 304 with no body, which is what the board page's poller uses.
 *   POST /api/board  { text, image? } -> 201 { message }
 *
 * Cursor pagination is KEYSET, not offset/page-number: the cursor encodes the
 * (createdAt, id) seek position, so pages are stable under concurrent inserts
 * and cost one indexed range query regardless of depth.
 *
 * NOT prerendered: runs in the Worker so it can read bindings (BOARD_DB,
 * BOARD_KV) and enforce limits. Storage is D1 (see src/server/board-store.ts);
 * an unconfigured store answers 503 storage_unconfigured — there is no
 * in-memory production fallback.
 *
 * Safety contract for user-generated content:
 *   - text: trimmed, control characters stripped, hard 250-char cap enforced
 *     HERE with a 422 rejection (never truncation);
 *   - image: accepted ONLY as a data: URL of an allowed MIME type under the
 *     size cap, re-validated server-side;
 *   - rate limit: KV-backed fixed windows (per client address), shared across
 *     isolates: 1 post per cooldown + hourly cap;
 *   - moderation: hidden/deleted messages are filtered in SQL and can never
 *     appear in any public response; the moderation status itself is stripped
 *     from public payloads;
 *   - no credentials ever flow to the client.
 */
import { BOARD_CONFIG } from '../../config/board.config';
import {
	decodeCursor,
	getBoardStore,
	type BoardMessage,
} from '../../server/board-store';
import { rateLimit, type KvRateLimitStore } from '../../server/ratelimit';
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

/**
 * Weak ETag over a JSON payload (SHA-256, truncated) + If-None-Match match.
 * Lets the board's poller ask "anything new?" with a conditional request:
 * unchanged pages answer 304 with no body. `no-store` stays — conditional
 * revalidation is client-driven, not a cache.
 */
async function etagFor(body: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
	return `W/"${hex}"`;
}

/** RFC 9110 weak comparison: strip the W/ prefix and compare opaque tags. */
function etagMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const opaque = etag.replace(/^W\//, '');
	return header
		.split(',')
		.some((candidate) => candidate.trim().replace(/^W\//, '') === opaque);
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
	if (!store) return json({ error: 'storage_unconfigured', messages: [] }, 503);

	const wantsAll = context.url.searchParams.get('all') === '1';
	const cap = wantsAll ? BOARD_CONFIG.archivePageSize : BOARD_CONFIG.pageSize;
	const limitParam = context.url.searchParams.get('limit');
	// Legacy contract: ?all=1 without an explicit limit asks for the whole
	// archive (first cursor page at archivePageSize), not defaultVisible.
	const fallback = wantsAll ? BOARD_CONFIG.archivePageSize : BOARD_CONFIG.defaultVisible;
	const requested = Number(limitParam ?? fallback);
	const limit = Math.min(Math.max(1, Number.isFinite(requested) ? requested : fallback), cap);

	const cursorParam = context.url.searchParams.get('cursor');
	let cursor: string | undefined;
	if (cursorParam) {
		if (!decodeCursor(cursorParam)) return json({ error: 'invalid_cursor' }, 400);
		cursor = cursorParam;
	}

	try {
		const page = await store.listPublic({ limit, cursor });
		const body = JSON.stringify({ ...page, provider: store.kind, limit });
		const etag = await etagFor(body);
		if (etagMatches(context.request.headers.get('if-none-match'), etag)) {
			return new Response(null, {
				status: 304,
				headers: { etag, 'cache-control': 'no-store' },
			});
		}
		return new Response(body, {
			status: 200,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store', etag },
		});
	} catch (error) {
		console.error('[bnji] board list failed:', error);
		return json({ error: 'storage_unavailable', messages: [], nextCursor: null }, 503);
	}
}

export async function POST(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();
	const store = getBoardStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const key = clientKey(context.request);

	// Abuse protection: KV-backed windows, shared across isolates.
	const cooldown = await rateLimit(
		kv,
		`board:post:${key}`,
		BOARD_CONFIG.postCooldownSeconds * 1000,
		1,
	);
	if (!cooldown.allowed) {
		return json({ error: 'rate_limited', retryAfter: cooldown.retryAfter }, 429);
	}
	const hourly = await rateLimit(kv, `board:hour:${key}`, 3_600_000, BOARD_CONFIG.hourlyPostLimit);
	if (!hourly.allowed) {
		return json({ error: 'rate_limited', retryAfter: hourly.retryAfter }, 429);
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
	// Server-side body cap: reject, never truncate.
	if (text.length > BOARD_CONFIG.maxTextLength) {
		return json(
			{
				error: 'text_too_long',
				maxLength: BOARD_CONFIG.maxTextLength,
				length: text.length,
			},
			422,
		);
	}
	const image = sanitizeImage(body.image);

	const message: BoardMessage = {
		id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		text,
		...(image ? { image } : {}),
		// Stable tint seed, derived once so every visitor sees the same hue.
		hue: Math.floor(Math.random() * 360),
		// New posts enter moderation as visible; flips happen server-side only.
		status: 'visible',
		createdAt: Date.now(),
	};

	try {
		await store.add(message);
		const { status: _status, ...publicMessage } = message;
		return json({ message: publicMessage, provider: store.kind }, 201);
	} catch (error) {
		console.error('[bnji] board add failed:', error);
		return json({ error: 'storage_unavailable' }, 503);
	}
}
