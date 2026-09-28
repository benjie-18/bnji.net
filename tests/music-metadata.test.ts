/**
 * Metadata resolution: provider mapping, partial results, and the manual
 * fallback that has to work when no credential is configured at all.
 *
 * Every provider response here is a stub `fetch`, so the suite needs no network
 * and no credentials — which is the same condition the fallback is designed
 * for. The assertions on `lookups` are the important ones: they are what the
 * admin panel reads to tell the operator WHY a field is blank.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_PROVIDER_URLS } from '../src/config/music.config.ts';
import {
	cleanMusicText,
	normalizeMusicDate,
	parseIsoDuration,
	resetSpotifyTokenCache,
	resolveMusicMetadata,
} from '../src/server/music-metadata.ts';
import { parseMusicLink } from '../src/server/music-links.ts';

const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';
const YOUTUBE_ID = 'dQw4w9WgXcQ';

const SPOTIFY_TRACK = {
	name: 'Never Gonna Give You Up',
	artists: [{ name: 'Rick Astley' }],
	album: { name: 'Whenever You Need Somebody', release_date: '1987-11-16', release_date_precision: 'day' },
	duration_ms: 213_000,
};

const YOUTUBE_VIDEO = {
	items: [
		{
			snippet: {
				title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
				channelTitle: 'Rick Astley',
				publishedAt: '2009-10-25T07:57:33Z',
			},
			contentDetails: { duration: 'PT3M33S' },
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

function spotifyLink(value = `https://open.spotify.com/track/${SPOTIFY_ID}`) {
	const link = parseMusicLink(value);
	assert.ok(link.ok);
	if (!link.ok) throw new Error('unreachable');
	return link;
}

function youtubeLink(value = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`) {
	const link = parseMusicLink(value);
	assert.ok(link.ok);
	if (!link.ok) throw new Error('unreachable');
	return link;
}

test.beforeEach(() => {
	resetSpotifyTokenCache();
});

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

test('normalizeMusicDate accepts provider date shapes and rejects junk', () => {
	assert.equal(normalizeMusicDate('1987-11-16'), '1987-11-16');
	// YouTube sends a full timestamp; only the date part is meaningful.
	assert.equal(normalizeMusicDate('2009-10-25T07:57:33Z'), '2009-10-25');
	// Spotify's precision may be a year or a year-month; it is kept as given
	// rather than padded into a precision the provider never claimed.
	assert.equal(normalizeMusicDate('1987'), '1987');
	assert.equal(normalizeMusicDate('1987-11'), '1987-11');
	assert.equal(normalizeMusicDate('not a date'), '');
	assert.equal(normalizeMusicDate('25/11/1987'), '');
	assert.equal(normalizeMusicDate(''), '');
	assert.equal(normalizeMusicDate(undefined), '');
});

test('parseIsoDuration reads YouTube durations', () => {
	assert.equal(parseIsoDuration('PT3M33S'), 213);
	assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
	assert.equal(parseIsoDuration('PT45S'), 45);
	assert.equal(parseIsoDuration('P1DT2H'), 93_600);
	assert.equal(parseIsoDuration('nonsense'), 0);
	assert.equal(parseIsoDuration(undefined), 0);
});

/* --- Spotify ------------------------------------------------------------- */

test('spotify: the Web API fills every field and the date lands in releaseDate', async () => {
	const { calls, fetchImpl } = recorder((url) => {
		if (url.startsWith(MUSIC_PROVIDER_URLS.spotify.tokenUrl)) {
			return jsonResponse({ access_token: 'test-token', expires_in: 3600 });
		}
		assert.equal(url, `${MUSIC_PROVIDER_URLS.spotify.apiBase}/tracks/${SPOTIFY_ID}`);
		return jsonResponse(SPOTIFY_TRACK);
	});

	const result = await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
		{ fetchImpl },
	);

	assert.equal(result.status, 'ok');
	assert.equal(result.source, 'spotify-web-api');
	assert.equal(result.fields.title, 'Never Gonna Give You Up');
	assert.equal(result.fields.artist, 'Rick Astley');
	assert.equal(result.fields.album, 'Whenever You Need Somebody');
	assert.equal(result.fields.releaseDate, '1987-11-16');
	// A Spotify album release date is NEVER a publication date.
	assert.equal(result.fields.publishedAt, undefined);
	assert.equal(result.fields.durationSeconds, 213);
	assert.equal(result.artistIsSuggestion, false);
	assert.deepEqual(result.lookups.map((entry) => entry.outcome), ['used']);
	// Two requests: the token exchange and the track. Nothing else.
	assert.equal(calls.length, 2);
});

test('spotify: the credential never leaves the server', async () => {
	const { fetchImpl } = recorder((url) => {
		if (url.startsWith(MUSIC_PROVIDER_URLS.spotify.tokenUrl)) {
			return jsonResponse({ access_token: 'super-secret-token', expires_in: 3600 });
		}
		return jsonResponse(SPOTIFY_TRACK);
	});

	const result = await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'client-id', SPOTIFY_CLIENT_SECRET: 'client-secret' },
		{ fetchImpl },
	);
	const serialised = JSON.stringify(result);
	assert.ok(!serialised.includes('super-secret-token'));
	assert.ok(!serialised.includes('client-secret'));
	assert.ok(!serialised.includes('client-id'));
});

test('spotify: no credentials means oEmbed, and a title alone is a partial draft', async () => {
	const { calls, fetchImpl } = recorder((url) => {
		assert.equal(
			url,
			`${MUSIC_PROVIDER_URLS.spotify.oEmbed}?url=${encodeURIComponent(`https://open.spotify.com/track/${SPOTIFY_ID}`)}`,
		);
		return jsonResponse({
			title: 'Never Gonna Give You Up',
			// The embed HTML is deliberately ignored: an admin page must never
			// render markup a third party chose.
			html: '<iframe src="https://evil.example"></iframe>',
			iframe_url: 'https://open.spotify.com/embed/track/x',
		});
	});

	const result = await resolveMusicMetadata(spotifyLink(), {}, { fetchImpl });

	assert.equal(result.status, 'partial');
	assert.equal(result.source, 'spotify-oembed');
	assert.equal(result.fields.title, 'Never Gonna Give You Up');
	// Spotify's oEmbed credits no artist and no album, and nothing is invented.
	assert.equal(result.fields.artist, undefined);
	assert.equal(result.fields.album, undefined);
	assert.equal(result.fields.releaseDate, undefined);
	assert.match(result.message, /editable/);
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['spotify-web-api', 'skipped_not_configured'],
			['spotify-oembed', 'used'],
		],
	);
	// The oEmbed endpoint is the only host contacted.
	assert.equal(calls.length, 1);
});

test('spotify: a refused token falls back to oEmbed rather than failing', async () => {
	const { fetchImpl } = recorder((url) => {
		if (url.startsWith(MUSIC_PROVIDER_URLS.spotify.tokenUrl)) return jsonResponse({}, 400);
		return jsonResponse({ title: 'Never Gonna Give You Up' });
	});

	const result = await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
		{ fetchImpl },
	);

	assert.equal(result.source, 'spotify-oembed');
	assert.equal(result.fields.title, 'Never Gonna Give You Up');
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['spotify-web-api', 'failed'],
			['spotify-oembed', 'used'],
		],
	);
});

test('spotify: an unreachable provider yields an empty, editable draft', async () => {
	const { fetchImpl } = recorder((url) => {
		if (url.startsWith(MUSIC_PROVIDER_URLS.spotify.oEmbed)) return jsonResponse({}, 500);
		throw new Error('boom');
	});

	const result = await resolveMusicMetadata(spotifyLink(), {}, { fetchImpl });

	assert.equal(result.status, 'unavailable');
	assert.equal(result.fields.title, undefined);
	assert.match(result.message, /Enter the title/);
	assert.deepEqual(result.fields, {});
});

test('spotify: a partial release date is kept as reported', async () => {
	const { fetchImpl } = recorder((url) => {
		if (url.startsWith(MUSIC_PROVIDER_URLS.spotify.tokenUrl)) {
			return jsonResponse({ access_token: 'token', expires_in: 3600 });
		}
		return jsonResponse({
			...SPOTIFY_TRACK,
			album: { name: 'Album', release_date: '1987', release_date_precision: 'year' },
		});
	});

	const result = await resolveMusicMetadata(
		spotifyLink(),
		{ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' },
		{ fetchImpl },
	);
	assert.equal(result.fields.releaseDate, '1987');
});

/* --- YouTube ------------------------------------------------------------- */

test('youtube: the Data API maps title, channel, publication date and duration', async () => {
	const { calls, fetchImpl } = recorder((url) => {
		assert.equal(
			url,
			`${MUSIC_PROVIDER_URLS.youtube.apiBase}/videos?part=snippet%2CcontentDetails&id=${YOUTUBE_ID}&key=${encodeURIComponent('key')}`,
		);
		return jsonResponse(YOUTUBE_VIDEO);
	});

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'key' }, { fetchImpl });

	assert.equal(result.status, 'ok');
	assert.equal(result.source, 'youtube-data-api');
	assert.equal(result.fields.title, 'Rick Astley - Never Gonna Give You Up (Official Video)');
	assert.equal(result.fields.artist, 'Rick Astley');
	// A YouTube upload date is a publication date, never a release date.
	assert.equal(result.fields.publishedAt, '2009-10-25');
	assert.equal(result.fields.releaseDate, undefined);
	assert.equal(result.fields.durationSeconds, 213);
	// The channel name is a suggestion, not credited metadata.
	assert.equal(result.artistIsSuggestion, true);
	assert.match(result.message, /YouTube Data API/);
	assert.equal(calls.length, 1);
});

test('youtube: the API key never appears in the response', async () => {
	const { fetchImpl } = recorder(() => jsonResponse(YOUTUBE_VIDEO));
	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'youtube-secret-key' }, { fetchImpl });
	assert.ok(!JSON.stringify(result).includes('youtube-secret-key'));
});

test('youtube: no key means oEmbed, with the channel name as a suggested artist', async () => {
	const { calls, fetchImpl } = recorder((url) => {
		assert.ok(url.startsWith(`${MUSIC_PROVIDER_URLS.youtube.oEmbed}?`));
		// The requested URL is the canonical link, never the pasted string.
		assert.ok(url.includes(encodeURIComponent(`https://youtube.com/watch?v=${YOUTUBE_ID}`)));
		return jsonResponse({ title: 'Rick Astley - Never Gonna Give You Up', author_name: 'RickAstleyVEVO' });
	});

	const result = await resolveMusicMetadata(youtubeLink(), {}, { fetchImpl });

	assert.equal(result.source, 'youtube-oembed');
	assert.equal(result.fields.title, 'Rick Astley - Never Gonna Give You Up');
	assert.equal(result.fields.artist, 'RickAstleyVEVO');
	assert.equal(result.artistIsSuggestion, true);
	// oEmbed publishes no date and no duration; nothing is guessed.
	assert.equal(result.fields.publishedAt, undefined);
	assert.equal(result.fields.durationSeconds, undefined);
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['youtube-data-api', 'skipped_not_configured'],
			['youtube-oembed', 'used'],
		],
	);
	assert.equal(calls.length, 1);
});

test('youtube: an empty items list is reported, not guessed at', async () => {
	const { fetchImpl } = recorder((url) => {
		if (url.includes('/videos?')) return jsonResponse({ items: [] });
		return jsonResponse({ title: 'From oEmbed' });
	});

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'key' }, { fetchImpl });

	assert.equal(result.source, 'youtube-oembed');
	assert.equal(result.fields.title, 'From oEmbed');
	assert.deepEqual(
		result.lookups.map((entry) => [entry.lookup, entry.outcome]),
		[
			['youtube-data-api', 'empty'],
			['youtube-oembed', 'used'],
		],
	);
});

test('youtube: a network failure still produces a draft the admin can fill in', async () => {
	const { fetchImpl } = recorder(() => {
		throw new Error('network down');
	});

	const result = await resolveMusicMetadata(youtubeLink(), { YOUTUBE_API_KEY: 'key' }, { fetchImpl });

	assert.equal(result.status, 'unavailable');
	assert.deepEqual(result.fields, {});
	assert.match(result.message, /Enter the title/);
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
			/^https:\/\/(www\.youtube\.com|www\.googleapis\.com|open\.spotify\.com|api\.spotify\.com|accounts\.spotify\.com)\//,
		);
	}
});
