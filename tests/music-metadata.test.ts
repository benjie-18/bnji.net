/**
 * Metadata resolution: per-provider field mapping, the manual fallback that has
 * to work when no credential is configured, and the one property that matters
 * most — the resolver never fetches what was pasted.
 *
 * Every provider response here is a stub `fetch`, so the suite needs no network
 * and no credentials — which is the same condition the fallback is designed
 * for. The assertions on `lookups` are the important ones: they are what the
 * admin panel reads to tell the operator WHY a field is blank.
 *
 * There is a Spotify section. Its shape mirrors the YouTube one on purpose:
 * both providers have a credentialed path, a public oEmbed fallback, and a
 * manual last resort, and the two must not drift apart in behaviour.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_PROVIDER_URLS } from '../src/config/music.config.ts';
import {
	cleanMusicText,
	normalizeMusicDate,
	resetSpotifyTokenCache,
	resolveMusicMetadata,
} from '../src/server/music-metadata.ts';
import { parseMusicLink } from '../src/server/music-links.ts';

const YOUTUBE_ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://${MUSIC_PROVIDER_URLS.youtube.hosts[0]}/watch?v=${YOUTUBE_ID}`;

const YOUTUBE_VIDEO = {
	items: [
		{
			snippet: {
				title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
				channelTitle: 'Rick Astley',
				publishedAt: '2009-10-25T07:57:33Z',
			},
		},
	],
};

/** A minimal Response stand-in: the lookup path only reads ok/status/json(). */
function jsonResponse(data: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => data,
	} as unknown as Response;
}

/** Record every URL requested, so a test can prove nothing else was fetched. */
function recorder(handler: (url: string) => Response | Promise<Response>) {
	const calls: string[] = [];
	const fetchImpl = (async (input: string) => {
		const url = String(input);
		calls.push(url);
		return handler(url);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

function youtubeLink(value = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`) {
	const link = parseMusicLink(value);
	assert.ok(link.ok);
	if (!link.ok) throw new Error('unreachable');
	return link;
}

/* --- normalisation helpers ------------------------------------------------ */

test('cleanMusicText strips control characters and caps length', () => {
	assert.equal(cleanMusicText('  hello\u0000world  ', 100), 'hello world');
	assert.equal(cleanMusicText('a\u001fb', 100), 'a b');
	assert.equal(cleanMusicText('x'.repeat(50), 10).length, 10);
	assert.equal(cleanMusicText(null, 10), '');
	assert.equal(cleanMusicText(42, 10), '');
	// A legitimate ampersand survives: the value is never markup, so it does
	// not need escaping and mangling it would be worse than leaving it.
	assert.equal(cleanMusicText('Rock & Roll <live>', 100), 'Rock & Roll <live>');
});

test('normalizeMusicDate accepts both providers\u2019 date shapes and rejects junk', () => {
	assert.equal(normalizeMusicDate('2009-10-25'), '2009-10-25');
	// YouTube sends a full timestamp; only the date part is meaningful.
	assert.equal(normalizeMusicDate('2009-10-25T07:57:33Z'), '2009-10-25');
	// A partial precision is kept as given rather than padded into one the
	// provider never claimed. This is a Spotify case specifically: its
	// `release_date` carries a `release_date_precision` of year, month or day,
	// so a bare `2009` or `2009-10` is what the API actually reported.
	assert.equal(normalizeMusicDate('2009'), '2009');
	assert.equal(normalizeMusicDate('2009-10'), '2009-10');
	assert.equal(normalizeMusicDate('not a date'), '');
	assert.equal(normalizeMusicDate('25/10/2009'), '');
	assert.equal(normalizeMusicDate(''), '');
	assert.equal(normalizeMusicDate(undefined), '');
});

/* --- YouTube Data API ----------------------------------------------------- */

test('the Data API fills the draft and the channel name is flagged as a suggestion', async () => {
	const { calls, fetchImpl } = recorder(() => jsonResponse(YOUTUBE_VIDEO));

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'test-key' }, { fetchImpl });

	assert.equal(result.status, 'ok');
	assert.equal(result.source, 'youtube-data-api');
	assert.equal(result.fields.title, 'Rick Astley - Never Gonna Give You Up (Official Video)');
	assert.equal(result.fields.artist, 'Rick Astley');
	assert.equal(result.fields.publishedAt, '2009-10-25');
	// A channel name is who uploaded it, not credited metadata. The panel has
	// to be able to say so, so the flag travels with the draft.
	assert.equal(result.artistIsSuggestion, true);
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[['youtube-data-api', 'used']],
	);
	// One request, to the fixed Data API endpoint, built from the validated id.
	assert.equal(calls.length, 1);
	assert.match(calls[0]!, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?/);
	assert.ok(calls[0]!.includes(`id=${YOUTUBE_ID}`));
});

test('the API key is used for exactly one request and never leaves the server', async () => {
	const { calls, fetchImpl } = recorder(() => jsonResponse(YOUTUBE_VIDEO));

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'super-secret-key' }, { fetchImpl });

	// It travels in the query string of the one request it authorises, which is
	// how the Data API is called from a server. What must never happen is it
	// appearing anywhere the operator or a visitor could read it back.
	const serialised = JSON.stringify(result);
	assert.ok(!serialised.includes('super-secret-key'), 'the key must not be serialised');
	assert.ok(!serialised.includes('key=super-secret-key'));
	assert.equal(calls.length, 1);
});

test('a video the API does not return falls through to oEmbed', async () => {
	// A deleted, private or region-blocked video answers 200 with an empty
	// items array. That is not a failure of the key, so oEmbed still runs.
	const { calls, fetchImpl } = recorder((url) =>
		url.includes('googleapis.com') ? jsonResponse({ items: [] }) : jsonResponse({ title: 'From oEmbed' }),
	);

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'test-key' }, { fetchImpl });

	assert.equal(result.source, 'youtube-oembed');
	assert.equal(result.fields.title, 'From oEmbed');
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['youtube-data-api', 'empty'],
			['youtube-oembed', 'used'],
		],
	);
	assert.equal(calls.length, 2);
});

test('a quota error is reported, not hidden, and oEmbed still runs', async () => {
	const { calls, fetchImpl } = recorder((url) =>
		url.includes('googleapis.com') ? jsonResponse({ error: 'quotaExceeded' }, 403) : jsonResponse({ title: 'From oEmbed' }),
	);

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'test-key' }, { fetchImpl });

	assert.equal(result.source, 'youtube-oembed');
	assert.equal(result.fields.title, 'From oEmbed');
	const dataApi = result.lookups.find((entry) => entry.lookup === 'youtube-data-api');
	assert.equal(dataApi?.outcome, 'failed');
	assert.equal(dataApi?.detail, 'http_403');
	// The detail names the HTTP status, never the key.
	assert.ok(!JSON.stringify(result).includes('test-key'));
});

test('an unreachable provider leaves a fully manual draft', async () => {
	const { fetchImpl } = recorder(() => {
		throw new Error('network is down');
	});

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'test-key' }, { fetchImpl });

	assert.equal(result.status, 'unavailable');
	assert.equal(result.source, 'manual');
	assert.deepEqual(result.fields, {});
	assert.equal(result.artistIsSuggestion, false);
	assert.match(result.message, /Enter the title/);
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['youtube-data-api', 'failed'],
			['youtube-oembed', 'failed'],
		],
	);
});

/* --- no key configured ---------------------------------------------------- */

test('with no key at all the draft is manual and says why', async () => {
	const { calls, fetchImpl } = recorder(() => jsonResponse({ title: 'From oEmbed', author_name: 'A channel' }));

	const result = await resolveMusicMetadata(youtubeLink(), {}, { fetchImpl });

	assert.equal(result.source, 'youtube-oembed');
	assert.equal(result.fields.title, 'From oEmbed');
	assert.equal(result.fields.artist, 'A channel');
	assert.equal(result.artistIsSuggestion, true);
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['youtube-data-api', 'skipped_not_configured'],
			['youtube-oembed', 'used'],
		],
	);
	assert.equal(result.lookups[0]?.detail, 'YOUTUBE_API_KEY not set');
	// The name of the missing variable is operator-facing detail; the value of
	// a configured one would never be.
	assert.ok(!JSON.stringify(result).includes('YOUTUBE_API_KEY='));
	assert.equal(calls.length, 1);
});

test('a title alone is a partial draft, and the panel is told so', async () => {
	const { fetchImpl } = recorder(() => jsonResponse({ title: 'Only a title' }));

	const result = await resolveMusicMetadata(youtubeLink(), {}, { fetchImpl });

	assert.equal(result.status, 'partial');
	assert.equal(result.fields.title, 'Only a title');
	assert.equal(result.fields.artist, undefined);
	assert.equal(result.fields.publishedAt, undefined);
	assert.equal(result.artistIsSuggestion, false);
	assert.match(result.message, /Only a title came back/);
});

test('the oEmbed embed HTML is never used, only its title and channel', async () => {
	const { fetchImpl } = recorder(() =>
		jsonResponse({
			title: 'A video',
			author_name: 'A channel',
			// Third-party markup. Rendering it would inject whatever a provider
			// chose into an admin page, so the normalizer drops it entirely.
			html: '<iframe src="https://evil.example"></iframe>',
			thumbnail_url: 'https://i.ytimg.com/vi/x/default.jpg',
		}),
	);

	const result = await resolveMusicMetadata(youtubeLink(), {}, { fetchImpl });

	assert.deepEqual(result.fields, { title: 'A video', artist: 'A channel' });
});

test('the importer never fetches the submitted URL', async () => {
	// The only hosts that may be contacted are the fixed provider endpoints in
	// config. If the lookup path ever fetched what was pasted, this test would
	// see it: the pasted link carries a host that is not on that list.
	const { calls, fetchImpl } = recorder(() => jsonResponse({ title: 'nope' }));
	const link = parseMusicLink('https://youtu.be/dQw4w9WgXcQ?utm_source=evil.example');
	assert.ok(link.ok);
	if (!link.ok) return;
	await resolveMusicMetadata(link, {}, { fetchImpl });

	for (const call of calls) {
		assert.match(
			call,
			/^https:\/\/(www\.youtube\.com|www\.googleapis\.com)\//,
		);
	}
	// The canonical link is rebuilt from the id, so the tracking parameter the
	// operator pasted is not in the oEmbed query either.
	assert.ok(calls.every((call) => !call.includes('evil.example')));
});

/* --- Spotify -------------------------------------------------------------- */

const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';
const SPOTIFY_CANONICAL = `https://open.spotify.com/track/${SPOTIFY_ID}`;

const SPOTIFY_TRACK = {
	name: 'Never Gonna Give You Up',
	artists: [{ name: 'Rick Astley' }],
	album: { name: 'Whenever You Need Somebody', release_date: '1987-11-07' },
};

function spotifyLink() {
	const link = parseMusicLink(SPOTIFY_CANONICAL);
	assert.ok(link.ok);
	if (!link.ok) throw new Error('unreachable');
	return link;
}

/** The Client Credentials exchange plus the track call, in one stub. */
function spotifyFetch(handler: (url: string) => Response | Promise<Response>) {
	return recorder(handler);
}

test('a Spotify track maps onto its own fields, with the album release date', async () => {
	resetSpotifyTokenCache();
	const { calls, fetchImpl } = spotifyFetch((url) =>
		url === MUSIC_PROVIDER_URLS.spotify.tokenUrl
			? jsonResponse({ access_token: 'token', expires_in: 3600 })
			: jsonResponse(SPOTIFY_TRACK),
	);

	const resolved = await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
		{ fetchImpl, now: () => 0 },
	);

	assert.deepEqual(resolved.fields, {
		title: 'Never Gonna Give You Up',
		artist: 'Rick Astley',
		album: 'Whenever You Need Somebody',
		releaseDate: '1987-11-07',
	});
	// A Spotify upload date is not a thing, so the field stays absent rather
	// than being filled with the album date by a mapping that "looks close".
	// The `in` check rather than a property read: `deepEqual` above already
	// pins the exact key set, and this states the intent for a reader.
	assert.ok(!('publishedAt' in resolved.fields));
	assert.equal(resolved.source, 'spotify-web-api');
	assert.equal(resolved.status, 'ok');

	// The token is cached, so a second resolution does not exchange again.
	const before = calls.length;
	await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
		{ fetchImpl, now: () => 1_000 },
	);
	assert.equal(calls.length, before + 1, 'the cached token must not be re-exchanged');
});

test('a refused token falls back to oEmbed, and neither is fatal', async () => {
	resetSpotifyTokenCache();
	const { calls, fetchImpl } = spotifyFetch((url) =>
		url === MUSIC_PROVIDER_URLS.spotify.tokenUrl
			? jsonResponse({ error: 'invalid_client' }, 400)
			: jsonResponse({ title: 'Never Gonna Give You Up' }),
	);

	const resolved = await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
		{ fetchImpl, now: () => 0 },
	);

	assert.equal(resolved.source, 'spotify-oembed');
	assert.equal(resolved.status, 'partial');
	// The report says which lookup ran and why the other did not, so the panel
	// can tell the operator that a credential is missing rather than broken.
	assert.deepEqual(
		resolved.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['spotify-web-api', 'failed'],
			['spotify-oembed', 'used'],
		],
	);
	// Spotify's oEmbed credits no artist, so none is invented.
	assert.equal(resolved.fields.artist, undefined);
	assert.ok(calls.some((call) => call.startsWith(MUSIC_PROVIDER_URLS.spotify.oEmbed)));
});

test('no Spotify credentials at all is a skipped lookup, not a failure', async () => {
	resetSpotifyTokenCache();
	const { calls, fetchImpl } = spotifyFetch(() => jsonResponse({ title: 'Never Gonna Give You Up' }));

	const resolved = await resolveMusicMetadata(spotifyLink(), {}, { fetchImpl, now: () => 0 });

	assert.equal(resolved.status, 'partial');
	assert.equal(
		resolved.lookups[0]?.detail,
		'SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set',
	);
	// Exactly one call, and it is the credential-free public endpoint: an
	// unconfigured provider is not "no lookup", it is the fallback lookup.
	assert.equal(calls.length, 1);
	assert.ok(calls[0]?.startsWith(MUSIC_PROVIDER_URLS.spotify.oEmbed));
	// And the token endpoint was never touched.
	assert.ok(!calls.some((call) => call === MUSIC_PROVIDER_URLS.spotify.tokenUrl));
});

test('a Spotify resolution only ever requests Spotify hosts', async () => {
	resetSpotifyTokenCache();
	const { calls, fetchImpl } = spotifyFetch((url) =>
		url === MUSIC_PROVIDER_URLS.spotify.tokenUrl
			? jsonResponse({ access_token: 'token', expires_in: 3600 })
			: jsonResponse(SPOTIFY_TRACK),
	);

	await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
		{ fetchImpl, now: () => 0 },
	);

	for (const call of calls) {
		assert.match(call, /^https:\/\/(open\.spotify\.com|accounts\.spotify\.com|api\.spotify\.com)\//);
	}
	// The id, not the pasted string, is what reaches the track query. The token
	// exchange is the one call that carries no id, and it is a fixed endpoint.
	const trackCall = calls.find((call) => call.includes(MUSIC_PROVIDER_URLS.spotify.apiBase));
	assert.ok(trackCall, 'the Web API must be called');
	assert.ok(trackCall?.includes(encodeURIComponent(SPOTIFY_ID)));
	assert.ok(calls.every((call) => !call.includes('si=') && !call.includes('evil.example')));
});
