/**
 * BNJI.NET — background music player runtime.
 *
 * One player, four interchangeable sources (src/config/music.config.ts):
 *
 *   'none'    — disabled, explained state. Nothing loads, nothing plays.
 *   'file'    — direct audio URL via HTMLAudioElement. Full transport:
 *               play/pause, volume, mute, loading and error states.
 *   'youtube' — official IFrame API, script tag injected ONLY after the first
 *               user-initiated play. play/pause/volume/mute via the API.
 *   'spotify' — Spotify embed iframe mounted on user-initiated play; unmounted
 *               on pause (Spotify exposes no transport API). Volume/mute are
 *               disabled for this provider and say so in their tooltips.
 *
 * Autoplay policy: playback NEVER starts without an explicit user gesture.
 * There is no preload of media or player scripts before the first click.
 *
 * The player writes its state to [data-state] on the player root; all visuals
 * (spinner, error, disabled) are CSS against that attribute.
 */
import { MUSIC_SOURCE } from '../config/music.config';

export type MusicState = 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'disabled';

type PlayerRoot = HTMLElement & { dataset: DOMStringMap & { state?: MusicState } };

let started = false;

/** Minimal shape of the YouTube IFrame API player we use. */
type YtPlayer = {
	playVideo: () => void;
	pauseVideo: () => void;
	setVolume: (v: number) => void;
	mute: () => void;
	unMute: () => void;
	destroy: () => void;
};

export function initMusicPlayer(): void {
	if (started) return;
	started = true;

	const root = document.querySelector<PlayerRoot>('[data-music-player]');
	if (!root) return;

	const playButton = root.querySelector<HTMLButtonElement>('[data-music-play]');
	const muteButton = root.querySelector<HTMLButtonElement>('[data-music-mute]');
	const volume = root.querySelector<HTMLInputElement>('[data-music-volume]');
	const status = root.querySelector<HTMLElement>('[data-music-status]');
	const embedHost = root.querySelector<HTMLElement>('[data-music-embed]');
	if (!playButton || !muteButton || !volume || !status || !embedHost) return;

	const config = MUSIC_SOURCE;
	const setState = (state: MusicState, message?: string) => {
		root.dataset.state = state;
		status.textContent = message ?? defaultStatus(state);
		playButton.setAttribute('aria-label', state === 'playing' ? 'Pause music' : 'Play music');
		playButton.disabled = state === 'disabled' || state === 'loading';
	};

	const supportsVolume = config.provider === 'file' || config.provider === 'youtube';
	if (!supportsVolume) {
		for (const control of [muteButton, volume]) {
			control.disabled = true;
			control.title = 'Volume control is not available for the Spotify embed provider.';
			control.setAttribute('aria-disabled', 'true');
		}
	}

	/* --- transport abstraction -------------------------------------------- */
	let audio: HTMLAudioElement | null = null;
	let yt: YtPlayer | null = null;
	let ytReady: Promise<YtPlayer> | null = null;
	let spotifyFrame: HTMLIFrameElement | null = null;

	const configured =
		(config.provider === 'file' && config.file.url !== '') ||
		(config.provider === 'youtube' && config.youtube.videoId !== '') ||
		(config.provider === 'spotify' && config.spotify.id !== '');

	if (config.provider === 'none' || !configured) {
		setState('disabled', 'No music source configured yet.');
		root.title = 'Add a source in src/config/music.config.ts to enable background music.';
		return;
	}

	const play = async () => {
		setState('loading');
		try {
			if (config.provider === 'file') {
				if (!audio) {
					audio = new Audio(config.file.url);
					audio.loop = true;
					audio.preload = 'none';
					audio.volume = Number(volume.value) / 100;
					audio.addEventListener('playing', () => setState('playing', config.file.title || 'Playing'));
					audio.addEventListener('pause', () => setState('paused'));
					audio.addEventListener('waiting', () => setState('loading'));
					audio.addEventListener('error', () =>
						setState('error', 'Could not load the audio source.'),
					);
				}
				await audio.play();
				setState('playing', config.file.title || 'Playing');
			} else if (config.provider === 'youtube') {
				ytReady = ytReady ?? loadYouTubePlayer(embedHost, config.youtube.videoId, (state) => {
					if (state === 'playing') setState('playing', 'YouTube source');
					else if (state === 'paused') setState('paused');
					else if (state === 'error') setState('error', 'YouTube source unavailable.');
					else if (state === 'loading') setState('loading');
				});
				yt = await ytReady;
				yt.setVolume(Number(volume.value));
				yt.playVideo();
			} else if (config.provider === 'spotify') {
				if (!spotifyFrame) {
					spotifyFrame = mountSpotify(embedHost, config.spotify.id, config.spotify.type);
				}
				// The embed autoplays once mounted — which is this gesture.
				setState('playing', 'Spotify source');
			}
		} catch {
			setState('error', 'Playback was blocked or failed.');
		}
	};

	const pause = () => {
		if (config.provider === 'file') audio?.pause();
		else if (config.provider === 'youtube') yt?.pauseVideo();
		else if (config.provider === 'spotify' && spotifyFrame) {
			// No transport API: unmounting stops audio immediately.
			spotifyFrame.remove();
			spotifyFrame = null;
			setState('paused');
		}
	};

	playButton.addEventListener('click', () => {
		if (root.dataset.state === 'playing') pause();
		else void play();
	});

	muteButton.addEventListener('click', () => {
		const muted = muteButton.getAttribute('aria-pressed') === 'true';
		muteButton.setAttribute('aria-pressed', String(!muted));
		if (config.provider === 'file' && audio) audio.muted = !muted;
		else if (config.provider === 'youtube' && yt) (!muted ? yt.mute : yt.unMute)();
	});

	volume.addEventListener('input', () => {
		if (config.provider === 'file' && audio) audio.volume = Number(volume.value) / 100;
		else if (config.provider === 'youtube' && yt) yt.setVolume(Number(volume.value));
	});

	setState('idle');
}

function defaultStatus(state: MusicState): string {
	switch (state) {
		case 'loading':
			return 'Loading…';
		case 'playing':
			return 'Playing';
		case 'paused':
			return 'Paused';
		case 'error':
			return 'Playback error';
		case 'disabled':
			return 'Music unavailable';
		default:
			return 'Music off';
	}
}

/** Inject the official IFrame API once, then create a hidden player. */
function loadYouTubePlayer(
	host: HTMLElement,
	videoId: string,
	onState: (s: MusicState) => void,
): Promise<YtPlayer> {
	return new Promise((resolve, reject) => {
		const w = window as unknown as {
			YT?: { Player: new (el: string | HTMLElement, opts: object) => YtPlayer; ready?: (f: () => void) => void };
			onYouTubeIframeAPIReady?: () => void;
		};
		const create = () => {
			const el = document.createElement('div');
			host.appendChild(el);
			try {
				const player = new w.YT!.Player(el, {
					videoId,
					playerVars: { autoplay: 1, controls: 0, rel: 0 },
					events: {
						onReady: () => resolve(player),
						onStateChange: (event: { data: number }) => {
							// YT state codes: 1 playing, 2 paused, 3 buffering, 5 cued
							onState(event.data === 1 ? 'playing' : event.data === 2 ? 'paused' : event.data === 3 ? 'loading' : 'paused');
						},
						onError: () => onState('error'),
					},
				});
			} catch {
				reject(new Error('yt init failed'));
			}
		};
		if (w.YT?.Player) {
			create();
			return;
		}
		w.onYouTubeIframeAPIReady = create;
		const script = document.createElement('script');
		script.src = 'https://www.youtube.com/iframe_api';
		script.async = true;
		script.onerror = () => reject(new Error('yt api blocked'));
		document.head.appendChild(script);
	});
}

function mountSpotify(host: HTMLElement, id: string, type: 'track' | 'album' | 'playlist'): HTMLIFrameElement {
	const frame = document.createElement('iframe');
	frame.title = 'Spotify player';
	frame.loading = 'lazy';
	frame.allow = 'encrypted-media; autoplay; clipboard-write; fullscreen';
	frame.src = `https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0`;
	frame.style.width = '1px';
	frame.style.height = '80px';
	frame.style.position = 'absolute';
	frame.style.opacity = '0';
	frame.style.pointerEvents = 'none';
	host.appendChild(frame);
	return frame;
}
