/**
 * Background music — SOURCE CONFIGURATION (public).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  ENTER YOUR MUSIC SOURCE HERE. This is the only place to change.     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Pick exactly one provider and fill its fields. The player component
 * (src/components/MusicPlayer.astro + src/scripts/music.ts) adapts its
 * behaviour to the provider; nothing else in the project needs to change.
 *
 *   provider: 'none'     — player renders a disabled, explained state.
 *   provider: 'youtube' — fill `youtube.videoId` (the ?v= part of a YouTube
 *                          URL). Playback uses the official IFrame API, loaded
 *                          at page start so the autoplay attempt can run; the
 *                          iframe itself stays hidden (the pill is the UI).
 *   provider: 'spotify' — fill `spotify.id` (track/album/playlist ID) and
 *                          `spotify.type`. Playback uses Spotify's embed
 *                          iframe, mounted VISIBLE above the pill: Spotify
 *                          exposes no transport/volume API, so the embed's
 *                          own UI is the control surface and the pill's
 *                          mute button is disabled for this provider.
 *   provider: 'file'    — fill `file.url` with a direct audio URL (mp3/ogg/
 *                          wav, same-origin or CORS-enabled). Full transport:
 *                          play/pause, volume, mute, loading and error states.
 *
 * Autoplay: ATTEMPTED on page load, never forced. When the browser refuses
 * (the usual case for audible audio), the pill shows its tap-to-play
 * affordance (data-state="blocked") — or, for Spotify, the embed's own play
 * button does. The refusal is never worked around. Volume/mute preferences
 * live in the settings store (scripts/settings.ts), not here; defaultVolume
 * only seeds it.
 *
 * PUBLIC vs SECRET: all values here are PUBLIC identifiers (they end up in
 * shipped HTML/JS). Never put API keys or private URLs in this file.
 */
export type MusicSourceConfig = {
	provider: 'none' | 'youtube' | 'spotify' | 'file';
	youtube: {
		/** e.g. 'dQw4w9WgXcQ' — leave empty until you have a source. */
		videoId: string;
	};
	spotify: {
		/** Spotify entity ID (track / album / playlist). */
		id: string;
		type: 'track' | 'album' | 'playlist';
	};
	file: {
		/** Direct audio file URL, e.g. '/music/ambient.mp3'. */
		url: string;
		/** Title shown in the player while playing. */
		title: string;
	};
	/** Initial volume 0..1 applied on first user-initiated play. */
	defaultVolume: number;
};

export const MUSIC_SOURCE: MusicSourceConfig = {
	// ▼▼▼ CONFIGURE HERE ▼▼▼
	provider: 'none',
	youtube: { videoId: '' },
	spotify: { id: '', type: 'track' },
	file: { url: '', title: '' },
	// ▲▲▲ CONFIGURE HERE ▲▲▲
	defaultVolume: 0.6,
};
