/**
 * Authenticated upgrade boundary for a GameRoom Durable Object. Joining needs a
 * principal (every visitor has one, guests included), a free seat and the code —
 * no host approval, because rooms are listed for anyone in
 * `src/pages/api/games/lobbies.ts`.
 */
import type { APIContext } from 'astro';
import { serverEnvironment } from '../../../../../server/env';
import type { D1Database } from '../../../../../server/game-store';
import { roomNamespace, roomPrincipal, roomServiceFetch } from '../../../../../server/game-room-gateway';
import { clientIp } from '../../../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../../../server/ratelimit';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext } from '../../../../../server/player-context';
import { sha256Hex } from '../../../../../server/player-store';
import { CHAT_CONFIG } from '../../../../../config/chat.config';
import { activeChatBan } from '../../../../../server/chat-moderation';

export const prerender = false;
function json(data: unknown, status = 400): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function allowedOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}

export async function GET(context: APIContext): Promise<Response> {
	if (!allowedOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	if (context.request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
	const code = context.params.roomCode ?? '';
	if (!/^[A-Za-z0-9_-]{22}$/.test(code)) return json({ error: 'invalid_room_code' }, 400);
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	let player: Awaited<ReturnType<typeof resolvePlayerContext>>;
	try { player = await resolvePlayerContext(context.request, db); }
	catch (error) { return json({ error: error instanceof PlayerContextStorageError ? 'storage_unavailable' : 'storage_unavailable' }, 503); }
	if (!roomNamespace(env.GAME_ROOMS)) {
		const response = json({ error: 'room_service_unavailable' }, 503); appendPlayerCookies(response.headers, player); return response;
	}
	const limit = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `game-room-join:${clientIp(context.request)}`, 60_000, 12);
	if (!limit.allowed) {
		const response = json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429);
		response.headers.set('retry-after', String(limit.retryAfter)); appendPlayerCookies(response.headers, player); return response;
	}
	// Phase C: cross-room chat ban (plan §6.2 "ban the principal for a
	// period"). Checked here so a banned principal never reaches the room;
	// the kill switch covers it — chat disabled means no ban gate.
	if (CHAT_CONFIG.enabled && db) {
		try {
			const bannedUntil = await activeChatBan(db, await sha256Hex(roomPrincipal(player)), Date.now());
			if (bannedUntil) {
				const response = json({ error: 'chat_banned', retryAfterMs: Math.max(1_000, bannedUntil - Date.now()) }, 403);
				appendPlayerCookies(response.headers, player); return response;
			}
		} catch { /* D1 blip: joining is not blocked by a failed ban lookup */ }
	}
	try {
		const response = await roomServiceFetch(env, code, player, '/ws', { method: 'GET', request: context.request });
		if (response.status !== 101) appendPlayerCookies(response.headers, player);
		return response;
	} catch {
		const response = json({ error: 'room_service_unavailable' }, 503); appendPlayerCookies(response.headers, player); return response;
	}
}
