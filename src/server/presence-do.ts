/**
 * BNJI.NET — chat plan Phase E: the hibernating `Presence` Durable Object
 * (plan §8.2, §9.2).
 *
 * One global instance (`idFromName('global')`) holds a socket per signed-in
 * browser and answers "which friends are online". The DO stores NOTHING
 * durable — §9.2 says "attachments only": every fact it needs rides on each
 * socket's serialized attachment (`{ handle, friends }`, minted by this
 * Worker's `/api/presence` route from D1), so an idle eviction followed by a
 * hibernation revival loses no state — the registry IS `state.getWebSockets()`.
 * No polling, no heartbeat writes, never KV (§11).
 *
 * Visibility (§8.1): a socket only ever learns about handles listed in its
 * OWN attachment's `friends` — presence is visible only to accepted friends,
 * enforced here rather than trusted from the client (the attachment is set by
 * the route; a browser cannot address the DO without it).
 */
import { DurableObject } from 'cloudflare:workers';

export const PRESENCE_PROTOCOL_VERSION = 1;

type PresenceEnv = Record<string, never>;
type Attachment = { handle: string; friends: string[] };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Accounts only — the route mints this, never a browser (same trust model as DM). */
function readPrincipal(request: Request): string | null {
	const value = request.headers.get('x-bnji-verified-principal') ?? '';
	return /^player:[a-f0-9]{32}$/.test(value) ? value : null;
}

const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

/** Own handle; empty string means the account has no handle yet (no friends can exist then). */
function readHandle(request: Request): string | null {
	const raw = request.headers.get('x-bnji-handle');
	if (raw === null) return null;
	return raw === '' || HANDLE_PATTERN.test(raw) ? raw : null;
}

/** Accepted-friend handles, resolved by the route — capped at the §8.1 limit. */
function readFriends(request: Request): string[] | null {
	const raw = request.headers.get('x-bnji-friend-handles');
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed) || parsed.length > 500) return null;
		const seen = new Set<string>();
		for (const entry of parsed) {
			if (typeof entry !== 'string' || !HANDLE_PATTERN.test(entry)) return null;
			seen.add(entry);
		}
		return [...seen];
	} catch {
		return null;
	}
}

function socketAttachment(socket: WebSocket): Attachment | null {
	try {
		const value = socket.deserializeAttachment() as unknown;
		if (!value || typeof value !== 'object') return null;
		const attachment = value as Partial<Attachment>;
		if (typeof attachment.handle !== 'string' || !Array.isArray(attachment.friends)) return null;
		return { handle: attachment.handle, friends: attachment.friends.filter((item): item is string => typeof item === 'string') };
	} catch {
		return null;
	}
}

export class Presence extends DurableObject<PresenceEnv> {
	private readonly state: DurableObjectState;
	constructor(state: DurableObjectState, env: PresenceEnv) {
		super(state, env);
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.method === 'GET') return this.acceptConnection(request);
		return json({ error: 'not_found' }, 404);
	}

	private acceptConnection(request: Request): Response {
		const principal = readPrincipal(request);
		const handle = readHandle(request);
		const friends = readFriends(request);
		if (!principal || handle === null || !friends) return json({ error: 'presence_authentication_required' }, 401);
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.state.acceptWebSocket(server);
		server.serializeAttachment({ handle, friends } satisfies Attachment);

		// Snapshot: which of MY friends already have a socket (§8.2's answer).
		const friendSet = new Set(friends);
		const online = new Set<string>();
		for (const socket of this.state.getWebSockets()) {
			if (socket === server) continue;
			const other = socketAttachment(socket);
			if (other && other.handle && friendSet.has(other.handle)) online.add(other.handle);
		}
		server.send(JSON.stringify({ t: 'presence_snapshot', v: PRESENCE_PROTOCOL_VERSION, handles: [...online].sort() }));

		// Announce me to the sockets that list me as a friend.
		this.announce(handle, true, server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Send `{presence_change}` to every socket whose attachment lists `handle`. */
	private announce(handle: string, online: boolean, except: WebSocket | null): void {
		if (!handle) return;
		const encoded = JSON.stringify({ t: 'presence_change', v: PRESENCE_PROTOCOL_VERSION, handle, online });
		for (const socket of this.state.getWebSockets()) {
			if (socket === except) continue;
			const attachment = socketAttachment(socket);
			if (attachment && attachment.friends.includes(handle)) {
				try { socket.send(encoded); } catch { try { socket.close(1011, 'presence delivery failed'); } catch { /* no-op */ } }
			}
		}
	}

	async webSocketMessage(socket: WebSocket, input: string | ArrayBuffer): Promise<void> {
		// The client sends nothing of consequence; tolerate ping for keep-alives.
		if (typeof input !== 'string' || input.length > 256) return;
		try {
			const parsed = JSON.parse(input) as { t?: unknown };
			if (parsed?.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
		} catch { /* ignore */ }
	}

	async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
		const attachment = socketAttachment(socket);
		try { socket.close(code || 1000, String(reason ?? '').slice(0, 120)); } catch { /* already closed */ }
		this.announceOffline(attachment, socket);
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		const attachment = socketAttachment(socket);
		try { socket.close(1011, 'presence connection error'); } catch { /* already closed */ }
		this.announceOffline(attachment, socket);
	}

	/**
	 * Offline only when NO other tab still holds the same handle. The closing
	 * socket itself is skipped explicitly: depending on timing the runtime can
	 * still list it in getWebSockets() while this handler runs — matching it
	 * would swallow the announcement (self-match bug caught by the local
	 * two-client smoke against wrangler dev).
	 */
	private announceOffline(attachment: Attachment | null, closing: WebSocket): void {
		if (!attachment?.handle) return;
		for (const socket of this.state.getWebSockets()) {
			if (socket === closing) continue;
			const other = socketAttachment(socket);
			if (other?.handle === attachment.handle) return; // another tab keeps them online
		}
		this.announce(attachment.handle, false, null);
	}
}
