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
 *                          only after the visitor presses play.
 *   provider: 'spotify' — fill `spotify.id` (track/album/playlist ID) and
 *                          `spotify.type`. Playback uses Spotify's embed
 *                          iframe; Spotify exposes no volume API, so the
 *                          player disables volume/mute for this provider.
 *   provider: 'file'    — fill `file.url` with a direct audio URL (mp3/ogg/
 *                          wav, same-origin or CORS-enabled). Full transport:
 *                          play/pause, volume, mute, loading and error states.
 *
 * Autoplay: never. Browsers block audible autoplay; the player only starts
 * after an explicit user gesture, for every provider.
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
