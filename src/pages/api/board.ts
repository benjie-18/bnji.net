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
 *
 * Security logging
 * -----------------
 * Two of this route's actions are logged to security_events, the same table
 * the profile surfaces use, tagged surface='board':
 *
 *   board-view   the FIRST page load of a visit — not every poll. The poller
 *                re-fetches every 20s while the tab is visible, so logging
 *                GETs wholesale would write ~180 rows per visitor-hour and
 *                bury the POST events that actually matter under read noise.
 *                The client opts in with `?track=1` on its initial load only.
 *   board-post   every accepted post, carrying target_id = the message id, so
 *                an admin can jump from a spam message straight to who sent it.
 *
 * board-report is logged by its own route (POST /api/board/report).
 *
 * Every logged action also establishes the shared session cookie, which is
 * what lets the client report device details a second or two later (see
 * /api/admin/../profile/security/enrich — one enrichment endpoint, both
 * surfaces).
 */
import { BOARD_CONFIG } from '../../config/board.config';
import {
	decodeCursor,
	getBoardStore,
	type BoardMessage,
} from '../../server/board-store';
import { getSecurityStore } from '../../server/security-store';
import { buildSecurityEvent, clientIp } from '../../server/security-helpers';
import { generateSessionKey, readSessionKey, sessionCookieHeader } from '../../config/session.config';
import { rateLimit, type KvRateLimitStore } from '../../server/ratelimit';
import { serverEnvironment } from '../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json',
			// Board data is never cached by the edge: visitors must see fresh
			// messages, and POST responses must not be replayed.
			'cache-control': 'no-store',
			...extraHeaders,
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
/**
 * Validate an attached image and explain any refusal.
 *
 * Returns the data URL to store, or a `reason` the route can hand back to
 * the client. The size cap is checked BEFORE the MIME allow-list is
 * consulted for the stored value, but the cap is only reached for a
 * well-formed PNG/JPEG/WebP/GIF — an oversized file of some other type is
 * still reported as a bad type, which is the more useful message.
 *
 * The byte count is derived from the base64 LENGTH (3/4 of it), not from a
 * decode, so validating a large attachment costs nothing: the string is
 * never turned back into bytes, let alone decoded as an image.
 */
function inspectImage(value: unknown): {
	value?: string;
	reason?: 'image_too_large' | 'image_unsupported';
} {
	if (typeof value !== 'string' || value.length === 0) return {};

	// Cap the regex work: a legitimate attachment is already near the base64
	// expansion of BOARD_CONFIG.maxImageBytes, plus the data-URL prefix.
	const maxEncoded = Math.ceil((BOARD_CONFIG.maxImageBytes * 4) / 3) + 64;
	if (value.length > maxEncoded) {
		return { reason: 'image_too_large' };
	}

	const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(value);
	if (!match) return { reason: 'image_unsupported' };
	if (!BOARD_CONFIG.allowedImageTypes.includes(match[1])) return { reason: 'image_unsupported' };

	// base64 length -> bytes (3/4 ratio), must fit the configured cap.
	//
	// The padding has to come off, or the count runs 1-2 bytes high. A file of
	// exactly maxImageBytes encodes to a length whose naive 3/4 product is
	// maxImageBytes + 1, so the file the client's own check accepts (file.size
	// <= max) would be rejected here as too large — the two halves disagreeing
	// at exactly the limit the copy promises.
	const encoded = match[2];
	const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
	const bytes = (encoded.length * 3) / 4 - padding;
	if (bytes > BOARD_CONFIG.maxImageBytes) return { reason: 'image_too_large' };

	return { value };
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

		// Opt-in security logging, on the FIRST page load of a visit only.
		// The client sends ?track=1 for that request and never for its polls,
		// so a long-lived tab does not turn into hundreds of read events.
		//
		// It also establishes the session cookie, which is what lets the
		// client report device details a beat later. Fire-and-forget: never
		// block the list response on telemetry.
		const track = context.url.searchParams.get('track') === '1';
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			etag,
		};
		if (track) {
			const secStore = getSecurityStore(env);
			if (secStore) {
				const existing = readSessionKey(context.request);
				const sessionKey = existing ?? generateSessionKey();
				if (!existing) headers['set-cookie'] = sessionCookieHeader(sessionKey);
				void buildSecurityEvent(context.request, {
					surface: 'board',
					endpoint: 'board-view',
					sessionKey,
				})
					.then((event) => secStore.recordEvent(event))
					.catch(() => {});
			}
		}

		if (etagMatches(context.request.headers.get('if-none-match'), etag)) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(body, { status: 200, headers });
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
	const key = clientIp(context.request);

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
	// Image validation. sanitizeImage() drops anything it will not accept
	// (wrong shape, wrong MIME, or over the byte cap) and says nothing, so
	// the caller learns only that the post was accepted WITHOUT the image —
	// which reads as "my upload worked". A rejected attachment is a mistake
	// the visitor can fix, so the failure is named and sized for them.
	const imageCheck = inspectImage(body.image);
	if (imageCheck.reason) {
		return json(
			{
				error: imageCheck.reason,
				maxBytes: BOARD_CONFIG.maxImageBytes,
			},
			422,
		);
	}
	const image = imageCheck.value;

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

		// Security logging: every accepted post, tagged with the message id so
		// an admin can go from a spam message to its author in one step.
		// Establishes the session cookie if this is the visitor's first action
		// on the board, which is what the client's device-detail beacon
		// correlates against.
		const secStore = getSecurityStore(env);
		const headers: Record<string, string> = {};
		if (secStore) {
			const existing = readSessionKey(context.request);
			const sessionKey = existing ?? generateSessionKey();
			if (!existing) headers['set-cookie'] = sessionCookieHeader(sessionKey);
			void buildSecurityEvent(context.request, {
				surface: 'board',
				endpoint: 'board-post',
				targetId: message.id,
				sessionKey,
			})
				.then((event) => secStore.recordEvent(event))
				.catch(() => {});
		}

		return json({ message: publicMessage, provider: store.kind }, 201, headers);
	} catch (error) {
		console.error('[bnji] board add failed:', error);
		return json({ error: 'storage_unavailable' }, 503);
	}
}
