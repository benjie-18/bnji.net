/** Game-independent multiplayer envelope and lifecycle rules; these do not authenticate players or validate games. */
export const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
export const ROOM_RECONNECT_GRACE_MS = 2 * 60 * 1000;
export const ROOM_CAPACITY = 8;
export const ROOM_MAX_MESSAGE_BYTES = 4 * 1024;
export const ROOM_MAX_STATE_BYTES = 3 * 1024;
export const ROOM_STATE_WRITE_INTERVAL_MS = 5_000;
export const ROOM_MAX_MESSAGES_PER_SECOND = 1;
export const ROOM_PROTOCOL_VERSION = 1;

export type RoomStateMessage = { v: 1; type: 'state'; baseRevision: number; state: Record<string, unknown> };
export type RoomLeaveMessage = { v: 1; type: 'leave' };
export type RoomClientMessage = RoomStateMessage | RoomLeaveMessage;
export type RoomMessageError = 'too_large' | 'invalid_json' | 'invalid_message' | 'unsupported_version' | 'invalid_state' | 'state_too_large';
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
	if (result.message.type === 'leave' || typeof result.stateJson !== 'string') return { ok: false, error: 'invalid_message' };
	return { ok: true, message: result.message, stateJson: result.stateJson };
}

export function roomIsExpired(expiresAt: number, now: number): boolean { return expiresAt <= now; }
export function roomReconnectIsAllowed(reconnectUntil: number | null, now: number): boolean {
	return reconnectUntil === null || reconnectUntil >= now;
}
export function roomCanAdmitMember(memberCount: number, alreadyMember: boolean, capacity = ROOM_CAPACITY): boolean {
	return alreadyMember || memberCount < capacity;
}
