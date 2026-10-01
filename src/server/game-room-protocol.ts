/** Game-independent multiplayer envelope and lifecycle rules; these do not authenticate players or validate games. */
import { CHAT_CONFIG } from '../config/chat.config';
import { sanitizePlainText } from './display-name';

export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
export const ROOM_RECONNECT_GRACE_MS = 2 * 60 * 1000;
export const ROOM_CAPACITY = 8;
export const ROOM_MAX_MESSAGE_BYTES = 4 * 1024;
export const ROOM_MAX_STATE_BYTES = 3 * 1024;
export const ROOM_STATE_WRITE_INTERVAL_MS = 5_000;
/**
 * Pre-parse abuse ceiling across all frame types per connection (plan §5.4.1).
 * The OLD rule was 1 msg/s closing with 1013 — a normal typing burst killed
 * the socket. Breach still closes 1013; per-frame chat pacing is the soft
 * per-member token bucket below.
 */
export const ROOM_MAX_GLOBAL_MESSAGES_PER_SECOND = CHAT_CONFIG.rate.globalPerSecond;
/**
 * The client drops any inbound frame whose JSON exceeds this many characters
 * (src/scripts/game-rooms.ts) — every server frame (snapshots, history
 * chunks, rosters) must stay under it. Named so both ends share one value.
 */
export const ROOM_MAX_OUTBOUND_FRAME_BYTES = 4_096;
/** Game-action frames (plan: multiplayer games) carry a bounded, validated payload. */
export const ROOM_MAX_ACTION_PAYLOAD_BYTES = 2_048;
export const ROOM_PROTOCOL_VERSION = 1;

export type RoomStateMessage = { v: 1; type: 'state'; baseRevision: number; state: Record<string, unknown> };
/** Client→server game action: validated by the game's registered handler, never a raw state proposal. */
export type RoomActionSend = { v: 1; type: 'action'; action: string; payload: Record<string, unknown> };
export type RoomLeaveMessage = { v: 1; type: 'leave' };
export type RoomChatSend = { v: 1; type: 'chat'; text: string };
export type RoomChatDeleteSend = { v: 1; type: 'chat_delete'; n: number };
export type RoomKickSend = { v: 1; type: 'kick'; member: string };
export type RoomMuteSend = { v: 1; type: 'mute'; member: string };
export type RoomClientMessage = RoomStateMessage | RoomActionSend | RoomLeaveMessage | RoomChatSend | RoomChatDeleteSend | RoomKickSend | RoomMuteSend;

/** Server→client chat frames. `n` is the per-room monotone sequence and the client's dedupe key; `mine` and `source` are per-socket computed. */
export type RoomChatFrame = { v: 1; type: 'chat'; n: number; label: string; text: string; at: number; mine?: boolean; removed?: 'host' | 'self' | 'admin' };
export type RoomChatDeleteFrame = { v: 1; type: 'chat_delete'; n: number; source: 'host' | 'self' | 'admin' };
export type RoomChatHistoryFrame = { v: 1; type: 'chat_history'; messages: RoomChatFrame[]; more: boolean };
export type RoomChatRejectedFrame = { v: 1; type: 'chat_rejected'; error: string; retryAfterMs?: number };
export type RoomMemberFrame = { v: 1; type: 'members'; members: Array<{ memberId: string; label: string; isHost: boolean; isSelf: boolean; muted: boolean }> };

export type RoomMessageError = 'too_large' | 'invalid_json' | 'invalid_message' | 'unsupported_version' | 'invalid_state' | 'state_too_large' | 'action_too_large';
export type RoomMessageResult =
	| { ok: true; message: RoomClientMessage; stateJson?: string }
	| { ok: false; error: RoomMessageError };

function validJson(value: unknown): boolean {
	let count = 0;
	const visit = (item: unknown, depth: number): boolean => {
		if (++count > 1_000 || depth > 12) return false;
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
		if (typeof item === 'number') return Number.isFinite(item);
		if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
		if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
			return Object.entries(item as Record<string, unknown>).every(([key, child]) => key.length <= 128 && visit(child, depth + 1));
		}
		return false;
	};
	return visit(value, 0);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Parse only bounded, versioned room-control or CAS-state envelopes. */
export function parseRoomClientMessage(text: string): RoomMessageResult {
	if (new TextEncoder().encode(text).byteLength > ROOM_MAX_MESSAGE_BYTES) return { ok: false, error: 'too_large' };
	let value: unknown;
	try { value = JSON.parse(text); } catch { return { ok: false, error: 'invalid_json' }; }
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'invalid_message' };
	const message = value as Record<string, unknown>;
	if (message.v !== ROOM_PROTOCOL_VERSION) return { ok: false, error: 'unsupported_version' };
	if (message.type === 'leave') {
		return exactKeys(message, ['v', 'type'])
			? { ok: true, message: { v: ROOM_PROTOCOL_VERSION, type: 'leave' } }
			: { ok: false, error: 'invalid_message' };
	}
	if (message.type === 'chat') {
		// Structure only: text content is sanitised soft (chat_rejected), never
		// a socket-closing violation — a typo must not kill the connection.
		return exactKeys(message, ['v', 'type', 'text']) && typeof message.text === 'string'
			? { ok: true, message: { v: ROOM_PROTOCOL_VERSION, type: 'chat', text: message.text } }
			: { ok: false, error: 'invalid_message' };
	}
	if (message.type === 'chat_delete') {
		return exactKeys(message, ['v', 'type', 'n']) && Number.isSafeInteger(message.n) && Number(message.n) > 0
			? { ok: true, message: { v: ROOM_PROTOCOL_VERSION, type: 'chat_delete', n: Number(message.n) } }
			: { ok: false, error: 'invalid_message' };
	}
	if (message.type === 'kick' || message.type === 'mute') {
		return exactKeys(message, ['v', 'type', 'member']) && typeof message.member === 'string' && /^[a-f0-9]{24}$/.test(message.member)
			? { ok: true, message: { v: ROOM_PROTOCOL_VERSION, type: message.type, member: message.member } }
			: { ok: false, error: 'invalid_message' };
	}
	if (message.type === 'action') {
		if (!exactKeys(message, ['v', 'type', 'action', 'payload']) || typeof message.action !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(message.action)) return { ok: false, error: 'invalid_message' };
		const payload = message.payload;
		if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !validJson(payload)) return { ok: false, error: 'invalid_message' };
		let payloadJson: string;
		try { payloadJson = JSON.stringify(payload); } catch { return { ok: false, error: 'invalid_message' }; }
		if (new TextEncoder().encode(payloadJson).byteLength > ROOM_MAX_ACTION_PAYLOAD_BYTES) return { ok: false, error: 'action_too_large' };
		return { ok: true, message: { v: ROOM_PROTOCOL_VERSION, type: 'action', action: message.action, payload: payload as Record<string, unknown> } };
	}
	if (message.type !== 'state' || !exactKeys(message, ['v', 'type', 'baseRevision', 'state']) ||
		!Number.isSafeInteger(message.baseRevision) || Number(message.baseRevision) < 0) return { ok: false, error: 'invalid_message' };
	if (!message.state || typeof message.state !== 'object' || Array.isArray(message.state) || !validJson(message.state)) return { ok: false, error: 'invalid_state' };
	let stateJson: string;
	try { stateJson = JSON.stringify(message.state); } catch { return { ok: false, error: 'invalid_state' }; }
	if (new TextEncoder().encode(stateJson).byteLength > ROOM_MAX_STATE_BYTES) return { ok: false, error: 'state_too_large' };
	return {
		ok: true,
		message: { v: ROOM_PROTOCOL_VERSION, type: 'state', baseRevision: Number(message.baseRevision), state: message.state as Record<string, unknown> },
		stateJson,
	};
}

/** Backwards-compatible named parser for state-only unit tests and adapters. */
export type RoomStateMessageResult = { ok: true; message: RoomStateMessage; stateJson: string } | { ok: false; error: RoomMessageError };
export function parseRoomStateMessage(text: string): RoomStateMessageResult {
	const result = parseRoomClientMessage(text);
	if (!result.ok) return result;
	if (result.message.type !== 'state' || typeof result.stateJson !== 'string') return { ok: false, error: 'invalid_message' };
	return { ok: true, message: result.message, stateJson: result.stateJson };
}

export function roomIsExpired(expiresAt: number, now: number): boolean { return expiresAt <= now; }
export function roomReconnectIsAllowed(reconnectUntil: number | null, now: number): boolean {
	return reconnectUntil === null || reconnectUntil >= now;
}
export function roomCanAdmitMember(memberCount: number, alreadyMember: boolean, capacity = ROOM_CAPACITY): boolean {
	return alreadyMember || memberCount < capacity;
}

/** Chat message text: the shared sanitising pipeline with the chat length cap (plan §12.2). */
export type ChatTextResult = { ok: true; text: string } | { ok: false; error: 'empty' | 'too_long' };
export function sanitizeChatText(value: unknown): ChatTextResult {
	const result = sanitizePlainText(value, CHAT_CONFIG.maxTextLength);
	return result.ok ? { ok: true, text: result.value } : { ok: false, error: result.error };
}

/**
 * Per-member chat token bucket (plan §5.4.2), pure so it is unit-testable.
 * State lives in the socket attachment — it survives hibernation and costs
 * zero storage reads. Refills at 1 token / refillMs up to `burst`.
 */
export type ChatTokenState = { tokens: number; at: number };
export function consumeChatToken(
	state: ChatTokenState | null | undefined,
	now: number,
	limits: { burst: number; refillMs: number },
): { allowed: boolean; retryAfterMs: number; state: ChatTokenState } {
	const burst = limits.burst;
	const current: ChatTokenState = state && Number.isFinite(state.tokens) && Number.isFinite(state.at)
		? { tokens: Math.min(burst, state.tokens), at: state.at }
		: { tokens: burst, at: now };
	const refilled = Math.min(burst, current.tokens + (now - current.at) / limits.refillMs);
	if (refilled < 1) {
		const retryAfterMs = Math.ceil((1 - refilled) * limits.refillMs);
		return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs), state: { tokens: refilled, at: now } };
	}
	const tokens = refilled - 1;
	return { allowed: true, retryAfterMs: 0, state: { tokens, at: now } };
}

/**
 * Pack history into `chat_history` frames that respect BOTH caps: at most
 * `chunkMessages` messages AND at most ROOM_MAX_OUTBOUND_FRAME_BYTES of JSON
 * per frame — the client silently drops oversized frames, so byte-aware
 * packing (not a fixed count of 25) is what keeps history arriving.
 */
export function packChatHistory(messages: RoomChatFrame[], chunkMessages: number, maxBytes = ROOM_MAX_OUTBOUND_FRAME_BYTES): RoomChatHistoryFrame[] {
	const frames: RoomChatHistoryFrame[] = [];
	let chunk: RoomChatFrame[] = [];
	const encoder = new TextEncoder();
	// Measure the WHOLE frame — the chat_history wrapper itself costs ~55
	// bytes, and the client drops anything over the guard regardless of why.
	const frameOf = (part: RoomChatFrame[]): RoomChatHistoryFrame => ({ v: ROOM_PROTOCOL_VERSION, type: 'chat_history', messages: part, more: false });
	const fits = (part: RoomChatFrame[]): boolean => encoder.encode(JSON.stringify(frameOf(part))).byteLength <= maxBytes;
	const flush = (): void => {
		if (!chunk.length) return;
		frames.push(frameOf(chunk));
		chunk = [];
	};
	for (const message of messages) {
		if (chunk.length >= chunkMessages) flush();
		chunk.push(message);
		if (!fits(chunk) && chunk.length > 1) {
			chunk.pop();
			flush();
			chunk.push(message);
		}
	}
	flush();
	for (let index = 0; index < frames.length; index += 1) frames[index]!.more = index < frames.length - 1;
	return frames;
}

// ------------------------------------------------------- Phase C (moderation)

/**
 * Service-authentication token for the DO's `/admin/*` endpoints (plan §6.2):
 * derived from the Worker secret both sides already share — never a
 * client-supplied value, and useless without the secret itself. Returns null
 * when the secret is not configured; both the gateway and the DO treat that
 * as "admin room reads unavailable" (fail closed, same as /admin without
 * ACCESS_SECRET).
 */
export async function roomAdminServiceToken(secret: string | null | undefined): Promise<string | null> {
	if (!secret) return null;
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bnji-room-admin:v1:${secret}`));
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Header carrying the service token (Worker → DO only; never from clients). */
export const ROOM_ADMIN_HEADER = 'x-bnji-room-admin';

/**
 * Plan §6.3 blocklist check — a triage aid, not a guarantee. Case-insensitive
 * substring match over the already-sanitised text; empty terms ignored so a
 * config with `['']` is inert rather than blocking everything.
 */
export function containsBlockedTerm(text: string, blocklist: readonly string[]): boolean {
	const haystack = text.toLowerCase();
	return blocklist.some((term) => {
		const needle = term.trim().toLowerCase();
		return needle.length > 0 && haystack.includes(needle);
	});
}
/**
 * Plan §6.3 URL stripper — ADMIN TRANSCRIPT DISPLAY ONLY. Raw text in the
 * database and what room members see are never altered; this exists so a
 * moderator triaging a report cannot accidentally open a link a poster chose.
 */
export function stripUrlsForDisplay(text: string): string {
	return text.replace(/\b(?:https?:\/\/|www\.)[^\s]+/gi, '[link]');
}
