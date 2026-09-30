/** Generic room coordination only. It validates membership/envelopes/revisions, never game rules or scores. */
import { DurableObject } from 'cloudflare:workers';
import { parseRoomClientMessage, parseRoomStateMessage, roomCanAdmitMember, roomIsExpired, roomReconnectIsAllowed, ROOM_CAPACITY, ROOM_MAX_MESSAGE_BYTES, ROOM_MAX_STATE_BYTES, ROOM_MAX_MESSAGES_PER_SECOND, ROOM_PROTOCOL_VERSION, ROOM_RECONNECT_GRACE_MS, ROOM_STATE_WRITE_INTERVAL_MS, ROOM_TTL_MS } from './game-room-protocol';
import { authorizeRoomStateTransition } from './room-authority';

interface RoomEnv {}
type Principal = { key: string; hash: string };
type Attachment = { principalHash: string; memberId: string; rateSecond: number; rateCount: number };
type RoomRow = { game_id: string; owner_hash: string; created_at: number; expires_at: number; revision: number; state_json: string; last_state_at: number };
type MemberRow = { principal_hash: string; member_id: string; reconnect_until: number | null };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function randomId(): string {
	const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function readPrincipal(request: Request): string | null {
	const value = request.headers.get('x-bnji-verified-principal') ?? '';
	return /^(?:player|guest):[a-f0-9]{32}$/.test(value) ? value : null;
}
function socketAttachment(socket: WebSocket): Attachment | null {
	try { return socket.deserializeAttachment() as Attachment | null; } catch { return null; }
}

export class GameRoom extends DurableObject<RoomEnv> {
	private readonly state: DurableObjectState;
	constructor(state: DurableObjectState, env: RoomEnv) {
		super(state, env);
		this.state = state;
		this.state.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS game_room (
				id INTEGER PRIMARY KEY CHECK (id = 1), game_id TEXT NOT NULL, owner_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revision INTEGER NOT NULL,
				state_json TEXT NOT NULL, last_state_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS game_room_members (
				principal_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL UNIQUE, reconnect_until INTEGER, joined_at INTEGER NOT NULL
			);
		`);
	}

	async fetch(request: Request): Promise<Response> {
		const principal = readPrincipal(request);
		if (!principal) return json({ error: 'room_authentication_required' }, 401);
		const url = new URL(request.url);
		if (url.pathname === '/create' && request.method === 'POST') return this.createRoom(request, principal);
		if (url.pathname === '/ws' && request.method === 'GET') return this.acceptConnection(request, principal);
		return json({ error: 'not_found' }, 404);
	}

	private async principalHash(principal: string): Promise<string> {
		const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(principal));
		return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
	}
	private room(): RoomRow | null {
		return this.state.storage.sql.exec<RoomRow>('SELECT game_id, owner_hash, created_at, expires_at, revision, state_json, last_state_at FROM game_room WHERE id = 1').toArray()[0] ?? null;
	}
	private decodeState(jsonText: string): unknown {
		try { return JSON.parse(jsonText); } catch { return null; }
	}

	private async createRoom(request: Request, principal: string): Promise<Response> {
		let body: unknown;
		try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
		if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_payload' }, 400);
		const payload = body as Record<string, unknown>;
		if (Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'gameId') || !Object.hasOwn(payload, 'now') ||
			typeof payload.gameId !== 'string' || !/^bnji\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.gameId) ||
			typeof payload.now !== 'number' || !Number.isSafeInteger(payload.now)) return json({ error: 'invalid_room' }, 400);
		if (this.room()) return json({ error: 'room_already_exists' }, 409);
		const now = payload.now;
		const expiresAt = now + ROOM_TTL_MS;
		const principalHash = await this.principalHash(principal);
		const memberId = randomId();
		this.state.storage.sql.exec(
			`INSERT INTO game_room (id, game_id, owner_hash, created_at, expires_at, revision, state_json, last_state_at)
			 VALUES (1, ?, ?, ?, ?, 0, '{}', 0)`, payload.gameId, principalHash, now, expiresAt,
		);
		this.state.storage.sql.exec(
			'INSERT INTO game_room_members (principal_hash, member_id, reconnect_until, joined_at) VALUES (?, ?, NULL, ?)',
			principalHash, memberId, now,
		);
		await this.state.storage.setAlarm(expiresAt);
		return json({ created: true, expiresAt, capacity: ROOM_CAPACITY });
	}

	private async acceptConnection(request: Request, principal: string): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
		const room = this.room();
		const now = Date.now();
		if (!room || roomIsExpired(room.expires_at, now)) return json({ error: 'room_expired' }, 410);
		const hash = await this.principalHash(principal);
		this.state.storage.sql.exec('DELETE FROM game_room_members WHERE reconnect_until IS NOT NULL AND reconnect_until < ?', now);
		let member: MemberRow | null = this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE principal_hash = ?', hash,
		).toArray()[0] ?? null;
		if (member && !roomReconnectIsAllowed(member.reconnect_until, now)) {
			this.state.storage.sql.exec('DELETE FROM game_room_members WHERE principal_hash = ?', hash);
			member = null;
		}
		const activeMembers = this.state.storage.sql.exec<{ count: number }>(
			'SELECT COUNT(*) AS count FROM game_room_members WHERE reconnect_until IS NULL OR reconnect_until >= ?', now,
		).toArray()[0]?.count ?? 0;
		if (!roomCanAdmitMember(activeMembers, Boolean(member), ROOM_CAPACITY)) return json({ error: 'room_full' }, 409);
		const memberId = member?.member_id ?? randomId();
		this.state.storage.sql.exec(
			`INSERT INTO game_room_members (principal_hash, member_id, reconnect_until, joined_at) VALUES (?, ?, NULL, ?)
			 ON CONFLICT(principal_hash) DO UPDATE SET reconnect_until = NULL`, hash, memberId, now,
		);

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.state.acceptWebSocket(server);
		server.serializeAttachment({ principalHash: hash, memberId, rateSecond: Math.floor(now / 1000), rateCount: 0 } satisfies Attachment);
		this.handoffHost();
		for (const socket of this.state.getWebSockets()) {
			if (socket === server) continue;
			if (socketAttachment(socket)?.principalHash === hash) {
				try { socket.close(4001, 'Reconnected on another connection'); } catch { /* already closed */ }
			}
		}
		const snapshot = this.snapshot(this.room() ?? room, hash);
		server.send(JSON.stringify(snapshot));
		this.broadcastPresence();
		return new Response(null, { status: 101, webSocket: client });
	}

	private connectedPrincipalHashes(): Set<string> {
		return new Set(this.state.getWebSockets()
			.filter((socket) => socket.readyState === WebSocket.OPEN)
			.map((socket) => socketAttachment(socket)?.principalHash)
			.filter((value): value is string => Boolean(value)));
	}
	private connectedCount(): number { return this.connectedPrincipalHashes().size; }
	private snapshot(room = this.room(), principalHash?: string): Record<string, unknown> {
		return {
			v: ROOM_PROTOCOL_VERSION, type: 'snapshot', gameId: room?.game_id ?? '', revision: room?.revision ?? 0,
			state: this.decodeState(room?.state_json ?? '{}'), connectedMembers: this.connectedCount(),
			isHost: Boolean(room && principalHash && room.owner_hash === principalHash), hasHost: Boolean(room?.owner_hash),
		};
	}
	private broadcastPresence(): void {
		const room = this.room();
		for (const socket of this.state.getWebSockets()) {
			const attachment = socketAttachment(socket);
			try { socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'presence', connectedMembers: this.connectedCount(), isHost: Boolean(room && attachment && room.owner_hash === attachment.principalHash), hasHost: Boolean(room?.owner_hash) })); }
			catch { try { socket.close(1011, 'Room delivery failed'); } catch { /* no-op */ } }
		}
	}
	private handoffHost(): void {
		const room = this.room();
		if (!room) return;
		const connected = this.connectedPrincipalHashes();
		const currentHost = room.owner_hash ? this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE principal_hash = ?', room.owner_hash,
		).toArray()[0] : null;
		if (currentHost && connected.has(room.owner_hash)) return;
		const nextHost = this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE reconnect_until IS NULL OR reconnect_until >= ? ORDER BY joined_at ASC, member_id ASC', Date.now(),
		).toArray().find((member) => connected.has(member.principal_hash));
		this.state.storage.sql.exec('UPDATE game_room SET owner_hash = ? WHERE id = 1', nextHost?.principal_hash ?? '');
	}
	private broadcast(value: unknown, except?: WebSocket): void {
		const encoded = JSON.stringify(value);
		for (const socket of this.state.getWebSockets()) {
			if (socket === except) continue;
			try { socket.send(encoded); } catch { try { socket.close(1011, 'Room delivery failed'); } catch { /* no-op */ } }
		}
	}

	async webSocketMessage(socket: WebSocket, input: string | ArrayBuffer): Promise<void> {
		const attachment = socketAttachment(socket);
		if (!attachment || !/^[a-f0-9]{64}$/.test(attachment.principalHash)) {
			try { socket.close(1008, 'Room membership missing'); } catch { /* no-op */ }
			return;
		}
		const now = Date.now();
		const room = this.room();
		if (!room || roomIsExpired(room.expires_at, now)) {
			try { socket.close(4002, room ? 'Room expired' : 'Room not found'); } catch { /* no-op */ }
			return;
		}
		const membership = this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE principal_hash = ? AND member_id = ?', attachment.principalHash, attachment.memberId,
		).toArray()[0];
		if (!membership) { try { socket.close(1008, 'Room membership missing'); } catch { /* no-op */ } return; }
		let text: string;
		try {
			text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
		} catch { try { socket.close(1003, 'Text JSON required'); } catch { /* no-op */ } return; }
		const second = Math.floor(now / 1000);
		const nextCount = attachment.rateSecond === second ? attachment.rateCount + 1 : 1;
		if (nextCount > ROOM_MAX_MESSAGES_PER_SECOND) {
			try { socket.close(1013, 'Message rate exceeded'); } catch { /* no-op */ }
			return;
		}
		attachment.rateSecond = second;
		attachment.rateCount = nextCount;
		socket.serializeAttachment(attachment);

		const parsed = parseRoomClientMessage(text);
		if (!parsed.ok) {
			const closeCode = parsed.error === 'too_large' || parsed.error === 'state_too_large' ? 1009 : parsed.error === 'invalid_json' ? 1007 : 1008;
			try { socket.close(closeCode, parsed.error.slice(0, 80)); } catch { /* no-op */ }
			return;
		}
		if (parsed.message.type === 'leave') {
			this.state.storage.sql.exec('DELETE FROM game_room_members WHERE principal_hash = ? AND member_id = ?', attachment.principalHash, attachment.memberId);
			this.handoffHost();
			try { socket.close(1000, 'Left room'); } catch { /* no-op */ }
			return;
		}
		const value = parsed.message;
		if (value.baseRevision !== room.revision) {
			socket.send(JSON.stringify({ ...this.snapshot(room, attachment.principalHash), type: 'conflict' }));
			return;
		}
		if (now - room.last_state_at < ROOM_STATE_WRITE_INTERVAL_MS) {
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'rate_limited', retryAfterMs: ROOM_STATE_WRITE_INTERVAL_MS - (now - room.last_state_at) }));
			return;
		}
		const decision = await authorizeRoomStateTransition({
			gameId: room.game_id,
			actor: { principalHash: attachment.principalHash, memberId: attachment.memberId, isHost: room.owner_hash === attachment.principalHash },
			baseRevision: value.baseRevision, currentRevision: room.revision,
			currentState: this.decodeState(room.state_json) as Record<string, unknown>, proposedState: value.state,
		});
		if (!decision.allowed) {
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'state_rejected', error: decision.error ?? 'game_action_rejected' }));
			return;
		}
		const authorized = parseRoomStateMessage(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'state', baseRevision: room.revision, state: decision.state }));
		if (!authorized.ok) {
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'state_rejected', error: 'game_adapter_invalid_state' }));
			return;
		}
		const stateText = authorized.stateJson;
		const updated = this.state.storage.sql.exec<{ revision: number; state_json: string; last_state_at: number }>(
			`UPDATE game_room SET revision = revision + 1, state_json = ?, last_state_at = ?
			 WHERE id = 1 AND revision = ? AND expires_at > ? RETURNING revision, state_json, last_state_at`,
			stateText, now, room.revision, now,
		).toArray()[0];
		if (!updated) {
			const latest = this.room();
			socket.send(JSON.stringify({ ...this.snapshot(latest, attachment.principalHash), type: 'conflict' }));
			return;
		}
		this.broadcast({
			v: ROOM_PROTOCOL_VERSION, type: 'state', revision: updated.revision, state: this.decodeState(updated.state_json),
			connectedMembers: this.connectedCount(),
		});
	}

	async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
		const attachment = socketAttachment(socket);
		if (attachment) {
			const now = Date.now();
			const room = this.room();
			const stillMember = this.state.storage.sql.exec<MemberRow>(
				'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE principal_hash = ? AND member_id = ?', attachment.principalHash, attachment.memberId,
			).toArray()[0];
			if (stillMember && room && room.expires_at > now) {
				this.state.storage.sql.exec(
					'UPDATE game_room_members SET reconnect_until = ? WHERE principal_hash = ? AND member_id = ?',
					now + ROOM_RECONNECT_GRACE_MS, attachment.principalHash, attachment.memberId,
				);
			}
			this.handoffHost();
			this.broadcastPresence();
		}
		try { socket.close(code || 1000, reason.slice(0, 120)); } catch { /* already closed */ }
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		try { socket.close(1011, 'Room connection error'); } catch { /* already closed */ }
	}

	async alarm(): Promise<void> {
		const room = this.room();
		if (!room) return;
		if (room.expires_at > Date.now()) {
			await this.state.storage.setAlarm(room.expires_at);
			return;
		}
		for (const socket of this.state.getWebSockets()) {
			try { socket.close(4002, 'Room expired'); } catch { /* no-op */ }
		}
		this.state.storage.sql.exec('DELETE FROM game_room_members');
		this.state.storage.sql.exec('DELETE FROM game_room');
	}
}

export const GAME_ROOM_LIMITS = {
	ttlMs: ROOM_TTL_MS, reconnectGraceMs: ROOM_RECONNECT_GRACE_MS, capacity: ROOM_CAPACITY,
	maxMessageBytes: ROOM_MAX_MESSAGE_BYTES, maxStateBytes: ROOM_MAX_STATE_BYTES, stateWriteIntervalMs: ROOM_STATE_WRITE_INTERVAL_MS,
	maxMessagesPerSecond: ROOM_MAX_MESSAGES_PER_SECOND, protocolVersion: ROOM_PROTOCOL_VERSION,
};
