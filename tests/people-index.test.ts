/**
 * The people index — discovery rules, on the real schema.
 *
 * Three properties matter and each has a test here: a short or wildcard query
 * never reaches SQL as a pattern; a block in either direction removes the row
 * from BOTH sides (so the index cannot be used to discover a block); and the
 * caller's own edge arrives as `friendState`, which is what lets the panel offer
 * "Send request" instead of a button that would fail. The database is the real
 * migration set on SQLite, because the LIKE-escape and the block filter are SQL,
 * not application code.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { D1Database } from '../src/server/game-store';
import { likePatternFor, listPeople, normalizePeopleQuery } from '../src/server/people-index';
import { DIRECTORY_CONFIG } from '../src/config/directory.config';
import { createTestD1 } from './support/d1.mjs';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const NOW = 1_700_000_000_000;

function database(): D1Database {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	return db as unknown as D1Database;
}

/** Accounts need an id, a recovery hash and a display name; handle is optional. */
async function account(db: D1Database, id: string, displayName: string, handle: string | null): Promise<void> {
	await db.prepare('INSERT INTO game_players (id, recovery_hash, display_name, created_at, updated_at, handle) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
		.bind(id, id.padEnd(64, '0'), displayName, NOW, NOW, handle).run();
}

async function edge(db: D1Database, a: string, b: string, state: string, requestedBy: string): Promise<void> {
	const [first, second] = [a, b].sort();
	await db.prepare('INSERT INTO player_friends (player_a, player_b, state, requested_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
		.bind(first, second, state, requestedBy, NOW, NOW).run();
}

async function block(db: D1Database, blocker: string, blocked: string): Promise<void> {
	await db.prepare('INSERT INTO player_blocks (blocker, blocked, created_at) VALUES (?1, ?2, ?3)').bind(blocker, blocked, NOW).run();
}

test('normalizePeopleQuery is a handle fragment and nothing else', () => {
	assert.deepEqual(normalizePeopleQuery(null), { query: '' });
	assert.deepEqual(normalizePeopleQuery('  KAI_01  '), { query: 'kai_01' });
	assert.deepEqual(normalizePeopleQuery('foo'), { query: 'foo' });

	assert.deepEqual(normalizePeopleQuery('ab'), { error: 'query_too_short' });
	assert.deepEqual(normalizePeopleQuery('x'.repeat(DIRECTORY_CONFIG.maxQueryLength + 1)), { error: 'invalid_query' });
	// `%` and `\` cannot appear in a handle, so they never reach the LIKE pattern.
	assert.deepEqual(normalizePeopleQuery('%'), { error: 'query_too_short' });
	assert.deepEqual(normalizePeopleQuery('a%b'), { error: 'invalid_query' });
	assert.deepEqual(normalizePeopleQuery('a\\\\b'), { error: 'invalid_query' });
	assert.deepEqual(normalizePeopleQuery('café'), { error: 'invalid_query' });

	// `_` IS a legal handle character, so it must be escaped for LIKE — the
	// difference between finding `fo_bar` and finding `foXbar`.
	assert.equal(likePatternFor('fo_bar'), '%fo\\_bar%');
	assert.equal(likePatternFor('100%'), '%100\\%%');
});

test('listPeople labels the caller\'s own edge and hides blocks in both directions', async () => {
	const db = database();
	await account(db, 'p'.repeat(32), 'Ann', 'anne');
	await account(db, 'q'.repeat(32), 'Bea', 'bea');
	await account(db, 'r'.repeat(32), 'Cy', 'cypress');
	await account(db, 's'.repeat(32), 'Di', 'dina');
	await account(db, 't'.repeat(32), 'No Handle', null);
	const me = 'm'.repeat(32);
	await account(db, me, 'Me', 'me_self');

	const page = await listPeople(db, me, '');
	assert.deepEqual(page.people.map((row) => row.handle), ['anne', 'bea', 'cypress', 'dina'], 'an empty query lists the page alphabetically');
	assert.equal(page.people.every((row) => row.friendState === 'none'), true);
	// The account with no handle is absent, and nothing says it exists.
	assert.equal(JSON.stringify(page).includes('t'.repeat(32)), false);

	await edge(db, me, 'p'.repeat(32), 'pending', me);                     // I asked → pending_out
	await edge(db, me, 'q'.repeat(32), 'pending', 'q'.repeat(32));         // they asked → pending_in
	await edge(db, me, 'r'.repeat(32), 'accepted', me);                    // friends
	const stated = await listPeople(db, me, '');
	const stateFor = (handle: string) => stated.people.find((row) => row.handle === handle)?.friendState;
	assert.equal(stateFor('anne'), 'pending_out');
	assert.equal(stateFor('bea'), 'pending_in');
	assert.equal(stateFor('cypress'), 'friends');
	assert.equal(stateFor('dina'), 'none');

	// A block hides the row from the blocker's own search…
	await block(db, me, 's'.repeat(32));
	const blocked = await listPeople(db, me, '');
	assert.equal(blocked.people.some((row) => row.handle === 'dina'), false);
	// …and from the blocked account's search: the index must not reveal a block.
	const back = await listPeople(db, 's'.repeat(32), '');
	assert.equal(back.people.some((row) => row.handle === 'me_self'), false);
});

test('listPeople orders prefix hits first and reports truncation', async () => {
	const db = database();
	await account(db, 'p'.repeat(32), 'Ann', 'anna');
	await account(db, 'q'.repeat(32), 'Bea', 'joanna');
	await account(db, 'r'.repeat(32), 'Cy', 'annabel');
	const me = 'm'.repeat(32);
	await account(db, me, 'Me', 'me_self');

	const page = await listPeople(db, me, 'anna');
	assert.deepEqual(page.people.map((row) => row.handle), ['anna', 'annabel', 'joanna']);
	assert.equal(page.truncated, false);

	const limited = await listPeople(db, me, 'an', 1);
	assert.equal(limited.people.length, 1);
	assert.equal(limited.truncated, true);
});
