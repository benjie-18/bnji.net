/**
 * Provider link parsing: what the importer accepts, and what it must refuse.
 *
 * The interesting half of this file is the refusals. A URL is attacker-chosen
 * input, and the failure mode being guarded against is not "a valid link is
 * rejected" — it is "an invalid link is accepted and then fetched".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MUSIC_PROVIDER_URLS } from '../src/config/music.config.ts';
import { musicDateField, parseMusicLink } from '../src/server/music-links.ts';

const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';
const YOUTUBE_ID = 'dQw4w9WgXcQ';

function spotify(value: string) {
	const result = parseMusicLink(value);
	assert.ok(result.ok, `expected ${value} to parse: ${JSON.stringify(result)}`);
	assert.equal(result.provider, 'spotify');
	return result;
}

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
		assert.equal(result.error, error);
		assert.ok(result.message.length > 0, 'a rejection must explain itself');
	}
}

test('spotify: a plain track link parses and is canonicalised', () => {
	const result = spotify(`https://open.spotify.com/track/${SPOTIFY_ID}`);
	assert.equal(result.kind, 'track');
	assert.equal(result.id, SPOTIFY_ID);
	assert.equal(result.canonicalUrl, `https://open.spotify.com/track/${SPOTIFY_ID}`);
});

test('spotify: tracking parameters, locale prefixes and userinfo are dropped', () => {
	// The canonical URL is rebuilt from the id, so nothing the operator pasted
	// beyond the id survives into storage.
	for (const value of [
		`https://open.spotify.com/track/${SPOTIFY_ID}?si=abc123`,
		`https://open.spotify.com/intl-de/track/${SPOTIFY_ID}`,
		`https://user:password@open.spotify.com/track/${SPOTIFY_ID}`,
		`https://open.spotify.com/track/${SPOTIFY_ID}/`,
	]) {
		const result = spotify(value);
		assert.equal(result.id, SPOTIFY_ID, value);
		assert.equal(result.canonicalUrl, `https://open.spotify.com/track/${SPOTIFY_ID}`, value);
	}
});

test('spotify: albums, playlists and other object types are refused', () => {
	// Phase one imports single tracks. An album or playlist link is a valid
	// Spotify URL that this feature does not expand, and saying so is more
	// useful than a generic "unsupported link".
	rejected(`https://open.spotify.com/album/${SPOTIFY_ID}`, 'unsupported_provider_type');
	rejected(`https://open.spotify.com/playlist/${SPOTIFY_ID}`, 'unsupported_provider_type');
	rejected(`https://open.spotify.com/artist/${SPOTIFY_ID}`, 'unsupported_provider_type');
	rejected(`https://open.spotify.com/episode/${SPOTIFY_ID}`, 'unsupported_provider_type');
});

test('spotify: malformed paths are refused', () => {
	rejected('https://open.spotify.com/track', 'unsupported_path');
	rejected(`https://open.spotify.com/track/${SPOTIFY_ID}/extra`, 'unsupported_path');
	rejected(`https://open.spotify.com/embed/track/${SPOTIFY_ID}`, 'unsupported_path');
	rejected('https://open.spotify.com/', 'unsupported_path');
	rejected(`https://open.spotify.com/track/short`, 'invalid_id');
	rejected(`https://open.spotify.com/track/${'x'.repeat(65)}`, 'invalid_id');
});

test('spotify: spoofed and unrelated hosts are refused', () => {
	// Equality against the allowlist, never a suffix test: these are real hosts
	// somebody owns, and a suffix match would accept every one of them.
	rejected(`https://open.spotify.com.evil.example/track/${SPOTIFY_ID}`, 'unsupported_host');
	rejected(`https://open.spotify.com.attacker.test/track/${SPOTIFY_ID}`, 'unsupported_host');
	rejected(`https://evil.example/open.spotify.com/track/${SPOTIFY_ID}`, 'unsupported_host');
	rejected(`https://open.spotify.com@evil.example/track/${SPOTIFY_ID}`, 'unsupported_host');
	rejected(`https://notopen.spotify.com/track/${SPOTIFY_ID}`, 'unsupported_host');
	rejected('https://play.spotify.com/track/' + SPOTIFY_ID, 'unsupported_host');
	rejected(`https://evil.example/track/${SPOTIFY_ID}`, 'unsupported_host');
});

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
		assert.equal(result.kind, 'video', value);
		assert.equal(result.id, YOUTUBE_ID, value);
		// One canonical form, so the stored playlist cannot hold two spellings
		// of the same video. The host comes from the provider config rather
		// than a second hardcoded string.
		assert.equal(result.canonicalUrl, `https://${MUSIC_PROVIDER_URLS.youtube.hosts[0]}/watch?v=${YOUTUBE_ID}`, value);
	}
});

test('youtube: extra parameters are dropped and a missing id is refused', () => {
	const result = youtube(`https://www.youtube.com/watch?v=${YOUTUBE_ID}&t=42s&feature=share`);
	assert.equal(result.id, YOUTUBE_ID);

	rejected('https://www.youtube.com/watch', 'invalid_id');
	// A watch URL with no `v` parameter names no video, which is an id problem
	// rather than a path problem.
	rejected('https://www.youtube.com/watch?feature=share', 'invalid_id');
	rejected(`https://www.youtube.com/watch/${YOUTUBE_ID}`, 'unsupported_path');
	rejected(`https://youtu.be/${YOUTUBE_ID}/extra`, 'unsupported_path');
	rejected('https://www.youtube.com/@channel', 'unsupported_path');
	rejected('https://www.youtube.com/playlist?list=abc', 'unsupported_path');
	rejected(`https://www.youtube.com/watch?v=tooshort`, 'invalid_id');
	rejected(`https://www.youtube.com/watch?v=${'x'.repeat(12)}`, 'invalid_id');
});

test('youtube: spoofed and unrelated hosts are refused', () => {
	rejected(`https://youtube.com.evil.example/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://youtu.be.evil.example/${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://evil.example/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://youtube.com@evil.example/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://notyoutube.com/watch?v=${YOUTUBE_ID}`, 'unsupported_host');
	rejected(`https://vimeo.com/${YOUTUBE_ID}`, 'unsupported_host');
});

test('non-URLs, insecure URLs and junk are refused', () => {
	rejected('', 'empty');
	rejected('   ', 'empty');
	// Everything below arrives as `unknown` from a JSON body, so the parser has
	// to refuse non-strings rather than trust the type it was handed.
	rejected(null as unknown as string, 'empty');
	rejected(undefined as unknown as string, 'empty');
	rejected(42 as unknown as string, 'empty');
	rejected({ url: 'https://open.spotify.com/track/x' } as unknown as string, 'empty');
	rejected('open.spotify.com/track/' + SPOTIFY_ID, 'not_a_url');
	// A URL, just not an https one: the scheme check catches it.
	rejected('javascript:alert(1)', 'insecure_url');
	rejected(`http://open.spotify.com/track/${SPOTIFY_ID}`, 'insecure_url');
	rejected(`http://youtu.be/${YOUTUBE_ID}`, 'insecure_url');
	rejected(`ftp://open.spotify.com/track/${SPOTIFY_ID}`, 'insecure_url');
	rejected(`https://open.spotify.com/track/${SPOTIFY_ID}${'?a=1'.repeat(200)}`, 'too_long');
});

test('a bare id is not a link: the importer wants a URL it can normalise', () => {
	rejected(SPOTIFY_ID, 'not_a_url');
	rejected(YOUTUBE_ID, 'not_a_url');
});

test('each provider writes its date to its own field', () => {
	assert.equal(musicDateField('spotify'), 'releaseDate');
	assert.equal(musicDateField('youtube'), 'publishedAt');
});
