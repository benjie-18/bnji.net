/**
 * BNJI.NET — message board report endpoint.
 *
 *   POST /api/board/report  { id }  ->  200 { reported: true, reportCount }
 *
 * Lets a visitor flag a message for moderator attention. A report does NOT
 * remove the message: `reported` is still a public status, so a single
 * grudge cannot censor the board. The message leaves public view only when a
 * moderator sets it to hidden or deleted.
 *
 * What a report does record:
 *   - report_count on the message, de-duplicated per session
 *   - reported_at, the most recent report time
 *   - a security_event (surface='board', endpoint='board-report', target_id =
 *     the message id) with the reporter's request metadata
 *
 * What it deliberately does NOT record: the reporter's identity. The
 * de-duplication key is the ephemeral session cookie (or, for a caller with
 * no cookie, a digest of their address) — neither can be traced back to a
 * person, and neither is readable as "who disliked what". An attribution
 * list would be personal data with no investigative value beyond the count.
 *
 * Abusive callers are contained by a KV rate limit (per IP) plus
 * de-duplication on the reporter's key — the session cookie, or a digest of
 * the client address when there is no cookie. So a caller cannot inflate
 * report_count by retrying, and cannot escape de-duplication by clearing
 * their cookie either.
 *
 * Anti-farming note: a session can report every message on the board, but
 * each (message, session) pair counts once and the hourly cap bounds total
 * volume — so a coordinated ring of N sessions is visible as N distinct
 * fingerprints in security_events, which is the signal an admin acts on.
 */
import { getBoardStore } from '../../../server/board-store';
import { getSecurityStore } from '../../../server/security-store';
import { buildSecurityEvent, clientIp } from '../../../server/security-helpers';
import { readSessionKey } from '../../../config/session.config';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import { serverEnvironment } from '../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const MAX_ID_LENGTH = 64;
const REPORT_RATE_WINDOW_MS = 10 * 60_000;
const REPORT_RATE_MAX = 10;

/**
 * The de-duplication key for one reporter.
 *
 * Normally the session cookie, which is a random per-visit value that cannot
 * be traced across sessions or devices.
 *
 * When the caller has no cookie, fall back to a digest of the client address
 * instead of minting a fresh random key. Minting one per request looks like
 * de-duplication and is not: a caller who omits (or clears) the cookie would
 * get a brand-new key every time and every one of their reports would count,
 * which is precisely the inflation the table exists to prevent. The address
 * is already recorded — in raw form — on the security_event for this report,
 * so digesting it here adds no personal data, and the key lives in a table
 * with no attribution beyond the count.
 *
 * The fallback is deliberately not a cookie: deriving the session key from
 * the address would make it shared by everyone behind one NAT, breaking the
 * per-visitor meaning the session key has everywhere else. A cookieless
 * reporter therefore stays cookieless, and de-duplicates by address.
 */
async function reporterKey(request: Request): Promise<string> {
	const sessionKey = readSessionKey(request);
	if (sessionKey) return sessionKey;
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`board-report:${clientIp(request)}`),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 32);
}

export async function POST(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();
	const store = getBoardStore(env);
	if (!store) {
		return Response.json({ error: 'storage_unconfigured' }, { status: 503 });
	}

	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const limit = await rateLimit(
		kv,
		`board:report:${clientIp(context.request)}`,
		REPORT_RATE_WINDOW_MS,
		REPORT_RATE_MAX,
	);
	if (!limit.allowed) {
		return Response.json(
			{ error: 'rate_limited', retryAfter: limit.retryAfter },
			{ status: 429, headers: { 'cache-control': 'no-store' } },
		);
	}

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 });
	}

	const id = (payload as { id?: unknown } | null)?.id;
	if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
		return Response.json({ error: 'invalid_id' }, { status: 400 });
	}

	// A report against an already-moderated message is a no-op, not an error:
	// the visitor's intent (flag this) is satisfied either way, and refusing
	// would leak moderation state back to the public.
	const sessionKey = readSessionKey(context.request);
	const key = await reporterKey(context.request);
	const headers: Record<string, string> = { 'cache-control': 'no-store' };

	try {
		const reportCount = await store.recordReport(id, key, Date.now());
		if (reportCount === null) {
			// Unknown message id. 404 rather than 422 so a client cannot use
			// this endpoint to probe which message ids exist.
			return Response.json({ error: 'not_found' }, { status: 404, headers });
		}

		// Security logging: who flagged what, from where. Fire-and-forget so
		// a D1 hiccup can never fail a visitor's report.
		const secStore = getSecurityStore(env);
		if (secStore) {
			void buildSecurityEvent(context.request, {
				surface: 'board',
				endpoint: 'board-report',
				targetId: id,
				sessionKey: sessionKey ?? undefined,
			})
				.then((event) => secStore.recordEvent(event))
				.catch(() => {});
		}

		return Response.json(
			{ reported: true, reportCount },
			{ status: 200, headers: { 'content-type': 'application/json', ...headers } },
		);
	} catch (error) {
		console.error('[bnji] board report failed:', error);
		return Response.json({ error: 'storage_unavailable' }, { status: 503, headers });
	}
}
