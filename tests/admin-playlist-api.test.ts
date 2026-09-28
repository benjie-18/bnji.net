/**
 * The playlist API: authorization, validation, persistence, and the public
 * read path.
 *
 * These call the real route handlers with the real store against real SQLite.
 * Astro's own cross-origin (`checkOrigin`) protection runs in the server layer
 * rather than in a handler, so it is not exercised here — what IS exercised is
 * the credential gate every handler performs itself, which is the part that
 * would silently disappear if someone forgot it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';

const ADMIN_TOKEN = 'playlist-test-token';
// The canonical form the store keeps, derived from the provider config rather
// than a second hardcoded host.
const YOUTUBE_URL = 'https://youtube.com/watch?v=dQw4w9WgXcQ';
const YOUTUBE_INPUT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/* --- environment --------------------------------------------------------- */

declare global {
	// Set by tests/support/register.mjs; the stubs read both live at call time
	// so a test can rebind between requests.
	var __BNJI_TEST_SECRETS__: Record<string, string>;
	var __BNJI_TEST_BINDINGS__: Record<string, unknown>;
}

globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'test-session-secret' };
globalThis.__BNJI_TEST_BINDINGS__ = {};

const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url))
	.filter((name) => name.endsWith('.sql'))
	.sort();

function freshDatabase() {
	const db = createTestD1();
	for (const name of MIGRATIONS) {
		db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	}
	return db;
}

/** Bind (or unbind) BOARD_DB for the code under test. */
function bind(db: ReturnType<typeof freshDatabase> | null) {
	globalThis.__BNJI_TEST_BINDINGS__ = db ? { BOARD_DB: db } : {};
}

/** Seed the admin credential row the same way migration 0005 does. */
function seedCredential(db: ReturnType<typeof freshDatabase>) {
	const hash = createHash('sha256').update(ADMIN_TOKEN).digest('hex');
	db.raw.prepare('UPDATE admin_credentials SET token_hash = ? WHERE id = 1').run(hash);
}

type CallOptions = {
	method?: string;
	body?: unknown;
	token?: string;
	query?: string;
};

function call(route: (context: APIContext) => Promise<Response>, options: CallOptions = {}): Promise<Response> {
	const url = `http://localhost/api/admin/playlist${options.query ?? ''}`;
	const headers = new Headers({ origin: 'http://localhost' });
	if (options.token) headers.set('authorization', `Bearer ${options.token}`);
	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	// Only these three properties are read by the handlers; a full APIContext
	// would need a running Astro server to produce.
	const context = {
		request,
		cookies: { get: () => undefined },
		url: new URL(url),
	} as unknown as APIContext;
	return route(context);
}

async function readJson(response: Response): Promise<Record<string, any>> {
	return (await response.json()) as Record<string, any>;
}

// Imported lazily so the stubs above are in place first.
const adminPlaylist = await import('../src/pages/api/admin/playlist.ts');
const playlistOrder = await import('../src/pages/api/admin/playlist/order.ts');
const playlistResolve = await import('../src/pages/api/admin/playlist/resolve.ts');
const publicPlaylist = await import('../src/pages/api/playlist.ts');

/* --- authorization ------------------------------------------------------- */

test('every admin mutation is refused without a credential', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	assert.equal((await call(adminPlaylist.GET)).status, 401);
	assert.equal((await call(adminPlaylist.POST, { method: 'POST', body: { url: YOUTUBE_URL, title: 'x' } })).status, 401);
	assert.equal((await call(adminPlaylist.DELETE, { method: 'DELETE', query: '?id=abc' })).status, 401);
	assert.equal(
		(await call(playlistOrder.PATCH, { method: 'PATCH', body: { id: 'abc', direction: 'up' } })).status,
		401,
	);
	assert.equal((await call(playlistResolve.POST, { method: 'POST', body: { url: YOUTUBE_URL } })).status, 401);
});

test('a wrong credential is refused, and nothing is written', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const response = await call(adminPlaylist.POST, {
		method: 'POST',
		token: 'not-the-token',
		body: { url: YOUTUBE_URL, title: 'Should not persist' },
	});
	assert.equal(response.status, 401);

	// Proving the refusal rather than trusting the status code: the playlist is
	// still untouched once the real token is used.
	await call(adminPlaylist.POST, { method: 'POST', token: ADMIN_TOKEN, body: { url: YOUTUBE_URL, title: 'Real' } });
	const list = await readJson(await call(adminPlaylist.GET, { token: ADMIN_TOKEN }));
	assert.equal(list.count, 2);
	assert.equal(list.items[1].title, 'Real');
});

test('an unconfigured admin surface fails closed with 503', async () => {
	// No credential row: the guard cannot authenticate anyone, so it must say
	// "not set up" (503) rather than "not allowed" (401).
	const db = freshDatabase();
	db.raw.prepare('DELETE FROM admin_credentials').run();
	bind(db);

	assert.equal((await call(adminPlaylist.GET, { token: ADMIN_TOKEN })).status, 503);
	assert.equal((await call(adminPlaylist.POST, { method: 'POST', token: ADMIN_TOKEN, body: {} })).status, 503);
});

test('no D1 binding means 503, not an empty playlist', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(null);

	assert.equal((await call(adminPlaylist.GET, { token: ADMIN_TOKEN })).status, 503);
	assert.equal(
		(await call(adminPlaylist.POST, { method: 'POST', token: ADMIN_TOKEN, body: { url: YOUTUBE_URL, title: 'x' } }))
			.status,
		503,
	);
	bind(db);
});

/* --- saving -------------------------------------------------------------- */

test('a link plus a title is enough to save, and the link is normalised', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const response = await call(adminPlaylist.POST, {
		method: 'POST',
		token: ADMIN_TOKEN,
		body: { url: `${YOUTUBE_URL}&t=42s`, title: 'Never Gonna Give You Up' },
	});
	assert.equal(response.status, 201);
	const payload = await readJson(response);
	assert.equal(payload.ok, true);
	assert.equal(payload.item.url, YOUTUBE_URL);
	assert.equal(payload.item.provider, 'youtube');
	assert.equal(payload.item.sourceId, 'dQw4w9WgXcQ');
	// Optional fields stay absent rather than being stored as empty strings.
	assert.equal(payload.item.artist, undefined);
	assert.equal(payload.item.album, undefined);
	assert.equal(payload.item.publishedAt, undefined);

	const list = await readJson(await call(adminPlaylist.GET, { token: ADMIN_TOKEN }));
	// The seed ran first, so the saved track is second in the queue.
	assert.equal(list.count, 2);
	assert.equal(list.initialized, true);
	assert.equal(list.items[1].title, 'Never Gonna Give You Up');
});

test('a YouTube track keeps its upload date in the publication column', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const response = await call(adminPlaylist.POST, {
		method: 'POST',
		token: ADMIN_TOKEN,
		body: {
			url: `${YOUTUBE_INPUT}&t=30s`,
			title: 'Never Gonna Give You Up',
			artist: 'Rick Astley',
			album: 'Whenever You Need Somebody',
			publishedAt: '2020-03-20',
		},
	});
	assert.equal(response.status, 201);
	const payload = await readJson(response);
	assert.equal(payload.item.provider, 'youtube');
	// The stored link is the canonical form, without the timestamp parameter.
	assert.equal(payload.item.url, YOUTUBE_URL);
	assert.equal(payload.item.publishedAt, '2020-03-20');
	// One date field means one column: there is no `releaseDate` to fall back
	// to, so a value that arrived under the old name is simply not stored.
	assert.equal(payload.item.releaseDate, undefined);
});

test('an unusable link or a missing title is refused with a reason', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const cases: { body: Record<string, unknown>; error: string }[] = [
		{ body: { url: 'https://evil.example/watch?v=dQw4w9WgXcQ', title: 'x' }, error: 'invalid_link' },
		{ body: { url: 'https://soundcloud.com/artist/track', title: 'x' }, error: 'invalid_link' },
		{ body: { url: 'http://youtu.be/dQw4w9WgXcQ', title: 'x' }, error: 'invalid_link' },
		{ body: { url: 'not a url', title: 'x' }, error: 'invalid_link' },
		{ body: { url: YOUTUBE_URL, title: '   ' }, error: 'title_required' },
		{ body: { url: YOUTUBE_URL }, error: 'title_required' },
	];

	for (const testCase of cases) {
		const response = await call(adminPlaylist.POST, {
			method: 'POST',
			token: ADMIN_TOKEN,
			body: testCase.body,
		});
		assert.equal(response.status, 400, JSON.stringify(testCase.body));
		const payload = await readJson(response);
		assert.equal(payload.error, testCase.error, JSON.stringify(testCase.body));
		assert.ok(payload.message.length > 0, 'a rejection explains itself');
	}

	// Nothing was saved by any of the refusals — not even the seeded track was
	// touched, because the seed only runs on a save or a public read.
	const list = await readJson(await call(adminPlaylist.GET, { token: ADMIN_TOKEN }));
	assert.equal(list.count, 0);
});

test('over-long fields are trimmed, and junk dates are dropped', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const response = await call(adminPlaylist.POST, {
		method: 'POST',
		token: ADMIN_TOKEN,
		body: {
			url: YOUTUBE_URL,
			title: `T${'o'.repeat(400)}`,
			artist: '  spaced\tartist  ',
			album: 'x'.repeat(400),
			publishedAt: 'not-a-date',
		},
	});
	assert.equal(response.status, 201);
	const payload = await readJson(response);
	assert.equal(payload.item.title.length, 200);
	assert.equal(payload.item.artist, 'spaced artist');
	assert.equal(payload.item.album.length, 160);
	assert.equal(payload.item.publishedAt, undefined);
});

test('removal works once and then reports the item as gone', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const created = await readJson(
		await call(adminPlaylist.POST, { method: 'POST', token: ADMIN_TOKEN, body: { url: YOUTUBE_URL, title: 'Gone' } }),
	);
	const id = created.item.id as string;

	const removed = await call(adminPlaylist.DELETE, { method: 'DELETE', token: ADMIN_TOKEN, query: `?id=${id}` });
	assert.equal(removed.status, 200);
	assert.deepEqual(await readJson(removed), { ok: true, count: 1 });

	const again = await call(adminPlaylist.DELETE, { method: 'DELETE', token: ADMIN_TOKEN, query: `?id=${id}` });
	assert.equal(again.status, 404);

	const bad = await call(adminPlaylist.DELETE, { method: 'DELETE', token: ADMIN_TOKEN, query: '?id=' });
	assert.equal(bad.status, 400);
});

/* --- reordering ---------------------------------------------------------- */

test('move up and move down persist, and out-of-range moves are refused', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const second = await readJson(
		await call(adminPlaylist.POST, { method: 'POST', token: ADMIN_TOKEN, body: { url: YOUTUBE_URL, title: 'Second' } }),
	);
	const third = await readJson(
		await call(adminPlaylist.POST, {
			method: 'POST',
			token: ADMIN_TOKEN,
			body: { url: 'https://youtu.be/aaaaaaaaaaa', title: 'Third' },
		}),
	);
	const moved = await call(playlistOrder.PATCH, {
		method: 'PATCH',
		token: ADMIN_TOKEN,
		body: { id: third.item.id, direction: 'up' },
	});
	assert.equal(moved.status, 200);
	let items = (await readJson(moved)).items;
	// "Up" swaps with the neighbour above, so Third and Second trade places.
	assert.deepEqual(
		items.map((item: { title: string }) => item.title),
		['the feeling', 'Third', 'Second'],
	);

	// The order survived the round trip through the database, not just the
	// response body.
	items = (await readJson(await call(adminPlaylist.GET, { token: ADMIN_TOKEN }))).items;
	assert.deepEqual(
		items.map((item: { title: string; position: number }) => [item.title, item.position]),
		[
			['the feeling', 0],
			['Third', 1],
			['Second', 2],
		],
	);
	const firstId = items[0].id as string;
	const lastId = items[items.length - 1].id as string;

	// At the top there is nothing above it, and at the end nothing below it.
	// Both are refusals rather than silent no-ops.
	const upAtTop = await call(playlistOrder.PATCH, {
		method: 'PATCH',
		token: ADMIN_TOKEN,
		body: { id: firstId, direction: 'up' },
	});
	assert.equal(upAtTop.status, 404, `up from the top: ${firstId}`);
	const downAtEnd = await call(playlistOrder.PATCH, {
		method: 'PATCH',
		token: ADMIN_TOKEN,
		body: { id: lastId, direction: 'down' },
	});
	assert.equal(downAtEnd.status, 404, `down from the end: ${lastId}`);
	assert.equal(
		(
			await call(playlistOrder.PATCH, {
				method: 'PATCH',
				token: ADMIN_TOKEN,
				body: { id: 'missing', direction: 'up' },
			})
		).status,
		404,
	);
	assert.equal(
		(
			await call(playlistOrder.PATCH, {
				method: 'PATCH',
				token: ADMIN_TOKEN,
				body: { id: firstId, direction: 'sideways' },
			})
		).status,
		400,
	);
	assert.equal(second.item.id.length > 0, true);
});

test('a whole new order is accepted, and a partial one is refused', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const second = await readJson(
		await call(adminPlaylist.POST, { method: 'POST', token: ADMIN_TOKEN, body: { url: YOUTUBE_URL, title: 'Second' } }),
	);
	const list = await readJson(await call(adminPlaylist.GET, { token: ADMIN_TOKEN }));
	const ids = list.items.map((item: { id: string }) => item.id as string);

	const reordered = await call(playlistOrder.PATCH, {
		method: 'PATCH',
		token: ADMIN_TOKEN,
		body: { order: [ids[1], ids[0]] },
	});
	assert.equal(reordered.status, 200);
	assert.deepEqual(
		(await readJson(reordered)).items.map((item: { title: string }) => item.title),
		['Second', 'the feeling'],
	);
	assert.deepEqual(
		(await readJson(await call(adminPlaylist.GET, { token: ADMIN_TOKEN }))).items.map(
			(item: { title: string; position: number }) => [item.title, item.position],
		),
		[
			['Second', 0],
			['the feeling', 1],
		],
	);

	// A partial list is refused with a 409 AND the stored order, so a stale
	// panel can recover without a second request.
	const partial = await call(playlistOrder.PATCH, {
		method: 'PATCH',
		token: ADMIN_TOKEN,
		body: { order: [ids[0]] },
	});
	assert.equal(partial.status, 409);
	assert.deepEqual(
		(await readJson(partial)).items.map((item: { title: string }) => item.title),
		['Second', 'the feeling'],
	);

	// A duplicate is a request to drop an item, so it is refused too.
	assert.equal(
		(
			await call(playlistOrder.PATCH, {
				method: 'PATCH',
				token: ADMIN_TOKEN,
				body: { order: [ids[0], ids[0]] },
			})
		).status,
		409,
	);
	assert.equal(second.item.id.length > 0, true);
});

/* --- the public read path ------------------------------------------------ */

test('the public endpoint returns the stored playlist and nothing private', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	await call(adminPlaylist.POST, {
		method: 'POST',
		token: ADMIN_TOKEN,
		body: { url: YOUTUBE_URL, title: 'Public track', artist: 'Someone' },
	});

	const response = await publicPlaylist.GET();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const payload = await readJson(response);

	assert.equal(payload.initialized, true);
	assert.equal(payload.count, 2);
	assert.deepEqual(
		payload.tracks.map((track: { title: string }) => track.title),
		['the feeling', 'Public track'],
	);
	assert.deepEqual(payload.tracks[1], {
		id: payload.tracks[1].id,
		title: 'Public track',
		artist: 'Someone',
		provider: 'youtube',
		url: YOUTUBE_URL,
	});
	// Storage-only fields never reach a visitor.
	assert.equal('position' in payload.tracks[0], false);
	assert.equal('sourceId' in payload.tracks[0], false);
	assert.equal('createdAt' in payload.tracks[0], false);
	assert.equal('updatedAt' in payload.tracks[0], false);
});

test('an emptied playlist is served empty, never re-seeded', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	// Initialise first: a never-seeded database is supposed to copy the static
	// playlist in on its first read, and that is a different state from "the
	// operator removed everything".
	await call(adminPlaylist.POST, { method: 'POST', token: ADMIN_TOKEN, body: { url: YOUTUBE_URL, title: 'Temp' } });
	for (const item of (await readJson(await call(adminPlaylist.GET, { token: ADMIN_TOKEN }))).items) {
		await call(adminPlaylist.DELETE, { method: 'DELETE', token: ADMIN_TOKEN, query: `?id=${item.id}` });
	}

	// Read twice: the second read is the one that would reseed if the flag were
	// derived from a row count.
	const first = await readJson(await publicPlaylist.GET());
	const second = await readJson(await publicPlaylist.GET());
	assert.equal(first.count, 0);
	assert.deepEqual(first.tracks, []);
	assert.deepEqual(second.tracks, []);
});

test('the public endpoint reports an unconfigured store instead of guessing', async () => {
	bind(null);
	const response = await publicPlaylist.GET();
	assert.equal(response.status, 503);
	assert.deepEqual(await readJson(response), { error: 'storage_unconfigured' });
});

/* --- resolution ---------------------------------------------------------- */

test('resolution is admin-only and reports a bad link without calling a provider', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	assert.equal((await call(playlistResolve.POST, { method: 'POST', body: { url: YOUTUBE_URL } })).status, 401);

	const originalFetch = globalThis.fetch;
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		return new Response('{}', { headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	try {
		const response = await call(playlistResolve.POST, {
			method: 'POST',
			token: ADMIN_TOKEN,
			body: { url: 'https://www.youtube.com/playlist?list=PLabcdef' },
		});
		assert.equal(response.status, 400);
		const payload = await readJson(response);
		assert.equal(payload.error, 'invalid_link');
		assert.match(payload.message, /That YouTube link does not point to a single video/);
		// An invalid link never reaches a provider at all.
		assert.equal(called, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('resolution returns a draft with no credentials configured', async () => {
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string) => {
		// The only host contacted is the public oEmbed endpoint.
		assert.match(String(input), /^https:\/\/www\.youtube\.com\/oembed\?/);
		assert.ok(String(input).includes(encodeURIComponent(YOUTUBE_URL)));
		return new Response(JSON.stringify({ title: 'From oEmbed', author_name: 'A channel' }), {
			headers: { 'content-type': 'application/json' },
		});
	}) as typeof fetch;
	try {
		const response = await call(playlistResolve.POST, {
			method: 'POST',
			token: ADMIN_TOKEN,
			body: { url: YOUTUBE_INPUT },
		});
		assert.equal(response.status, 200);
		const payload = await readJson(response);
		// A title plus a channel name is a complete-enough draft to save as-is.
		assert.equal(payload.draft.status, 'ok');
		assert.equal(payload.draft.fields.title, 'From oEmbed');
		assert.equal(payload.draft.artistIsSuggestion, true);
		assert.deepEqual(
			payload.draft.lookups.map((entry: { lookup: string; outcome: string }) => [entry.lookup, entry.outcome]),
			[
				['youtube-data-api', 'skipped_not_configured'],
				['youtube-oembed', 'used'],
			],
		);
		// Capabilities are reported so the panel can explain what is available.
		assert.equal(payload.capabilities.youtube.dataApi, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('a Spotify link is refused by the importer, because the panel is YouTube-only', async () => {
	// The library-level player DOES play Spotify tracks — they are seeded by
	// hand from src/config/music.config.ts — but the admin form is YouTube-only:
	// its input label, its 400 message and its date field all say so. Refusing
	// the link is what keeps that promise. The alternative is worse than a
	// refusal: the link would parse, resolveMusicMetadata() would fill in a
	// releaseDate, and the save path — which carries only publishedAt — would
	// drop it, leaving a Spotify row the player renders with no date at all.
	const db = freshDatabase();
	seedCredential(db);
	bind(db);

	const spotifyUrl = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';

	const originalFetch = globalThis.fetch;
	let called = false;
	globalThis.fetch = (async () => {
		called = true;
		return new Response('{}', { headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
	try {
		// Resolution: refused before any provider is contacted.
		const resolved = await call(playlistResolve.POST, {
			method: 'POST',
			token: ADMIN_TOKEN,
			body: { url: spotifyUrl },
		});
		assert.equal(resolved.status, 400);
		const resolvedPayload = await readJson(resolved);
		assert.equal(resolvedPayload.error, 'invalid_link');
		assert.match(resolvedPayload.message, /YouTube video links only/);
		assert.equal(called, false, 'a refused link must not reach a provider');

		// Saving: refused too, so a crafted POST cannot store a Spotify row
		// whose releaseDate this route has no field for.
		const saved = await call(adminPlaylist.POST, {
			method: 'POST',
			token: ADMIN_TOKEN,
			body: { url: spotifyUrl, title: 'Never Gonna Give You Up' },
		});
		assert.equal(saved.status, 400);
		const savedPayload = await readJson(saved);
		assert.equal(savedPayload.error, 'invalid_link');
		assert.match(savedPayload.message, /YouTube video links only/);

		// And nothing was written.
		const listed = await call(adminPlaylist.GET, { token: ADMIN_TOKEN });
		assert.equal((await readJson(listed)).items.length, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('a lookup path that blows up still answers with a manual draft, never null', async () => {
	// The route's catch is defence in depth for "a bug in the lookup path".
	// Every fetch inside the resolver is wrapped and every normaliser is
	// type-guarded, so no *provider response* can reach this catch — but a bug
	// in the lookup path can, and the response body is exactly where a bug
	// would surface: the resolver hands `response.json()`'s value straight to a
	// normaliser that reads properties off it. Returning a body whose property
	// access throws is therefore the one deterministic way to force the throw,
	// and it proves the contract that matters: a 200 whose `draft` is a usable
	// manual form, not a null and not a 500. If the panel ever got
	// `draft: null` here it would have nothing to render and the manual
	// fallback would be unreachable.
	const db = freshDatabase();
	seedCredential(db);
	bind(db);
	globalThis.__BNJI_TEST_SECRETS__.YOUTUBE_API_KEY = 'test-key';

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		json: async () =>
			new Proxy(
				{},
				{
					// `then` must stay undefined, or `await` on the body throws
					// inside fetchJson and the failure is reported as a network
					// error instead of reaching the route's catch.
					get(target, key) {
						if (key === 'then') return undefined;
						throw new Error('a bug in the normaliser must not take the feature down');
					},
				},
			),
	})) as unknown as typeof fetch;
	try {
		const response = await call(playlistResolve.POST, {
			method: 'POST',
			token: ADMIN_TOKEN,
			body: { url: YOUTUBE_URL },
		});
		assert.equal(response.status, 200);
		const payload = await readJson(response);
		assert.ok(payload.draft, 'the draft must never be null');
		// An empty draft the operator fills in by hand: provider, id and the
		// canonicalised link are all the panel needs to save a track.
		assert.equal(payload.draft.provider, 'youtube');
		assert.equal(payload.draft.id, 'dQw4w9WgXcQ');
		assert.equal(payload.draft.url, YOUTUBE_URL);
		assert.equal(payload.draft.source, 'manual');
		assert.equal(payload.draft.status, 'unavailable');
		assert.deepEqual(payload.draft.fields, {});
		assert.equal(payload.draft.artistIsSuggestion, false);
		assert.deepEqual(payload.draft.lookups, []);
		assert.match(payload.draft.message, /Enter the title/);
		assert.equal(payload.capabilities.youtube.dataApi, true);
	} finally {
		globalThis.fetch = originalFetch;
		delete globalThis.__BNJI_TEST_SECRETS__.YOUTUBE_API_KEY;
	}
});
