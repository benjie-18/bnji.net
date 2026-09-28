/**
 * D1 persistence: the seed-once rule, and the order being a stored fact.
 *
 * These run the real store against real SQLite through the D1-shaped adapter
 * in tests/support/d1.mjs, including the real migration file. The UNIQUE
 * constraint on `position` is load-bearing for the reorder logic, so it is
 * exercised rather than assumed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { MUSIC_SOURCE } from '../src/config/music.config.ts';
import { getMusicPlaylistStore, toMusicTrack, type StoredPlaylistItem } from '../src/server/music-store.ts';
import { createTestD1 } from './support/d1.mjs';

/** Every migration, in the order D1 applies them. */
const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url))
	.filter((name) => name.endsWith('.sql'))
	.sort();

function seededStore() {
	const db = createTestD1();
	for (const name of MIGRATIONS) {
		db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	}
	const store = getMusicPlaylistStore({ BOARD_DB: db });
	assert.ok(store, 'BOARD_DB must produce a store');
	if (!store) throw new Error('unreachable');
	return { db, store };
}

function newItem(overrides: Partial<StoredPlaylistItem> = {}) {
	return {
		id: overrides.id ?? crypto.randomUUID(),
		title: overrides.title ?? 'Untitled',
		provider: overrides.provider ?? 'youtube',
		url: overrides.url ?? 'https://youtube.com/watch?v=dQw4w9WgXcQ',
		sourceId: overrides.sourceId ?? 'dQw4w9WgXcQ',
		artist: overrides.artist,
		album: overrides.album,
		publishedAt: overrides.publishedAt,
	};
}

test('an unconfigured environment yields no store, not an empty playlist', () => {
	// 503 storage_unconfigured is the honest answer; a null playlist would look
	// like "the operator deleted everything".
	assert.equal(getMusicPlaylistStore({}), null);
	assert.equal(getMusicPlaylistStore({ BOARD_DB: {} }), null);
});

test('the store applies the migration and starts uninitialised and empty', async () => {
	const { db, store } = seededStore();
	assert.equal(store.kind, 'd1');
	assert.equal(await store.isInitialized(), false);
	assert.deepEqual(await store.list(), []);

	// The state row exists with the flag down, so "not initialised" is a stored
	// fact rather than an inference from an empty table.
	const row = db.raw.prepare('SELECT seeded FROM music_playlist_state WHERE id = 1').get() as
		| { seeded?: number }
		| undefined;
	assert.ok(row, 'the state row must exist from migration time');
	assert.equal(row.seeded, 0);
});

test('seeding copies the static playlist once, in order', async () => {
	const { store } = seededStore();

	const first = await store.ensureSeeded();
	assert.equal(await store.isInitialized(), true);
	assert.equal(first.length, MUSIC_SOURCE.tracks.length);
	assert.deepEqual(
		first.map((item) => item.title),
		MUSIC_SOURCE.tracks.map((track) => track.title),
	);
	assert.deepEqual(
		first.map((item) => item.position),
		MUSIC_SOURCE.tracks.map((_track, index) => index),
	);
	// The seed keeps the config's own id, which is what makes it idempotent.
	assert.equal(first[0]?.id, MUSIC_SOURCE.tracks[0]?.id);
	assert.equal(first[0]?.provider, 'file');
});

test('seeding again is a no-op, including after items are added', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();
	await store.add(newItem({ title: 'Added later' }));

	const again = await store.ensureSeeded();
	assert.equal(again.length, MUSIC_SOURCE.tracks.length + 1);
	// The static playlist is not re-appended: the flag, not the row count, is
	// what decides.
	assert.equal(again.filter((item) => item.id === MUSIC_SOURCE.tracks[0]?.id).length, 1);
});

test('an emptied playlist stays empty and is never re-seeded', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();
	for (const item of await store.list()) await store.remove(item.id);

	assert.deepEqual(await store.list(), []);
	// The load-bearing assertion of this whole feature: a COUNT(*) = 0 check
	// would reseed here and silently undo the operator's decision.
	assert.deepEqual(await store.ensureSeeded(), []);
	assert.equal((await store.list()).length, 0);
});

test('add appends at the end and stores every field', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();

	const added = await store.add(
		newItem({
			title: 'Blinding Lights',
			artist: 'The Weeknd',
			album: 'After Hours',
			publishedAt: '2020-03-20',
			sourceId: '0VjIjW4GlUZAMYd2vXMi3b',
		}),
	);
	const items = await store.list();

	assert.equal(added.position, MUSIC_SOURCE.tracks.length);
	assert.equal(items.at(-1)?.id, added.id);
	assert.equal(items.at(-1)?.publishedAt, '2020-03-20');
	assert.equal(items.at(-1)?.sourceId, '0VjIjW4GlUZAMYd2vXMi3b');
	assert.ok(added.createdAt > 0);
});

test('remove deletes the row and closes the gap in the order', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();
	const second = await store.add(newItem({ title: 'Second' }));
	const third = await store.add(newItem({ title: 'Third' }));

	assert.equal(await store.remove(second.id), true);
	const items = await store.list();
	assert.deepEqual(
		items.map((item) => [item.title, item.position]),
		[
			[MUSIC_SOURCE.tracks[0]?.title, 0],
			['Third', 1],
		],
	);
	// Positions stay dense, so a later add lands where it looks like it should.
	const fourth = await store.add(newItem({ title: 'Fourth' }));
	assert.equal(fourth.position, 2);
	assert.equal(await store.remove(second.id), false);
	assert.equal(await store.remove('nope'), false);
});

test('move swaps with the neighbour and refuses out-of-range moves', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();
	const second = await store.add(newItem({ title: 'Second' }));

	assert.equal(await store.move(second.id, 'up'), true);
	let items = await store.list();
	assert.deepEqual(
		items.map((item) => item.title),
		['Second', MUSIC_SOURCE.tracks[0]?.title],
	);
	assert.deepEqual(
		items.map((item) => item.position),
		[0, 1],
	);

	// Already at the top: there is nothing to swap with, and the answer is
	// "no" rather than a silent success that changed nothing.
	assert.equal(await store.move(second.id, 'up'), false);
	assert.equal(await store.move(MUSIC_SOURCE.tracks[0]?.id ?? '', 'down'), false);
	assert.equal(await store.move('missing', 'up'), false);

	assert.equal(await store.move(second.id, 'down'), true);
	items = await store.list();
	assert.deepEqual(
		items.map((item) => item.title),
		[MUSIC_SOURCE.tracks[0]?.title, 'Second'],
	);
});

test('reorder persists a whole new order', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();
	const b = await store.add(newItem({ title: 'B' }));
	const c = await store.add(newItem({ title: 'C' }));
	const a = MUSIC_SOURCE.tracks[0]?.id ?? '';

	assert.equal(await store.reorder([b.id, c.id, a]), true);
	assert.deepEqual(
		(await store.list()).map((item) => item.title),
		['B', 'C', MUSIC_SOURCE.tracks[0]?.title],
	);
	// Positions are rewritten, not just read in a different order.
	assert.deepEqual(
		(await store.list()).map((item) => item.position),
		[0, 1, 2],
	);

	// Reversing again must work: the offset-then-rewrite path cannot depend on
	// the previous state being tidy.
	assert.equal(await store.reorder([a, c.id, b.id]), true);
	assert.deepEqual(
		(await store.list()).map((item) => item.title),
		[MUSIC_SOURCE.tracks[0]?.title, 'C', 'B'],
	);
});

test('reorder refuses a list that is not exactly the stored set', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();
	const b = await store.add(newItem({ title: 'B' }));
	const c = await store.add(newItem({ title: 'C' }));
	const a = MUSIC_SOURCE.tracks[0]?.id ?? '';
	const before = (await store.list()).map((item) => item.title);

	// A partial list is a request to delete the missing items, which is not
	// what a reorder means — so it is refused rather than half-applied.
	assert.equal(await store.reorder([a, b.id]), false);
	// A duplicate would silently drop an item from the order.
	assert.equal(await store.reorder([a, b.id, b.id]), false);
	// An unknown id is a mismatch with what is stored.
	assert.equal(await store.reorder([a, b.id, 'ghost']), false);
	// An empty list against a non-empty playlist is the same refusal.
	assert.equal(await store.reorder([]), false);

	assert.deepEqual(
		(await store.list()).map((item) => item.title),
		before,
	);
	assert.ok(c.id.length > 0);
});

test('a large reorder stays consistent (the position constraint holds)', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();

	const ids: string[] = [];
	for (let index = 0; index < 60; index += 1) {
		ids.push((await store.add(newItem({ title: `Track ${index}` }))).id);
	}
	const all = (await store.list()).map((item) => item.id);
	const shuffled = [...all].reverse();

	assert.equal(await store.reorder(shuffled), true);
	assert.deepEqual(
		(await store.list()).map((item) => item.id),
		shuffled,
	);
	assert.deepEqual(
		(await store.list()).map((item) => item.position),
		all.map((_id, index) => index),
	);
	// Every id survived, exactly once.
	assert.equal(new Set((await store.list()).map((item) => item.id)).size, all.length);
	assert.ok(ids.length === 60);
});

test('the stored item maps onto the player model with its own date field', async () => {
	const { store } = seededStore();
	await store.ensureSeeded();
	const added = await store.add(
		newItem({
			title: 'Song',
			artist: 'Artist',
			album: 'Album',
			publishedAt: '2024-05-01',
		}),
	);

	const track = toMusicTrack(added);
	assert.deepEqual(track, {
		id: added.id,
		title: 'Song',
		artist: 'Artist',
		album: 'Album',
		publishedAt: '2024-05-01',
		provider: 'youtube',
		url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
	});
	// The player's model has no storage-only fields leaking into it.
	assert.equal('position' in track, false);
	assert.equal('sourceId' in track, false);
	assert.equal('createdAt' in track, false);
});

test('a Spotify row is a live track, read and mapped with its own date field', async () => {
	// All three providers are live in this build, so the storage CHECK and
	// ACTIVE_PROVIDERS agree and the skip path in `rowToItem` has no reachable
	// input. What is worth pinning is the other half of that change: a Spotify
	// row is played, not skipped, and its album date lands in `releaseDate`
	// rather than being forced into `publishedAt`.
	const { db, store } = seededStore();
	await store.ensureSeeded();
	const before = await store.list();
	assert.ok(before.length > 0, 'the seeded playlist is not empty');

	db.raw
		.prepare(
			`INSERT INTO music_playlist_items
			   (id, position, title, provider, url, release_date, created_at, updated_at)
			 VALUES (?, ?, ?, 'spotify', ?, ?, 1, 1)`,
		)
		.run(
			'legacy-1',
			before.length,
			'a Spotify track',
			'https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6',
			'2019-11-15',
		);

	// The row is really there.
	assert.equal(
		(
			db.raw
				.prepare("SELECT COUNT(*) AS n FROM music_playlist_items WHERE provider = 'spotify'")
				.get() as { n: number }
		).n,
		1,
		'the spotify row must still exist',
	);

	// And readable, with the date in the field that matches the provider.
	const after = await store.list();
	const spotify = after.find((item) => item.id === 'legacy-1');
	assert.ok(spotify, 'a spotify row must be readable, not skipped');
	assert.equal(spotify?.provider, 'spotify');
	assert.equal(spotify?.releaseDate, '2019-11-15');
	assert.equal(spotify?.publishedAt, undefined, 'the upload date must stay empty');

	// The public shape carries it through, and still carries nothing private.
	const track = toMusicTrack(spotify!);
	assert.equal(track.releaseDate, '2019-11-15');
	assert.equal(track.publishedAt, undefined);
	assert.equal('createdAt' in track, false);
});
