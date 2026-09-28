/**
 * Provider link parsing: what the importer accepts, and what it must refuse.
 *
 * The interesting half of this file is the refusals. A URL is attacker-chosen
 * input, and the failure mode being guarded against is not "a valid link is
 * rejected" — it is "an invalid link is accepted and then fetched".
 *
 * Two providers are importable, so there are two accepted shapes — and the
 * Spotify half has its own interesting refusal: an album or playlist link is not
 * a bad host, it is a shape this importer deliberately does not expand, and the
 * operator is told the difference.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_PROVIDER_URLS } from '../src/config/music.config.ts';
import { musicDateField, parseMusicLink } from '../src/server/music-links.ts';

const YOUTUBE_ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://${MUSIC_PROVIDER_URLS.youtube.hosts[0]}/watch?v=${YOUTUBE_ID}`;

function youtube(value: string) {
	const result = parseMusicLink(value);
	assert.ok(result.ok, `expected ${value} to parse: ${JSON.stringify(result)}`);
	assert.equal(result.provider, 'youtube');
	return result;
}

function rejected(value: string, error: string) {
	const result = parseMusicLink(value);
	assert.ok(!result.ok, `expected ${value} to be rejected`);
	if (!result.ok) {
		assert.equal(result.error, error, value);
		assert.ok(result.message.length > 0, 'a rejection must explain itself');
	}
}

test('youtube: every supported link shape parses', () => {
	for (const value of [
		`https://www.youtube.com/watch?v=${YOUTUBE_ID}`,
		`https://youtube.com/watch?v=${YOUTUBE_ID}`,
		`https://m.youtube.com/watch?v=${YOUTUBE_ID}`,
		`https://music.youtube.com/watch?v=${YOUTUBE_ID}`,
		`https://youtu.be/${YOUTUBE_ID}`,
		`https://www.youtube.com/shorts/${YOUTUBE_ID}`,
		`https://www.youtube.com/embed/${YOUTUBE_ID}`,
		`https://www.youtube.com/live/${YOUTUBE_ID}`,
		`https://www.youtube.com/v/${YOUTUBE_ID}`,
	]) {
		const result = youtube(value);
		assert.equal(result.id, YOUTUBE_ID, value);
		// One canonical form, so the stored playlist cannot hold two spellings
		// of the same video. The host comes from the provider config rather
		// than a second hardcoded string.
		assert.equal(result.canonicalUrl, CANONICAL, value);
	}
});

test('youtube: tracking parameters, userinfo and a trailing slash are dropped', () => {
	// The canonical URL is rebuilt from the id, so nothing the operator pasted
	// beyond the id survives into storage.
	for (const value of [
		`https://www.youtube.com/watch?v=${YOUTUBE_ID}&t=42s&feature=share`,
		`https://www.youtube.com/watch?v=${YOUTUBE_ID}&list=PLwhatever`,
		`https://user:password@youtube.com/watch?v=${YOUTUBE_ID}`,
		`https://youtu.be/${YOUTUBE_ID}?si=abc123`,
	]) {
		const result = youtube(value);
		assert.equal(result.id, YOUTUBE_ID, value);
		assert.equal(result.canonicalUrl, CANONICAL, value);
	}
});

test('youtube: a missing or malformed video id is refused', () => {
	rejected('https://www.youtube.com/watch', 'invalid_id');
	// A watch URL with no `v` parameter names no video, which is an id problem
	// rather than a path problem.
	rejected('https://www.youtube.com/watch?feature=share', 'invalid_id');
	rejected(`https://www.youtube.com/watch?v=tooshort`, 'invalid_id');
	rejected(`https://www.youtube.com/watch?v=${'x'.repeat(12)}`, 'invalid_id');
	// Underscores and dashes are in YouTube's alphabet, so these are valid.
	for (const id of ['a_b-c-d_e-f', '-'.repeat(11)]) {
		assert.equal(youtube(`https://youtu.be/${id}`).id, id);
	}
});

test('youtube: unsupported paths are refused', () => {
	rejected(`https://www.youtube.com/watch/${YOUTUBE_ID}`, 'unsupported_path');
	rejected(`https://youtu.be/${YOUTUBE_ID}/extra`, 'unsupported_path');
	rejected('https://www.youtube.com/@channel', 'unsupported_path');
	rejected('https://www.youtube.com/playlist?list=abc', 'unsupported_path');
	rejected('https://www.youtube.com/feed/subscriptions', 'unsupported_path');
	rejected('https://www.youtube.com/results?search_query=cats', 'unsupported_path');
	// `/shorts/<id>` needs exactly one segment: a Shorts URL with a second one
	// is not a video link the player can resolve.
	rejected(`https://www.youtube.com/shorts/${YOUTUBE_ID}/extra`, 'unsupported_path');
});

test('youtube: spoofed and unrelated hosts are refused', () => {
	// Equality against the allowlist, never a suffix test: these are real hosts
	// somebody owns, and a suffix match would accept every one of them.
	rejected(`https://youtube.com.evil.example/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://youtu.be.evil.example/${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://evil.example/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://youtube.com@evil.example/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://notyoutube.com/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://vimeo.com/${YOUTUBE_ID}`, 'unsupported_host');
});

test('a host on neither allowlist is an unsupported host, not a special case', () => {
	// Spotify is a supported provider, so it is deliberately absent from this
	// list. Everything here is a host that is on neither allowlist, which is
	// exactly what the operator is told.
	for (const value of [
		'https://soundcloud.com/artist/track',
		'https://example.com/watch?v=' + YOUTUBE_ID,
		// A suffix test would accept this; an equality test must not.
		'https://open.spotify.com.attacker.example/track/4uLU6hMCjMI75M1A2tKUQC',
		'https://notyoutube.com/watch?v=' + YOUTUBE_ID,
	]) {
		rejected(value, 'unsupported_host');
	}
});

test('non-URLs, insecure URLs and junk are refused', () => {
	rejected('', 'empty');
	rejected('   ', 'empty');
	// Everything below arrives as `unknown` from a JSON body, so the parser has
	// to refuse non-strings rather than trust the type it was handed.
	rejected(null as unknown as string, 'empty');
	rejected(undefined as unknown as string, 'empty');
	rejected(42 as unknown as string, 'empty');
	rejected({ url: 'https://youtu.be/' + YOUTUBE_ID } as unknown as string, 'empty');
	rejected('youtu.be/' + YOUTUBE_ID, 'not_a_url');
	// A URL, just not an https one: the scheme check catches it.
	rejected('javascript:alert(1)', 'insecure_url');
	rejected(`http://youtube.com/watch?v=${YOUTUBE_ID}`, 'insecure_url');
	rejected(`http://youtu.be/${YOUTUBE_ID}`, 'insecure_url');
	rejected(`ftp://youtube.com/watch?v=${YOUTUBE_ID}`, 'insecure_url');
	rejected(`https://youtu.be/${YOUTUBE_ID}${'?a=1'.repeat(200)}`, 'too_long');
});

test('a bare id is not a link: the importer wants a URL it can normalise', () => {
	rejected(YOUTUBE_ID, 'not_a_url');
});

/* --- Spotify ------------------------------------------------------------- */

const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';

test('a Spotify track link parses, and the stored URL is rebuilt from the id', () => {
	const parsed = parseMusicLink(`https://open.spotify.com/track/${SPOTIFY_ID}?si=abc123`);
	assert.ok(parsed.ok);
	if (!parsed.ok) return;
	assert.equal(parsed.provider, 'spotify');
	assert.equal(parsed.kind, 'track');
	assert.equal(parsed.id, SPOTIFY_ID);
	// The tracking query is discarded, not persisted.
	assert.equal(parsed.canonicalUrl, `https://open.spotify.com/track/${SPOTIFY_ID}`);
});

test('a locale-prefixed Spotify link parses, and a spotify: URI is not a URL', () => {
	// The locale segment is optional and always precedes the type, so it is
	// skipped rather than treated as part of the path.
	const prefixed = parseMusicLink(`https://open.spotify.com/intl-de/track/${SPOTIFY_ID}`);
	assert.ok(prefixed.ok);
	if (!prefixed.ok) return;
	assert.equal(prefixed.id, SPOTIFY_ID);
	assert.equal(prefixed.kind, 'track');

	// A `spotify:track:<id>` URI is a real Spotify form, but it is not a URL and
	// this parser is for pasted links. It is the PLAYER's parseSpotifyTarget that
	// accepts it, because a config entry is the one place a URI can appear.
	// `spotify:` is a real URL scheme, so the scheme gate is what refuses it
	// rather than the URL parser — which is the stricter of the two answers.
	rejected(`spotify:track:${SPOTIFY_ID}`, 'insecure_url');
});

test('Spotify albums and playlists are refused rather than silently truncated', () => {
	// The importer expands a single track and nothing else, so an album link is
	// a different KIND of refusal from a bad host — and the operator is told
	// which one they hit.
	for (const value of [
		`https://open.spotify.com/album/${SPOTIFY_ID}`,
		`https://open.spotify.com/playlist/${SPOTIFY_ID}`,
		`https://open.spotify.com/artist/${SPOTIFY_ID}`,
	]) {
		rejected(value, 'unsupported_provider_type');
	}
});

test('a Spotify link with extra path segments or a short id is refused', () => {
	rejected(`https://open.spotify.com/track/${SPOTIFY_ID}/extra`, 'unsupported_path');
	rejected('https://open.spotify.com/track/tooshort', 'invalid_id');
	// A locale segment must look like one.
	rejected(`https://open.spotify.com/nonsense/track/${SPOTIFY_ID}`, 'unsupported_path');
});

test('the date field follows the provider, so the two dates never share a column', () => {
	assert.equal(musicDateField('spotify'), 'releaseDate');
	assert.equal(musicDateField('youtube'), 'publishedAt');
});
