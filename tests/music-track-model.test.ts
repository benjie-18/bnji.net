/**
 * The shared track model.
 *
 * One track description reaches a visitor through two paths: the markup
 * prerendered from `MUSIC_SOURCE` at deploy time, and the queue rebuilt at
 * runtime from `/api/playlist`. Both are supposed to read identically, so the
 * helpers they share live in `src/config/music.config.ts` and are tested here
 * as the single source of truth for labels, dates and playability.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getMusicTrackDateLabel,
	getMusicTrackMetadata,
	musicTrackAriaLabel,
	MUSIC_PROVIDER_URLS,
	MUSIC_SOURCE,
	type MusicTrack,
} from '../src/config/music.config.ts';
import { formatMusicTime, isMusicTrack, parseYouTubeVideoId } from '../src/scripts/music.ts';

const track = (overrides: Partial<MusicTrack> = {}): MusicTrack => ({
	id: 'track-1',
	title: 'the feeling',
	provider: 'file',
	url: '/music/the feeling.mp3',
	...overrides,
});

/* --- optional metadata ---------------------------------------------------- */

test('metadata trims, and absent fields stay empty rather than undefined', () => {
	assert.deepEqual(getMusicTrackMetadata(track({ artist: '  benji  ', album: '\tSongs\n' })), {
		artist: 'benji',
		album: 'Songs',
		publishedAt: '',
		releaseDate: '',
	});
	assert.deepEqual(getMusicTrackMetadata(track()), {
		artist: '',
		album: '',
		publishedAt: '',
		releaseDate: '',
	});
	assert.deepEqual(getMusicTrackMetadata(null), {
		artist: '',
		album: '',
		publishedAt: '',
		releaseDate: '',
	});
	assert.deepEqual(getMusicTrackMetadata(undefined), {
		artist: '',
		album: '',
		publishedAt: '',
		releaseDate: '',
	});
});

/* --- the date line -------------------------------------------------------- */

test('a YouTube upload date says Published, and a missing one says nothing', () => {
	assert.equal(getMusicTrackDateLabel(track({ publishedAt: '2024-05-01' })), 'Published 2024-05-01');
	// A blank date is not a date: it falls through instead of printing a gap.
	assert.equal(getMusicTrackDateLabel(track({ publishedAt: '   ' })), '');
	assert.equal(getMusicTrackDateLabel(track()), '');
	assert.equal(getMusicTrackDateLabel(null), '');
});

test('a partial date is reported as it arrived, never padded into a real one', () => {
	assert.equal(getMusicTrackDateLabel(track({ publishedAt: '2019-11' })), 'Published 2019-11');
});

test('the two date fields are distinct, and each keeps its own verb', () => {
	// A YouTube upload date and a Spotify album release date are different facts
	// about different things. The guard is on the WORD as much as on the field:
	// printing "Released 2024-05-01" for an upload would be a lie, and so would
	// "Published 2019-11-15" for a release.
	const shape = getMusicTrackMetadata(track({ publishedAt: '2024-05-01' }));
	assert.deepEqual(Object.keys(shape).sort(), ['album', 'artist', 'publishedAt', 'releaseDate']);
	assert.ok(!getMusicTrackDateLabel(track({ publishedAt: '2024-05-01' })).includes('Released'));
	assert.ok(!getMusicTrackDateLabel(track({ releaseDate: '2019-11-15' })).includes('Published'));
});

test('a Spotify release date says Released, and only that', () => {
	assert.equal(getMusicTrackDateLabel(track({ releaseDate: '2019-11-15' })), 'Released 2019-11-15');
	// Both dates present: the upload date wins, because it is the one a YouTube
	// track has and the label must not describe a Spotify track ambiguously.
	assert.equal(
		getMusicTrackDateLabel(track({ publishedAt: '2024-05-01', releaseDate: '2019-11-15' })),
		'Published 2024-05-01',
	);
	// A blank date is not a date: it falls through instead of printing a gap.
	assert.equal(getMusicTrackDateLabel(track()), '');
	assert.equal(getMusicTrackDateLabel(track({ publishedAt: '   ' })), '');
});

test('the accessible name carries the release date with its own verb', () => {
	assert.equal(
		musicTrackAriaLabel(
			track({
				title: 'the feeling',
				artist: 'benji',
				album: 'Songs',
				releaseDate: '2019-11-15',
			}),
		),
		'Play the feeling, by benji, from Songs, Released 2019-11-15',
	);
});

/* --- the accessible name -------------------------------------------------- */

test('the accessible name carries the title, artist, album and date', () => {
	assert.equal(
		musicTrackAriaLabel(
			track({
				title: 'the feeling',
				artist: 'benji',
				album: 'Songs',
				publishedAt: '2024-05-01',
			}),
		),
		'Play the feeling, by benji, from Songs, Published 2024-05-01',
	);
});

test('the accessible name drops the parts that do not exist', () => {
	assert.equal(musicTrackAriaLabel(track()), 'Play the feeling');
	assert.equal(musicTrackAriaLabel(track({ artist: 'benji' })), 'Play the feeling, by benji');
	assert.equal(
		musicTrackAriaLabel(track({ artist: 'benji', publishedAt: '2019-11-15' })),
		'Play the feeling, by benji, Published 2019-11-15',
	);
	// An album with no artist still reads as a sentence fragment worth saying.
	assert.equal(musicTrackAriaLabel(track({ album: 'Songs' })), 'Play the feeling, from Songs');
});

test('an untitled track still announces something playable', () => {
	assert.equal(musicTrackAriaLabel(track({ title: '   ' })), 'Play untitled track');
	assert.equal(musicTrackAriaLabel(track({ title: '  spaced  ' })), 'Play spaced');
});

/* --- the seed config ------------------------------------------------------ */

test('the seed playlist is well formed and playable as configured', () => {
	assert.ok(MUSIC_SOURCE.tracks.length > 0, 'a seeded playlist with no tracks disables music entirely');
	assert.ok(MUSIC_SOURCE.defaultVolume > 0 && MUSIC_SOURCE.defaultVolume <= 1);

	const ids = new Set<string>();
	for (const item of MUSIC_SOURCE.tracks) {
		assert.ok(item.id.trim(), `a track has no id: ${JSON.stringify(item)}`);
		assert.ok(!ids.has(item.id), `duplicate track id: ${item.id}`);
		ids.add(item.id);
		assert.ok(item.title.trim(), `${item.id} has no title`);
		assert.ok(item.url.trim(), `${item.id} has no url`);

		// Whatever the provider claims, the player must be able to parse it —
		// otherwise the seeded queue ships a track that can never start.
		if (item.provider === 'file') {
			assert.match(item.url, /^(\/|https?:\/\/)/, `${item.id}: a file track needs a path or URL`);
		} else {
			assert.ok(parseYouTubeVideoId(item.url), `${item.id}: not a YouTube link the player can read`);
		}
	}
});

test('the provider URL table keeps the bare host first, as the client parser assumes', () => {
	assert.equal(MUSIC_PROVIDER_URLS.youtube.hosts[0], 'youtube.com');
	assert.equal(MUSIC_PROVIDER_URLS.youtube.hosts[1], 'youtu.be');
	// The server-side list is a superset of the client suffix test.
	assert.ok(MUSIC_PROVIDER_URLS.youtube.watchHosts.includes('youtube.com'));
	assert.ok(MUSIC_PROVIDER_URLS.youtube.watchHosts.includes('youtu.be'));
	// Two providers, so two entries — and every entry is a host the server is
	// willing to request metadata from. Adding a third is a deliberate act.
	assert.deepEqual(Object.keys(MUSIC_PROVIDER_URLS).sort(), ['spotify', 'youtube']);
	// Spotify's host is a single exact string, not a list: the client parser
	// compares it for equality, so there is no suffix ambiguity to guard.
	assert.equal(MUSIC_PROVIDER_URLS.spotify.host, 'open.spotify.com');
});

/* --- the client-side link parsers ----------------------------------------- */

test('the client reads a bare video id and every YouTube link shape', () => {
	assert.equal(parseYouTubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('  dQw4w9WgXcQ  '), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s'), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=12'), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
	assert.equal(parseYouTubeVideoId('https://www.youtube.com/v/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
	// A subdomain of the real host is still YouTube.
	assert.equal(parseYouTubeVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('the client refuses a host that only looks like YouTube, and a short id', () => {
	assert.equal(parseYouTubeVideoId('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), null);
	assert.equal(parseYouTubeVideoId('https://evil.example/watch?v=dQw4w9WgXcQ'), null);
	assert.equal(parseYouTubeVideoId('https://www.youtube.com/watch?v=tooshort'), null);
	assert.equal(parseYouTubeVideoId('https://www.youtube.com/watch'), null);
	assert.equal(parseYouTubeVideoId('not a url at all'), null);
});

/* --- media time ----------------------------------------------------------- */

test('media time is always printable', () => {
	assert.equal(formatMusicTime(0), '0:00');
	assert.equal(formatMusicTime(9), '0:09');
	assert.equal(formatMusicTime(61), '1:01');
	assert.equal(formatMusicTime(600), '10:00');
	assert.equal(formatMusicTime(3600), '1:00:00');
	assert.equal(formatMusicTime(59.9), '0:59');
	// A player that has not loaded yet reports these; none of them may render.
	assert.equal(formatMusicTime(Number.NaN), '0:00');
	assert.equal(formatMusicTime(Number.POSITIVE_INFINITY), '0:00');
	assert.equal(formatMusicTime(-5), '0:00');
});

/* --- untrusted tracks from the network ------------------------------------ */

test('a track that crossed the network must describe itself before it plays', () => {
	assert.ok(isMusicTrack({ id: 'a', title: 'A', provider: 'file', url: '/a.mp3' }));
	assert.ok(isMusicTrack({ id: 'a', title: 'A', provider: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' }));
	// Optional fields are allowed to be anything; the model only needs the four.
	assert.ok(isMusicTrack({ id: 'a', title: 'A', provider: 'file', url: '/a.mp3', artist: 12, extra: true }));
});

test('a malformed entry is dropped, not played', () => {
	assert.ok(!isMusicTrack(null));
	assert.ok(!isMusicTrack(undefined));
	assert.ok(!isMusicTrack('a track'));
	assert.ok(!isMusicTrack({ title: 'A', provider: 'file', url: '/a.mp3' }));
	assert.ok(!isMusicTrack({ id: 'a', provider: 'file', url: '/a.mp3' }));
	assert.ok(!isMusicTrack({ id: 'a', title: 'A', url: '/a.mp3' }));
	assert.ok(!isMusicTrack({ id: 'a', title: 'A', provider: 'file' }));
	// `provider` selects a player branch below, so it is a closed set — and a
	// provider outside it is dropped rather than played through the wrong one.
	assert.ok(!isMusicTrack({ id: 'a', title: 'A', provider: 'bandcamp', url: 'https://x.example/a' }));
	// Spotify is now IN the set, so a well-formed Spotify track is a track.
	assert.ok(isMusicTrack({ id: 'a', title: 'A', provider: 'spotify', url: 'https://open.spotify.com/track/x' }));
	assert.ok(!isMusicTrack({ id: 1, title: 'A', provider: 'file', url: '/a.mp3' }));
});
