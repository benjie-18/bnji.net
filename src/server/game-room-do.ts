/** Generic room coordination only. It validates membership/envelopes/revisions, never game rules or scores. Chat (plan Phase B) lives here as a transport feature: DO SQLite rows, socket-attachment rate buckets, and zero contact with `revision`/`state_json`. Phase C adds the service-authenticated `/admin/read` + `/admin/action` endpoints and the member-authenticated `/report` snapshot. */
import { DurableObject } from 'cloudflare:workers';
import { CHAT_CONFIG } from '../config/chat.config';
import { sanitizePublicLabel } from './display-name';
import {
	containsBlockedTerm, consumeChatToken, packChatHistory, parseRoomClientMessage, parseRoomStateMessage, roomAdminServiceToken, ROOM_ADMIN_HEADER,
	roomCanAdmitMember, roomIsExpired, roomReconnectIsAllowed, ROOM_CAPACITY, ROOM_MAX_GLOBAL_MESSAGES_PER_SECOND, ROOM_MAX_MESSAGE_BYTES,
	ROOM_MAX_STATE_BYTES, ROOM_PROTOCOL_VERSION, ROOM_RECONNECT_GRACE_MS, ROOM_STATE_WRITE_INTERVAL_MS, ROOM_TTL_MS, sanitizeChatText, stripUrlsForDisplay,
	type RoomChatFrame, type RoomChatDeleteFrame, type RoomMemberFrame,
} from './game-room-protocol';
import { authorizeGameAction, authorizeRoomStateTransition, redactGameState, verifyRoundWin, type GameActionRequest } from './room-authority';
// Side effect: registers the game authorities/adapters inside this isolate.
import './game-adapters/chess';
import './game-adapters/pvp-minesweeper';

interface RoomEnv { ACCESS_SECRET?: string }
type Principal = { key: string; hash: string };
type Attachment = {
	principalHash: string; memberId: string;
	/** Pre-parse abuse ceiling counters (plan §5.4.1, all frame types). */
	rateSecond: number; rateCount: number;
	/** Per-member chat token bucket (plan §5.4.2) — survives hibernation. */
	chatTokens: number; chatTokensAt: number;
	/** Sanitized display label resolved at upgrade time; self-asserted, never an authorization input. */
	label: string;
};
type RoomRow = { game_id: string; owner_hash: string; created_at: number; expires_at: number; revision: number; state_json: string; last_state_at: number };
type MemberRow = { principal_hash: string; member_id: string; reconnect_until: number | null };
type ChatRow = { n: number; label: string; principal_hash: string; text: string; created_at: number; removed: string | null };

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
/**
 * Label from the upgrade route, URL-encoded because headers are not a Unicode
 * channel. Sanitized here again — the DO never trusts a header. The public-label
 * sanitizer (not the display-name one) is what accepts the composed
 * `@handle · Display Name` form; anything else degrades to the generic label.
 */
function readChatLabel(request: Request, principal: string): string {
	const raw = request.headers.get('x-bnji-chat-label');
	let decoded = '';
	if (raw) { try { decoded = decodeURIComponent(raw); } catch { decoded = ''; } }
	const sanitized = sanitizePublicLabel(decoded);
	if (sanitized.ok) return sanitized.label;
	return principal.startsWith('player:') ? 'Player' : 'Guest';
}
function socketAttachment(socket: WebSocket): Attachment | null {
	try { return socket.deserializeAttachment() as Attachment | null; } catch { return null; }
}

export class GameRoom extends DurableObject<RoomEnv> {
	/**
	 * Game-action token bucket (games plan): actions persist room state but
	 * do NOT spend the 5s state-frame budget. Burst 16 covers a full-room
	 * simultaneous vote/placement; refill is one action per second. Reset on
	 * hibernation only loosens the bound by one burst — the pre-parse frame
	 * ceiling still applies.
	 */
	private actionTokens = 16;
	private actionTokensAt = Date.now();

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
			CREATE TABLE IF NOT EXISTS game_room_chat (
				n INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, principal_hash TEXT NOT NULL,
				text TEXT NOT NULL, created_at INTEGER NOT NULL, removed TEXT
			);
			CREATE TABLE IF NOT EXISTS game_room_chat_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor_hash TEXT NOT NULL, target TEXT, at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS game_room_mutes (
				principal_hash TEXT PRIMARY KEY, muted_at INTEGER NOT NULL
			);
			-- Open lobbies: a kick must outlast the socket it closed. Member rows
			-- are deleted on kick, so without this table a kicked player could walk
			-- straight back in — which is not a kick, it is a doorbell. Same
			-- lifetime rule as game_room_mutes: the row lives until the room does.
			CREATE TABLE IF NOT EXISTS game_room_kicks (
				principal_hash TEXT PRIMARY KEY, kicked_at INTEGER NOT NULL, member_id TEXT NOT NULL, label TEXT NOT NULL
			);
		`);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// Phase C: service-authenticated admin endpoints carry NO visitor
		// principal — they are only reachable from the Worker's admin routes.
		if (url.pathname === '/admin/read' || url.pathname === '/admin/action') return this.adminFetch(request, url.pathname);
		const principal = readPrincipal(request);
		if (!principal) return json({ error: 'room_authentication_required' }, 401);
		if (url.pathname === '/create' && request.method === 'POST') return this.createRoom(request, principal);
		if (url.pathname === '/ws' && request.method === 'GET') return this.acceptConnection(request, principal);
		// Open lobbies: the lobby list asks a room whether it is still alive and
		// how many seats it has taken. Membership is NOT required — this is the
		// only read a stranger may perform, so it answers with counters and
		// nothing else (no state, no chat, no labels).
		if (url.pathname === '/lobby' && request.method === 'GET') return this.lobbyStatus();
		if (url.pathname === '/report' && request.method === 'POST') return this.handleReport(request, principal);
		if (url.pathname === '/game/verify_win' && request.method === 'POST') return this.verifyWin(request, principal);
		return json({ error: 'not_found' }, 404);
	}

	/** Plan §6.2: the DO verifies a header derived from the Worker secret, never a client-supplied value. Fails closed with no secret configured. */
	private async isAdminService(request: Request): Promise<boolean> {
		const expected = await roomAdminServiceToken(this.env.ACCESS_SECRET);
		if (!expected) return false;
		const provided = request.headers.get(ROOM_ADMIN_HEADER) ?? '';
		return provided.length === expected.length && provided === expected;
	}
	private async adminFetch(request: Request, pathname: string): Promise<Response> {
		if (!(await this.isAdminService(request))) return json({ error: 'service_unauthorized' }, 403);
		if (pathname === '/admin/read') {
			if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			return this.adminRead();
		}
		if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
		const text = await request.text();
		if (text.length > 1_024) return json({ error: 'payload_too_large' }, 413);
		let body: unknown;
		try { body = JSON.parse(text || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }
		return this.adminAction(body);
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
		// A kicked principal is out for the room's remaining lifetime. The grace
		// window that normally lets a player reconnect must not become the way
		// back in for someone the host just removed.
		if (this.isKicked(hash)) return json({ error: 'room_kicked' }, 403);
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
		server.serializeAttachment({
			principalHash: hash, memberId,
			rateSecond: Math.floor(now / 1000), rateCount: 0,
			chatTokens: CHAT_CONFIG.rate.burst, chatTokensAt: now,
			label: readChatLabel(request, principal),
		} satisfies Attachment);
		this.handoffHost();
		for (const socket of this.state.getWebSockets()) {
			if (socket === server) continue;
			if (socketAttachment(socket)?.principalHash === hash) {
				try { socket.close(4001, 'Reconnected on another connection'); } catch { /* already closed */ }
			}
		}
		const snapshot = this.snapshot(this.room() ?? room, hash);
		server.send(JSON.stringify(snapshot));
		// Plan §5.2: history follows the snapshot, chunked so no frame trips the
		// client's outbound-size guard; `mine` is computed per socket.
		for (const history of packChatHistory(this.historyFrames(hash), CHAT_CONFIG.historyChunkMessages)) {
			server.send(JSON.stringify(history));
		}
		this.broadcastMembers();
		this.broadcastPresence();
		return new Response(null, { status: 101, webSocket: client });
	}

	// ------------------------------------------------------------------ chat

	private historyFrames(forHash: string): RoomChatFrame[] {
		const rows = this.state.storage.sql.exec<ChatRow>(
			'SELECT n, label, principal_hash, text, created_at, removed FROM game_room_chat ORDER BY n DESC LIMIT ?', CHAT_CONFIG.maxStoredMessages,
		).toArray();
		return rows.reverse().map((row) => ({
			v: ROOM_PROTOCOL_VERSION, type: 'chat' as const, n: Number(row.n), label: row.label,
			text: row.text, at: Number(row.created_at), mine: row.principal_hash === forHash,
			...(row.removed ? { removed: row.removed as 'host' | 'self' | 'admin' } : {}),
		}));
	}
	private sendMembers(socket: WebSocket, forHash: string): void {
		const room = this.room();
		const muted = new Set(this.state.storage.sql.exec<{ principal_hash: string }>('SELECT principal_hash FROM game_room_mutes').toArray().map((row) => row.principal_hash));
		const members: RoomMemberFrame['members'] = [];
		for (const peer of this.state.getWebSockets()) {
			const attachment = socketAttachment(peer);
			if (!attachment || peer.readyState !== WebSocket.OPEN) continue;
			members.push({
				memberId: attachment.memberId, label: attachment.label,
				isHost: Boolean(room && room.owner_hash === attachment.principalHash),
				isSelf: attachment.principalHash === forHash,
				muted: muted.has(attachment.principalHash),
			});
		}
		socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'members', members } satisfies RoomMemberFrame));
	}
	/** Roster frame is per-socket (`isSelf` differs), so this fans out individually. */
	private broadcastMembers(): void {
		for (const socket of this.state.getWebSockets()) {
			const attachment = socketAttachment(socket);
			if (!attachment) continue;
			try { this.sendMembers(socket, attachment.principalHash); } catch { try { socket.close(1011, 'Room delivery failed'); } catch { /* no-op */ } }
		}
	}
	private reject(socket: WebSocket, error: string, retryAfterMs?: number): void {
		try {
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'chat_rejected', error, ...(retryAfterMs ? { retryAfterMs } : {}) }));
		} catch { try { socket.close(1011, 'Room delivery failed'); } catch { /* no-op */ } }
	}
	/** True while a kick row exists for this principal (the row dies with the room). */
	private isKicked(principalHash: string): boolean {
		return Boolean(this.state.storage.sql.exec<{ principal_hash: string }>('SELECT principal_hash FROM game_room_kicks WHERE principal_hash = ?', principalHash).toArray()[0]);
	}

	/**
	 * Lobby answer for a visitor who is not in the room. Deliberately
	 * count-and-clock only: the room's opaque state, its members' labels and its
	 * chat are unreachable here, because this is the one read a stranger may
	 * perform before joining — and neither the room's membership nor the caller's
	 * place in it is reported, since lobby answers are cached across visitors.
	 * A room that is gone answers 410 rather than 200 with an empty body, so a
	 * stale registry row cannot be mistaken for an empty lobby.
	 */
	private lobbyStatus(): Response {
		const room = this.room();
		const now = Date.now();
		if (!room || roomIsExpired(room.expires_at, now)) return json({ error: 'room_expired' }, 410);
		const seats = Number(this.state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM game_room_members').toArray()[0]?.count ?? 0);
		return json({
			live: true,
			gameId: room.game_id,
			players: seats,
			connected: this.connectedPrincipalHashes().size,
			capacity: ROOM_CAPACITY,
			joinable: roomCanAdmitMember(seats, false, ROOM_CAPACITY),
			createdAt: Number(room.created_at),
			expiresAt: Number(room.expires_at),
			revision: Number(room.revision),
		});
	}

	private isMuted(principalHash: string): boolean {
		return Boolean(this.state.storage.sql.exec<{ principal_hash: string }>('SELECT principal_hash FROM game_room_mutes WHERE principal_hash = ?', principalHash).toArray()[0]);
	}
	private logChatAction(action: string, actorHash: string, target: string | null): void {
		this.state.storage.sql.exec('INSERT INTO game_room_chat_log (action, actor_hash, target, at) VALUES (?, ?, ?, ?)', action, actorHash, target, Date.now());
	}

	private async handleChat(socket: WebSocket, attachment: Attachment, text: string): Promise<void> {
		if (!CHAT_CONFIG.enabled) return this.reject(socket, 'chat_disabled');
		const sanitized = sanitizeChatText(text);
		if (!sanitized.ok) return this.reject(socket, 'invalid_text');
		// Plan §6.3 — config-driven blocklist: a triage aid, not a guarantee.
		if (containsBlockedTerm(sanitized.text, CHAT_CONFIG.filter.blocklist)) return this.reject(socket, 'blocked');
		if (this.isMuted(attachment.principalHash)) return this.reject(socket, 'muted');
		const now = Date.now();
		const bucket = consumeChatToken(
			{ tokens: attachment.chatTokens, at: attachment.chatTokensAt }, now,
			{ burst: CHAT_CONFIG.rate.burst, refillMs: CHAT_CONFIG.rate.refillMs },
		);
		attachment.chatTokens = bucket.state.tokens;
		attachment.chatTokensAt = bucket.state.at;
		socket.serializeAttachment(attachment);
		if (!bucket.allowed) return this.reject(socket, 'rate_limited', bucket.retryAfterMs);
		const inserted = this.state.storage.sql.exec<{ n: number }>(
			'INSERT INTO game_room_chat (label, principal_hash, text, created_at, removed) VALUES (?, ?, ?, ?, NULL) RETURNING n',
			attachment.label, attachment.principalHash, sanitized.text, now,
		).toArray()[0];
		// Storage cap (plan §5.4.3): trim oldest beyond maxStoredMessages. When
		// the subquery runs out of rows it returns NULL and `n < NULL` matches
		// nothing — a short history simply is not trimmed.
		this.state.storage.sql.exec(
			'DELETE FROM game_room_chat WHERE n < (SELECT n FROM game_room_chat ORDER BY n DESC LIMIT 1 OFFSET ?)',
			CHAT_CONFIG.maxStoredMessages,
		);
		const frame: RoomChatFrame = { v: ROOM_PROTOCOL_VERSION, type: 'chat', n: Number(inserted.n), label: attachment.label, text: sanitized.text, at: now };
		for (const peer of this.state.getWebSockets()) {
			const peerAttachment = socketAttachment(peer);
			if (!peerAttachment) continue;
			try { peer.send(JSON.stringify({ ...frame, mine: peerAttachment.principalHash === attachment.principalHash })); }
			catch { try { peer.close(1011, 'Room delivery failed'); } catch { /* no-op */ } }
		}
	}

	/** Tombstone + broadcast, shared by the host/self delete path and the admin delete action. */
	private tombstoneMessage(n: number, source: RoomChatDeleteFrame['source'], actorHash: string, logAction: string): boolean {
		const row = this.state.storage.sql.exec<ChatRow>(
			'SELECT n, label, principal_hash, text, created_at, removed FROM game_room_chat WHERE n = ?', n,
		).toArray()[0];
		if (!row || row.removed) return false;
		this.state.storage.sql.exec('UPDATE game_room_chat SET text = ?, removed = ? WHERE n = ?', '', source, n);
		this.logChatAction(logAction, actorHash, String(n));
		this.broadcast({ v: ROOM_PROTOCOL_VERSION, type: 'chat_delete', n, source } satisfies RoomChatDeleteFrame);
		return true;
	}

	private handleChatDelete(socket: WebSocket, attachment: Attachment, n: number): void {
		const row = this.state.storage.sql.exec<ChatRow>(
			'SELECT n, label, principal_hash, text, created_at, removed FROM game_room_chat WHERE n = ?', n,
		).toArray()[0];
		const room = this.room();
		if (!row || !room || row.removed) return this.reject(socket, 'not_allowed');
		const isAuthor = row.principal_hash === attachment.principalHash;
		const isHost = room.owner_hash === attachment.principalHash;
		if (!isAuthor && !isHost) return this.reject(socket, 'not_allowed');
		const source: 'host' | 'self' = isAuthor ? 'self' : 'host';
		this.tombstoneMessage(n, source, attachment.principalHash, source === 'self' ? 'delete_self' : 'delete_host');
	}

	private handleKick(socket: WebSocket, attachment: Attachment, member: string): void {
		const room = this.room();
		if (!room || room.owner_hash !== attachment.principalHash) return this.reject(socket, 'not_allowed');
		if (member === attachment.memberId) return this.reject(socket, 'invalid_target');
		const target = this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE member_id = ?', member,
		).toArray()[0];
		if (!target) return this.reject(socket, 'not_allowed');
		// Record first, delete second: the reverse order would let a reconnect
		// between the two statements seat the player we are removing.
		const targetLabel = this.state.getWebSockets()
			.map((peer) => socketAttachment(peer))
			.find((att) => att?.principalHash === target.principal_hash)?.label ?? 'Member';
		this.state.storage.sql.exec(
			`INSERT INTO game_room_kicks (principal_hash, kicked_at, member_id, label) VALUES (?, ?, ?, ?)
			 ON CONFLICT(principal_hash) DO UPDATE SET kicked_at = excluded.kicked_at, member_id = excluded.member_id, label = excluded.label`,
			target.principal_hash, Date.now(), target.member_id, targetLabel,
		);
		this.state.storage.sql.exec('DELETE FROM game_room_members WHERE member_id = ?', member);
		this.logChatAction('kick', attachment.principalHash, target.principal_hash);
		for (const peer of this.state.getWebSockets()) {
			const peerAttachment = socketAttachment(peer);
			if (peerAttachment?.principalHash !== target.principal_hash) continue;
			try { peer.close(4003, 'Kicked by host'); } catch { /* no-op */ }
		}
		this.broadcastMembers();
		this.broadcastPresence();
	}

	private handleMute(socket: WebSocket, attachment: Attachment, member: string): void {
		const room = this.room();
		if (!room || room.owner_hash !== attachment.principalHash) return this.reject(socket, 'not_allowed');
		if (member === attachment.memberId) return this.reject(socket, 'invalid_target');
		const target = this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE member_id = ?', member,
		).toArray()[0];
		if (!target) return this.reject(socket, 'not_allowed');
		// Mute lasts for the room's remaining lifetime (rows die in alarm()).
		// Plan §5.4 said "attachment flag", but an attachment is recreated on
		// reconnect — a table is the only form that survives rejoin.
		this.state.storage.sql.exec(
			'INSERT INTO game_room_mutes (principal_hash, muted_at) VALUES (?, ?) ON CONFLICT(principal_hash) DO NOTHING',
			target.principal_hash, Date.now(),
		);
		this.logChatAction('mute', attachment.principalHash, target.principal_hash);
		this.broadcastMembers();
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
			state: redactGameState(room?.game_id ?? '', (this.decodeState(room?.state_json ?? '{}') ?? {}) as Record<string, unknown>), connectedMembers: this.connectedCount(),
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

	// ------------------------------------------------- Phase C: moderation

	/** Plan §6.2 transcript read: messages (URLs stripped for display when configured), members with principal hashes for ban actions, host log. */
	private adminRead(): Response {
		const room = this.room();
		const now = Date.now();
		if (!room) return json({ error: 'room_not_found' }, 404);
		if (roomIsExpired(room.expires_at, now)) return json({ error: 'room_expired' }, 410);
		const strip = CHAT_CONFIG.filter.stripUrlsForAdmin;
		const blocklist = CHAT_CONFIG.filter.blocklist;
		const messages = this.state.storage.sql.exec<ChatRow>(
			'SELECT n, label, principal_hash, text, created_at, removed FROM game_room_chat ORDER BY n ASC LIMIT ?', CHAT_CONFIG.maxStoredMessages,
		).toArray().map((row) => ({
			n: Number(row.n), label: row.label,
			// Raw text stays raw in storage and in the room; the strip is view-only.
			text: strip ? stripUrlsForDisplay(row.text) : row.text,
			at: Number(row.created_at), removed: row.removed ?? null,
			flagged: !row.removed && containsBlockedTerm(row.text, blocklist),
			authorHash: row.principal_hash,
		}));
		const muted = new Set(this.state.storage.sql.exec<{ principal_hash: string }>('SELECT principal_hash FROM game_room_mutes').toArray().map((row) => row.principal_hash));
		const connected = new Map<string, string>();
		for (const socket of this.state.getWebSockets()) {
			const attachment = socketAttachment(socket);
			if (attachment && socket.readyState === WebSocket.OPEN) connected.set(attachment.principalHash, attachment.label);
		}
		const members = this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members ORDER BY joined_at ASC',
		).toArray().map((member) => ({
			memberId: member.member_id, principalHash: member.principal_hash,
			label: connected.get(member.principal_hash) ?? '—',
			isHost: room.owner_hash === member.principal_hash,
			connected: connected.has(member.principal_hash),
			muted: muted.has(member.principal_hash),
		}));
		const hostLog = this.state.storage.sql.exec<{ action: string; target: string | null; at: number }>(
			'SELECT action, target, at FROM game_room_chat_log ORDER BY id DESC LIMIT 50',
		).toArray().map((row) => ({ action: row.action, target: row.target, at: Number(row.at) }));
		return json({
			room: { gameId: room.game_id, createdAt: Number(room.created_at), expiresAt: Number(room.expires_at), revision: Number(room.revision), capacity: ROOM_CAPACITY },
			chatEnabled: CHAT_CONFIG.enabled, members, messages, hostLog,
		});
	}

	private adminAction(body: unknown): Response {
		if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid_payload' }, 400);
		const payload = body as Record<string, unknown>;
		if (payload.type === 'delete_message') {
			if (Object.keys(payload).length !== 2 || !Number.isSafeInteger(payload.n) || Number(payload.n) < 1) return json({ error: 'invalid_payload' }, 400);
			if (!this.room()) return json({ error: 'room_not_found' }, 404);
			const n = Number(payload.n);
			if (!this.tombstoneMessage(n, 'admin', 'administrator', 'delete_admin')) return json({ error: 'message_not_found' }, 404);
			return json({ ok: true, n });
		}
		if (payload.type === 'close_room') {
			if (Object.keys(payload).length !== 1) return json({ error: 'invalid_payload' }, 400);
			if (!this.room()) return json({ error: 'room_not_found' }, 404);
			this.teardown('Room closed by administrator');
			return json({ ok: true });
		}
		if (payload.type === 'kick') {
			if (Object.keys(payload).length !== 2 || typeof payload.principalHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.principalHash)) return json({ error: 'invalid_payload' }, 400);
			if (!this.room()) return json({ error: 'room_not_found' }, 404);
			const hash = payload.principalHash;
			const target = this.state.storage.sql.exec<MemberRow>(
				'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE principal_hash = ?', hash,
			).toArray()[0];
			if (!target) return json({ ok: true, kicked: false });
			// Same lockout as a host kick: an administrator removing a griefer from
			// a public lobby has to be able to leave the page without the griefer
			// walking straight back in.
			this.state.storage.sql.exec(
				`INSERT INTO game_room_kicks (principal_hash, kicked_at, member_id, label) VALUES (?, ?, ?, ?)
				 ON CONFLICT(principal_hash) DO UPDATE SET kicked_at = excluded.kicked_at, member_id = excluded.member_id, label = excluded.label`,
				hash, Date.now(), target.member_id, 'Administrator',
			);
			this.state.storage.sql.exec('DELETE FROM game_room_members WHERE principal_hash = ?', hash);
			this.logChatAction('kick_admin', 'administrator', hash);
			for (const peer of this.state.getWebSockets()) {
				if (socketAttachment(peer)?.principalHash !== hash) continue;
				try { peer.close(4003, 'Removed by administrator'); } catch { /* no-op */ }
			}
			this.handoffHost();
			this.broadcastMembers();
			this.broadcastPresence();
			return json({ ok: true, kicked: true });
		}
		return json({ error: 'invalid_action' }, 400);
	}

	/** Plan §6.4: the DO snapshots the message at report time so evidence survives the room. Persisted to D1 by the Worker route. */
	private async handleReport(request: Request, principal: string): Promise<Response> {
		const hash = await this.principalHash(principal);
		const member = this.state.storage.sql.exec<MemberRow>(
			'SELECT principal_hash, member_id, reconnect_until FROM game_room_members WHERE principal_hash = ?', hash,
		).toArray()[0];
		if (!member) return json({ error: 'not_member' }, 403);
		const room = this.room();
		const now = Date.now();
		if (!room || roomIsExpired(room.expires_at, now)) return json({ error: 'room_expired' }, 410);
		const text = await request.text();
		if (text.length > 256) return json({ error: 'payload_too_large' }, 413);
		let body: unknown;
		try { body = JSON.parse(text || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }
		const payload = body as Record<string, unknown>;
		if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
			Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'n') ||
			!Number.isSafeInteger(payload.n) || Number(payload.n) < 1) return json({ error: 'invalid_payload' }, 400);
		const row = this.state.storage.sql.exec<ChatRow>(
			'SELECT n, label, principal_hash, text, created_at, removed FROM game_room_chat WHERE n = ?', Number(payload.n),
		).toArray()[0];
		// Removed messages hold no text; trimmed ones are gone — both are 404.
		if (!row || row.removed) return json({ error: 'message_not_found' }, 404);
		const author = this.state.storage.sql.exec<{ member_id: string }>(
			'SELECT member_id FROM game_room_members WHERE principal_hash = ?', row.principal_hash,
		).toArray()[0];
		return json({
			snapshot: {
				authorHash: row.principal_hash, label: row.label, text: row.text,
				messageAt: Number(row.created_at), memberId: author?.member_id ?? null,
			},
		});
	}

	/** Close every socket and delete every room table (alarm expiry and admin close share this). */
	private teardown(reason: string): void {
		for (const socket of this.state.getWebSockets()) {
			try { socket.close(4002, reason); } catch { /* no-op */ }
		}
		this.state.storage.sql.exec('DELETE FROM game_room_members');
		this.state.storage.sql.exec('DELETE FROM game_room_chat');
		this.state.storage.sql.exec('DELETE FROM game_room_chat_log');
		this.state.storage.sql.exec('DELETE FROM game_room_mutes');
		this.state.storage.sql.exec('DELETE FROM game_room_kicks');
		this.state.storage.sql.exec('DELETE FROM game_room');
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
		// Plan §5.4.1: pre-parse abuse ceiling across all frame types; breach closes.
		const second = Math.floor(now / 1000);
		const nextCount = attachment.rateSecond === second ? attachment.rateCount + 1 : 1;
		if (nextCount > ROOM_MAX_GLOBAL_MESSAGES_PER_SECOND) {
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
		if (parsed.message.type === 'chat') {
			await this.handleChat(socket, attachment, parsed.message.text);
			return;
		}
		if (parsed.message.type === 'chat_delete') {
			this.handleChatDelete(socket, attachment, parsed.message.n);
			return;
		}
		if (parsed.message.type === 'kick') {
			this.handleKick(socket, attachment, parsed.message.member);
			return;
		}
		if (parsed.message.type === 'mute') {
			this.handleMute(socket, attachment, parsed.message.member);
			return;
		}
		if (parsed.message.type === 'leave') {
			this.state.storage.sql.exec('DELETE FROM game_room_members WHERE principal_hash = ? AND member_id = ?', attachment.principalHash, attachment.memberId);
			this.handoffHost();
			try { socket.close(1000, 'Left room'); } catch { /* no-op */ }
			return;
		}
		if (parsed.message.type === 'action') {
			await this.handleGameAction(socket, attachment, parsed.message, now, room);
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
			v: ROOM_PROTOCOL_VERSION, type: 'state', revision: updated.revision, state: redactGameState(room.game_id, (this.decodeState(updated.state_json) ?? {}) as Record<string, unknown>),
			connectedMembers: this.connectedCount(),
		});
	}

	/** Live-or-grace members with their trusted hashes — context for game action handlers. */
	private memberContext(now: number): Array<{ memberId: string; principalHash: string }> {
		return this.state.storage.sql.exec<{ member_id: string; principal_hash: string }>(
			'SELECT member_id, principal_hash FROM game_room_members WHERE reconnect_until IS NULL OR reconnect_until >= ?',
			now,
		).toArray().map((row) => ({ memberId: row.member_id, principalHash: row.principal_hash }));
	}

	/**
	 * Game actions: validated by the game's registered handler, persisted as
	 * a revision bump WITHOUT the 5s state-frame write budget, broadcast to
	 * the whole room. Denied actions answer the actor only.
	 */
	private async handleGameAction(socket: WebSocket, attachment: Attachment, message: { action: string; payload: Record<string, unknown> }, now: number, room: RoomRow): Promise<void> {
		const elapsed = now - this.actionTokensAt;
		const refill = elapsed > 0 ? Math.floor(elapsed / 1000) : 0;
		if (refill > 0) {
			this.actionTokens = Math.min(16, this.actionTokens + refill);
			this.actionTokensAt += refill * 1000;
		}
		if (this.actionTokens < 1) {
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'action_rejected', error: 'rate_limited', retryAfterMs: 1000 }));
			return;
		}
		this.actionTokens -= 1;
		const request: GameActionRequest = {
			gameId: room.game_id,
			actor: { principalHash: attachment.principalHash, memberId: attachment.memberId, isHost: room.owner_hash === attachment.principalHash },
			action: message.action,
			payload: message.payload,
			currentState: (this.decodeState(room.state_json) ?? {}) as Record<string, unknown>,
			now,
			members: this.memberContext(now),
			hasHost: Boolean(room.owner_hash),
		};
		const decision = await authorizeGameAction(request);
		if (!decision.allowed) {
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'action_rejected', error: decision.error ?? 'game_action_rejected' }));
			return;
		}
		const authorized = parseRoomStateMessage(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'state', baseRevision: room.revision, state: decision.state }));
		if (!authorized.ok) {
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'action_rejected', error: 'game_adapter_invalid_state' }));
			return;
		}
		const updated = this.state.storage.sql.exec<{ revision: number; state_json: string }>(
			`UPDATE game_room SET revision = revision + 1, state_json = ?
			 WHERE id = 1 AND revision = ? AND expires_at > ? RETURNING revision, state_json`,
			authorized.stateJson, room.revision, now,
		).toArray()[0];
		if (!updated) {
			const latest = this.room();
			socket.send(JSON.stringify({ ...this.snapshot(latest, attachment.principalHash), type: 'conflict' }));
			return;
		}
		if (decision.reply) {
			// Actor-only: private per-player views (a racer's own minefield)
			// must never ride the broadcast that every socket receives.
			socket.send(JSON.stringify({ v: ROOM_PROTOCOL_VERSION, type: 'action_result', action: message.action, revision: updated.revision, reply: decision.reply }));
		}
		this.broadcast({
			v: ROOM_PROTOCOL_VERSION, type: 'action', action: message.action, actor: attachment.memberId,
			revision: updated.revision, state: redactGameState(room.game_id, (this.decodeState(updated.state_json) ?? {}) as Record<string, unknown>),
			connectedMembers: this.connectedCount(),
		});
	}

	/**
	 * Leaderboard attestation (`/game/verify_win`): the Worker scores route
	 * asks this DO whether the caller's principal won a given round. Trusted
	 * because only Worker code can reach DO fetch; the principal header is
	 * derived by the gateway route, never by a client.
	 */
	private async verifyWin(request: Request, principal: string): Promise<Response> {
		const room = this.room();
		const now = Date.now();
		if (!room || roomIsExpired(room.expires_at, now)) return json({ error: 'room_expired' }, 410);
		const text = await request.text();
		if (text.length > 512) return json({ error: 'payload_too_large' }, 413);
		let body: unknown;
		try { body = JSON.parse(text || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }
		const payload = (body && typeof body === 'object' && !Array.isArray(body) ? body : null) as Record<string, unknown> | null;
		if (!payload) return json({ error: 'invalid_payload' }, 400);
		const gameId = typeof payload.gameId === 'string' ? payload.gameId : '';
		const round = payload.round;
		if (!gameId || !Number.isSafeInteger(round) || Number(round) < 1) return json({ error: 'invalid_payload' }, 400);
		if (room.game_id !== gameId) return json({ ok: false, error: 'wrong_game' }, 404);
		const hash = await this.principalHash(principal);
		const state = (this.decodeState(room.state_json) ?? {}) as Record<string, unknown>;
		const result = verifyRoundWin(gameId, state, { principalHash: hash, round: Number(round) });
		if (!result) return json({ ok: false, error: 'unsupported_game' }, 404);
		if (!result.ok) return json({ ok: false, error: 'not_winner' }, 404);
		return json({ ok: true, mode: result.mode });
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
			this.broadcastMembers();
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
		this.teardown('Room expired');
	}
}

export const GAME_ROOM_LIMITS = {
	ttlMs: ROOM_TTL_MS, reconnectGraceMs: ROOM_RECONNECT_GRACE_MS, capacity: ROOM_CAPACITY,
	maxMessageBytes: ROOM_MAX_MESSAGE_BYTES, maxStateBytes: ROOM_MAX_STATE_BYTES, stateWriteIntervalMs: ROOM_STATE_WRITE_INTERVAL_MS,
	maxGlobalMessagesPerSecond: ROOM_MAX_GLOBAL_MESSAGES_PER_SECOND, protocolVersion: ROOM_PROTOCOL_VERSION,
	chat: {
		enabled: CHAT_CONFIG.enabled, maxTextLength: CHAT_CONFIG.maxTextLength, maxStoredMessages: CHAT_CONFIG.maxStoredMessages,
		burst: CHAT_CONFIG.rate.burst, refillMs: CHAT_CONFIG.rate.refillMs,
	},
};
