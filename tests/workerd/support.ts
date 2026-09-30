/**
 * Shared harness for the workerd specs (`tests/workerd/*.spec.ts`).
 *
 * Extracted so the baseline GameRoom retro-tests and the Phase B chat tests
 * drive the DO through the exact same helpers: real upgrades, real socket
 * attachments, real DO SQLite. Not a spec file — vitest only collects
 * `*.spec.ts`.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { GameRoom } from '../../src/server/game-room-do';
import { ROOM_CAPACITY } from '../../src/server/game-room-protocol';

export const GAME = 'bnji.glass-minesweeper';
export const PRINCIPAL_A = 'guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const PRINCIPAL_B = 'guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const HEADERS = (principal: string, extra: Record<string, string> = {}): Record<string, string> => ({
	'x-bnji-verified-principal': principal,
	...extra,
});

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let roomSeq = 0;
export function uniqueRoomCode(): string {
	// Same shape as production (22 base64url chars); uniqueness keeps the
	// suite independent of cross-test storage isolation semantics.
	roomSeq += 1;
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 20) + roomSeq.toString(36).padStart(2, '0');
}

export async function principalHash(principal: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(principal));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type BoxFrame = { v?: number; type?: string; [key: string]: unknown };

/** Collects one test client's inbound frames and its close event. */
export class SocketBox {
	readonly frames: BoxFrame[] = [];
	private used = new Set<number>();
	private closedWith: { code: number; reason: string } | null = null;

	constructor(socket: WebSocket) {
		socket.addEventListener('message', (event) => {
			try { this.frames.push(JSON.parse(String(event.data)) as BoxFrame); } catch { /* not JSON */ }
		});
		socket.addEventListener('close', (event) => {
			this.closedWith = { code: event.code, reason: event.reason };
		});
		socket.accept();
	}

	/** First unconsumed frame matching `match`, or fail after `timeoutMs`. */
	async next(match: (frame: BoxFrame) => boolean, timeoutMs = 5_000): Promise<BoxFrame> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const index = this.frames.findIndex((frame, i) => !this.used.has(i) && match(frame));
			if (index >= 0) {
				this.used.add(index);
				return this.frames[index];
			}
			if (Date.now() >= deadline) {
				throw new Error(`timed out waiting for frame; saw: ${this.frames.map((frame) => String(frame.type)).join(', ') || '(none)'}`);
			}
			await delay(20);
		}
	}

	async closed(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
		const deadline = Date.now() + timeoutMs;
		while (!this.closedWith) {
			if (Date.now() >= deadline) throw new Error('timed out waiting for socket close');
			await delay(20);
		}
		return this.closedWith;
	}
}

export function stubFor(code: string) {
	const namespace = env.GAME_ROOMS;
	return namespace.get(namespace.idFromName(code));
}

export async function createRoom(code: string, principal: string, now = Date.now()): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await stubFor(code).fetch(new Request('https://room.test/create', {
		method: 'POST',
		headers: HEADERS(principal, { 'content-type': 'application/json' }),
		body: JSON.stringify({ gameId: GAME, now }),
	}));
	// Drain the body: an unread stream keeps an active reference on the
	// instance, which a later evictDurableObject() refuses to break.
	const text = await response.text();
	return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

export async function connect(code: string, principal: string, extraHeaders: Record<string, string> = {}): Promise<{ socket: WebSocket; box: SocketBox }> {
	const response = await stubFor(code).fetch(new Request('https://room.test/ws', {
		method: 'GET',
		headers: HEADERS(principal, { upgrade: 'websocket', ...extraHeaders }),
	}));
	if (response.status !== 101) throw new Error(`expected 101 upgrade, got ${response.status}: ${await response.text()}`);
	const socket = response.webSocket;
	if (!socket) throw new Error('101 response carried no webSocket');
	return { socket, box: new SocketBox(socket) };
}

/** Raw SQL reads/writes against the DO under test (storage seeding + asserts). */
export function sqlRows<T extends Record<string, SqlStorageValue>>(code: string, query: string, ...bindings: (string | number)[]): Promise<T[]> {
	return runInDurableObject(stubFor(code), (_instance: GameRoom, state: DurableObjectState) =>
		state.storage.sql.exec<T>(query, ...bindings).toArray(),
	);
}

export const snapshotOf = (frame: BoxFrame): boolean => frame.type === 'snapshot';
export { ROOM_CAPACITY };
