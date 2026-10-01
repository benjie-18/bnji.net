/**
 * BNJI.NET — chat plan Phase E: the HTTP boundary for the `Presence`
 * Durable Object namespace (mirrors src/server/dm-gateway.ts).
 *
 * Only `/api/presence` turns player context + the D1 friend list into the
 * trusted attachment headers (`handle`, `friends`) the DO reads — a browser
 * can never address the DO or choose who it appears online to (§8.1:
 * presence is visible only to accepted friends).
 */
export type PresenceNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type PresenceGatewayEnv = { PRESENCE?: PresenceNamespace };

export const PRESENCE_INSTANCE = 'global';

export function presenceNamespace(value: unknown): PresenceNamespace | null {
	if (!value || typeof value !== 'object') return null;
	const namespace = value as PresenceNamespace;
	return typeof namespace.idFromName === 'function' && typeof namespace.get === 'function' ? namespace : null;
}

/** Upgrade into the single global Presence instance with route-minted identity headers. */
export async function presenceServiceFetch(
	env: Record<string, unknown>,
	init: { player: string; handle: string; friends: string[]; request: Request },
): Promise<Response> {
	const unavailable = (error: string, status: number): Response =>
		new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
	const namespace = presenceNamespace((env as PresenceGatewayEnv).PRESENCE);
	if (!namespace) return unavailable('presence_service_unavailable', 503);
	const stub = namespace.get(namespace.idFromName(PRESENCE_INSTANCE));
	// Upgrade: preserve the client's headers (Connection/Upgrade must survive),
	// then set the trusted identity the DO re-validates by shape.
	const headers = new Headers(init.request.headers);
	headers.set('x-bnji-verified-principal', init.player);
	headers.set('x-bnji-handle', init.handle);
	headers.set('x-bnji-friend-handles', JSON.stringify(init.friends));
	return stub.fetch(new Request('https://presence.internal/ws', { method: 'GET', headers }));
}
