/** Thin browser client for the generic versioned room protocol; it never asserts game rules. */
export type RoomNotice = { v: number; type: string; gameId?: string; revision?: number; connectedMembers?: number; retryAfterMs?: number; isHost?: boolean; hasHost?: boolean; error?: string };
export async function createGameRoom(gameId: string): Promise<{ roomCode: string; expiresAt: number; capacity: number }> {
	const response = await fetch('/api/games/rooms', {
		method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gameId }),
	});
	const body = await response.json().catch(() => ({})) as Record<string, unknown>;
	if (!response.ok || typeof body.roomCode !== 'string' || typeof body.expiresAt !== 'number' || typeof body.capacity !== 'number') {
		throw new Error(typeof body.error === 'string' ? body.error : `room_create_${response.status}`);
	}
	return { roomCode: body.roomCode, expiresAt: body.expiresAt, capacity: body.capacity };
}
export function connectGameRoom(code: string, onNotice: (message: RoomNotice) => void, onStatus: (state: 'connecting' | 'connected' | 'closed' | 'error') => void): WebSocket {
	if (!/^[A-Za-z0-9_-]{22}$/.test(code)) throw new Error('invalid_room_code');
	const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
	const socket = new WebSocket(`${protocol}//${location.host}/api/games/rooms/${encodeURIComponent(code)}/ws`);
	onStatus('connecting');
	socket.addEventListener('open', () => onStatus('connected'));
	socket.addEventListener('message', (event) => {
		if (typeof event.data !== 'string' || event.data.length > 4_096) return;
		try {
			const message = JSON.parse(event.data) as RoomNotice;
			if (message && message.v === 1 && typeof message.type === 'string') onNotice(message);
		} catch { /* invalid protocol payload is ignored by this display-only client */ }
	});
	socket.addEventListener('close', () => onStatus('closed'));
	socket.addEventListener('error', () => onStatus('error'));
	return socket;
}
