/** Create a short-lived private room. Room state is generic opaque synchronization, never game-rule authority. */
import type { APIContext } from 'astro';
import { getGame } from '../../../data/games';
import { serverEnvironment } from '../../../server/env';
import { roomNamespace, roomPrincipal, roomServiceFetch } from '../../../server/game-room-gateway';
import { clientIp } from '../../../server/security-helpers';
import { readBodyTextBounded } from '../../../server/read-body';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import type { D1Database } from '../../../server/game-store';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext } from '../../../server/player-context';
import { sha256Hex } from '../../../server/player-store';

export const prerender = false;
function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function randomRoomCode(): string {
	const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function allowedOrigin(request: Request): boolean { return request.headers.get('origin') === new URL(request.url).origin; }

export async function POST(context: APIContext): Promise<Response> {
	if (!allowedOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	let player;
	try { player = await resolvePlayerContext(context.request, db); }
	catch (error) {
		return json({ error: error instanceof PlayerContextStorageError ? 'storage_unavailable' : 'storage_unavailable' }, 503);
	}
	if (!roomNamespace(env.GAME_ROOMS)) {
		const response = json({ error: 'room_service_unavailable' }, 503); appendPlayerCookies(response.headers, player); return response;
	}
	const text = await readBodyTextBounded(context.request, 512);
	if (text === null) { const response = json({ error: 'payload_too_large' }, 413); appendPlayerCookies(response.headers, player); return response; }
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { const response = json({ error: 'invalid_json' }, 400); appendPlayerCookies(response.headers, player); return response; }
	if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'gameId') || typeof (body as Record<string, unknown>).gameId !== 'string') {
		const response = json({ error: 'invalid_payload' }, 400); appendPlayerCookies(response.headers, player); return response;
	}
	const gameId = (body as { gameId: string }).gameId;
	if (!getGame(gameId)) { const response = json({ error: 'unknown_game' }, 404); appendPlayerCookies(response.headers, player); return response; }
	const limit = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `game-room-create:${clientIp(context.request)}`, 60_000, 3);
	if (!limit.allowed) {
		const response = json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429);
		response.headers.set('retry-after', String(limit.retryAfter)); appendPlayerCookies(response.headers, player); return response;
	}
	const code = randomRoomCode();
	try {
		const internal = await roomServiceFetch(env, code, player, '/create', {
			method: 'POST', body: JSON.stringify({ gameId, now: Date.now() }), request: context.request,
		});
		const data = await internal.json().catch(() => ({ error: 'room_service_unavailable' })) as Record<string, unknown>;
		if (internal.ok) {
			// Phase C room registry (plan §6.1): best-effort — a failed insert
			// never fails an already-created room, it only hides it from /admin.
			const ownerHash = await sha256Hex(roomPrincipal(player));
			const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : Date.now();
			try {
				await db?.prepare('INSERT OR IGNORE INTO room_registry (code, game_id, owner_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
					.bind(code, gameId, ownerHash, Date.now(), expiresAt).run();
			} catch { /* registry is an admin aid, not the room of record */ }
		}
		const response = json(internal.ok ? { roomCode: code, gameId, expiresAt: data.expiresAt, capacity: data.capacity, protocolVersion: 1 } : data, internal.status);
		appendPlayerCookies(response.headers, player);
		return response;
	} catch {
		const response = json({ error: 'room_service_unavailable' }, 503); appendPlayerCookies(response.headers, player); return response;
	}
}
