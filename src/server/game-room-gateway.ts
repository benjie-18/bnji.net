/** HTTP boundary for the private room namespace. Only this module derives trusted principals from player-context. */
import type { PlayerContext } from './player-context';

export type GameRoomNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type RoomEnv = { GAME_ROOMS?: GameRoomNamespace };

export function roomPrincipal(player: PlayerContext): string {
	return player.playerId ? `player:${player.playerId}` : `guest:${player.sessionId}`;
}
export function roomNamespace(value: unknown): GameRoomNamespace | null {
	if (!value || typeof value !== 'object') return null;
	const namespace = value as GameRoomNamespace;
	return typeof namespace.idFromName === 'function' && typeof namespace.get === 'function' ? namespace : null;
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
	const request = path === '/ws' && init.request
		? new Request('https://game-room.internal/ws', { method: 'GET', headers })
		: new Request(`https://game-room.internal${path}`, { method: 'POST', headers, body: init.body ?? '{}' });
	return stub.fetch(request);
}
