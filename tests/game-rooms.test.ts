import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { ROOM_CAPACITY, ROOM_MAX_MESSAGE_BYTES, ROOM_MAX_STATE_BYTES, ROOM_PROTOCOL_VERSION, ROOM_RECONNECT_GRACE_MS, ROOM_STATE_WRITE_INTERVAL_MS, ROOM_TTL_MS, parseRoomStateMessage, roomCanAdmitMember, roomIsExpired, roomReconnectIsAllowed } from '../src/server/game-room-protocol';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const createRoute = await import('../src/pages/api/games/rooms.ts');
const wsRoute = await import('../src/pages/api/games/rooms/[roomCode]/ws.ts');
const GUEST = '0123456789abcdef0123456789abcdef';
const GAME = 'bnji.glass-minesweeper';

function dbFixture() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	globalThis.__BNJI_TEST_BINDINGS__ = {
		BOARD_DB: db,
		BOARD_KV: { get: async () => null, put: async () => undefined },
	};
	return db;
}
function context(path: string, input: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; params?: Record<string, string> } = {}): APIContext {
	const url = `http://localhost${path}`;
	const headers = new Headers({ origin: 'http://localhost', ...(input.headers ?? {}) });
	if (input.cookie) headers.set('cookie', input.cookie);
	if (input.body !== undefined) headers.set('content-type', 'application/json');
	const request = new Request(url, { method: input.method ?? 'GET', headers, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
	return { request, url: new URL(url), params: input.params ?? {}, cookies: { get: () => undefined } } as unknown as APIContext;
}

function mockNamespace() {
	const seen: Request[] = [];
	const namespace = {
		idFromName: (name: string) => name,
		get: (_id: unknown) => ({
			fetch: async (request: Request) => {
				seen.push(request);
				return new Response(JSON.stringify(request.url.endsWith('/create') ? { created: true, expiresAt: Date.now() + ROOM_TTL_MS, capacity: ROOM_CAPACITY } : { ok: true }), {
					status: 200, headers: { 'content-type': 'application/json' },
				});
			},
		}),
	};
	return { namespace, seen };
}

test('room API overwrites client-forged principal headers with the shared validated player-context', async () => {
	const db = dbFixture();
	const fake = mockNamespace();
	globalThis.__BNJI_TEST_BINDINGS__.GAME_ROOMS = fake.namespace;
	const created = await createRoute.POST(context('/api/games/rooms', {
		method: 'POST', cookie: `bnji_ps=${GUEST}`, body: { gameId: GAME },
		headers: { 'x-bnji-verified-principal': 'player:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
	}));
	assert.equal(created.status, 200, await created.clone().text());
	const payload = await created.json() as Record<string, unknown>;
	assert.match(String(payload.roomCode), /^[A-Za-z0-9_-]{22}$/);
	assert.equal(payload.gameId, GAME);
	assert.equal(payload.capacity, ROOM_CAPACITY);
	assert.doesNotMatch(JSON.stringify(payload), /playerId|sessionId|principal|hash/i);
	assert.equal(fake.seen[0].headers.get('x-bnji-verified-principal'), `guest:${GUEST}`);
	assert.equal(new URL(fake.seen[0].url).pathname, '/create');

	const websocket = await wsRoute.GET(context(`/api/games/rooms/${payload.roomCode}/ws`, {
		cookie: `bnji_ps=${GUEST}`,
		headers: { upgrade: 'websocket', 'x-bnji-verified-principal': 'player:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
		params: { roomCode: String(payload.roomCode) },
	}));
	assert.equal(websocket.status, 200);
	assert.equal(fake.seen[1].headers.get('x-bnji-verified-principal'), `guest:${GUEST}`);
	assert.equal(fake.seen[1].headers.get('upgrade'), 'websocket');
	assert.equal(new URL(fake.seen[1].url).pathname, '/ws');
	void db;
});

test('room routes fail safely without binding, reject cross-origin mutation, and bound game/context input', async () => {
	dbFixture();
	const noBinding = await createRoute.POST(context('/api/games/rooms', { method: 'POST', body: { gameId: GAME } }));
	assert.equal(noBinding.status, 503);
	const fake = mockNamespace();
	globalThis.__BNJI_TEST_BINDINGS__.GAME_ROOMS = fake.namespace;
	const crossOrigin = await createRoute.POST(context('/api/games/rooms', { method: 'POST', body: { gameId: GAME }, headers: { origin: 'https://attacker.test' } }));
	assert.equal(crossOrigin.status, 403);
	const unknownGame = await createRoute.POST(context('/api/games/rooms', { method: 'POST', body: { gameId: 'bnji.unknown' } }));
	assert.equal(unknownGame.status, 404);
	const badCode = await wsRoute.GET(context('/api/games/rooms/not-a-room/ws', { headers: { upgrade: 'websocket' }, params: { roomCode: 'not-a-room' } }));
	assert.equal(badCode.status, 400);
	const badUpgrade = await wsRoute.GET(context(`/api/games/rooms/${'A'.repeat(22)}/ws`, { params: { roomCode: 'A'.repeat(22) } }));
	assert.equal(badUpgrade.status, 426);
	assert.equal(fake.seen.length, 0);
});

test('room protocol versions, byte bounds, shape/depth checks and CAS envelope are explicit', () => {
	const errorOf = (text: string): string => {
		const result = parseRoomStateMessage(text);
		return result.ok ? 'accepted' : result.error;
	};
	const payload = { v: ROOM_PROTOCOL_VERSION, type: 'state', baseRevision: 2, state: { board: { cells: [1, 2, 3] } } };
	const accepted = parseRoomStateMessage(JSON.stringify(payload));
	assert.equal(accepted.ok, true);
	if (accepted.ok) {
		assert.equal(accepted.message.baseRevision, 2);
		assert.deepEqual(JSON.parse(accepted.stateJson), payload.state);
	}
	assert.equal(errorOf('{'), 'invalid_json');
	assert.equal(errorOf(JSON.stringify({ ...payload, v: 99 })), 'unsupported_version');
	assert.equal(errorOf(JSON.stringify({ ...payload, state: [] })), 'invalid_state');
	assert.equal(errorOf(JSON.stringify({ ...payload, baseRevision: -1 })), 'invalid_message');
	assert.equal(errorOf(JSON.stringify({ ...payload, state: { value: 'x'.repeat(ROOM_MAX_STATE_BYTES) } })), 'state_too_large');
	assert.equal(errorOf(JSON.stringify({ ...payload, state: { value: 'x'.repeat(ROOM_MAX_MESSAGE_BYTES) } })), 'too_large');
	let deep: unknown = 'end';
	for (let index = 0; index < 14; index += 1) deep = { next: deep };
	assert.equal(errorOf(JSON.stringify({ ...payload, state: deep })), 'invalid_state');
});

test('room lifecycle policy fixes capacity, reconnect grace, absolute expiry and state-write budget', () => {
	const now = 2_000_000;
	assert.equal(roomCanAdmitMember(ROOM_CAPACITY - 1, false), true);
	assert.equal(roomCanAdmitMember(ROOM_CAPACITY, false), false);
	assert.equal(roomCanAdmitMember(ROOM_CAPACITY, true), true, 'reconnect keeps the same reserved seat');
	assert.equal(roomReconnectIsAllowed(null, now), true, 'connected member');
	assert.equal(roomReconnectIsAllowed(now + ROOM_RECONNECT_GRACE_MS, now), true, 'grace boundary is inclusive');
	assert.equal(roomReconnectIsAllowed(now + ROOM_RECONNECT_GRACE_MS - 1, now + ROOM_RECONNECT_GRACE_MS), false);
	assert.equal(roomIsExpired(now + ROOM_TTL_MS, now), false);
	assert.equal(roomIsExpired(now, now), true);
	assert.equal(ROOM_STATE_WRITE_INTERVAL_MS, 5_000);
	assert.equal(ROOM_MAX_STATE_BYTES, 3_072);
});
