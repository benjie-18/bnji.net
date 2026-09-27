/**
 * BNJI.NET — background music runtime.
 *
 * The site UI is the small pill (components/MusicPlayer.astro): play/pause,
 * mute and a status dot — nothing else. Volume lives in the Settings overlay.
 * All audio preference (volume, mute) flows through the central settings
 * store (scripts/settings.ts): the pill's mute button, the overlay's Audio
 * rows and this module are three views of ONE state; nothing here persists
 * anything itself.
 *
 * Autoplay policy (honest)
 * ------------------------
 * Playback is ATTEMPTED on page load. Browsers routinely refuse unmuted
 * autoplay; when the attempt is refused we do not work around the refusal —
 * the pill falls into [data-state="blocked"], a small but clearly visible
 * tap-to-play affordance, and waits for a real gesture. (Muted autoplay is
 * generally allowed, so with the store's mute on, the attempt usually
 * succeeds silently.)
 *
 * Three providers, three genuinely distinct surfaces
 * ---------------------------------------------------
 *   'file'    — HTMLAudioElement. Real events (playing/pause/waiting/error),
 *               a real transport (volume, mute, resume), and a precise
 *               blocked detection: play() rejects with NotAllowedError.
 *               The pill is the whole UI.
 *   'youtube' — official IFrame API in a hidden iframe. Events arrive via
 *               onStateChange; volume/mute through the API. The API fires NO
 *               "autoplay refused" event, so a non-gesture attempt is probed
 *               once after it settles (getPlayerState) and reported as
 *               blocked if the video never started. The pill is the whole UI.
 *   'spotify' — embed iframe with ZERO transport API: no events, no volume,
 *               no mute. Pretending otherwise would be a lie, so the embed
 *               itself is the control surface: it mounts VISIBLE on every
 *               play attempt (including the load-time autoplay attempt) and
 *               unmounts on pause. Whether autoplay actually started is
 *               visible inside the embed — Spotify's own play button is the
 *               blocked affordance. The pill's mute button is disabled and
 *               says why.
 *   'none'    — disabled, explained state. Nothing loads, nothing plays.
 *
 * The player writes its state to [data-state] on the player root; all visuals
 * (dot colour, spinner, blocked pulse, error) are CSS against that attribute.
 */
import { MUSIC_SOURCE } from '../config/music.config';
import { getSettings, setSetting, subscribeSettings } from './settings';

export type MusicState =
	| 'idle'
	| 'loading'
	| 'playing'
	| 'paused'
	| 'blocked'
	| 'error'
	| 'disabled';

type PlayerRoot = HTMLElement & { dataset: DOMStringMap & { state?: MusicState } };

let started = false;

/** Minimal shape of the YouTube IFrame API player we use. */
type YtPlayer = {
	playVideo: () => void;
	pauseVideo: () => void;
	setVolume: (v: number) => void;
	mute: () => void;
	unMute: () => void;
	/** YT player state: 1 playing, 2 paused, 3 buffering, 5 cued. */
	getPlayerState?: () => number;
	destroy: () => void;
};

export function initMusicPlayer(): void {
	if (started) return;
	started = true;

	const root = document.querySelector<PlayerRoot>('[data-music-player]');
	if (!root) return;

	const playButton = root.querySelector<HTMLButtonElement>('[data-music-play]');
	const muteButton = root.querySelector<HTMLButtonElement>('[data-music-mute]');
	const status = root.querySelector<HTMLElement>('[data-music-status]');
	const embedHost = root.querySelector<HTMLElement>('[data-music-embed]');
	const toggleButton = root.querySelector<HTMLButtonElement>('[data-music-toggle]');
	if (!playButton || !muteButton || !status || !embedHost) return;

	/* --- Collapse toggle state --- */
	const isBoard = window.location.pathname.startsWith('/board');
	let isCollapsed = false;
	try {
		const saved = sessionStorage.getItem('bnji-music-collapsed');
		isCollapsed = saved !== null ? saved === 'true' : isBoard;
	} catch {
		isCollapsed = isBoard;
	}

	const setCollapsed = (collapsed: boolean) => {
		isCollapsed = collapsed;
		root.dataset.collapsed = String(collapsed);
		if (toggleButton) {
			toggleButton.setAttribute('aria-expanded', String(!collapsed));
			toggleButton.setAttribute('aria-label', collapsed ? 'Expand music player' : 'Collapse music player');
			toggleButton.title = collapsed ? 'Expand music player' : 'Collapse music player';
		}
		try {
			sessionStorage.setItem('bnji-music-collapsed', String(collapsed));
		} catch {}
	};

	setCollapsed(isCollapsed);

	toggleButton?.addEventListener('click', (e) => {
		e.stopPropagation();
		setCollapsed(!isCollapsed);
	});

	root.addEventListener('click', () => {
		if (isCollapsed) {
			setCollapsed(false);
		}
	});

	const config = MUSIC_SOURCE;
	const setState = (state: MusicState, message?: string) => {
		root.dataset.state = state;
		status.textContent = message ?? defaultStatus(state);
		playButton.setAttribute('aria-label', state === 'playing' ? 'Pause music' : 'Play music');
		playButton.disabled = state === 'disabled' || state === 'loading';
	};

	/* Spotify exposes no volume/mute API — the pill says so instead of
	   pretending its buttons do something. */
	const supportsVolume = config.provider === 'file' || config.provider === 'youtube';
	if (!supportsVolume) {
		muteButton.disabled = true;
		muteButton.title = 'The Spotify embed controls its own audio — use the embed.';
		muteButton.setAttribute('aria-disabled', 'true');
	}

	/* --- transport state (per provider; see the header for the surfaces) ---- */
	let audio: HTMLAudioElement | null = null;
	let yt: YtPlayer | null = null;
	let ytReady: Promise<YtPlayer> | null = null;
	let spotifyFrame: HTMLIFrameElement | null = null;
	/** Set once the visitor clicks play: the YouTube blocked-probe stands down. */
	let userActed = false;

	const configured =
		(config.provider === 'file' && config.file.url !== '') ||
		(config.provider === 'youtube' && config.youtube.videoId !== '') ||
		(config.provider === 'spotify' && config.spotify.id !== '');

	if (config.provider === 'none' || !configured) {
		setState('disabled', 'No music source configured yet.');
		root.title = 'Add a source in src/config/music.config.ts to enable background music.';
		return;
	}

	/* --- settings-store binding (volume + mute) ------------------------------ */
	// Single applier: store → pill UI → transport. Called at init, on every
	// store change, and after a transport object comes into existence. The
	// pill has no volume slider of its own — the Settings overlay owns it.
	const applyAudio = () => {
		const settings = getSettings();
		muteButton.setAttribute('aria-pressed', String(settings.muted));
		if (config.provider === 'file' && audio) {
			audio.volume = settings.volume;
			audio.muted = settings.muted;
		} else if (config.provider === 'youtube' && yt) {
			yt.setVolume(Math.round(settings.volume * 100));
			if (settings.muted) yt.mute();
			else yt.unMute();
		}
		// spotify/none: no transport API — the preference stays in the store
		// and applies the moment a controllable provider is configured.
	};
	applyAudio();
	subscribeSettings(applyAudio);

	/* --- 'file' surface: HTMLAudioElement ----------------------------------- */

	const ensureAudio = (): HTMLAudioElement => {
		if (audio) return audio;
		audio = new Audio(config.file.url);
		audio.loop = true;
		// The load-time autoplay attempt needs the stream, so this is 'auto'
		// now — the old 'none' + first-gesture contract was deliberately
		// replaced by the autoplay-attempt task.
		audio.preload = 'auto';
		audio.addEventListener('playing', () => setState('playing', config.file.title || 'Playing'));
		audio.addEventListener('pause', () => setState('paused'));
		audio.addEventListener('waiting', () => setState('loading'));
		audio.addEventListener('error', () => setState('error', 'Could not load the audio source.'));
		applyAudio(); // stored volume + mute onto the fresh element
		return audio;
	};

	const attemptFile = async () => {
		setState('loading');
		try {
			await ensureAudio().play();
			setState('playing', config.file.title || 'Playing');
		} catch (error) {
			// Precise blocked detection: the DOM spec names the refusal.
			if (error instanceof DOMException && error.name === 'NotAllowedError') {
				setState('blocked');
			} else {
				setState('error', 'Playback failed.');
			}
		}
	};

	/* --- 'youtube' surface: IFrame API, hidden iframe ----------------------- */

	const attemptYouTube = async (gesture: boolean) => {
		setState('loading');
		try {
			ytReady = ytReady ?? loadYouTubePlayer(embedHost, config.youtube.videoId, (state) => {
				if (state === 'playing') setState('playing', 'YouTube source');
				else if (state === 'paused') setState('paused');
				else if (state === 'error') setState('error', 'YouTube source unavailable.');
				else if (state === 'loading') setState('loading');
			});
			yt = await ytReady;
			applyAudio(); // stored volume + mute onto the fresh player
			yt.playVideo();
			if (!gesture) {
				// The IFrame API fires no "autoplay refused" event. Probe once
				// after the attempt has had time to settle: anything other
				// than playing/buffering means the browser said no. Stands
				// down if the visitor clicked in the meantime.
				window.setTimeout(() => {
					if (userActed || !yt) return;
					const state = yt.getPlayerState?.() ?? 1;
					if (state !== 1 && state !== 3) setState('blocked');
				}, 1500);
			}
		} catch {
			setState('error', 'YouTube source unavailable.');
		}
	};

	/* --- 'spotify' surface: the embed IS the control ------------------------ */

	const attemptSpotify = () => {
		if (!spotifyFrame) {
			spotifyFrame = mountSpotify(embedHost, config.spotify.id, config.spotify.type);
		}
		// No events exist to wait for. 'playing' here means "the embed is
		// mounted and it is Spotify's turn": if the browser blocked the
		// embed's autoplay, Spotify's own play button inside the (visible)
		// embed is the affordance — we cannot detect that from outside and
		// do not pretend to.
		setState('playing', 'Spotify embed');
	};

	/* --- unified attempt / pause -------------------------------------------- */

	const attempt = (gesture: boolean): void => {
		if (config.provider === 'file') void attemptFile();
		else if (config.provider === 'youtube') void attemptYouTube(gesture);
		else if (config.provider === 'spotify') attemptSpotify();
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

	const handlePlayButton = () => {
		userActed = true;
		const state = root.dataset.state;
		if (state === 'playing' || state === 'loading') pause();
		else attempt(true);
	};
	playButton.addEventListener('click', handlePlayButton);

	/* --- first real input also gets one play attempt ------------------------ */
	// Browsers do not let a page force audible autoplay. Reuse the visitor's
	// first trusted input as a genuine activation instead, without cancelling
	// or replacing its normal click/scroll/touch/keyboard behaviour. Listen to
	// the input gestures that cause scrolling (wheel, touch, scrollbar/pointer,
	// keyboard) rather than `scroll` itself, which can fire during restoration.
	const firstInputEvents = ['pointerdown', 'touchstart', 'wheel', 'keydown', 'click'] as const;
	const removeFirstInputListeners = () => {
		for (const type of firstInputEvents) window.removeEventListener(type, onFirstInput, true);
	};
	const onFirstInput = (event: Event) => {
		if (!event.isTrusted) return;
		removeFirstInputListeners();

		// If the visitor's first input is the player button itself, its real
		// click handler below is already the one play action. A disabled button
		// cannot receive that click, so let a loading attempt use this gesture.
		if (event.composedPath().includes(playButton)) {
			if (playButton.disabled && root.dataset.state === 'loading') {
				userActed = true;
				attempt(true);
			}
			return;
		}

		// This is a play action, not a toggle: never pause music that already
		// started on its own. The original input continues untouched.
		userActed = true;
		if (root.dataset.state !== 'playing') attempt(true);
	};
	for (const type of firstInputEvents) {
		window.addEventListener(type, onFirstInput, { capture: true, passive: true });
	}

	// The pill's mute button writes to the store; the subscription
	// (applyAudio) echoes it onto the button and the transport. One loop, one
	// source of truth — the Settings overlay's mute row moves in lockstep.
	muteButton.addEventListener('click', () => {
		setSetting('muted', muteButton.getAttribute('aria-pressed') !== 'true');
	});

	/* --- autoplay attempt on load ------------------------------------------- */
	// Refusals are not worked around: they land in the 'blocked' affordance
	// (file/youtube) or inside Spotify's own embed UI.
	setState('idle');
	attempt(false);
}

function defaultStatus(state: MusicState): string {
	switch (state) {
		case 'loading':
			return 'Loading…';
		case 'playing':
			return 'Playing';
		case 'paused':
			return 'Paused';
		case 'blocked':
			return 'Tap to play';
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

/**
 * Mount the Spotify embed — visibly: with no transport API, the embed's own
 * UI is the only honest control surface (and its internal play button is the
 * autoplay-blocked affordance). The component's CSS positions it above the
 * pill; the host is empty again once pause() unmounts it.
 */
function mountSpotify(host: HTMLElement, id: string, type: 'track' | 'album' | 'playlist'): HTMLIFrameElement {
	const frame = document.createElement('iframe');
	frame.title = 'Spotify player';
	frame.allow = 'encrypted-media; autoplay; clipboard-write; fullscreen';
	frame.src = `https://open.spotify.com/embed/${type}/${id}?utm_source=generator&theme=0`;
	frame.style.width = '100%';
	frame.style.height = '80px';
	frame.style.border = '0';
	frame.style.borderRadius = 'var(--radius-md, 12px)';
	frame.style.display = 'block';
	host.appendChild(frame);
	return frame;
}
