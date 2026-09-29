/**
 * BNJI.NET — Verity secret code balls physics and audio integration tests.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installTestDom } from './support/dom.mjs';

type Dom = ReturnType<typeof installTestDom>;

let activeDom: Dom | null = null;

afterEach(() => {
	if (activeDom) activeDom.uninstall();
	activeDom = null;
});

async function setupDom() {
	activeDom = installTestDom(/* html */ `
		<div data-music-player data-state="idle">
			<button type="button" data-music-play aria-label="Play music">Play</button>
			<button type="button" data-music-next aria-label="Next track">Next</button>
			<button type="button" data-music-playlist-toggle aria-label="Open music playlist">Playlist</button>
			<button type="button" data-music-playlist-close aria-label="Close music playlist">Close</button>
			<div data-music-playlist hidden>
				<div data-music-track-list></div>
			</div>
			<div data-music-status-title></div>
			<div data-music-status-meta></div>
			<div data-music-state-announcement></div>
			<div data-music-youtube-host aria-hidden="true"></div>
			<div data-music-spotify-host aria-hidden="true"></div>
			<div data-music-current-title></div>
			<div data-music-current-artist></div>
			<div data-music-current-album></div>
			<div data-music-current-date></div>
			<div data-music-progress-region hidden>
				<div data-music-progress role="progressbar" aria-valuenow="0" aria-valuetext="0:00 of 0:00"></div>
				<div data-music-progress-fill></div>
				<div data-music-elapsed>0:00</div>
				<div data-music-duration>0:00</div>
			</div>
			<div data-music-progress-note hidden></div>
		</div>
	`);

	const { initMusicPlayer, destroyMusicPlayer } = await import('../src/scripts/music.ts');
	destroyMusicPlayer();
	initMusicPlayer();

	const { spawnVerityBalls, clearVerityBalls } = await import('../src/scripts/verity-balls.ts');
	clearVerityBalls();

	return { dom: activeDom, destroyMusicPlayer, spawnVerityBalls, clearVerityBalls };
}

test('spawnVerityBalls creates stage and balls within viewport bounds', async () => {
	const { dom, spawnVerityBalls, clearVerityBalls } = await setupDom();

	try {
		spawnVerityBalls();
		const stage = dom.q('[id="verity-balls-stage"]');
		assert.notEqual(stage, null, 'stage exists');
		assert.equal(stage?.id, 'verity-balls-stage');

		const balls = stage?.querySelectorAll('div') ?? [];
		assert.ok(balls.length > 0, 'balls were spawned');

		clearVerityBalls();
		assert.equal(dom.q('[id="verity-balls-stage"]'), null, 'stage removed after clear');
	} finally {
		clearVerityBalls();
	}
});

test('spawnVerityBalls pauses playing music and clearVerityBalls resumes it', async () => {
	const { dom, spawnVerityBalls, clearVerityBalls } = await setupDom();

	try {
		const playBtn = dom.q('[data-music-play]');
		assert.notEqual(playBtn, null);

		// Simulate background music playing
		const playerRoot = dom.q('[data-music-player]');
		assert.notEqual(playerRoot, null);
		playerRoot!.dataset.state = 'playing';

		// Spawn verity balls -> should pause playing music
		spawnVerityBalls();
		assert.equal(playerRoot!.dataset.state, 'paused', 'background music is paused when verity balls spawn');

		// Clear verity balls -> should resume playing music
		clearVerityBalls();
		assert.notEqual(playerRoot!.dataset.state, 'paused', 'background music resumed after clearing verity balls');
	} finally {
		clearVerityBalls();
	}
});

test('spawnVerityBalls does not resume music on clear if music was not playing beforehand', async () => {
	const { dom, spawnVerityBalls, clearVerityBalls } = await setupDom();

	try {
		const playerRoot = dom.q('[data-music-player]');
		assert.notEqual(playerRoot, null);
		playerRoot!.dataset.state = 'paused';

		// Spawn verity balls when music is already paused
		spawnVerityBalls();
		assert.equal(playerRoot!.dataset.state, 'paused');

		// Clear verity balls -> should remain paused
		clearVerityBalls();
		assert.equal(playerRoot!.dataset.state, 'paused', 'background music stays paused if it was not playing before');
	} finally {
		clearVerityBalls();
	}
});
