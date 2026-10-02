/**
 * People index (`src/server/people-index.ts`).
 *
 * A friend-request surface that searches handles is a place where a small
 * mistake leaks a lot: the SQL must exclude the caller, exclude blocks in
 * EITHER direction, and the response must carry nothing but the two public
 * labels plus the caller's own edge.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { likePatternFor, listPeople, normalizePeopleQuery } from '../src/server/people-index';
import { DIRECTORY_CONFIG } from '../src/config/directory.config';
import type { D1Database } from '../src/server/game-store';

test('normalizePeopleQuery keeps the handle fragment vocabulary and rejects everything else', () => {
	assert.deepEqual(normalizePeopleQuery('ada_'), { query: 'ada_' });
	assert.deepEqual(normalizePeopleQuery('  ADA  '), { query: 'ada' }, 'case and surrounding space are normalised');
	assert.deepEqual(normalizePeopleQuery('a'.repeat(3)), { query: 'aaa' });
	assert.deepEqual(normalizePeopleQuery('a'.repeat(DIRECTORY_CONFIG.minQueryLength)), { query: 'a'.repeat(DIRECTORY_CONFIG.minQueryLength) });
	for (const bad of ['ab', 'a'.repeat(DIRECTORY_CONFIG.maxQueryLength + 1), 'Ada!', 'a b', 'a-b', '%', 'aaa%', "a'aa"]) {
		const result = normalizePeopleQuery(bad);
		assert.ok('error' in result, `${JSON.stringify(bad)} must be refused`);
	}
	// No fragment at all is the browse case, not an error: the ROUTE can list
	// handles, while the client is the surface that insists on a minimum.
	assert.deepEqual(normalizePeopleQuery(null), { query: '' });
	assert.deepEqual(normalizePeopleQuery(''), { query: '' });
	assert.deepEqual(normalizePeopleQuery('  '), { query: '' });
});

test('likePatternFor escapes the LIKE wildcards a handle can contain', () => {
	// `_` is a wildcard and handles are FULL of it: unescaped, `fo_bar` would
	// match `foXbar`.
	assert.equal(likePatternFor('fo_bar'), '%fo\\_bar%');
	assert.equal(likePatternFor('100%'), '%100\\%%');
	assert.equal(likePatternFor('back\\slash'), '%back\\\\slash%');
	assert.equal(likePatternFor('plain'), '%plain%');
});

test('listPeople excludes the caller and blocks in either direction in SQL', async () => {
	const sql: string[] = [];
	const db = {
		prepare(statement: string) {
			sql.push(statement);
			// One candidate, so the caller's own edges are read too.
			const results = /FROM game_players/.test(statement) ? [{ id: 'p-1', handle: 'ada', display_name: 'Ada' }] : [];
			return { bind: () => ({ all: async () => ({ results }) }) };
		},
	} as unknown as D1Database;
	await listPeople(db, 'player-self', 'ada', 30);
	assert.match(sql[0]!, /p\.id <> \?1/);
	assert.match(sql[0]!, /NOT EXISTS/);
	assert.match(sql[0]!, /b\.blocker = p\.id AND b\.blocked = \?1/);
	assert.match(sql[0]!, /b\.blocker = \?1 AND b\.blocked = p\.id/);
	assert.match(sql[0]!, /p\.handle IS NOT NULL/);
	assert.match(sql[1]!, /player_friends/);
});

test('listPeople maps each candidate to the caller relationship, and a decline back to none', async () => {
	const candidates = [
		{ id: 'p-1', handle: 'ada', display_name: 'Ada Lovelace' },
		{ id: 'p-2', handle: 'bob_', display_name: 'Bob' },
		{ id: 'p-3', handle: 'carol', display_name: 'Carol' },
		{ id: 'p-4', handle: 'dave', display_name: 'Dave' },
	];
	const edges = [
		{ player_a: 'player-self', player_b: 'p-1', state: 'accepted', requested_by: 'player-self' },
		{ player_a: 'player-self', player_b: 'p-2', state: 'pending', requested_by: 'player-self' },
		{ player_a: 'player-self', player_b: 'p-3', state: 'pending', requested_by: 'p-3' },
		{ player_a: 'player-self', player_b: 'p-4', state: 'declined', requested_by: 'player-self' },
	];
	let call = 0;
	const db = {
		prepare() {
			const results = call === 0 ? candidates : edges;
			call += 1;
			return { bind: () => ({ all: async () => ({ results }) }) };
		},
	} as unknown as D1Database;
	const page = await listPeople(db, 'player-self', 'a', 30);
	assert.deepEqual(page.people, [
		{ handle: 'ada', displayName: 'Ada Lovelace', friendState: 'friends' },
		{ handle: 'bob_', displayName: 'Bob', friendState: 'pending_out' },
		{ handle: 'carol', displayName: 'Carol', friendState: 'pending_in' },
		{ handle: 'dave', displayName: 'Dave', friendState: 'none' },
	]);
	assert.equal(page.truncated, false);
	// Nothing beyond the two public labels and the caller's own edge: no player
	// id, no session, no timestamps.
	for (const person of page.people) {
		assert.deepEqual(Object.keys(person).sort(), ['displayName', 'friendState', 'handle']);
	}
});

test('listPeople reports truncation instead of paging, and asks for one extra row to know', async () => {
	const requested: number[] = [];
	const candidates = Array.from({ length: 4 }, (_, index) => ({ id: `p-${index}`, handle: `user${index}`, display_name: `User ${index}` }));
	const db = {
		prepare(statement: string) {
			return {
				bind: (...args: unknown[]) => {
					if (/FROM game_players/.test(statement)) requested.push(Number(args[args.length - 1]));
					return { all: async () => ({ results: /FROM game_players/.test(statement) ? candidates : [] }) };
				},
			};
		},
	} as unknown as D1Database;
	const page = await listPeople(db, 'player-self', 'user', 3);
	assert.equal(page.people.length, 3);
	assert.equal(page.truncated, true);
	assert.equal(requested[0], 4, 'limit + 1 rows is what makes truncated honest');
});

test('listPeople returns an empty page without a second query when nothing matches', async () => {
	let calls = 0;
	const db = {
		prepare() {
			calls += 1;
			return { bind: () => ({ all: async () => ({ results: [] }) }) };
		},
	} as unknown as D1Database;
	const page = await listPeople(db, 'player-self', 'zzz', 30);
	assert.deepEqual(page, { people: [], truncated: false });
	assert.equal(calls, 1);
});
