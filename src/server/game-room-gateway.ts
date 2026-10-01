/** HTTP boundary for the private room namespace. Only this module derives trusted principals from player-context. */
import { sanitizeDisplayName } from './display-name';
import { readGuestProfile } from './guest-profile-store';
import type { PlayerContext } from './player-context';
import type { D1Database } from './game-store';
import { ROOM_ADMIN_HEADER, roomAdminServiceToken } from './game-room-protocol';

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

/**
 * Forward to one room's DO. Only `/ws` carries client headers (the upgrade
 * header must survive); every other path builds fresh headers so a visitor
 * can never ride along a trusted value (`x-bnji-verified-principal`, the
 * Phase C service token). Admin paths derive the token from ACCESS_SECRET —
 * absent secret, absent admin room access (fail closed, plan §6.2).
 */
export async function roomServiceFetch(env: Record<string, unknown>, code: string, player: PlayerContext, path: '/create' | '/ws' | '/report', init: {
	method: 'POST' | 'GET'; body?: string; request?: Request;
}): Promise<Response>;
export async function roomServiceFetch(env: Record<string, unknown>, code: string, player: null, path: '/admin/read' | '/admin/action', init: {
	method: 'POST' | 'GET'; body?: string; request?: Request;
}): Promise<Response>;
export async function roomServiceFetch(env: Record<string, unknown>, code: string, player: PlayerContext | null, path: '/create' | '/ws' | '/report' | '/admin/read' | '/admin/action', init: {
	method: 'POST' | 'GET'; body?: string; request?: Request;
}): Promise<Response> {
	const unavailable = (error: string, status: number): Response => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
	const namespace = roomNamespace((env as RoomEnv).GAME_ROOMS);
	if (!namespace) return unavailable('room_service_unavailable', 503);
	const stub = namespace.get(namespace.idFromName(code));
	if (path === '/ws') {
		if (!player) return unavailable('room_service_unavailable', 503);
		const headers = new Headers(init.request?.headers);
		headers.set('x-bnji-verified-principal', roomPrincipal(player));
		// URL-encoded: HTTP headers are not a Unicode channel for names like 日本語.
		headers.set('x-bnji-chat-label', encodeURIComponent(await resolveRoomChatLabel(env, player)));
		return stub.fetch(new Request('https://game-room.internal/ws', { method: 'GET', headers }));
	}
	const headers = new Headers({ 'content-type': 'application/json' });
	if (path === '/admin/read' || path === '/admin/action') {
		const token = await roomAdminServiceToken(typeof env.ACCESS_SECRET === 'string' ? env.ACCESS_SECRET : undefined);
		if (!token) return unavailable('admin_service_unconfigured', 503);
		headers.set(ROOM_ADMIN_HEADER, token);
	} else {
		if (!player) return unavailable('room_service_unavailable', 503);
		headers.set('x-bnji-verified-principal', roomPrincipal(player));
	}
	return stub.fetch(new Request(`https://game-room.internal${path}`, { method: 'POST', headers, body: init.body ?? '{}' }));
}
