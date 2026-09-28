/**
 * BNJI.NET — provider link parsing for the music playlist importer.
 *
 * Pure functions, no I/O: this module decides whether a pasted string is ONE
 * supported provider link and which id it names. Everything that talks to a
 * provider (src/server/music-metadata.ts) takes its id from here, so a request
 * is only ever built from a value that already passed validation.
 *
 * THE THREAT THIS EXISTS FOR
 * --------------------------
 * A URL is attacker-chosen input. The tempting implementation — parse it and
 * fetch whatever host it names — turns an admin form into an SSRF primitive and
 * a metadata oracle for the whole internet. So:
 *
 *   - hosts are matched for EQUALITY against an allowlist. A suffix test would
 *     accept `youtube.com.attacker.example`, which is a real host someone owns;
 *   - only `https:` is accepted. `http://open.spotify.com/…` is not a thing the
 *     real site serves, and accepting it invites a redirect-based bypass;
 *   - the PATH is validated, not just the host: `/watch` needs a `v` parameter,
 *     `/track/` needs exactly one id segment, and nothing else is accepted;
 *   - the id must match the provider's own alphabet and length;
 *   - the canonical URL that gets stored is REBUILT from the validated id, so
 *     whatever else was in the pasted string (query tracking, extra path
 *     segments, a userinfo component) is discarded rather than persisted.
 *
 * The result is that the only hosts this code can cause a request to are
 * `api.spotify.com`, `accounts.spotify.com`, `open.spotify.com`,
 * `www.googleapis.com` and `www.youtube.com` — all fixed endpoints built from
 * config, never from user input.
 */
import { MUSIC_PLAYLIST, MUSIC_PROVIDER_URLS } from '../config/music.config';

/** The two providers the importer understands. `file` is never imported. */
export type MusicLinkProvider = 'spotify' | 'youtube';

/**
 * Which of those the ADMIN PANEL may import.
 *
 * Parsing and importing are deliberately two different questions. `parseMusicLink()`
 * accepts both providers because the library-level player plays both: a Spotify
 * entry is authored by hand in `src/config/music.config.ts` and seeded into D1,
 * and `spotify:` URIs are resolved client-side too. The admin form, by contrast,
 * is YouTube-only — its input says "YouTube video URL", its rejection message
 * says "not a supported YouTube video URL", and its date field is hardcoded to
 * "Publication date ... as reported by YouTube".
 *
 * So the gate has to live at the route boundary. Without it, a pasted Spotify
 * link parses fine, `resolveMusicMetadata()` fills in a `releaseDate`, and the
 * save path — which reads and writes only `publishedAt` — drops it silently.
 * The track would then sit in the queue with no date at all, because
 * `musicDateField('spotify')` reads `releaseDate`. Refusing the link is the
 * honest answer: the panel says it imports YouTube, so it imports YouTube.
 */
export const IMPORTABLE_PROVIDER: MusicLinkProvider = 'youtube';

/** Why an importable-provider refusal reads the way it does. */
export const IMPORTABLE_PROVIDER_MESSAGE =
	'The playlist panel imports YouTube video links only. A Spotify track is added by hand in src/config/music.config.ts.';

export type MusicLinkKind = 'track' | 'video';

export type MusicLinkParseError =
	| 'empty'
	| 'too_long'
	| 'not_a_url'
	| 'insecure_url'
	| 'unsupported_host'
	| 'unsupported_provider_type'
	| 'unsupported_path'
	| 'invalid_id';

/** One validated provider link. `canonicalUrl` is what gets stored. */
export type ParsedMusicLink =
	| {
			ok: true;
			provider: MusicLinkProvider;
			kind: MusicLinkKind;
			/** The provider's own id: a Spotify track id or a YouTube video id. */
			id: string;
			/** Rebuilt from the id; never the pasted string. */
			canonicalUrl: string;
	  }
	| { ok: false; error: MusicLinkParseError; /** Operator-facing explanation. */ message: string };

/** Spotify's locale prefix, e.g. `open.spotify.com/intl-de/track/<id>`. */
const SPOTIFY_LOCALE_SEGMENT = /^intl-[a-z0-9-]{2,7}$/i;
/** Spotify ids are base62; the embed player accepts this range. */
const SPOTIFY_ID = /^[A-Za-z0-9]{10,64}$/;
/** YouTube video ids: 11 characters of the URL-safe alphabet. */
const YOUTUBE_ID = /^[\w-]{11}$/;
/** YouTube path prefixes that carry a video id as their second segment. */
const YOUTUBE_ID_PATHS = ['embed', 'shorts', 'live', 'v'] as const;

/** The Spotify object types the importer will not expand. */
const SPOTIFY_OTHER_TYPES = ['album', 'playlist', 'artist', 'episode', 'show', 'user'] as const;

function reject(error: MusicLinkParseError, message: string): ParsedMusicLink {
	return { ok: false, error, message };
}

/**
 * Parse one pasted link into a validated provider target.
 *
 * Accepts `unknown` on purpose: the value arrives as JSON from a form, so
 * "not a string" is an ordinary outcome rather than an exception.
 */
export function parseMusicLink(value: unknown): ParsedMusicLink {
	if (typeof value !== 'string') return reject('empty', 'Paste a Spotify track link or a YouTube video link.');
	const input = value.trim();
	if (input.length === 0) return reject('empty', 'Paste a Spotify track link or a YouTube video link.');
	// Cheap length gate before any parsing: an over-long string is not a
	// provider link, and this keeps a pathological paste from reaching the
	// URL parser at all.
	if (input.length > MUSIC_PLAYLIST.maxUrlLength) {
		return reject('too_long', `That link is longer than ${MUSIC_PLAYLIST.maxUrlLength} characters.`);
	}

	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return reject('not_a_url', 'That is not a URL. Paste a full https:// link.');
	}

	// `new URL` lowercases the scheme, so this is an exact comparison.
	if (url.protocol !== 'https:') {
		return reject('insecure_url', 'Only https:// links are accepted.');
	}
	// The host is already lowercased by the URL parser; an explicit allowlist
	// comparison (never a suffix test) is what makes spoofed hosts fail here.
	const host = url.hostname;

	if (host === MUSIC_PROVIDER_URLS.spotify.host) return parseSpotifyLink(url);
	if ((MUSIC_PROVIDER_URLS.youtube.watchHosts as readonly string[]).includes(host)) {
		return parseYouTubeLink(url);
	}

	return reject(
		'unsupported_host',
		'Only open.spotify.com track links and youtube.com / youtu.be video links are supported.',
	);
}

function parseSpotifyLink(url: URL): ParsedMusicLink {
	const segments = url.pathname.split('/').filter(Boolean);

	// A locale segment is optional and always precedes the type, so the type
	// is the last segment before the id.
	const typeIndex = segments.findIndex((segment) => segment === 'track' || (SPOTIFY_OTHER_TYPES as readonly string[]).includes(segment));
	if (typeIndex < 0) return reject('unsupported_path', 'That Spotify link does not point to a single item.');
	if (segments[typeIndex] !== 'track') {
		return reject(
			'unsupported_provider_type',
			'Only single Spotify tracks can be imported. Albums, playlists and shows are not expanded.',
		);
	}

	// Every segment before the type must be a locale prefix, and there must be
	// exactly one segment after it. `open.spotify.com/track/<id>/extra` is a
	// malformed link, not a different one.
	const prefix = segments.slice(0, typeIndex);
	if (prefix.some((segment) => !SPOTIFY_LOCALE_SEGMENT.test(segment))) {
		return reject('unsupported_path', 'That Spotify link path is not a track link.');
	}
	if (segments.length !== typeIndex + 2) {
		return reject('unsupported_path', 'That Spotify link has extra path segments; paste the plain track link.');
	}

	const id = segments[typeIndex + 1] ?? '';
	if (!SPOTIFY_ID.test(id)) return reject('invalid_id', 'That Spotify link does not contain a valid track id.');

	return {
		ok: true,
		provider: 'spotify',
		kind: 'track',
		id,
		canonicalUrl: `https://${MUSIC_PROVIDER_URLS.spotify.host}/track/${id}`,
	};
}

function parseYouTubeLink(url: URL): ParsedMusicLink {
	const segments = url.pathname.split('/').filter(Boolean);
	let id = '';

	if (url.hostname === MUSIC_PROVIDER_URLS.youtube.hosts[1]) {
		// youtu.be/<id> — the id is the whole path, and a second segment means
		// the link is something else entirely.
		if (segments.length !== 1) return reject('unsupported_path', 'That youtu.be link is not a plain video link.');
		id = segments[0] ?? '';
	} else if (segments[0] === 'watch') {
		// /watch?v=<id>. The parameter is required; `?feature=…` alone is not a
		// video link, and a second `v` is ignored by the URL parser.
		if (segments.length !== 1) return reject('unsupported_path', 'That YouTube link path is not a watch URL.');
		id = url.searchParams.get('v') ?? '';
	} else if ((YOUTUBE_ID_PATHS as readonly string[]).includes(segments[0] ?? '')) {
		if (segments.length !== 2) return reject('unsupported_path', 'That YouTube link path is not a video URL.');
		id = segments[1] ?? '';
	} else {
		return reject('unsupported_path', 'That YouTube link does not point to a single video.');
	}

	if (!YOUTUBE_ID.test(id)) return reject('invalid_id', 'That YouTube link does not contain a valid video id.');

	return {
		ok: true,
		provider: 'youtube',
		kind: 'video',
		id,
		canonicalUrl: `https://${MUSIC_PROVIDER_URLS.youtube.hosts[0]}/watch?v=${id}`,
	};
}

/**
 * The stored field a provider's date belongs in.
 *
 * YouTube publishes a video; Spotify releases an album. The two dates answer
 * different questions and the UI labels them differently, so they are never
 * written to the same column.
 */
export function musicDateField(provider: MusicLinkProvider): 'publishedAt' | 'releaseDate' {
	return provider === 'spotify' ? 'releaseDate' : 'publishedAt';
}
