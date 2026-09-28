/* ==========================================================================
   BNJI.NET — background music playlist (public configuration).
   --------------------------------------------------------------------------
   `MUSIC_SOURCE.tracks` is the SEED playlist and the offline fallback:
     - the first time the playlist is read from D1, this array is copied into
       `music_playlist_items` once (migrations/0008_music_playlist.sql +
       src/server/music-store.ts);
     - after that the stored playlist is the playlist. Editing this file does
       NOT change a deployment that has already been seeded — the admin panel
       (/admin → Playlist) is the editing surface;
     - if D1 is unavailable the player falls back to this array, so the site
       never goes silent because a database hiccupped.
   An EMPTY stored playlist stays empty: removing every item is a decision, not
   a state to repair. Only a never-seeded database copies this array in.

   Add songs to `tracks` in playback order; array order is playback order. Each
   item needs a stable `id`, a title, a provider and a URL. Artist, album and
   the publication date are optional; non-empty metadata is shown after the
   title in the pill and playlist, while missing fields stay hidden.

   Providers:
     file     — the one built-in source: place the audio file under public/music/
                and use its root path, or use a direct same-origin/CORS-enabled
                audio URL. It cannot be imported from /admin; it exists so an
                owner-authored track keeps working, and it is the only provider
                with a native <audio> element.
     youtube  — paste a YouTube watch, youtu.be, shorts, live or embed URL. The
                IFrame API gives progress and end events, so YouTube tracks
                advance in playlist order exactly like file tracks.
     spotify  — paste an open.spotify.com track URL (single tracks only; albums
                and playlists are not expanded by the importer). Spotify's
                current iFrame API is documented for podcast controls; it does
                not provide a supported progress/end contract for music tracks.
                Use the embed's own controls. Use file or YouTube for site-level
                progress and automatic advance.

   Two date fields, deliberately distinct: `publishedAt` is when a YouTube video
   was uploaded, `releaseDate` is when a Spotify album was released. They are
   different facts about different things, so the player labels them with
   different verbs ("Published …" vs "Released …") and they are never written to
   one field and relabelled later.

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
	/**
	 * When a YouTube video was UPLOADED. Never used for a Spotify release
	 * date — that is `releaseDate`, and the two are labelled differently.
	 */
	publishedAt?: string;
	/**
	 * When a Spotify album was RELEASED. Optional and provider-specific; an
	 * item with neither date simply shows no date line.
	 */
	releaseDate?: string;
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
	releaseDate: string;
};

/** Normalize optional per-track metadata; absent values stay empty for the UI to omit. */
export function getMusicTrackMetadata(track: MusicTrack | null | undefined): MusicTrackDisplayMetadata {
	return {
		artist: track?.artist?.trim() ?? '',
		album: track?.album?.trim() ?? '',
		publishedAt: track?.publishedAt?.trim() ?? '',
		releaseDate: track?.releaseDate?.trim() ?? '',
	};
}

/**
 * The date line for a track, with the verb that matches the field it came from.
 *
 * A YouTube upload date and a Spotify album release date are different facts
 * about different things, so they are never printed with the same word: the
 * player says "Published 2024-05-01" for one and "Released 2019-11-15" for the
 * other. Missing dates return an empty string, which callers treat as "render
 * nothing" rather than as a placeholder.
 */
export function getMusicTrackDateLabel(track: MusicTrack | null | undefined): string {
	const published = track?.publishedAt?.trim() ?? '';
	if (published) return `Published ${published}`;
	const released = track?.releaseDate?.trim() ?? '';
	if (released) return `Released ${released}`;
	return '';
}

/**
 * The accessible name of a track's play button.
 *
 * One definition, used by the prerendered markup in MusicPlayer.astro and by
 * the runtime rebuild in scripts/music.ts, so the queue a visitor hears and the
 * queue a screen reader announces cannot drift apart.
 */
export function musicTrackAriaLabel(track: MusicTrack): string {
	const { artist, album } = getMusicTrackMetadata(track);
	const date = getMusicTrackDateLabel(track);
	return [
		`Play ${track.title.trim() || 'untitled track'}`,
		artist ? `by ${artist}` : '',
		album ? `from ${album}` : '',
		date,
	]
		.filter(Boolean)
		.join(', ');
}

/**
 * Endpoints and accepted hosts belong to the music integration config.
 *
 * `apiBase` and `oEmbed` are the ONLY hosts the server ever requests for
 * metadata, and every request is built from a validated video id — never from
 * a submitted URL. They are public strings by design: knowing the endpoint is
 * not knowing a credential, and the credential itself lives in the Worker
 * environment (see docs/CONFIGURATION.md).
 */
export const MUSIC_PROVIDER_URLS = {
	youtube: {
		iframeApi: 'https://www.youtube.com/iframe_api',
		/** Positional: [0] is the bare domain, [1] the short host. */
		hosts: ['youtube.com', 'youtu.be'],
		/**
		 * Exact hosts the admin importer accepts, checked for EQUALITY rather
		 * than a suffix match, so `youtube.com.evil.example` cannot pass as
		 * `youtube.com`. The client parser derives the same set from `hosts`
		 * with a suffix test; this is the stricter, server-side list.
		 */
		watchHosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
		apiBase: 'https://www.googleapis.com/youtube/v3',
		oEmbed: 'https://www.youtube.com/oembed',
	},
	spotify: {
		embedBase: 'https://open.spotify.com/embed',
		host: 'open.spotify.com',
		apiBase: 'https://api.spotify.com/v1',
		tokenUrl: 'https://accounts.spotify.com/api/token',
		oEmbed: 'https://open.spotify.com/oembed',
	},
} as const;

/**
 * Limits for the admin-managed playlist. The server enforces every one of
 * them; the admin panel mirrors them so a rejected save is not a surprise.
 */
export const MUSIC_PLAYLIST = {
	/** Hard cap on stored items. Keeps reorder batches small and bounded. */
	maxItems: 100,
	maxTitleLength: 200,
	maxArtistLength: 120,
	maxAlbumLength: 160,
	maxUrlLength: 500,
	maxDateLength: 10,
	/** How long a provider lookup may take before manual entry is offered. */
	lookupTimeoutMs: 6000,
} as const;

/**
 * Which lookups the importer is willing to attempt. These are capability
 * switches, not credentials: a lookup only runs when its credential is also
 * present in the Worker environment.
 */
export const MUSIC_LOOKUP = {
	spotify: {
		/** Web API single-track endpoint, with server-side Client Credentials. */
		webApi: true,
		/** Public oEmbed endpoint: title only, no credentials. */
		oEmbed: true,
	},
	youtube: {
		/** Data API videos endpoint, with a server-side API key. */
		dataApi: true,
		/** Public oEmbed endpoint: title + channel name, no credentials. */
		oEmbed: true,
	},
} as const;

export const MUSIC_SOURCE: MusicSourceConfig = {
	tracks: [
		// Copy an entry, replace its fields, then move it to set playback order.
		// { id: 'next-song', title: 'Song title', artist: 'Artist', album: 'Album', publishedAt: '2026-01-01', provider: 'file', url: '/music/song.mp3' },
		// { id: 'youtube-song', title: 'Video title', artist: 'Channel name', publishedAt: '2026-01-01', provider: 'youtube', url: 'https://youtu.be/VIDEO_ID' },
		// { id: 'spotify-song', title: 'Track title', artist: 'Artist', album: 'Album', releaseDate: '2019-11-15', provider: 'spotify', url: 'https://open.spotify.com/track/TRACK_ID' },
		{
			id: 'the-feeling',
			title: 'the feeling',
			provider: 'file',
			url: '/music/the feeling.mp3',
		},
	],
	defaultVolume: 0.6,
};
