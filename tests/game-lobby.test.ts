/**
 * Open lobbies — the listing rules and the cache, without a network.
 *
 * `listOpenLobbies` is the one place where "is this room joinable" is decided,
 * so the tests below pin the removal rules one at a time (wrong game, not live,
 * full, expired, unreadable) and then the composition: a probe that answers for
 * one room and dies for another must yield a list with a `stale` flag, never a
 * list that quietly claims to be complete. The registry is the real
 * `room_registry` table on a real SQLite engine, because the query's
 * `expires_at > now` predicate is part of the contract.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { D1Database } from '../src/server/game-store';
import {
	emptyLobbyList,
	listOpenLobbies,
	lobbyCacheKey,
	lobbyRowFromProbe,
	readLobbyCache,
	writeLobbyCache,
	type LobbyRow,
} from '../src/server/game-lobby';
import { LOBBY_CONFIG } from '../src/config/lobby.config';
import { createTestD1 } from './support/d1.mjs';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const NOW = 1_700_000_000_000;
const CODE_A = 'A'.repeat(22);
const CODE_B = 'B'.repeat(22);

function registry(): D1Database {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	return db as unknown as D1Database;
}

async function seed(db: D1Database, rows: Array<{ code: string; gameId: string; createdAt: number; expiresAt: number }>): Promise<void> {
	for (const row of rows) {
		await db.prepare('INSERT INTO room_registry (code, game_id, owner_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
			.bind(row.code, row.gameId, 'a'.repeat(64), row.createdAt, row.expiresAt).run();
	}
}

const liveProbe = (code: string, gameId: string, extra: Record<string, unknown> = {}) => ({
	live: true, gameId, players: 1, capacity: 8, createdAt: NOW - 1_000, expiresAt: NOW + 60_000, revision: 3, ...extra,
});

test('lobbyRowFromProbe drops a room that is not exactly what it claims to be', () => {
	const entry = { code: CODE_A, game_id: 'bnji.chess', created_at: NOW - 1_000, expires_at: NOW + 60_000 };
	const row = lobbyRowFromProbe(entry, liveProbe(CODE_A, 'bnji.chess'), NOW);
	assert.deepEqual(row, {
		roomCode: CODE_A, gameId: 'bnji.chess', players: 1, capacity: 8,
		createdAt: NOW - 1_000, expiresAt: NOW + 60_000, revision: 3,
	});

	// A probe that disagrees about the game would send a player to the wrong page.
	assert.equal(lobbyRowFromProbe(entry, liveProbe(CODE_A, 'bnji.stack'), NOW), null);
	// A room that is full is not joinable, which is the only promise a row makes.
	assert.equal(lobbyRowFromProbe(entry, liveProbe(CODE_A, 'bnji.chess', { players: 8 }), NOW), null);
	// Expired, silent, or malformed answers never become rows.
	assert.equal(lobbyRowFromProbe(entry, liveProbe(CODE_A, 'bnji.chess', { expiresAt: NOW - 1 }), NOW), null);
	assert.equal(lobbyRowFromProbe(entry, null, NOW), null);
	assert.equal(lobbyRowFromProbe(entry, { live: false }, NOW), null);
	assert.equal(lobbyRowFromProbe(entry, liveProbe(CODE_A, 'bnji.chess', { players: 'many' }), NOW), null);
	// A room code that is not the registry shape is a corrupt row, not a room.
	assert.equal(lobbyRowFromProbe({ ...entry, code: 'too-short' }, liveProbe('too-short', 'bnji.chess'), NOW), null);
});

test('listOpenLobbies keeps only the rooms that answer, and says when one did not', async () => {
	const db = registry();
	await seed(db, [
		{ code: CODE_A, gameId: 'bnji.chess', createdAt: NOW - 2_000, expiresAt: NOW + 30_000 },
		{ code: CODE_B, gameId: 'bnji.chess', createdAt: NOW - 1_000, expiresAt: NOW + 90_000 },
	]);
	const list = await listOpenLobbies({
		db, gameId: 'bnji.chess', now: NOW,
		probe: async (code) => (code === CODE_A ? liveProbe(code, 'bnji.chess') : null),
	});
	assert.equal(list.lobbies.length, 1);
	assert.equal(list.lobbies[0]?.roomCode, CODE_A);
	assert.equal(list.stale, true, 'a probe that did not answer must be reported, not hidden');
	assert.equal(list.refreshAfterSeconds, LOBBY_CONFIG.cacheTtlSeconds);

	// All-silent is an empty list and still honest about it.
	const empty = await listOpenLobbies({ db, gameId: 'bnji.chess', now: NOW, probe: async () => null });
	assert.deepEqual(empty.lobbies, []);
	assert.equal(empty.stale, true);

	// Rows past their expiry are not candidates at all.
	const gone = await listOpenLobbies({ db, gameId: 'bnji.chess', now: NOW + 200_000, probe: async (code) => liveProbe(code, 'bnji.chess') });
	assert.deepEqual(gone.lobbies, []);
	assert.equal(gone.stale, false);
});

test('listOpenLobbies leaves out another game and stays empty when disabled', async () => {
	const db = registry();
	await seed(db, [{ code: CODE_A, gameId: 'bnji.chess', createdAt: NOW, expiresAt: NOW + 60_000 }]);
	const other = await listOpenLobbies({ db, gameId: 'bnji.stack', now: NOW, probe: async (code) => liveProbe(code, 'bnji.chess') });
	assert.deepEqual(other.lobbies, []);

	const disabled = await listOpenLobbies({
		db, gameId: 'bnji.chess', now: NOW,
		probe: async (code) => liveProbe(code, 'bnji.chess'),
		config: { ...LOBBY_CONFIG, enabled: false },
	});
	assert.deepEqual(disabled.lobbies, []);
	assert.deepEqual(disabled, emptyLobbyList(NOW));
});

test('truncated is reported when the registry holds more rooms than one page', async () => {
	const db = registry();
	const rows = Array.from({ length: 3 }, (_, index) => ({
		code: String.fromCharCode(65 + index).repeat(22),
		gameId: 'bnji.chess',
		createdAt: NOW - index,
		expiresAt: NOW + 60_000,
	}));
	await seed(db, rows);
	const list = await listOpenLobbies({
		db, gameId: 'bnji.chess', now: NOW,
		probe: async (code) => liveProbe(code, 'bnji.chess'),
		config: { ...LOBBY_CONFIG, listLimit: 2 },
	});
	assert.equal(list.lobbies.length, 2);
	assert.equal(list.truncated, true);
	// Soonest expiry first: the rooms a player can still catch come first.
	assert.ok(list.lobbies[0]!.expiresAt <= list.lobbies[1]!.expiresAt);
});

test('the lobby cache round-trips a list and refuses anything else', async () => {
	const store = new Map<string, string>();
	const kv = {
		async get(key: string) { return store.get(key) ?? null; },
		async put(key: string, value: string) { store.set(key, value); },
	};
	// The cache validator compares expiry against the real clock (a stored list
	// must not resurrect an expired room), so this row has to be future-dated.
	const row: LobbyRow = { roomCode: CODE_A, gameId: 'bnji.chess', players: 1, capacity: 8, createdAt: Date.now() - 1, expiresAt: Date.now() + 60_000, revision: 0 };
	const list = { lobbies: [row], truncated: false, stale: false, checkedAt: NOW, refreshAfterSeconds: LOBBY_CONFIG.cacheTtlSeconds };
	const key = lobbyCacheKey('bnji.chess');
	assert.equal(key, 'bnji-lobby:bnji.chess');
	assert.equal(lobbyCacheKey(''), 'bnji-lobby:all');

	await writeLobbyCache(kv, key, list, LOBBY_CONFIG.cacheTtlSeconds);
	assert.deepEqual(await readLobbyCache(kv, key), list);

	store.set(key, '{"nope":true}');
	assert.equal(await readLobbyCache(kv, key), null);
	store.set(key, `{"lobbies":[{"roomCode":"short"}],"checkedAt":${NOW}}`);
	assert.equal(await readLobbyCache(kv, key), null);

	// A KV that throws is a cache miss, never an error: the list still works.
	const broken = { async get(): Promise<string | null> { throw new Error('kv down'); }, async put(): Promise<void> { throw new Error('kv down'); } };
	assert.equal(await readLobbyCache(broken, key), null);
	await writeLobbyCache(broken, key, list, 10);
	await writeLobbyCache(undefined, key, list, 10);
});
