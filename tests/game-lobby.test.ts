/**
 * Open-lobby listing (`src/server/game-lobby.ts`).
 *
 * The contract this file exists to protect: the list is a claim of
 * JOINABILITY, not a catalogue. Every rule that drops a row — dead room,
 * mismatched game, unparseable counts, full room, expired — is a rule that
 * stops a player clicking into a room that is not there, and every one of them
 * is tested here rather than trusted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	emptyLobbyList, listOpenLobbies, lobbyCacheKey, lobbyRowFromProbe, LOBBY_CACHE_PREFIX,
	probeRooms, readLobbyCache, readRegistryRows, writeLobbyCache,
} from '../src/server/game-lobby';
import type { D1Database } from '../src/server/game-store';
import { LOBBY_CONFIG } from '../src/config/lobby.config';

const CODE = 'a'.repeat(22);
const NOW = 1_700_000_000_000;

function entry(overrides: Partial<{ code: string; game_id: string; created_at: number; expires_at: number }> = {}) {
	return { code: CODE, game_id: 'bnji.chess', created_at: NOW - 60_000, expires_at: NOW + 600_000, ...overrides };
}
function liveProbe(overrides: Record<string, unknown> = {}) {
	return {
		live: true, gameId: 'bnji.chess', players: 2, connected: 2, capacity: 8,
		joinable: true, createdAt: NOW - 60_000, expiresAt: NOW + 600_000, revision: 3, ...overrides,
	};
}

test('lobbyRowFromProbe accepts a live, joinable, matching room', () => {
	const row = lobbyRowFromProbe(entry(), liveProbe(), NOW);
	assert.deepEqual(row, {
		roomCode: CODE, gameId: 'bnji.chess', players: 2, capacity: 8,
		createdAt: NOW - 60_000, expiresAt: NOW + 600_000, revision: 3,
	});
});

test('lobbyRowFromProbe drops every room a player could not actually join', () => {
	const cases: Array<[string, unknown]> = [
		['no response', null],
		['not an object', 'gone'],
		['live false', liveProbe({ live: false })],
		['different game', liveProbe({ gameId: 'bnji.isometric-stack' })],
		['missing gameId', liveProbe({ gameId: undefined })],
		['non-integer players', liveProbe({ players: 1.5 })],
		['negative players', liveProbe({ players: -1 })],
		['players not numeric', liveProbe({ players: 'many' })],
		['non-integer capacity', liveProbe({ capacity: 'eight' })],
		['zero capacity', liveProbe({ capacity: 0 })],
		['full room', liveProbe({ players: 8, capacity: 8 })],
		['over-full room', liveProbe({ players: 9, capacity: 8 })],
		['expired', liveProbe({ expiresAt: NOW - 1 })],
		['unparseable expiry', liveProbe({ expiresAt: 'soon' })],
	];
	for (const [label, probe] of cases) {
		assert.equal(lobbyRowFromProbe(entry(), probe, NOW), null, label);
	}
	assert.equal(lobbyRowFromProbe(entry({ code: 'short' }), liveProbe(), NOW), null, 'registry row with a malformed code');
});

test('readRegistryRows asks D1 only for unexpired rows, filtered by game when given one', async () => {
	const statements: string[] = [];
	const db = {
		prepare(sql: string) {
			statements.push(sql);
			return { bind: () => ({ all: async () => ({ results: [] }) }) };
		},
	} as unknown as D1Database;
	await readRegistryRows(db, 'bnji.chess', NOW, 24);
	await readRegistryRows(db, '', NOW, 24);
	assert.match(statements[0]!, /expires_at > \?1 AND game_id = \?2/);
	assert.match(statements[0]!, /ORDER BY created_at DESC/);
	assert.doesNotMatch(statements[1]!, /game_id =/);
	assert.match(statements[1]!, /expires_at > \?1/);
});

test('probeRooms bounds concurrency and abandons a slow room', async () => {
	let inFlight = 0;
	let peak = 0;
	const items = Array.from({ length: 12 }, (_, index) => index);
	const results = await probeRooms(items, async (item) => {
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await new Promise((resolve) => setTimeout(resolve, 5));
		inFlight -= 1;
		return item;
	}, 3, 500);
	assert.deepEqual(results, items);
	assert.ok(peak <= 3, `expected at most 3 probes in flight, saw ${peak}`);

	const timedOut = await probeRooms(['slow', 'fast'], async (item) => {
		if (item === 'slow') { await new Promise((resolve) => setTimeout(resolve, 60)); return item; }
		return item;
	}, 2, 10);
	assert.deepEqual(timedOut, [null, 'fast'], 'a room that does not answer is not listed');
});

test('probeRooms survives a probe that throws, keeping the other answers', async () => {
	const results = await probeRooms(['bad', 'good'], async (item) => {
		if (item === 'bad') throw new Error('do_unavailable');
		return 1;
	}, 2, 50);
	assert.deepEqual(results, [null, 1]);
});

test('listOpenLobbies keeps only probed-and-joinable rooms and reports staleness', async () => {
	const rows = [
		{ code: 'a'.repeat(22), game_id: 'bnji.chess', created_at: NOW, expires_at: NOW + 500_000 },
		{ code: 'b'.repeat(22), game_id: 'bnji.chess', created_at: NOW, expires_at: NOW + 900_000 },
		{ code: 'c'.repeat(22), game_id: 'bnji.chess', created_at: NOW, expires_at: NOW + 100_000 },
	];
	const db = {
		prepare() { return { bind: () => ({ all: async () => ({ results: rows }) }) }; },
	} as unknown as D1Database;
	const list = await listOpenLobbies({
		db, gameId: 'bnji.chess', now: NOW,
		probe: async (code) => (code.startsWith('a')
			? liveProbe({ expiresAt: NOW + 500_000 })
			: code.startsWith('b') ? null : liveProbe({ expiresAt: NOW + 100_000 })),
	});
	assert.deepEqual(list.lobbies.map((row) => row.roomCode), ['c'.repeat(22), 'a'.repeat(22)], 'soonest expiry first');
	assert.equal(list.stale, true, 'the room that did not answer is reported as stale');
	assert.equal(list.truncated, false);
	assert.equal(list.refreshAfterSeconds, LOBBY_CONFIG.cacheTtlSeconds);
	assert.equal(list.checkedAt, NOW);
});

test('listOpenLobbies is empty (not broken) without D1, without a game, or with the feature off', async () => {
	const db = { prepare() { throw new Error('must not be queried'); } } as unknown as D1Database;
	const probe = async () => { throw new Error('must not be probed'); };
	assert.deepEqual(await listOpenLobbies({ db: undefined, gameId: '', now: NOW, probe }), { ...emptyLobbyList(NOW) });
	assert.deepEqual(await listOpenLobbies({ db, gameId: '', now: NOW, probe, config: { ...LOBBY_CONFIG, enabled: false } }), { ...emptyLobbyList(NOW) });
});

test('lobbyCacheKey is stable per game and namespaced for the KV', () => {
	assert.equal(lobbyCacheKey('bnji.chess'), `${LOBBY_CACHE_PREFIX}bnji.chess`);
	assert.equal(lobbyCacheKey(''), `${LOBBY_CACHE_PREFIX}all`);
});

test('the lobby cache round-trips, and a broken KV degrades to uncached rather than an error', async () => {
	const kv = new Map<string, string>();
	const store = {
		async get(key: string) { return kv.get(key) ?? null; },
		async put(key: string, value: string) { kv.set(key, value); },
	};
	const list = { ...emptyLobbyList(NOW), truncated: true };
	await writeLobbyCache(store, 'k', list, 10);
	assert.deepEqual(await readLobbyCache(store, 'k'), { ...list, lobbies: [] });

	kv.set('bad', 'not json');
	assert.equal(await readLobbyCache(store, 'bad'), null);
	// A cached row whose room has since expired must not be served: the cache is
	// a short-cut, not a way to list a dead room.
	kv.set('stale', JSON.stringify({ ...list, lobbies: [{ roomCode: CODE, gameId: 'bnji.chess', players: 1, capacity: 8, createdAt: NOW, expiresAt: Date.now() - 1, revision: 0 }] }));
	assert.equal(await readLobbyCache(store, 'stale'), null);

	const failing = {
		async get() { throw new Error('kv down'); },
		async put() { throw new Error('kv down'); },
	};
	assert.equal(await readLobbyCache(failing, 'k'), null);
	assert.equal(await readLobbyCache(undefined, 'k'), null);
	await writeLobbyCache(failing, 'k', list, 10);
	await writeLobbyCache(undefined, 'k', list, 10);
});
