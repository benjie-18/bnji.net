/**
 * BNJI.NET — chat plan Phase D: the HTTP boundary for the DMConversation
 * Durable Object namespace (mirrors src/server/game-room-gateway.ts).
 *
 * Only this module turns player context into trusted DO headers. `/ws` is the
 * only path that carries client-derived headers (the upgrade must survive);
 * `/push` builds fresh headers so a browser can never ride along a trusted
 * value — and a browser cannot address the DO at all without going through
 * the DM routes.
 */
import type { PlayerContext } from './player-context';
import type { DmSide } from './dm-protocol';

export type DmNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type DmGatewayEnv = { DM_CONVERSATIONS?: DmNamespace };

export function dmNamespace(value: unknown): DmNamespace | null {
	if (!value || typeof value !== 'object') return null;
	const namespace = value as DmNamespace;
	return typeof namespace.idFromName === 'function' && typeof namespace.get === 'function' ? namespace : null;
}

export async function dmServiceFetch(
	env: Record<string, unknown>,
	conversationId: string,
	init:
		| { path: '/ws'; player: PlayerContext; side: DmSide; request: Request }
		| { path: '/push'; frame: unknown },
): Promise<Response> {
	const unavailable = (error: string, status: number): Response =>
		new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
	const namespace = dmNamespace((env as DmGatewayEnv).DM_CONVERSATIONS);
	if (!namespace) return unavailable('dm_service_unavailable', 503);
	const stub = namespace.get(namespace.idFromName(conversationId));
	if (init.path === '/push') {
		return stub.fetch(new Request('https://dm-conversation.internal/push', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ frame: init.frame }),
		}));
	}
	// Upgrade: preserve the client's headers (Connection/Upgrade must survive),
	// then set the trusted identity the DO re-validates by shape.
	const headers = new Headers(init.request.headers);
	headers.set('x-bnji-verified-principal', `player:${init.player.playerId ?? ''}`);
	headers.set('x-bnji-dm-side', init.side);
	return stub.fetch(new Request('https://dm-conversation.internal/ws', { method: 'GET', headers }));
}

/**
 * Best-effort live fanout AFTER the durable D1 write (plan §7.3 order).
 * A failed push never fails the send — the recipient catches up over REST
 * (§7.3's reconnect pull) exactly as if they had been offline.
 */
export async function pushDmFrame(env: Record<string, unknown>, conversationId: string, frame: unknown): Promise<void> {
	try {
		const response = await dmServiceFetch(env, conversationId, { path: '/push', frame });
		if (!response.ok) console.error(`[bnji] dm push rejected: ${response.status}`);
	} catch (error) {
		console.error('[bnji] dm push failed:', error);
	}
}
