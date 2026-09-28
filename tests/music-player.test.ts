/**
 * BNJI.NET — the music player's behaviour across providers.
 *
 * The queue a visitor hears is rebuilt at runtime from `/api/playlist`, and a
 * queue can mix `file` and YouTube tracks — the built-in audio file plus
 * everything the admin panel can add. What has to hold is not "each provider
 * plays" but "switching between them is clean": the previous source stops, its
 * audio element and its IFrame player are torn down, and the controls the new
 * provider cannot support are hidden with an explanation instead of left
 * looking live.
 *
 * Both `file` and YouTube expose a real transport, so the pill's progress bar
 * is always meaningful for them. Spotify is the third case and it is the
 * deliberate exception: its embed contract exposes no music-track progress or
 * end event, so the player hides the progress region, says why, and leaves
 * transport to the embed's own controls. Switching between all three is what
 * has to stay clean — the previous source stops, its audio element and IFrame
 * player are torn down, and the controls the new provider cannot support are
 * hidden with an explanation instead of left looking live.
 *
 * There is no browser here, so these run against the DOM shim in
 * tests/support/dom.mjs with a virtual clock, a fake IFrame API and a fake
 * `<audio>`. The fixture mirrors MusicPlayer.astro's selectors, so a rename in
 * the component fails here rather than silently skipping.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installTestDom } from './support/dom.mjs';
import type { MusicTrack } from '../src/config/music.config.ts';

type Dom = ReturnType<typeof installTestDom>;
type MusicModule = typeof import('../src/scripts/music.ts');
type SettingsModule = typeof import('../src/scripts/settings.ts');

let musicModule: MusicModule | null = null;
let settingsModule: SettingsModule | null = null;
let active: Dom | null = null;

/** `music.ts` reads the DOM globals at import time, so the import waits. */
async function modules(): Promise<{ music: MusicModule; settings: SettingsModule }> {
	if (!musicModule) musicModule = await import('../src/scripts/music.ts');
	if (!settingsModule) settingsModule = await import('../src/scripts/settings.ts');
	return { music: musicModule, settings: settingsModule };
}

const FILE_TRACK: MusicTrack = {
	id: 'file-1',
	title: 'the feeling',
	provider: 'file',
	url: '/music/the feeling.mp3',
	artist: 'benji',
	album: 'Songs',
};

const YOUTUBE_TRACK: MusicTrack = {
	id: 'yt-1',
	title: 'a video',
	provider: 'youtube',
	url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
	publishedAt: '2024-05-01',
};

/** Boot the player against a given `/api/playlist` payload. */
async function boot(tracks: MusicTrack[], options: { youtubeApi?: boolean } = {}): Promise<Dom> {
	const dom = installTestDom({
		responses: [{ initialized: true, count: tracks.length, tracks }],
	});
	if (options.youtubeApi !== false) dom.installYouTubeApi();
	const { music } = await modules();
	music.initMusicPlayer();
	await dom.settle(12);
	active = dom;
	return dom;
}

afterEach(() => {
	if (active) {
		musicModule?.destroyMusicPlayer();
		active.uninstall();
		active = null;
	}
});

/* --- file ----------------------------------------------------------------- */

test('a file track plays through an <audio> element the settings drive', async () => {
	const { settings } = await modules();
	const dom = await boot([FILE_TRACK]);

	const audio = dom.lastAudio();
	assert.ok(audio, 'a file track must create an audio element');
	assert.equal(audio.src, '/music/the feeling.mp3');
	assert.equal(audio.playCalls, 1);
	// Volume and mute are the visitor's, from the shared settings store.
	assert.equal(audio.volume, settings.getSettings().volume);
	assert.equal(audio.muted, settings.getSettings().muted);

	assert.equal(dom.dataset.state, 'playing');
	assert.equal(dom.dataset.provider, 'file');
	assert.equal(dom.text('[data-music-current-title]'), 'the feeling');
	// Non-empty metadata is shown, and nothing is left as a blank label.
	assert.equal(dom.text('[data-music-current-artist]'), 'benji');
	assert.equal(dom.hidden('[data-music-current-artist]'), false);
	assert.equal(dom.text('[data-music-current-album]'), 'Songs');
	assert.equal(dom.hidden('[data-music-current-date]'), true);
	assert.equal(dom.hidden('[data-music-progress-region]'), false);
});

test('volume and mute reach the IFrame player, live and on ready', async () => {
	// The pill has no slider and no mute button of its own — Settings → Audio
	// owns both, for every provider. The file path is an <audio> element, so
	// setting `.volume` is enough; a YouTube player needs the API calls, and
	// they have to be re-issued when the visitor changes the setting while a
	// video is already loaded. Skipping either half leaves a video playing at
	// full volume after the visitor muted the site.
	// The settings store notifies through `window`, so the DOM has to be
	// installed before the first change — exactly as it is for a visitor.
	const { music, settings } = await modules();
	const dom = installTestDom({ responses: [{ initialized: true, count: 1, tracks: [YOUTUBE_TRACK] }] });
	dom.installYouTubeApi();
	settings.setSetting('volume', 0.4);
	settings.setSetting('muted', true);

	music.initMusicPlayer();
	// Long enough for the whole chain to drain: loadYouTubeApi -> onReady ->
	// playYouTubeTrack's own applyAudioSettings(). Snapshotting mid-chain would
	// count the tail of the boot as the effect of the settings change.
	await dom.settle(40);
	active = dom;

	const player = dom.lastYouTube();
	assert.ok(player, 'a YouTube track must create an IFrame player');
	assert.equal(player?.volumeValue, 40, 'the initial volume must reach the player');
	assert.ok((player?.muteCalls ?? 0) >= 1, 'the initial mute must reach the player');
	assert.equal(player?.unmuteCalls, 0, 'a muted player must not be unmuted');

	// A change while the video is loaded must be re-applied, not remembered for
	// the next track only. The counts are snapshotted so the assertion is about
	// the change causing the call, not about how often the player re-applied
	// the same state while it was loading.
	const muted = { mute: player?.muteCalls ?? 0, unmute: player?.unmuteCalls ?? 0 };
	settings.setSetting('muted', false);
	await dom.settle(12);
	assert.equal(player?.unmuteCalls, muted.unmute + 1, 'unmuting must reach the live player');
	assert.equal(player?.muteCalls, muted.mute, 'unmuting must not also mute');

	settings.setSetting('volume', 0.85);
	await dom.settle(12);
	assert.equal(player?.volumeValue, 85, 'the new volume must reach the live player');
});

test('a blocked autoplay attempt is a state, and the first real input retries', async () => {
	const dom = installTestDom({ responses: [{ initialized: true, count: 1, tracks: [FILE_TRACK] }] });
	dom.installYouTubeApi();
	dom.rejectNextAudioPlay('NotAllowedError');
	const { music } = await modules();
	music.initMusicPlayer();
	await dom.settle(12);
	active = dom;

	assert.equal(dom.dataset.state, 'blocked');
	const audio = dom.lastAudio();
	assert.equal(audio?.playCalls, 1);

	dom.outsideInput();
	await dom.settle(12);
	assert.equal(audio?.playCalls, 2, 'the first trusted input must retry playback');
});

test('a file track that cannot be loaded says so instead of spinning', async () => {
	const dom = await boot([FILE_TRACK]);
	const audio = dom.lastAudio();
	audio?.emit('error');
	assert.equal(dom.dataset.state, 'error');
	assert.match(dom.text('[data-music-state-announcement]') ?? '', /Could not load this audio file/);
});

test('the end of a file track advances to the next one', async () => {
	const dom = await boot([FILE_TRACK, { ...FILE_TRACK, id: 'file-2', title: 'second', url: '/music/two.mp3' }]);
	dom.lastAudio()?.emit('ended');
	await dom.settle(12);

	assert.equal(dom.text('[data-music-current-title]'), 'second');
	assert.equal(dom.lastAudio()?.src, '/music/two.mp3');
	assert.equal(dom.lastAudio()?.playCalls, 1);
	// The finished element is released rather than left holding the old source.
	assert.equal(dom.audioRegistry[0]?.src, '');
});

/* --- youtube -------------------------------------------------------------- */

test('a YouTube track plays through the IFrame player, not an audio element', async () => {
	const dom = await boot([YOUTUBE_TRACK]);

	assert.equal(dom.audioRegistry.length, 0, 'a YouTube track must not create an <audio>');
	const player = dom.lastYouTube();
	assert.ok(player, 'a YouTube track must create an IFrame player');
	assert.equal(player.videoId, 'dQw4w9WgXcQ');
	assert.equal(dom.dataset.provider, 'youtube');

	// The player was constructed with this video already cued, so it plays it
	// directly rather than loading it again.
	assert.equal(player.loadedVideoIds.length, 0, 'the first video is the one the player was built with');
	assert.equal(dom.dataset.state, 'playing');
	// Progress is available for YouTube, so the region is shown with no excuse.
	assert.equal(dom.hidden('[data-music-progress-region]'), false);
	assert.equal(dom.hidden('[data-music-progress-note]'), true);
});

test('a second YouTube video is loaded into the same player, buffering first', async () => {
	const dom = await boot([YOUTUBE_TRACK, { ...YOUTUBE_TRACK, id: 'yt-2', url: 'https://youtu.be/abcdefghijk' }]);
	const player = dom.lastYouTube();

	dom.click('[data-music-track-index="1"]');
	await dom.settle(25);

	assert.deepEqual(player?.loadedVideoIds, ['abcdefghijk']);
	assert.equal(dom.dataset.state, 'loading', 'a newly loaded video buffers before it plays');
	player?.playVideo();
	assert.equal(dom.dataset.state, 'playing');
});

test('a YouTube video that cannot be played is reported, not ignored', async () => {
	const dom = await boot([YOUTUBE_TRACK]);
	dom.lastYouTube()?.fail();

	assert.equal(dom.dataset.state, 'error');
	assert.match(dom.text('[data-music-state-announcement]') ?? '', /YouTube video unavailable/);
});

test('the end of a YouTube video advances to the next track', async () => {
	const dom = await boot([YOUTUBE_TRACK, FILE_TRACK]);
	dom.lastYouTube()?.playVideo();
	dom.lastYouTube()?.finish();
	await dom.settle(12);

	assert.equal(dom.text('[data-music-current-title]'), 'the feeling');
	assert.equal(dom.lastAudio()?.src, '/music/the feeling.mp3');
});

test('an unreachable YouTube API is an error state the operator can read', async () => {
	const dom = installTestDom({ responses: [{ initialized: true, count: 1, tracks: [YOUTUBE_TRACK] }] });
	// No window.YT: the player has to load the script, and the script fails.
	const { music } = await modules();
	music.initMusicPlayer();
	await dom.settle(12);
	active = dom;

	const script = dom.document.querySelector('script[data-music-youtube-api]');
	assert.ok(script, 'the IFrame API script must be requested');
	script.dispatchEvent({ type: 'error' });
	await dom.settle(12);

	assert.equal(dom.dataset.state, 'error');
	assert.match(dom.text('[data-music-state-announcement]') ?? '', /Could not load the YouTube player/);
});

/* --- youtube failure states ----------------------------------------------- */

test('the autoplay probe is cancelled by a track change and by destroy', async () => {
	// The probe is a one-shot timer that decides whether autoplay was refused.
	// A timer left pending after the track it was probing is gone would fire
	// against a player that no longer owns the shell and flip an unrelated
	// track to "blocked".
	const dom = await boot([YOUTUBE_TRACK, FILE_TRACK, YOUTUBE_TRACK]);
	const pending = () => dom.clock.pending();
	assert.ok(pending() >= 1, 'the probe must be scheduled for a YouTube track');

	// Moving to a file track cancels it rather than letting it fire.
	dom.click('[data-music-track-index="1"]');
	await dom.settle(12);
	assert.equal(dom.clock.pending(), 0, 'leaving YouTube must cancel the probe');

	// And a player that is destroyed cancels it too.
	dom.click('[data-music-track-index="2"]');
	await dom.settle(12);
	assert.ok(dom.clock.pending() >= 1, 'a new YouTube track arms a new probe');
	musicModule?.destroyMusicPlayer();
	assert.equal(dom.clock.pending(), 0, 'destroy must cancel the probe');

	// Advancing well past the probe's 1600 ms changes nothing once it is gone:
	// a cancelled timer cannot report on a shell that no longer owns it.
	const settled = dom.dataset.state;
	dom.advance(5000);
	await dom.settle(12);
	assert.equal(dom.dataset.state, settled, 'a cancelled probe must not report anything');
});

test('an unavailable or unembeddable video is an error, not a silent player', async () => {
	// The IFrame API reports 101 (the uploader refused embedding) and 100 (the
	// video does not exist) through onError. Both must land in the error state
	// with a sentence that says what happened, rather than leaving the pill
	// looking like it is playing something.
	const dom = await boot([YOUTUBE_TRACK]);
	dom.lastYouTube()?.fail();
	await dom.settle(12);

	assert.equal(dom.dataset.state, 'error');
	assert.match(dom.text('[data-music-state-announcement]') ?? '', /YouTube video unavailable/);
	// The play button stays live so the operator can try the next item.
	assert.equal(dom.disabled('[data-music-play]'), false);
});

test('a YouTube link the player cannot read is an error, not a blank frame', async () => {
	const dom = await boot([{ ...YOUTUBE_TRACK, url: 'https://example.com/not-a-video' }]);
	assert.equal(dom.dataset.state, 'error');
	assert.match(dom.text('[data-music-state-announcement]') ?? '', /not a valid YouTube video link/);
	// The registry keeps destroyed instances on purpose, so "no live player" is
	// the assertion that matters — and comparing a shim object to null would
	// make node:assert render an 800 KB diff.
	assert.equal(dom.youtubeRegistry.filter((entry) => !entry.destroyed).length, 0, 'no live player may be left behind');
});

/* --- switching between providers ------------------------------------------ */

test('file -> youtube stops the audio and starts the video', async () => {
	const dom = await boot([FILE_TRACK, YOUTUBE_TRACK]);
	const audio = dom.lastAudio();
	assert.equal(audio?.playCalls, 1);

	dom.click('[data-music-track-index="1"]');
	await dom.settle(12);

	// The previous source is stopped AND unloaded: its src is gone, so a
	// half-loaded file cannot keep streaming behind the new track.
	assert.ok((audio?.pauseCalls ?? 0) >= 1, 'the audio element must be paused');
	assert.equal(audio?.src, '', 'the audio element must be released');
	assert.equal(dom.audioRegistry.at(-1)?.src, '', 'no new audio element for a YouTube track');
	assert.equal(dom.lastYouTube()?.videoId, 'dQw4w9WgXcQ');
	assert.equal(dom.dataset.provider, 'youtube');
	assert.equal(dom.text('[data-music-current-title]'), 'a video');
	assert.equal(dom.hidden('[data-music-progress-region]'), false);
});

test('youtube -> file destroys the player, not just pauses it', async () => {
	const dom = await boot([YOUTUBE_TRACK, FILE_TRACK]);
	const player = dom.lastYouTube();
	player?.playVideo();

	dom.click('[data-music-track-index="1"]');
	await dom.settle(12);

	// Pausing would leave the iframe's listeners, its buffered audio and any
	// error state alive for a track that is no longer in view. Destroying is
	// the only cleanup that leaves exactly one thing making sound.
	assert.equal(player?.destroyed, true, 'leaving YouTube must destroy the player');
	// The registry keeps destroyed instances on purpose, so "no live player" is
	// the assertion that matters — and comparing a shim object to null would
	// make node:assert render an 800 KB diff.
	assert.equal(dom.youtubeRegistry.filter((entry) => !entry.destroyed).length, 0, 'no live player may be left behind');
	assert.equal(dom.lastAudio()?.src, '/music/the feeling.mp3');
	assert.equal(dom.dataset.provider, 'file');
	assert.equal(dom.hidden('[data-music-progress-region]'), false);
});

test('a full round trip leaves exactly one live source', async () => {
	const dom = await boot([FILE_TRACK, YOUTUBE_TRACK, FILE_TRACK]);

	dom.click('[data-music-track-index="1"]');
	await dom.settle(12);
	dom.click('[data-music-track-index="2"]');
	await dom.settle(12);
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);

	// Exactly one audio element holds a source, and no YouTube player is left
	// over from the visit to the middle of the queue.
	const live = dom.audioRegistry.filter((audio) => audio.src !== '');
	assert.equal(live.length, 1, 'only the current file track may hold a source');
	assert.equal(live[0]?.src, '/music/the feeling.mp3');
	// The registry keeps destroyed instances on purpose, so "no live player" is
	// the assertion that matters — and comparing a shim object to null would
	// make node:assert render an 800 KB diff.
	assert.equal(dom.youtubeRegistry.filter((entry) => !entry.destroyed).length, 0, 'no live player may be left behind');
	assert.equal(dom.dataset.provider, 'file');
});

test('switching between two YouTube videos reuses one player instance', async () => {
	// One player, two loadVideoById calls: creating an iframe per track would
	// leak a player per skip, and the IFrame API is built to swap videos.
	const dom = await boot([YOUTUBE_TRACK, { ...YOUTUBE_TRACK, id: 'yt-2', url: 'https://youtu.be/aaaaaaaaaaa' }]);
	const first = dom.lastYouTube();

	dom.click('[data-music-track-index="1"]');
	await dom.settle(12);

	assert.equal(dom.youtubeRegistry.length, 1, 'no second iframe player may be created');
	assert.equal(first?.destroyed, false, 'the live player must not be destroyed');
	assert.equal(first?.videoId, 'aaaaaaaaaaa', 'the same player swaps to the new video');
	assert.deepEqual(first?.loadedVideoIds, ['aaaaaaaaaaa'], 'swapping is one loadVideoById');
	assert.equal(dom.text('[data-music-current-title]'), 'a video');
});

test('the current track cannot be restarted by clicking its own row', async () => {
	const dom = await boot([FILE_TRACK, YOUTUBE_TRACK]);
	const audio = dom.lastAudio();
	assert.equal(audio?.playCalls, 1);

	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	assert.equal(audio?.playCalls, 1, 're-selecting the playing track is a no-op');
});

/* --- the queue markup ----------------------------------------------------- */

test('the rebuilt queue keeps its order and its per-provider labels', async () => {
	const dom = await boot([YOUTUBE_TRACK, FILE_TRACK]);

	const buttons = dom.player.querySelectorAll('[data-music-track-index]');
	assert.equal(buttons.length, 2);
	assert.deepEqual(
		buttons.map((button) => button.getAttribute('aria-label')),
		['Play a video, Published 2024-05-01', 'Play the feeling, by benji, from Songs'],
	);
	// The provider is visible on each row, so a mixed queue is legible.
	assert.deepEqual(
		buttons.map((button) => button.getAttribute('data-provider')),
		['youtube', 'file'],
	);
	assert.equal(dom.text('[data-music-queue-count]'), '2');
	// Empty metadata renders nothing at all, not an empty line.
	const fileRow = buttons[1];
	assert.equal(fileRow.querySelectorAll('.music-player__track-meta').length, 2);
	assert.equal(fileRow.querySelectorAll('.music-player__track-meta')[0]?.textContent, 'benji');
});

test('the prerendered queue is replaced, not appended to', async () => {
	const dom = await boot([FILE_TRACK]);
	assert.equal(dom.count('[data-music-track-list]'), 1);
	assert.equal(dom.count('[data-music-track-index]'), 1);
});

test('the queue count follows the saved playlist', async () => {
	const dom = await boot([FILE_TRACK, YOUTUBE_TRACK]);
	assert.equal(dom.text('[data-music-queue-count]'), '2');
	assert.equal(dom.dataset.trackCount, '2');
});

/* --- playlist dialog ------------------------------------------------------ */

test('the playlist dialog opens, closes on Escape and on an outside click', async () => {
	const dom = await boot([FILE_TRACK]);

	assert.equal(dom.hidden('[data-music-playlist]'), true);
	dom.click('[data-music-playlist-toggle]');
	assert.equal(dom.hidden('[data-music-playlist]'), false);
	assert.equal(dom.attr('[data-music-playlist-toggle]', 'aria-expanded'), 'true');

	dom.keydown('[data-music-playlist]', 'Escape');
	assert.equal(dom.hidden('[data-music-playlist]'), true);
	assert.equal(dom.attr('[data-music-playlist-toggle]', 'aria-expanded'), 'false');

	dom.click('[data-music-playlist-toggle]');
	assert.equal(dom.hidden('[data-music-playlist]'), false);
	dom.outsideInput();
	assert.equal(dom.hidden('[data-music-playlist]'), true, 'an outside pointer must close the dialog');
});

/* --- states the player must survive --------------------------------------- */

test('an empty saved playlist stays empty and points at the admin panel', async () => {
	const dom = await boot([]);

	const empty = dom.player.querySelector('.music-player__empty');
	assert.ok(empty, 'an empty playlist must say so');
	assert.match(empty.textContent, /admin playlist panel/);
	assert.equal(dom.count('[data-music-track-index]'), 0);
	assert.equal(dom.text('[data-music-queue-count]'), '0');
	assert.equal(dom.disabled('[data-music-play]'), true);
	assert.equal(dom.disabled('[data-music-next]'), true);
	assert.equal(dom.dataset.state, 'disabled');
	assert.equal(dom.text('[data-music-current-title]'), 'No songs configured');
});

test('a failing playlist read leaves the prerendered queue in place', async () => {
	const dom = installTestDom({ responses: [{ error: 'storage_unconfigured', status: 503 }] });
	dom.installYouTubeApi();
	const { music } = await modules();
	music.initMusicPlayer();
	await dom.settle(12);
	active = dom;

	// Nothing was swapped in, so the static seed still plays.
	assert.equal(dom.count('[data-music-track-index]'), 0, 'the fixture has no prerendered rows');
	assert.equal(dom.text('[data-music-current-title]'), 'the feeling');
	assert.equal(dom.dataset.provider, 'file');
	assert.equal(dom.lastAudio()?.src, '/music/the feeling.mp3');
});

test('a malformed playlist response is ignored rather than half-applied', async () => {
	const dom = installTestDom({ responses: ['this is not json'] });
	dom.installYouTubeApi();
	const { music } = await modules();
	music.initMusicPlayer();
	await dom.settle(12);
	active = dom;

	assert.equal(dom.count('[data-music-track-index]'), 0);
	assert.equal(dom.text('[data-music-current-title]'), 'the feeling');
	assert.equal(dom.lastAudio()?.src, '/music/the feeling.mp3');
});

test('entries that are not tracks are dropped from the saved playlist', async () => {
	const dom = await boot([
		FILE_TRACK,
		// A malformed row from the network: it must not become a player.
		{ id: 'bad', title: 'no provider', url: '/music/x.mp3' } as unknown as MusicTrack,
		null as unknown as MusicTrack,
		YOUTUBE_TRACK,
	]);

	const buttons = dom.player.querySelectorAll('[data-music-track-index]');
	assert.equal(buttons.length, 2, 'only well-formed tracks may reach the queue');
	assert.equal(dom.text('[data-music-current-title]'), 'the feeling');
	assert.equal(dom.text('[data-music-queue-count]'), '2');
});

test('a hung playlist request does not hold the player hostage', async () => {
	const dom = installTestDom({ responses: [new Error('aborted')] });
	dom.installYouTubeApi();
	const { music } = await modules();
	music.initMusicPlayer();
	// The four-second abort is what frees the player.
	dom.advance(4000);
	await dom.settle(12);
	active = dom;

	assert.equal(dom.lastAudio()?.src, '/music/the feeling.mp3');
	assert.equal(dom.dataset.provider, 'file');
});

test('destroying the player stops every source and drops its listeners', async () => {
	const dom = await boot([FILE_TRACK, YOUTUBE_TRACK, FILE_TRACK]);
	dom.click('[data-music-track-index="1"]');
	await dom.settle(12);
	dom.click('[data-music-track-index="2"]');
	await dom.settle(12);

	const audio = dom.audioRegistry.at(-1);
	musicModule?.destroyMusicPlayer();

	// The YouTube player was already destroyed when the queue moved off it, so
	// there is nothing left to stop: exactly one audio element is released and
	// no iframe survives the shell being torn down.
	assert.equal(dom.youtubeRegistry.filter((entry) => !entry.destroyed).length, 0, 'no live player may survive');
	assert.equal(audio?.src, '', 'the audio element must be released');
	assert.equal(dom.hidden('[data-music-playlist]'), true);
	// Listeners registered with the player's signal are gone: a click does
	// nothing rather than selecting a track in a torn-down player.
	const before = dom.audioRegistry.length;
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	assert.equal(dom.audioRegistry.length, before);
});

/* --- Spotify -------------------------------------------------------------- */

const SPOTIFY_TRACK = {
	id: 'spot-1',
	title: 'Never Gonna Give You Up',
	artist: 'Rick Astley',
	releaseDate: '1987-11-07',
	provider: 'spotify' as const,
	url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
};

/**
 * The embed host's live iframe, or null when the host is empty.
 *
 * `childNodes`, not `children`: TestElement in tests/support/dom.mjs is
 * deliberately not a spec-complete Element and only carries the former. A
 * `children` read here would be `undefined`, so every assertion below would
 * fail with a TypeError rather than a real difference — the failure mode this
 * helper exists to avoid.
 */
function spotifyFrame(dom: Dom): HTMLIFrameElement | null {
	const host = dom.player.querySelector('[data-music-spotify-host]');
	// The shim's node is not an HTMLIFrameElement, but the node it hands back
	// for `document.createElement('iframe')` is the one mountSpotifyFrame()
	// built, and in a browser it is exactly this type — so the cast describes
	// the real element rather than papering over a mismatch.
	return (host?.childNodes[0] as HTMLIFrameElement | undefined) ?? null;
}

test('a Spotify track mounts an embed iframe instead of an audio element', async () => {
	const dom = await boot([SPOTIFY_TRACK]);
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	active = dom;

	const frame = spotifyFrame(dom);
	assert.ok(frame, 'a Spotify track must mount an embed');
	// Property reads, not getAttribute(): mountSpotifyFrame() assigns
	// `frame.src = …`, and the shim does not reflect a property assignment
	// back into the attribute map — so getAttribute('src') would return null
	// for a correctly built embed and pass a shim gap off as a product bug.
	assert.equal(frame.src, 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=generator&theme=0');
	// A titled iframe, not an anonymous one: it is the only visible player.
	assert.equal(frame.title, 'Spotify player: Never Gonna Give You Up');
	// And no <audio> is built for it — the embed is the source.
	assert.equal(dom.audioRegistry.length, 0, 'a Spotify track must not create an audio element');
	assert.equal(dom.dataset.provider, 'spotify');
});

test('a spotify: URI in a config entry is a valid target too', async () => {
	const dom = await boot([{ ...SPOTIFY_TRACK, url: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' }]);
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	active = dom;

	assert.equal(
		spotifyFrame(dom)?.src,
		'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=generator&theme=0',
	);
});

test('parseSpotifyTarget reads both Spotify forms, and albums and playlists too', () => {
	// This is the CLIENT's parser, and it is deliberately wider than the
	// server's parseMusicLink(). The importer expands a single track and
	// refuses an album; a hand-authored config entry is a different case —
	// Spotify's embed endpoint serves /embed/album/<id> and
	// /embed/playlist/<id> as happily as /embed/track/<id>, so refusing them
	// here would refuse a link that plays perfectly well. The narrow gate is
	// IMPORTABLE_PROVIDER on the admin route, not this function.
	const target = musicModule?.parseSpotifyTarget('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
	assert.deepEqual(target, { type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' });

	for (const type of ['track', 'album', 'playlist'] as const) {
		assert.deepEqual(musicModule?.parseSpotifyTarget(`https://open.spotify.com/${type}/4uLU6hMCjMI75M1A2tKUQC`), {
			type,
			id: '4uLU6hMCjMI75M1A2tKUQC',
		});
		// The URI form of the same link, and a locale-prefixed one.
		assert.deepEqual(musicModule?.parseSpotifyTarget(`spotify:${type}:4uLU6hMCjMI75M1A2tKUQC`), {
			type,
			id: '4uLU6hMCjMI75M1A2tKUQC',
		});
		assert.deepEqual(
			musicModule?.parseSpotifyTarget(`https://open.spotify.com/intl-de/${type}/4uLU6hMCjMI75M1A2tKUQC`),
			{ type, id: '4uLU6hMCjMI75M1A2tKUQC' },
		);
	}

	// Refused: a wrong host, a non-Spotify scheme, and a short id.
	assert.equal(musicModule?.parseSpotifyTarget('https://youtube.com/watch?v=dQw4w9WgXcQ'), null);
	assert.equal(musicModule?.parseSpotifyTarget('https://open.spotify.com.attacker.example/track/4uLU6hMCjMI75M1A2tKUQC'), null);
	assert.equal(musicModule?.parseSpotifyTarget('spotify:episode:4uLU6hMCjMI75M1A2tKUQC'), null);
	assert.equal(musicModule?.parseSpotifyTarget('https://open.spotify.com/track/tooshort'), null);
	assert.equal(musicModule?.parseSpotifyTarget('   '), null);
});

test('leaving a Spotify track removes the embed rather than hiding it', async () => {
	// The embed keeps playing on its own, so "pausing" it is not a thing the
	// player can do. Removing it is the only honest cleanup.
	const dom = await boot([SPOTIFY_TRACK, FILE_TRACK]);
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	assert.ok(spotifyFrame(dom), 'the embed is mounted');

	dom.click('[data-music-track-index="1"]');
	await dom.settle(12);
	active = dom;

	assert.equal(spotifyFrame(dom), null, 'the embed must be gone, not merely hidden');
	assert.equal(dom.dataset.provider, 'file');
	assert.equal(dom.lastAudio()?.src, '/music/the feeling.mp3');
});

test('a Spotify track says the progress region is not available, and why', async () => {
	const dom = await boot([SPOTIFY_TRACK]);
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	active = dom;

	// There is no supported music-track progress contract, so the region is
	// hidden rather than driven by a guess — and the note says so, because a
	// silently missing progress bar looks like a bug.
	assert.equal(dom.hidden('[data-music-progress-region]'), true);
	assert.match(dom.text('[data-music-progress-note]'), /Spotify does not document/);
	assert.equal(dom.hidden('[data-music-progress-note]'), false);
});

test('a bad Spotify URL is an error state, not a blank frame', async () => {
	const dom = await boot([{ ...SPOTIFY_TRACK, url: 'https://open.spotify.com/album/xyz' }]);
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	active = dom;

	assert.equal(spotifyFrame(dom), null, 'an unembeddable link must not mount a frame');
	assert.equal(dom.dataset.state, 'error');
	// The reason reaches the live region, composed with the title, rather than
	// the meta line — a blank frame with no explanation is the failure this
	// guards against.
	assert.match(
		dom.text('[data-music-state-announcement]'),
		/That is not a valid Spotify link: Never Gonna Give You Up/,
	);
});
test('pausing a Spotify track stops the audio, by unmounting the embed', async () => {
	// There is no documented API to pause the music embed, so the only lever
	// that actually stops the audio is removing the frame. The cost — resuming
	// restarts the track — is stated in the source; what must hold here is that
	// the pill never claims "paused" while the music is still going.
	const dom = await boot([SPOTIFY_TRACK]);
	dom.click('[data-music-track-index="0"]');
	await dom.settle(12);
	assert.ok(spotifyFrame(dom), 'the embed is mounted while playing');

	dom.click('[data-music-play]');
	await dom.settle(12);
	active = dom;

	assert.equal(dom.dataset.state, 'paused');
	assert.equal(spotifyFrame(dom), null, 'the embed must be gone, or the audio keeps playing');

	// And play brings it back: the toggle round-trips rather than dead-ending.
	dom.click('[data-music-play]');
	await dom.settle(12);
	assert.equal(
		spotifyFrame(dom)?.src,
		'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=generator&theme=0',
	);
	assert.equal(dom.dataset.state, 'playing');
});
