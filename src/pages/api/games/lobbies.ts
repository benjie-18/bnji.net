/**
 * Open-lobby listing: every live room a visitor may join, newest expiry first.
 * `GET /api/games/lobbies?gameId=bnji.chess` (or no gameId for all games).
 *
 * The room code is the entry ticket, so this response is the one place codes
 * become public — that is the feature. It is therefore `no-store`, rate-limited
 * per IP, never prerendered into HTML, and answered only from live probes: a
 * room that is full, gone, or slow is absent rather than listed and broken.
 */
import type { APIContext } from 'astro';
import { LOBBY_CONFIG } from '../../../config/lobby.config';
import { getGame } from '../../../data/games';
import { serverEnvironment } from '../../../server/env';
import { roomNamespace, roomServiceFetch } from '../../../server/game-room-gateway';
import { listOpenLobbies, lobbyCacheKey, readLobbyCache, writeLobbyCache } from '../../../server/game-lobby';
import { clientIp } from '../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import { appendPlayerCookies, resolvePlayerContext, type PlayerContext } from '../../../server/player-context';
import type { D1Database } from '../../../server/game-store';

export const prerender = false;

function json(data: unknown, status = 200, player?: PlayerContext): Response {
	const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'vary': 'Cookie' });
	if (player) appendPlayerCookies(headers, player);
	return new Response(JSON.stringify(data), { status, headers });
}

export async function GET(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	// No D1 means no registry, which means no list. Answer 503 rather than a 200
	// with an empty lobby, which a player reads as "nobody is online".
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unavailable' }, 503);
	let player: PlayerContext;
	try { player = await resolvePlayerContext(context.request, db); }
	catch { return json({ error: 'storage_unavailable' }, 503); }
	if (!LOBBY_CONFIG.enabled) return json({ error: 'lobby_disabled' }, 503, player);
	const namespace = roomNamespace(env.GAME_ROOMS);
	if (!namespace) return json({ error: 'room_service_unavailable' }, 503, player);

	const gameId = context.url.searchParams.get('gameId') ?? '';
	if (gameId && !getGame(gameId)) return json({ error: 'unknown_game' }, 404, player);

	const limit = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `game-lobby:${clientIp(context.request)}`, LOBBY_CONFIG.rate.windowMs, LOBBY_CONFIG.rate.requests);
	if (!limit.allowed) {
		const response = json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429, player);
		response.headers.set('retry-after', String(limit.retryAfter));
		return response;
	}

	const key = lobbyCacheKey(gameId);
	const now = Date.now();
	// One cached list per game, shared by every visitor: the payload carries only
	// joinability facts, which is why nothing per-player is in it to begin with.
	const cached = await readLobbyCache(env.BOARD_KV as KvRateLimitStore | undefined, key);
	if (cached) return json({ ...cached, cached: true }, 200, player);

	const list = await listOpenLobbies({
		db,
		gameId,
		now,
		probe: async (code) => {
			try {
				const response = await roomServiceFetch(env, code, player, '/lobby', { method: 'GET' });
				if (!response.ok) return null;
				return await response.json().catch(() => null);
			} catch {
				return null;
			}
		},
	});
	await writeLobbyCache(env.BOARD_KV as KvRateLimitStore | undefined, key, list, LOBBY_CONFIG.cacheTtlSeconds);
	return json({ ...list, cached: false }, 200, player);
}
