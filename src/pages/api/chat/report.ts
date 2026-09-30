/**
 * BNJI.NET — chat plan Phase C: report a room-chat message.
 *
 *   POST /api/chat/report  { code, n }  ->  200 { reported: true, reportCount }
 *
 * Mirrors the board's proven flow (POST /api/board/report): a report does not
 * remove anything — it snapshots the message through the room DO (`/report`,
 * membership-authenticated) and persists the evidence to D1 `chat_reports`, so
 * moderation survives the room's ≤2 h expiry (plan §6.4).
 *
 * Abuse containment: a D1 per-IP budget (`game_auth_attempts`, prefix
 * bnji-chat-report:) plus distinct-reporter de-duplication keyed by the same
 * room principal membership already uses — no KV writes (the standing rule
 * keeps chat activity out of KV), no reporter identity beyond a one-way hash.
 */
import type { APIContext } from 'astro';
import { CHAT_CONFIG } from '../../../config/chat.config';
import { serverEnvironment } from '../../../server/env';
import { roomPrincipal, roomNamespace, roomServiceFetch } from '../../../server/game-room-gateway';
import { hasReporter, recordChatReport } from '../../../server/chat-moderation';
import { clientIp } from '../../../server/security-helpers';
import { readBodyTextBounded } from '../../../server/read-body';
import { reserveAuthAttempt, sha256Hex } from '../../../server/player-store';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext } from '../../../server/player-context';
import type { D1Database } from '../../../server/game-store';

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function allowedOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}
const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export async function POST(context: APIContext): Promise<Response> {
	if (!allowedOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	if (!CHAT_CONFIG.enabled) return json({ error: 'chat_disabled' }, 403);
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unconfigured' }, 503);
	let player;
	try { player = await resolvePlayerContext(context.request, db); }
	catch (error) {
		return json({ error: error instanceof PlayerContextStorageError ? 'storage_unavailable' : 'storage_unavailable' }, 503);
	}
	const finish = (data: unknown, status: number): Response => {
		const response = json(data, status);
		appendPlayerCookies(response.headers, player);
		return response;
	};

	const text = await readBodyTextBounded(context.request, 256);
	if (text === null) return finish({ error: 'payload_too_large' }, 413);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return finish({ error: 'invalid_json' }, 400); }
	const payload = body as Record<string, unknown>;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
		Object.keys(payload).length !== 2 ||
		typeof payload.code !== 'string' || !ROOM_CODE_PATTERN.test(payload.code) ||
		!Number.isSafeInteger(payload.n) || Number(payload.n) < 1) return finish({ error: 'invalid_payload' }, 400);
	const code = payload.code;
	const n = Number(payload.n);

	// D1 budget first: a flood of invalid reports must not reach the DO.
	try {
		const ipHash = await sha256Hex(`bnji-chat-report:${clientIp(context.request)}`);
		const budget = await reserveAuthAttempt(db, ipHash, Date.now(), {
			windowMs: CHAT_CONFIG.moderation.reportWindowMs,
			maxAttempts: CHAT_CONFIG.moderation.reportMaxPerWindow,
		});
		if (!budget.allowed) {
			const response = json({ error: 'rate_limited', retryAfter: budget.retryAfter }, 429);
			response.headers.set('retry-after', String(budget.retryAfter));
			appendPlayerCookies(response.headers, player);
			return response;
		}
	} catch { return finish({ error: 'storage_unavailable' }, 503); }

	if (!roomNamespace(env.GAME_ROOMS)) return finish({ error: 'room_service_unavailable' }, 503);
	const reporterHash = await sha256Hex(roomPrincipal(player));

	// Distinct-report counting: a repeat report is an idempotent no-op that
	// never inflates the count (plan §6.4, matching 0004_board_moderation).
	try {
		if (await hasReporter(db, code, n, reporterHash)) {
			const count = await db.prepare('SELECT report_count FROM chat_reports WHERE room_code = ?1 AND message_n = ?2')
				.bind(code, n).first<{ report_count: number }>();
			return finish({ reported: true, reportCount: Number(count?.report_count ?? 1), alreadyReported: true }, 200);
		}
	} catch { return finish({ error: 'storage_unavailable' }, 503); }

	let snapshotResponse: Response;
	try {
		snapshotResponse = await roomServiceFetch(env, code, player, '/report', {
			method: 'POST', body: JSON.stringify({ n }),
		});
	} catch { return finish({ error: 'room_service_unavailable' }, 503); }
	type Snapshot = { authorHash: string; label: string; text: string; messageAt: number; memberId: string | null };
	const snapshotBody = await snapshotResponse.json().catch(() => null) as { snapshot?: Snapshot; error?: string } | null;
	if (!snapshotResponse.ok || !snapshotBody?.snapshot) {
		const error = snapshotBody?.error || 'report_failed';
		const status = snapshotResponse.status === 404 ? 404 : snapshotResponse.status === 403 ? 403 : snapshotResponse.status === 410 ? 410 : 502;
		return finish({ error: error === 'room_authentication_required' ? 'report_failed' : error }, status);
	}

	try {
		const result = await recordChatReport(db, {
			code, n, snapshot: snapshotBody.snapshot, reporterHash,
		});
		return finish({ reported: true, reportCount: result.reportCount }, 200);
	} catch { return finish({ error: 'storage_unavailable' }, 503); }
}
