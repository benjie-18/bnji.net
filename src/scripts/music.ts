/**
 * BNJI.NET — ordered background-music playlist runtime.
 *
 * Two providers, both with a real transport behind them:
 *   file     — the built-in <audio> element, from the config array.
 *   youtube  — the IFrame API, which reports progress and end events.
 * Both advance in playlist order and drive the progress display, so there is
 * no provider in the queue whose state this player has to guess at.
 *
 * YouTube is the only provider the admin panel can add. There is no upload, no
 * file picker and no tag parsing anywhere in this module: a `file` track is
 * authored in src/config/music.config.ts and nothing else.
 *
 * Volume and mute are shared with the Settings overlay through settings.ts.
 * The compact player itself owns play/pause, next and playlist controls; there
 * is deliberately no seek slider (the progress bar is read-only) and no volume
 * slider on the pill, so neither provider is asked to support a control it
 * does not have.
 */
import {
	getMusicTrackDateLabel,
	getMusicTrackMetadata,
	musicTrackAriaLabel,
	MUSIC_PROVIDER_URLS,
	MUSIC_SOURCE,
	type MusicTrack,
} from '../config/music.config';
import { getSettings, subscribeSettings } from './settings';

export type MusicState =
	| 'idle'
	| 'loading'
	| 'playing'
	| 'paused'
	| 'blocked'
	| 'error'
	| 'disabled';

type PlayerRoot = HTMLElement & { dataset: DOMStringMap & { state?: MusicState } };

type YtPlayer = {
	playVideo: () => void;
	pauseVideo: () => void;
	loadVideoById: (videoId: string) => void;
	setVolume: (volume: number) => void;
	mute: () => void;
	unMute: () => void;
	getPlayerState?: () => number;
	getCurrentTime?: () => number;
	getDuration?: () => number;
	getVideoData?: () => { video_id?: string; title?: string; author?: string };
	seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
	destroy: () => void;
};

type YtApi = {
	Player: new (element: HTMLElement, options: Record<string, unknown>) => YtPlayer;
};

type YtWindow = Window & {
	YT?: YtApi;
	onYouTubeIframeAPIReady?: () => void;
};

type SpotifyType = 'track' | 'album' | 'playlist';
type SpotifyTarget = { type: SpotifyType; id: string };

let started = false;
let activeCleanup: (() => void) | null = null;
let youtubeApiPromise: Promise<YtApi> | null = null;

/**
 * Accept a bare video ID or any of the YouTube URL shapes the importer and the
 * owner config can produce.
 *
 * This is the CLIENT parser, so it is deliberately more permissive about hosts
 * than the server one: it has to cope with whatever a pasted link already in
 * the config looks like, and it never causes a request — the server-side
 * allowlist in src/server/music-links.ts is what gates what gets stored.
 */
export function parseYouTubeVideoId(value: string): string | null {
	const input = value.trim();
	if (/^[\w-]{11}$/.test(input)) return input;

	try {
		const url = new URL(input);
		const host = url.hostname.toLowerCase();
		const youtubeRoot = MUSIC_PROVIDER_URLS.youtube.hosts[0];
		const shortHost = MUSIC_PROVIDER_URLS.youtube.hosts[1];
		let id = '';

		if (host === shortHost) {
			id = url.pathname.split('/').filter(Boolean)[0] ?? '';
		} else if (host === youtubeRoot || host.endsWith(`.${youtubeRoot}`)) {
			if (url.pathname === '/watch') {
				id = url.searchParams.get('v') ?? '';
			} else {
				const parts = url.pathname.split('/').filter(Boolean);
				if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? '';
			}
		}

		return /^[\w-]{11}$/.test(id) ? id : null;
	} catch {
		return null;
	}
}

/** Accept Spotify track, album or playlist links/URIs and return embed parts. */
export function parseSpotifyTarget(value: string): SpotifyTarget | null {
	const input = value.trim();
	const uriMatch = input.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)$/);
	if (uriMatch) return { type: uriMatch[1] as SpotifyType, id: uriMatch[2] };

	try {
		const url = new URL(input);
		if (url.hostname.toLowerCase() !== MUSIC_PROVIDER_URLS.spotify.host) return null;
		const parts = url.pathname.split('/').filter(Boolean);
		const typeIndex = parts.findIndex((part) => part === 'track' || part === 'album' || part === 'playlist');
		if (typeIndex < 0) return null;
		const type = parts[typeIndex] as SpotifyType;
		const id = parts[typeIndex + 1] ?? '';
		return /^[A-Za-z0-9]{10,64}$/.test(id) ? { type, id } : null;
	} catch {
		return null;
	}
}

/**
 * Is this value a playable track?
 *
 * A structural check rather than a cast: the value crossed a network boundary
 * and a malformed entry must not become a player that silently fails on a
 * track it cannot describe. `provider` is checked against the closed set
 * because every branch below switches on it.
 */
export function isMusicTrack(value: unknown): value is MusicTrack {
	if (!value || typeof value !== 'object') return false;
	const track = value as Partial<MusicTrack>;
	return (
		typeof track.id === 'string' &&
		typeof track.title === 'string' &&
		typeof track.url === 'string' &&
		(track.provider === 'file' || track.provider === 'youtube' || track.provider === 'spotify')
	);
}

/** Format a media time without showing NaN/Infinity in the UI. */
export function formatMusicTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
	const wholeSeconds = Math.floor(seconds);
	const minutes = Math.floor(wholeSeconds / 60);
	const remainder = String(wholeSeconds % 60).padStart(2, '0');
	if (minutes < 60) return `${minutes}:${remainder}`;
	const hours = Math.floor(minutes / 60);
	return `${hours}:${String(minutes % 60).padStart(2, '0')}:${remainder}`;
}

/** Idempotent boot entry, called from scripts/boot.ts. */
export function initMusicPlayer(): void {
	if (started) return;

	const root = document.querySelector<PlayerRoot>('[data-music-player]');
	if (!root) return;
	const playerRoot = root;

	const playButton = playerRoot.querySelector<HTMLButtonElement>('[data-music-play]');
	const nextButton = playerRoot.querySelector<HTMLButtonElement>('[data-music-next]');
	const playlistToggle = playerRoot.querySelector<HTMLButtonElement>('[data-music-playlist-toggle]');
	const playlistClose = playerRoot.querySelector<HTMLButtonElement>('[data-music-playlist-close]');
	const playlistPanel = playerRoot.querySelector<HTMLElement>('[data-music-playlist]');
	const statusTitle = playerRoot.querySelector<HTMLElement>('[data-music-status-title]');
	const statusMeta = playerRoot.querySelector<HTMLElement>('[data-music-status-meta]');
	const stateAnnouncement = playerRoot.querySelector<HTMLElement>('[data-music-state-announcement]');
	const youtubeHost = playerRoot.querySelector<HTMLElement>('[data-music-youtube-host]');
	const spotifyHost = playerRoot.querySelector<HTMLElement>('[data-music-spotify-host]');
	const currentTitle = playerRoot.querySelector<HTMLElement>('[data-music-current-title]');
	const currentArtist = playerRoot.querySelector<HTMLElement>('[data-music-current-artist]');
	const currentAlbum = playerRoot.querySelector<HTMLElement>('[data-music-current-album]');
	const currentDate = playerRoot.querySelector<HTMLElement>('[data-music-current-date]');
	const progressRegion = playerRoot.querySelector<HTMLElement>('[data-music-progress-region]');
	const progressBar = playerRoot.querySelector<HTMLElement>('[data-music-progress]');
	const progressFill = playerRoot.querySelector<HTMLElement>('[data-music-progress-fill]');
	const progressNote = playerRoot.querySelector<HTMLElement>('[data-music-progress-note]');
	const elapsedTime = playerRoot.querySelector<HTMLElement>('[data-music-elapsed]');
	const durationTime = playerRoot.querySelector<HTMLElement>('[data-music-duration]');
	// Reassigned by renderTrackList(): the prerendered <ol> is replaced when the
	// saved playlist arrives from /api/playlist, so this cannot stay const.
	let trackButtons = Array.from(playerRoot.querySelectorAll<HTMLButtonElement>('[data-music-track-index]'));
	const queueCount = playerRoot.querySelector<HTMLElement>('[data-music-queue-count]');
	const toggleButton = playerRoot.querySelector<HTMLButtonElement>('[data-music-toggle]');

	if (
		!playButton ||
		!nextButton ||
		!playlistToggle ||
		!playlistClose ||
		!playlistPanel ||
		!statusTitle ||
		!statusMeta ||
		!stateAnnouncement ||
		!youtubeHost ||
		!spotifyHost ||
		!currentTitle ||
		!currentArtist ||
		!currentAlbum ||
		!currentDate ||
		!progressRegion ||
		!progressBar ||
		!progressFill ||
		!progressNote ||
		!elapsedTime ||
		!durationTime
	) {
		return;
	}

	const playerYoutubeHost = youtubeHost;
	const playerSpotifyHost = spotifyHost;
	started = true;
	const controller = new AbortController();
	const { signal } = controller;
	// Starts as the static config (the seed and the no-D1 fallback) and is
	// replaced by the saved playlist before playback begins. A copy, never the
	// config array itself: reassigning `tracks` must not mutate shared module
	// state that another player instance or a test might read.
	let tracks: MusicTrack[] = [...MUSIC_SOURCE.tracks];
	const isBoard = window.location.pathname.startsWith('/board');
	// Autoplay lives on /gizlyy only. Everywhere else the player boots ready
	// but silent — the visitor presses play. The trailing slash is stripped so
	// /gizlyy and /gizlyy/ agree.
	const isAutoplayPage = (): boolean => window.location.pathname.replace(/\/$/, '') === '/gizlyy';
	let currentIndex = -1;
	let currentTrack: MusicTrack | null = null;
	// The Spotify embed is a real iframe the player owns, so it needs the same
	// explicit lifecycle as the YouTube player: mounted on demand, and removed
	// the moment the queue moves to a track that is not this one.
	let spotifyFrame: HTMLIFrameElement | null = null;
	let spotifyTargetKey: string | null = null;
	let playbackRequest = 0;
	let destroyed = false;
	let isCollapsed = false;
	let isPlaylistOpen = false;
	let audio: HTMLAudioElement | null = null;
	let audioTrackIndex = -1;
	let audioRequest = 0;
	let youtubePlayer: YtPlayer | null = null;
	let youtubeReady: Promise<YtPlayer> | null = null;
	let youtubeVideoId: string | null = null;
	let youtubeRequest = 0;
	/** The one-shot autoplay probe. Cleared on every teardown, never left to fire. */
	let youtubeProbe: number | null = null;
	let progressFrame: number | null = null;
	let lastProgressPaint = 0;
	let playlistIntersecting = !('IntersectionObserver' in window);
	let syncProgressLoop = () => {};

	const trackIndexFromButton = (button: HTMLButtonElement): number =>
		Number.parseInt(button.dataset.musicTrackIndex ?? '-1', 10);
	// Skip is always available while a track is selected: at the end of the
	// queue it wraps to the beginning (and a single-track queue restarts),
	// so the button is never disabled for having nowhere to go.
	const canSkip = (): boolean => currentIndex >= 0 && tracks.length > 0;
	const isCurrentRequest = (request: number, index: number): boolean =>
		!destroyed && request === playbackRequest && index === currentIndex;

	const updateTrackButtons = () => {
		for (const button of trackButtons) {
			const isCurrent = trackIndexFromButton(button) === currentIndex;
			button.setAttribute('aria-pressed', String(isCurrent));
			if (isCurrent) button.setAttribute('aria-current', 'true');
			else button.removeAttribute('aria-current');
		}
		nextButton.disabled = !canSkip();
	};

	const setCurrentTrackDetails = (track: MusicTrack | null) => {
		const title = track?.title.trim() || (tracks.length ? 'Music off' : 'No songs configured');
		const { artist, album } = getMusicTrackMetadata(track);
		// One definition of the date line, shared with the prerendered markup:
		// a YouTube upload date says "Published", and that is the only date
		// this playlist carries.
		const dateLabel = getMusicTrackDateLabel(track);
		const metadata = [artist, album, dateLabel].filter(Boolean);

		currentTitle.textContent = title;
		currentArtist.textContent = artist;
		currentArtist.hidden = !artist;
		currentAlbum.textContent = album;
		currentAlbum.hidden = !album;
		currentDate.textContent = dateLabel;
		currentDate.hidden = !dateLabel;
		statusTitle.textContent = title;
		statusMeta.textContent = metadata.join(' · ');
		statusMeta.hidden = metadata.length === 0;
	};

	const updateProgress = (currentSeconds: number, durationSeconds: number) => {
		const current = Number.isFinite(currentSeconds) && currentSeconds > 0 ? currentSeconds : 0;
		const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
		const ratio = duration > 0 ? Math.min(1, current / duration) : 0;
		const percent = Math.round(ratio * 100);
		const elapsedText = formatMusicTime(current);
		const durationText = duration > 0 ? formatMusicTime(duration) : '—:—';

		progressFill.style.transform = `scaleX(${ratio})`;
		// The circular ring around the toggle button reads the same ratio: one
		// progress value, two presentations (linear bar in the playlist,
		// circle on the pill). Spotify never reaches here — its progress mode
		// hides the region and selectTrack resets to 0 — so the ring simply
		// stays empty for it.
		playerRoot.style.setProperty('--music-progress', ratio.toFixed(3));
		progressBar.setAttribute('aria-valuenow', String(percent));
		progressBar.setAttribute(
			'aria-valuetext',
			duration > 0 ? `${elapsedText} of ${durationText}` : `${elapsedText}; duration unavailable`,
		);
		elapsedTime.textContent = elapsedText;
		durationTime.textContent = durationText;
	};

	const updateActiveProgress = () => {
		if (currentTrack?.provider === 'file' && audio && audioTrackIndex === currentIndex) {
			updateProgress(audio.currentTime, audio.duration);
		} else if (currentTrack?.provider === 'youtube' && youtubePlayer) {
			try {
				updateProgress(youtubePlayer.getCurrentTime?.() ?? 0, youtubePlayer.getDuration?.() ?? 0);
			} catch {
				updateProgress(0, 0);
			}
		}
	};

	const setProgressMode = (track: MusicTrack | null) => {
		if (!track) {
			progressRegion.hidden = true;
			progressNote.textContent = 'There is no song to show progress for yet.';
			progressNote.hidden = false;
			return;
		}

		// Spotify's iFrame API is documented for podcast controls and does not
		// provide a supported progress or end contract for music tracks, so the
		// region is hidden rather than driven by a guess. Skip still works,
		// because advancing is this player's own decision and not an event.
		if (track.provider === 'spotify') {
			progressRegion.hidden = true;
			progressNote.textContent =
				"Spotify does not document a supported music-track progress or end event for this embed. Use its own controls; Skip still works.";
			progressNote.hidden = false;
			return;
		}

		progressRegion.hidden = false;
		// Cleared as well as hidden. Leaving the previous provider's copy in a
		// hidden node is invisible today, but it is a live trap: any later
		// branch that reveals the note without writing its own text would
		// announce Spotify's explanation over a file track. The `!track` and
		// Spotify branches above both set their own text; this one owns none,
		// so it owns emptying.
		progressNote.textContent = '';
		progressNote.hidden = true;
	};

	const shouldPollYouTubeProgress = () =>
		isPlaylistOpen &&
		playlistIntersecting &&
		document.visibilityState === 'visible' &&
		currentTrack?.provider === 'youtube' &&
		playerRoot.dataset.state === 'playing';

	const stopProgressLoop = () => {
		if (progressFrame !== null) {
			cancelAnimationFrame(progressFrame);
			progressFrame = null;
		}
	};

	const progressTick = (now: number) => {
		progressFrame = null;
		if (!shouldPollYouTubeProgress()) return;
		if (now - lastProgressPaint >= 250) {
			updateActiveProgress();
			lastProgressPaint = now;
		}
		progressFrame = requestAnimationFrame(progressTick);
	};

	syncProgressLoop = () => {
		if (shouldPollYouTubeProgress()) {
			if (progressFrame === null) progressFrame = requestAnimationFrame(progressTick);
		} else {
			stopProgressLoop();
		}
	};

	const setState = (state: MusicState, message?: string) => {
		playerRoot.dataset.state = state;
		const stateLabel = message ?? defaultStatus(state);
		// A custom message is a LABEL, not a sentence: it is composed with
		// ": <title>" below, so a trailing full stop would be read out as
		// "unavailable dot" before the title. Keep them stop-less.
		stateAnnouncement.textContent = currentTrack ? `${stateLabel}: ${currentTrack.title}` : stateLabel;
		playButton.setAttribute('aria-label', state === 'playing' || state === 'loading' ? 'Pause music' : 'Play music');
		playButton.disabled = tracks.length === 0;
		nextButton.disabled = !canSkip();
		syncProgressLoop();
	};

	const setPlaylistOpen = (open: boolean, restoreFocus = false) => {
		if (open && isCollapsed) setCollapsed(false);
		isPlaylistOpen = open;
		playlistPanel.hidden = !open;
		playerRoot.dataset.playlistOpen = String(open);
		playlistToggle.setAttribute('aria-expanded', String(open));
		playlistToggle.setAttribute('aria-label', open ? 'Close music playlist' : 'Open music playlist');
		playlistToggle.title = open ? 'Close music playlist' : 'Open music playlist';
		if (open) {
			updateActiveProgress();
			playlistClose.focus({ preventScroll: true });
		} else if (restoreFocus) {
			playlistToggle.focus({ preventScroll: true });
		}
		syncProgressLoop();
	};

	const setCollapsed = (collapsed: boolean) => {
		isCollapsed = collapsed;
		playerRoot.dataset.collapsed = String(collapsed);
		if (collapsed && isPlaylistOpen) setPlaylistOpen(false);
		if (toggleButton) {
			toggleButton.setAttribute('aria-expanded', String(!collapsed));
			toggleButton.setAttribute('aria-label', collapsed ? 'Expand music player' : 'Collapse music player');
			toggleButton.title = collapsed ? 'Expand music player' : 'Collapse music player';
		}
		try {
			sessionStorage.setItem('bnji-music-collapsed', String(collapsed));
		} catch {
			/* Storage can be disabled; the current page still works. */
		}
	};

	const isBoardDefault = isBoard;
	try {
		const saved = sessionStorage.getItem('bnji-music-collapsed');
		isCollapsed = saved !== null ? saved === 'true' : isBoardDefault;
	} catch {
		isCollapsed = isBoardDefault;
	}
	setCollapsed(isCollapsed);

	const applyAudioSettings = () => {
		const settings = getSettings();
		if (audio) {
			audio.volume = settings.volume;
			audio.muted = settings.muted;
		}
		if (youtubePlayer) {
			try {
				youtubePlayer.setVolume(Math.round(settings.volume * 100));
				if (settings.muted) youtubePlayer.mute();
				else youtubePlayer.unMute();
			} catch {
				/* The iframe may be between states; a later settings change reapplies it. */
			}
		}
	};
	const unsubscribeSettings = subscribeSettings(applyAudioSettings);

	const releaseAudio = () => {
		const previous = audio;
		audio = null;
		audioTrackIndex = -1;
		audioRequest = 0;
		if (!previous) return;
		previous.pause();
		previous.removeAttribute('src');
		previous.load();
	};

	const clearSpotifyFrame = () => {
		spotifyFrame?.remove();
		spotifyFrame = null;
		spotifyTargetKey = null;
		playerSpotifyHost.setAttribute('aria-hidden', 'true');
	};

	const mountSpotifyFrame = (target: SpotifyTarget, track: MusicTrack): HTMLIFrameElement => {
		clearSpotifyFrame();
		const frame = document.createElement('iframe');
		frame.title = `Spotify player: ${track.title}`;
		frame.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
		frame.src = `${MUSIC_PROVIDER_URLS.spotify.embedBase}/${target.type}/${encodeURIComponent(target.id)}?utm_source=generator&theme=0`;
		playerSpotifyHost.appendChild(frame);
		playerSpotifyHost.setAttribute('aria-hidden', 'false');
		spotifyFrame = frame;
		spotifyTargetKey = `${target.type}:${target.id}`;
		return frame;
	};

	const getAudioForTrack = (track: MusicTrack, index: number, request: number): HTMLAudioElement => {
		if (audio && audioTrackIndex === index) {
			audioRequest = request;
			return audio;
		}
		releaseAudio();

		const element = new Audio(track.url);
		element.loop = false;
		element.preload = 'auto';
		audio = element;
		audioTrackIndex = index;
		audioRequest = request;

		const isActiveElement = () =>
			audio === element && audioTrackIndex === index && audioRequest === playbackRequest && currentIndex === index;
		element.addEventListener('playing', () => {
			if (isActiveElement()) setState('playing', 'Playing');
		});
		element.addEventListener('pause', () => {
			if (isActiveElement() && !element.ended && playerRoot.dataset.state !== 'loading') setState('paused');
		});
		element.addEventListener('waiting', () => {
			if (isActiveElement()) setState('loading');
		});
		element.addEventListener('loadedmetadata', () => {
			if (isActiveElement()) updateProgress(element.currentTime, element.duration);
		});
		element.addEventListener('durationchange', () => {
			if (isActiveElement()) updateProgress(element.currentTime, element.duration);
		});
		element.addEventListener('timeupdate', () => {
			if (isActiveElement()) updateProgress(element.currentTime, element.duration);
		});
		element.addEventListener('ended', () => {
			if (isActiveElement()) void advanceAfterEnd(index);
		});
		element.addEventListener('error', () => {
			if (isActiveElement()) setState('error', 'Could not load this audio file');
		});

		applyAudioSettings();
		return element;
	};

	const advanceAfterEnd = async (endedIndex: number) => {
		if (endedIndex !== currentIndex || !currentTrack) return;
		const nextIndex = endedIndex + 1;
		if (nextIndex < tracks.length) {
			await selectTrack(nextIndex);
		} else {
			setState('paused', 'Playlist finished');
		}
	};

	function onYouTubeStateChange(stateCode: number) {
		if (currentTrack?.provider !== 'youtube' || currentIndex < 0 || youtubeRequest !== playbackRequest) return;
		const expectedId = parseYouTubeVideoId(currentTrack.url);
		if (!expectedId) return;
		const activeId = youtubePlayer?.getVideoData?.()?.video_id;
		if (activeId && activeId !== expectedId) return;
		const actualState = youtubePlayer?.getPlayerState?.();
		if (actualState !== undefined && actualState !== stateCode) return;

		if (stateCode === 1) {
			setState('playing', 'Playing');
			updateActiveProgress();
		} else if (stateCode === 2) {
			setState('paused');
		} else if (stateCode === 3) {
			setState('loading');
		} else if (stateCode === 0) {
			void advanceAfterEnd(currentIndex);
		}
		// State 5 means cued. The short blocked-play probe below handles it.
	}

	async function ensureYouTubePlayer(
		initialVideoId: string,
		index: number,
		request: number,
	): Promise<YtPlayer | null> {
		const api = await loadYouTubeApi();
		if (!isCurrentRequest(request, index)) return null;

		if (!youtubeReady) {
			const element = document.createElement('div');
			playerYoutubeHost.replaceChildren(element);
			youtubeReady = new Promise<YtPlayer>((resolve, reject) => {
				let ready = false;
				let timedOut = false;
				let playerInstance: YtPlayer | null = null;
				const frameSize = Math.max(1, Math.round(playerYoutubeHost.getBoundingClientRect().width));
				const readyTimer = window.setTimeout(() => {
					timedOut = true;
					try {
						playerInstance?.destroy();
					} catch {
						/* Best effort: a half-built or already-gone player can refuse, and nothing here depends on it. */
					}
					reject(new Error('YouTube player timed out'));
				}, 15000);
				try {
					const player = new api.Player(element, {
						width: frameSize,
						height: frameSize,
						videoId: initialVideoId,
						playerVars: { autoplay: 0, controls: 0, playsinline: 1, rel: 0 },
						events: {
							onReady: (event: { target: YtPlayer }) => {
								window.clearTimeout(readyTimer);
								if (timedOut || destroyed) {
									try {
										event.target.destroy();
									} catch {
										/* Best effort: a half-built or already-gone player can refuse, and nothing here depends on it. */
									}
									reject(new Error('YouTube player is no longer active'));
									return;
								}
								ready = true;
								youtubePlayer = event.target;
								youtubeVideoId = initialVideoId;
								applyAudioSettings();
								resolve(event.target);
							},
							onStateChange: (event: { data: number }) => onYouTubeStateChange(event.data),
							onError: () => {
								if (!ready) {
									window.clearTimeout(readyTimer);
									try {
										playerInstance?.destroy();
									} catch {
										/* Best effort: a half-built or already-gone player can refuse, and nothing here depends on it. */
									}
									reject(new Error('YouTube playback unavailable'));
								} else if (currentTrack?.provider === 'youtube') {
									setState('error', 'YouTube video unavailable');
								}
							},
						},
					});
					playerInstance = player;
				} catch (error) {
					window.clearTimeout(readyTimer);
					reject(error instanceof Error ? error : new Error('YouTube player initialization failed'));
				}
			}).catch((error) => {
				youtubeReady = null;
				throw error;
			});
		}

		const player = await youtubeReady;
		if (!isCurrentRequest(request, index)) return null;
		youtubePlayer = player;
		return player;
	}

	/**
	 * Drop the current YouTube player so the next track builds a fresh one.
	 *
	 * `loadVideoById` is the right call for a queue of YouTube videos, and
	 * ensureYouTubePlayer uses it. What it cannot do is undo the *previous*
	 * video's listeners, timers and buffered state — and an instance that has
	 * already fired `onError` for an unavailable or unembeddable video stays in
	 * that state forever. Destroying is also the only honest cleanup for the
	 * `destroy()` path below, where an orphaned iframe would keep playing audio
	 * after the shell is gone.
	 */
	const releaseYouTubePlayer = () => {
		if (youtubeProbe !== null) {
			window.clearTimeout(youtubeProbe);
			youtubeProbe = null;
		}
		const previous = youtubePlayer;
		youtubePlayer = null;
		youtubeReady = null;
		youtubeVideoId = null;
		youtubeRequest = 0;
		if (!previous) return;
		try {
			previous.destroy();
		} catch {
			/* Best effort: a half-built or already-gone player can refuse, and nothing here depends on it. */
		}
	};

	async function playFileTrack(track: MusicTrack, index: number, request: number) {
		if (!track.url.trim()) {
			setState('error', 'No audio URL configured');
			return;
		}

		const element = getAudioForTrack(track, index, request);
		if (element.ended || (Number.isFinite(element.duration) && element.currentTime >= element.duration)) {
			element.currentTime = 0;
		}
		applyAudioSettings();

		try {
			await element.play();
			if (isCurrentRequest(request, index)) setState('playing', 'Playing');
		} catch (error) {
			if (!isCurrentRequest(request, index)) return;
			const name = (error as { name?: string } | null)?.name;
			if (name === 'NotAllowedError') setState('blocked');
			else setState('error', 'Playback failed');
		}
	}

	async function playYouTubeTrack(track: MusicTrack, index: number, request: number, restart = false) {
		const videoId = parseYouTubeVideoId(track.url);
		if (!videoId) {
			setState('error', 'That is not a valid YouTube video link');
			return;
		}

		try {
			const player = await ensureYouTubePlayer(videoId, index, request);
			if (!player || !isCurrentRequest(request, index)) return;
			applyAudioSettings();

			if (youtubeVideoId !== videoId) {
				youtubeVideoId = videoId;
				player.loadVideoById(videoId);
			} else {
				// A restart rewinds even mid-play; otherwise only a finished video
				// is rewound before playing again.
				if (restart || player.getPlayerState?.() === 0) player.seekTo?.(0, true);
				player.playVideo();
			}

			// The IFrame API has no autoplay-refused event. Probe once, without
			// claiming playback until the player reports playing/buffering.
			// The timer is tracked so a track change (or destroy()) cancels it
			// instead of letting it fire against a player that is gone.
			if (youtubeProbe !== null) window.clearTimeout(youtubeProbe);
			youtubeProbe = window.setTimeout(() => {
				youtubeProbe = null;
				if (!isCurrentRequest(request, index) || playerRoot.dataset.state === 'playing') return;
				const state = player.getPlayerState?.() ?? -1;
				if (state !== 1 && state !== 3) setState('blocked');
			}, 1600);
		} catch {
			if (isCurrentRequest(request, index)) setState('error', 'Could not load the YouTube player');
		}
	}

	function playSpotifyTrack(track: MusicTrack, index: number, request: number, restart = false) {
		if (!isCurrentRequest(request, index)) return;
		const target = parseSpotifyTarget(track.url);
		if (!target) {
			// Stop-less, like every other custom message: setState() composes
			// this with ": <title>", so a trailing full stop is read out as
			// "link dot" before the title. See the note in setState().
			setState('error', 'That is not a valid Spotify link');
			return;
		}

		const targetKey = `${target.type}:${target.id}`;
		// A restart remounts even the same target: reloading the frame is the
		// only way to take the embed back to the beginning.
		if (restart || !spotifyFrame || spotifyTargetKey !== targetKey) mountSpotifyFrame(target, track);
		setState('playing', 'Spotify embed');
	}

	async function selectTrack(index: number, restart = false): Promise<void> {
		if (index < 0 || index >= tracks.length) return;
		if (!restart && index === currentIndex && playerRoot.dataset.state === 'playing') return;

		const track = tracks[index];
		const request = ++playbackRequest;
		// A restart never reuses the audio element: a fresh element starts at
		// 0, which is exactly what "restart from the beginning" means.
		const canReuseAudio = !restart && track.provider === 'file' && audio !== null && audioTrackIndex === index;
		currentIndex = index;
		currentTrack = track;
		youtubeRequest = track.provider === 'youtube' ? request : 0;
		playerRoot.dataset.provider = track.provider;
		setCurrentTrackDetails(track);
		setProgressMode(track);
		updateProgress(0, 0);
		updateTrackButtons();

		// Leaving YouTube means leaving it for good: pausing the iframe would
		// keep its listeners, its buffered audio and any error state alive for
		// a track that is no longer in view. Destroy it, so a `file` track is
		// the only thing making sound and the next YouTube track starts clean.
		if (track.provider !== 'youtube') releaseYouTubePlayer();
		if (track.provider !== 'spotify') clearSpotifyFrame();
		if (!canReuseAudio) releaseAudio();

		setState('loading');
		if (track.provider === 'youtube') await playYouTubeTrack(track, index, request, restart);
		else if (track.provider === 'spotify') playSpotifyTrack(track, index, request, restart);
		else await playFileTrack(track, index, request);
	}

	const attemptCurrentTrack = () => {
		if (currentIndex >= 0) void selectTrack(currentIndex);
	};

	const pauseCurrentTrack = () => {
		if (!currentTrack) return;
		playbackRequest += 1; // make any unresolved play() / API attempt stale
		if (currentTrack.provider === 'youtube') {
			try {
				youtubePlayer?.pauseVideo();
			} catch {
				/* Best effort: a half-built or already-gone player can refuse, and nothing here depends on it. */
			}
		} else if (currentTrack.provider === 'spotify') {
			// A pause button has to pause. There is no documented API to pause
			// the music embed — the iFrame API is specified for podcast controls,
			// and reaching for an undocumented postMessage verb is exactly the
			// invented state the rest of this module refuses to have. Removing
			// the frame is the only lever that reliably stops the audio.
			//
			// The cost is stated rather than hidden: unmounting loses the
			// embed's position, so resuming restarts the track from the
			// beginning instead of continuing. That is a worse pause than a
			// real transport offers, and it is still better than a button that
			// reports "paused" while the music keeps playing. The visitor who
			// wants a true pause can use the embed's own controls, which is
			// what the note in setProgressMode points at.
			clearSpotifyFrame();
		} else {
			audio?.pause();
		}
		setState('paused');
	};

	playButton.addEventListener(
		'click',
		() => {
			if (playerRoot.dataset.state === 'playing' || playerRoot.dataset.state === 'loading') pauseCurrentTrack();
			else attemptCurrentTrack();
		},
		{ signal },
	);

	nextButton.addEventListener(
		'click',
		() => {
			if (!canSkip()) return;
			// Skip always starts the next song immediately — selectTrack plays,
			// it never just selects. At the end of the queue it wraps to the
			// beginning; a single-track queue restarts its one track.
			const nextIndex = (currentIndex + 1) % tracks.length;
			if (nextIndex === currentIndex) void selectTrack(currentIndex, true);
			else void selectTrack(nextIndex);
		},
		{ signal },
	);

	playlistToggle.addEventListener(
		'click',
		(event) => {
			event.stopPropagation();
			setPlaylistOpen(!isPlaylistOpen, !isPlaylistOpen);
		},
		{ signal },
	);

	playlistClose.addEventListener(
		'click',
		() => setPlaylistOpen(false, true),
		{ signal },
	);

	playlistPanel.addEventListener(
		'keydown',
		(event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				setPlaylistOpen(false, true);
			}
		},
		{ signal },
	);

	for (const button of trackButtons) {
		button.addEventListener(
			'click',
			() => void selectTrack(trackIndexFromButton(button)),
			{ signal },
		);
	}

	toggleButton?.addEventListener(
		'click',
		(event) => {
			event.stopPropagation();
			setCollapsed(!isCollapsed);
		},
		{ signal },
	);

	playerRoot.addEventListener(
		'click',
		() => {
			if (isCollapsed) setCollapsed(false);
		},
		{ signal },
	);

	const onOutsidePointer = (event: PointerEvent) => {
		if (isPlaylistOpen && !event.composedPath().includes(root)) setPlaylistOpen(false);
	};
	document.addEventListener('pointerdown', onOutsidePointer, { capture: true, signal });

	const onVisibilityChange = () => syncProgressLoop();
	document.addEventListener('visibilitychange', onVisibilityChange, { signal });

	let intersectionObserver: IntersectionObserver | null = null;
	if ('IntersectionObserver' in window) {
		intersectionObserver = new IntersectionObserver((entries) => {
			playlistIntersecting = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
			syncProgressLoop();
		});
		intersectionObserver.observe(playlistPanel);
	}

	const firstInputEvents = ['pointerdown', 'touchstart', 'wheel', 'keydown', 'click'] as const;
	const removeFirstInputListeners = () => {
		for (const type of firstInputEvents) window.removeEventListener(type, onFirstInput, true);
	};
	const onFirstInput = (event: Event) => {
		if (!event.isTrusted) return;
		removeFirstInputListeners();
		// The player's own buttons perform their own gesture-aware action.
		if (event.composedPath().includes(root)) return;
		// The first-input retry is autoplay by another name, so it follows the
		// same rule: /gizlyy only. Elsewhere the first input belongs to the
		// page, and playback waits for an explicit press of play.
		if (!isAutoplayPage()) return;
		if (playerRoot.dataset.state !== 'playing' && playerRoot.dataset.state !== 'loading') attemptCurrentTrack();
	};
	for (const type of firstInputEvents) {
		window.addEventListener(type, onFirstInput, { capture: true, passive: true, signal });
	}

	const cleanup = () => {
		destroyed = true;
		playbackRequest += 1;
		controller.abort();
		removeFirstInputListeners();
		unsubscribeSettings();
		intersectionObserver?.disconnect();
		stopProgressLoop();
		releaseAudio();
		releaseYouTubePlayer();
		playerYoutubeHost.replaceChildren();
		playlistPanel.hidden = true;
		playerRoot.dataset.playlistOpen = 'false';
		started = false;
		activeCleanup = null;
	};
	activeCleanup = cleanup;

	/* --- the saved playlist -------------------------------------------------- */

	/**
	 * Rebuild the queue list from `tracks`.
	 *
	 * The prerendered markup is built from the static config at deploy time;
	 * this is the same markup built at runtime from the playlist the server
	 * actually holds. Both use `musicTrackAriaLabel()` and
	 * `getMusicTrackDateLabel()` from the config, so a track's accessible name
	 * and its date line cannot differ between the two paths.
	 *
	 * Everything is created with createElement/textContent: a title is a
	 * provider-returned string, and a string that is never markup cannot be
	 * markup that executes.
	 */
	const renderTrackList = (): void => {
		playlistPanel.querySelector<HTMLElement>('[data-music-track-list]')?.remove();
		playlistPanel.querySelector<HTMLElement>('.music-player__empty')?.remove();
		if (queueCount) queueCount.textContent = String(tracks.length);

		if (tracks.length === 0) {
			// An empty saved playlist is a real state, not an error: the
			// operator removed every item. Say that, rather than pointing at
			// a config file that no longer drives the queue.
			const empty = document.createElement('p');
			empty.className = 'music-player__empty';
			empty.textContent = 'The playlist is empty. Add songs from the admin playlist panel.';
			playlistPanel.appendChild(empty);
			trackButtons = [];
			return;
		}

		const list = document.createElement('ol');
		list.className = 'music-player__track-list';
		list.dataset.musicTrackList = '';
		tracks.forEach((track, index) => {
			const item = document.createElement('li');

			const button = document.createElement('button');
			button.className = 'music-player__track';
			button.type = 'button';
			button.dataset.musicTrackIndex = String(index);
			button.dataset.provider = track.provider;
			button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
			button.setAttribute('aria-label', musicTrackAriaLabel(track));

			const number = document.createElement('span');
			number.className = 'music-player__track-number mono';
			number.setAttribute('aria-hidden', 'true');
			number.textContent = String(index + 1).padStart(2, '0');

			const copy = document.createElement('span');
			copy.className = 'music-player__track-copy';

			const title = document.createElement('span');
			title.className = 'music-player__track-title';
			title.textContent = track.title;
			copy.appendChild(title);

			const { artist, album } = getMusicTrackMetadata(track);
			if (artist) {
				const artistLine = document.createElement('span');
				artistLine.className = 'music-player__track-meta';
				artistLine.textContent = artist;
				copy.appendChild(artistLine);
			}
			if (album) {
				const albumLine = document.createElement('span');
				albumLine.className = 'music-player__track-meta music-player__track-meta--album';
				albumLine.textContent = album;
				copy.appendChild(albumLine);
			}
			const dateLabel = getMusicTrackDateLabel(track);
			if (dateLabel) {
				const dateLine = document.createElement('span');
				dateLine.className = 'music-player__track-meta music-player__track-meta--date';
				dateLine.textContent = dateLabel;
				copy.appendChild(dateLine);
			}

			const provider = document.createElement('span');
			provider.className = 'music-player__provider mono';
			provider.textContent = track.provider;

			// appendChild, not append(): the Workers-types DOM lib declares
			// append() with an unrelated overload set, so a Node argument does
			// not resolve. Every other builder in this file uses appendChild.
			button.appendChild(number);
			button.appendChild(copy);
			button.appendChild(provider);
			item.appendChild(button);
			list.appendChild(item);
		});
		playlistPanel.appendChild(list);

		trackButtons = Array.from(list.querySelectorAll<HTMLButtonElement>('[data-music-track-index]'));
		for (const button of trackButtons) {
			button.addEventListener('click', () => void selectTrack(trackIndexFromButton(button)), { signal });
		}
	};

	/**
	 * Swap in the playlist the server returned.
	 *
	 * Whatever the static list had selected is dropped first: the saved queue
	 * may not contain that track, and an index that outlived its playlist is
	 * how a player ends up playing the wrong song. `releaseAudio()` and the
	 * frame teardown also stop anything already in flight, because the
	 * previous selection's media is no longer in the queue.
	 */
	const applyPlaylist = (next: MusicTrack[]): void => {
		tracks = next;
		currentIndex = -1;
		currentTrack = null;
		playbackRequest += 1;
		releaseAudio();
		releaseYouTubePlayer();

		renderTrackList();
		playerRoot.dataset.trackCount = String(tracks.length);
		playerRoot.dataset.provider = tracks[0]?.provider ?? 'none';
		updateTrackButtons();
	};

	/**
	 * The saved playlist, or null when the static config stands.
	 *
	 * null covers three honest cases, all of which mean "play what the page
	 * shipped with": the store is not initialised yet (nothing to swap in),
	 * D1 is unconfigured or the query failed, or the response is not the shape
	 * this player understands. It deliberately does NOT cover an empty array —
	 * that is a real answer and is passed straight through.
	 */
	const loadSavedPlaylist = async (): Promise<MusicTrack[] | null> => {
		// A hung request must not hold the player hostage: four seconds is
		// longer than a healthy D1 read and shorter than an operator's patience.
		const timeout = new AbortController();
		const timer = window.setTimeout(() => timeout.abort(), 4000);
		try {
			const response = await fetch('/api/playlist', {
				headers: { accept: 'application/json' },
				credentials: 'same-origin',
				signal: timeout.signal,
			});
			if (!response.ok) return null;
			const data: unknown = await response.json();
			if (!data || typeof data !== 'object') return null;
			const payload = data as { initialized?: unknown; tracks?: unknown };
			if (payload.initialized !== true || !Array.isArray(payload.tracks)) return null;
			return payload.tracks.filter(isMusicTrack);
		} catch {
			return null;
		} finally {
			window.clearTimeout(timer);
		}
	};

	const start = (): void => {
		if (tracks.length === 0) {
			setCurrentTrackDetails(null);
			setProgressMode(null);
			setState('disabled', 'No music configured');
			return;
		}

		currentIndex = 0;
		currentTrack = tracks[0] ?? null;
		updateTrackButtons();
		setCurrentTrackDetails(currentTrack);
		setProgressMode(currentTrack);
		updateProgress(0, 0);
		applyAudioSettings();
		if (isAutoplayPage()) {
			attemptCurrentTrack();
			return;
		}
		// Everywhere else the queue is selected but silent: the first track is
		// current, the ring and bar sit at zero, and playback waits for play.
		setState('idle');
	};

	// Resolve the saved playlist before starting playback. The prerendered
	// markup is the seed and the fallback; this is the swap. A failure here is
	// not fatal by design — `loadSavedPlaylist()` returns null and `start()`
	// runs against the static queue, so a database hiccup costs the operator a
	// playlist edit, not the visitor their music.
	void (async () => {
		const saved = await loadSavedPlaylist();
		if (destroyed) return;
		if (saved) applyPlaylist(saved);
		start();
	})();
}

/** Stop media, polling and listeners if the shell is ever torn down. */
export function destroyMusicPlayer(): void {
	activeCleanup?.();
	activeCleanup = null;
	started = false;
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

function loadYouTubeApi(): Promise<YtApi> {
	const win = window as unknown as YtWindow;
	if (win.YT?.Player) return Promise.resolve(win.YT);
	if (youtubeApiPromise) return youtubeApiPromise;

	const promise = new Promise<YtApi>((resolve, reject) => {
		let settled = false;
		let timeout = 0;
		const previousCallback = win.onYouTubeIframeAPIReady;
		let readyCallback: (() => void) | null = null;

		const restoreCallback = () => {
			if (readyCallback && win.onYouTubeIframeAPIReady === readyCallback) {
				win.onYouTubeIframeAPIReady = previousCallback;
			}
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			restoreCallback();
			reject(error);
		};
		const ready = () => {
			if (settled) return;
			try {
				previousCallback?.();
			} catch {
				/* A third-party callback must not prevent our API initialization. */
			}
			if (!win.YT?.Player) {
				fail(new Error('YouTube IFrame API did not initialize'));
				return;
			}
			settled = true;
			window.clearTimeout(timeout);
			restoreCallback();
			resolve(win.YT);
		};
		readyCallback = ready;
		win.onYouTubeIframeAPIReady = ready;

		let script = document.querySelector<HTMLScriptElement>('script[data-music-youtube-api]');
		if (!script) {
			script = document.createElement('script');
			script.dataset.musicYoutubeApi = 'true';
			script.src = MUSIC_PROVIDER_URLS.youtube.iframeApi;
			script.async = true;
		}
		script.addEventListener('error', () => fail(new Error('YouTube IFrame API could not be loaded')), { once: true });
		timeout = window.setTimeout(() => fail(new Error('YouTube IFrame API timed out')), 15000);
		if (!script.isConnected) document.head.appendChild(script);
	});

	youtubeApiPromise = promise.catch((error: unknown) => {
		youtubeApiPromise = null;
		throw error;
	});
	return youtubeApiPromise;
}
