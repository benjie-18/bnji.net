/**
 * BNJI.NET — chat plan Phase D: the per-conversation DM Durable Object
 * (plan D4/D5/§7.3/§9.2).
 *
 * Responsibilities, deliberately narrow:
 *   - accept hibernation-API sockets for the two participants, and
 *   - broadcast live frames the Worker's DM routes push after a durable D1
 *     write (send / hide / read watermark).
 *
 * The DO stores NOTHING: D1 is the durable record, and history is pulled
 * over REST ("the DO only ever carries live frames, never history" §7.3).
 * Conversation identity and membership are validated by the gateway route
 * before the upgrade; the DO re-checks only the header shape it is given
 * (`x-bnji-verified-principal` is set by this Worker's own routes, never by
 * a browser — same trust model as GameRoom's `/create`).
 */
import { DurableObject } from 'cloudflare:workers';
import {
	DM_PROTOCOL_VERSION, type DmSide,
} from './dm-protocol';

type DmEnv = Record<string, never>;
type Attachment = { principal: string; side: DmSide };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Accounts only (plan §7.1 — registered accounts). Guests never reach the gateway. */
function readPrincipal(request: Request): string | null {
	const value = request.headers.get('x-bnji-verified-principal') ?? '';
	return /^player:[a-f0-9]{32}$/.test(value) ? value : null;
}

function readSide(request: Request): DmSide | null {
	const value = request.headers.get('x-bnji-dm-side');
	return value === 'lo' || value === 'hi' ? value : null;
}

function socketAttachment(socket: WebSocket): Attachment | null {
	try { return socket.deserializeAttachment() as Attachment | null; } catch { return null; }
}

export class DMConversation extends DurableObject<DmEnv> {
	private readonly state: DurableObjectState;
	constructor(state: DurableObjectState, env: DmEnv) {
		super(state, env);
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.method === 'GET') return this.acceptConnection(request);
		if (url.pathname === '/push' && request.method === 'POST') return this.handlePush(request);
		return json({ error: 'not_found' }, 404);
	}

	private acceptConnection(request: Request): Response {
		const principal = readPrincipal(request);
		const side = readSide(request);
		if (!principal || !side) return json({ error: 'dm_authentication_required' }, 401);
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.state.acceptWebSocket(server);
		server.serializeAttachment({ principal, side } satisfies Attachment);
		// One participant per browser tab is plenty for DMs; a second connect
		// from the same principal replaces the older socket (same 4001 policy
		// as room chat, without the room's member registry to consult).
		for (const socket of this.state.getWebSockets()) {
			if (socket === server) continue;
			if (socketAttachment(socket)?.principal === principal) {
				try { socket.close(4001, 'Reconnected on another connection'); } catch { /* already closed */ }
			}
		}
		server.send(JSON.stringify({ t: 'dm_ready', v: DM_PROTOCOL_VERSION }));
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Called by the Worker's DM routes AFTER the D1 write succeeds (§7.3). */
	private async handlePush(request: Request): Promise<Response> {
		const text = await request.text();
		if (text.length > 65_536) return json({ error: 'payload_too_large' }, 413);
		let body: unknown;
		try { body = JSON.parse(text || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }
		const frame = (body as { frame?: unknown } | null)?.frame;
		if (!frame || typeof frame !== 'object') return json({ error: 'invalid_payload' }, 400);
		this.broadcast(frame as Record<string, unknown>);
		return json({ ok: true });
	}

	private broadcast(value: unknown): void {
		const encoded = JSON.stringify(value);
		for (const socket of this.state.getWebSockets()) {
			try { socket.send(encoded); } catch { try { socket.close(1011, 'DM delivery failed'); } catch { /* no-op */ } }
		}
	}

	async webSocketMessage(socket: WebSocket, input: string | ArrayBuffer): Promise<void> {
		// The client sends nothing of consequence (REST carries sends/reads/
		// hides); tolerate a ping so keep-alive probes do not log errors.
		if (typeof input !== 'string' || input.length > 256) return;
		try {
			const parsed = JSON.parse(input) as { t?: unknown };
			if (parsed?.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
		} catch { /* ignore */ }
	}

	async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
		try { socket.close(code || 1000, reason.slice(0, 120)); } catch { /* already closed */ }
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		try { socket.close(1011, 'DM connection error'); } catch { /* already closed */ }
	}
}
