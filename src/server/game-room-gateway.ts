/** HTTP boundary for the private room namespace. Only this module derives trusted principals from player-context. */
import { sanitizeDisplayName } from './display-name';
import { readGuestProfile } from './guest-profile-store';
import type { PlayerContext } from './player-context';
import type { D1Database } from './game-store';

export type GameRoomNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type RoomEnv = { GAME_ROOMS?: GameRoomNamespace; BOARD_DB?: unknown };

export function roomPrincipal(player: PlayerContext): string {
	return player.playerId ? `player:${player.playerId}` : `guest:${player.sessionId}`;
}
export function roomNamespace(value: unknown): GameRoomNamespace | null {
	if (!value || typeof value !== 'object') return null;
	const namespace = value as GameRoomNamespace;
	return typeof namespace.idFromName === 'function' && typeof namespace.get === 'function' ? namespace : null;
}

/**
 * Current display label for the upgrade route (plan §4: the sanitizer is used
 * by the room upgrade route). Resolved server-side from the Phase A stores —
 * NOT client-supplied — then sanitised here and again in the DO. Failures fall
 * back to a generic label: the label is cosmetic and must never block a join.
 */
export async function resolveRoomChatLabel(env: Record<string, unknown>, player: PlayerContext): Promise<string> {
	const fallback = player.playerId ? 'Player' : 'Guest';
	const db = (env as RoomEnv).BOARD_DB;
	if (!db || typeof (db as D1Database).prepare !== 'function') return fallback;
	try {
		const raw = player.playerId
			? (await (db as D1Database).prepare('SELECT display_name FROM game_players WHERE id = ?1 LIMIT 1').bind(player.playerId).first<{ display_name: string }>())?.display_name
			: (await readGuestProfile(db as D1Database, player.sessionId))?.display_name;
		const sanitized = sanitizeDisplayName(raw ?? '');
		return sanitized.ok ? sanitized.name : fallback;
	} catch {
		return fallback;
	}
}

export async function roomServiceFetch(env: Record<string, unknown>, code: string, player: PlayerContext, path: '/create' | '/ws', init: {
	method: 'POST' | 'GET'; body?: string; request?: Request;
}): Promise<Response> {
	const namespace = roomNamespace((env as RoomEnv).GAME_ROOMS);
	if (!namespace) return new Response(JSON.stringify({ error: 'room_service_unavailable' }), { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
	const stub = namespace.get(namespace.idFromName(code));
	const headers = new Headers(init.request?.headers);
	headers.set('x-bnji-verified-principal', roomPrincipal(player));
	if (path === '/create') headers.set('content-type', 'application/json');
	if (path === '/ws') {
		// URL-encoded: HTTP headers are not a Unicode channel for names like 日本語.
		headers.set('x-bnji-chat-label', encodeURIComponent(await resolveRoomChatLabel(env, player)));
	}
	const request = path === '/ws' && init.request
		? new Request('https://game-room.internal/ws', { method: 'GET', headers })
		: new Request(`https://game-room.internal${path}`, { method: 'POST', headers, body: init.body ?? '{}' });
	return stub.fetch(request);
}
