/* ==========================================================================
   BNJI.NET — background music playlist (public configuration).
   --------------------------------------------------------------------------
   Add songs to `tracks` in playback order; reordering the array changes the
   queue. Each item needs a stable `id`, a title, a provider and a URL. Artist,
   album and publication date are optional; non-empty metadata is shown after
   the title in the pill and playlist, while missing fields stay hidden.

   Providers:
     file     — place the audio file under public/music/ and use its root path,
                or use a direct same-origin/CORS-enabled audio URL.
     youtube  — paste a YouTube watch, youtu.be, shorts or embed URL.
     spotify  — paste an open.spotify.com track/album/playlist URL. Spotify's
                current iFrame API is documented for podcast controls; it does
                not provide a supported progress/end contract for music tracks.
                Use the embed's own controls. Use file or YouTube for site-level
                progress and automatic advance.

   Volume/mute preferences live in the visitor settings store. These values are
   public and shipped to browsers; never put secrets or private URLs here.
   ========================================================================== */
export type MusicProvider = 'file' | 'youtube' | 'spotify';

export type MusicTrack = {
	/** Stable, unique key used by the rendered playlist. */
	id: string;
	/** Display title. */
	title: string;
	/** Optional display metadata; empty or missing fields are not rendered. */
	artist?: string;
	album?: string;
	/** Optional upload/release date when the provider or owner supplies it. */
	publishedAt?: string;
	provider: MusicProvider;
	/** Direct audio URL, or a YouTube/Spotify link for that provider. */
	url: string;
};

export type MusicSourceConfig = {
	/** Ordered queue; array order is playback order. An empty list disables music. */
	tracks: MusicTrack[];
	/** Initial volume 0..1, applied to file/YouTube playback. */
	defaultVolume: number;
};

export type MusicTrackDisplayMetadata = {
	artist: string;
	album: string;
	publishedAt: string;
};

/** Normalize optional per-track metadata; absent values stay empty for the UI to omit. */
export function getMusicTrackMetadata(track: MusicTrack | null | undefined): MusicTrackDisplayMetadata {
	return {
		artist: track?.artist?.trim() ?? '',
		album: track?.album?.trim() ?? '',
		publishedAt: track?.publishedAt?.trim() ?? '',
	};
}

/** Endpoints and accepted hosts belong to the music integration config. */
export const MUSIC_PROVIDER_URLS = {
	youtube: {
		iframeApi: 'https://www.youtube.com/iframe_api',
		hosts: ['youtube.com', 'youtu.be'],
	},
	spotify: {
		embedBase: 'https://open.spotify.com/embed',
		host: 'open.spotify.com',
	},
} as const;

export const MUSIC_SOURCE: MusicSourceConfig = {
	tracks: [
		// Copy an entry, replace its fields, then move it to set playback order.
		// { id: 'next-song', title: 'Song title', artist: 'Artist', album: 'Album', publishedAt: '2026-01-01', provider: 'file', url: '/music/song.mp3' },
		// { id: 'youtube-song', title: 'Video title', provider: 'youtube', url: 'https://youtu.be/VIDEO_ID' },
		{
			id: 'the-feeling',
			title: 'the feeling',
			provider: 'file',
			url: '/music/the feeling.mp3',
		},
	],
	defaultVolume: 0.6,
};
