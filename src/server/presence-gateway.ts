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

/**
 * Service-authenticated stats path (mirrors the room admin token): the DO
 * answers socket/handle counts to anyone holding
 * `hex(sha256('bnji-presence-admin:v1:' + ACCESS_SECRET))` — the same secret
 * that already guards GameRoom admin reads. Never KV, never a browser path.
 */
export const PRESENCE_ADMIN_HEADER = 'x-bnji-presence-admin';

export async function derivePresenceAdminToken(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bnji-presence-admin:v1:${secret}`));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Live presence counts for the admin dashboard; null whenever unavailable (never fails the request). */
export async function presenceAdminFetch(
	env: Record<string, unknown>,
	secret: string | undefined,
): Promise<{ sockets: number; handles: number } | null> {
	if (!secret) return null;
	const namespace = presenceNamespace((env as PresenceGatewayEnv).PRESENCE);
	if (!namespace) return null;
	try {
		const token = await derivePresenceAdminToken(secret);
		const stub = namespace.get(namespace.idFromName(PRESENCE_INSTANCE));
		const response = await stub.fetch(new Request('https://presence.internal/admin/stats', {
			headers: { [PRESENCE_ADMIN_HEADER]: token },
		}));
		if (!response.ok) return null;
		const data = await response.json() as { sockets?: unknown; handles?: unknown };
		const sockets = Number(data.sockets);
		const handles = Number(data.handles);
		if (!Number.isFinite(sockets) || !Number.isFinite(handles) || sockets < 0 || handles < 0) return null;
		return { sockets, handles };
	} catch {
		return null;
	}
}

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
