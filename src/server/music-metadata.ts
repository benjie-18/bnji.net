/**
 * BNJI.NET — server-side provider metadata lookup for the music playlist.
 *
 * The admin panel pastes a link; this module answers with a DRAFT. It never
 * saves anything and never returns a credential: the only things that leave
 * this module are provider-derived display strings, plus a description of which
 * lookups ran and why the others did not.
 *
 * WHAT IS ALLOWED TO REACH THE NETWORK
 * ------------------------------------
 * Only the fixed endpoints in MUSIC_PROVIDER_URLS, built from a provider id that
 * already passed src/server/music-links.ts. A submitted URL is parsed, never
 * fetched. Provider-returned HTML is discarded — YouTube's oEmbed response
 * carries an `<iframe>` snippet, and using it would mean injecting markup built
 * by a third party into an admin page; the embed the player uses is constructed
 * from the validated id instead (scripts/music.ts).
 *
 * CREDENTIALS ARE OPTIONAL, AND THAT IS THE DESIGN
 * ------------------------------------------------
 * YouTube's Data API `videos.list` needs YOUTUBE_API_KEY and Spotify's Web API
 * needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Any of them can be absent,
 * revoked, or over quota, and none of those may take the importer down: each
 * provider's public oEmbed endpoint is the fallback and manual entry is the last
 * resort. A link plus a title is always enough to save, so an operator who has
 * configured nothing still has a working playlist.
 *
 * The channel name is a SUGGESTION, not credited metadata: plenty of videos are
 * uploads by a channel that did not make the music. It is returned with
 * `artistIsSuggestion: true` so the panel can say so and the admin can edit it.
 */
import { MUSIC_LOOKUP, MUSIC_PLAYLIST, MUSIC_PROVIDER_URLS } from '../config/music.config';
import type { MusicLinkProvider, ParsedMusicLink } from './music-links';

export type MusicMetadataLookup =
	| 'spotify-web-api'
	| 'spotify-oembed'
	| 'youtube-data-api'
	| 'youtube-oembed';

export type MusicMetadataOutcome =
	| 'used'
	/** The lookup is enabled but its credential is not in the environment. */
	| 'skipped_not_configured'
	/** The provider was called and refused, timed out, or answered unusably. */
	| 'failed'
	/** The provider answered, but not with a title. */
	| 'empty';

/** Suggested field values. Every one is optional and editable before saving. */
export type MusicMetadataDraft = {
	title?: string;
	artist?: string;
	album?: string;
	publishedAt?: string;
	releaseDate?: string;
};

export type MusicMetadataLookupReport = {
	lookup: MusicMetadataLookup;
	outcome: MusicMetadataOutcome;
	/** Operator-facing detail. Never a credential or a credential value. */
	detail?: string;
};

export type ResolvedMusicMetadata = {
	provider: MusicLinkProvider;
	id: string;
	/** The canonical link the item would be stored with. */
	url: string;
	/** Where the draft came from. */
	source: MusicMetadataLookup | 'manual';
	/**
	 * `ok`       — a title was resolved and at least one other field with it;
	 * `partial`  — a title was resolved, the rest is blank and editable;
	 * `unavailable` — nothing was resolved; the admin fills everything in.
	 */
	status: 'ok' | 'partial' | 'unavailable';
	/** One sentence for the admin panel. Always says what to do next. */
	message: string;
	fields: MusicMetadataDraft;
	/** True when `artist` is a channel name rather than credited metadata. */
	artistIsSuggestion: boolean;
	lookups: MusicMetadataLookupReport[];
};

export type MusicLookupEnv = Record<string, unknown>;

export type ResolveOptions = {
	/** Injectable for tests; defaults to the platform fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable for tests; the token cache's expiry is compared to it. */
	now?: () => number;
};

type FetchResult<T> = { ok: true; data: T } | { ok: false; reason: string };

/* --- text handling -------------------------------------------------------- */

/**
 * Trim, strip control characters and cap a provider- or operator-supplied
 * string.
 *
 * Control characters are removed rather than escaped: they are invisible in a
 * rendered pill, they corrupt JSON round-trips in odd places, and a title with
 * a newline in it is not a title. Angle brackets are NOT stripped — the value
 * is never treated as markup anywhere (every renderer uses textContent), and
 * silently mangling a legitimate `&` or `<` in a video title would be worse
 * than the problem it pretends to solve.
 */
export function cleanMusicText(value: unknown, maxLength: number): string {
	if (typeof value !== 'string') return '';
	const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
	return stripped.slice(0, maxLength);
}

/** A date worth storing: `YYYY-MM-DD`, or a provider's partial `YYYY-MM`. */
const DATE_VALUE = /^\d{4}(-\d{1,2}){0,2}$/;

/**
 * Normalize a date to a storable value, or '' when it is not a date.
 *
 * YouTube sends `snippet.publishedAt` as a full ISO timestamp, whose date part
 * is what the operator actually wants. Partial values are kept rather than
 * padded into a precision the provider never claimed. Anything that is not
 * digits and dashes is dropped.
 */
export function normalizeMusicDate(value: unknown, maxLength = MUSIC_PLAYLIST.maxDateLength): string {
	if (typeof value !== 'string') return '';
	const trimmed = value.trim();
	// An ISO timestamp (YouTube's publishedAt) keeps its date part only.
	const candidate = /^\d{4}-\d{2}-\d{2}T/.test(trimmed) ? trimmed.slice(0, 10) : trimmed;
	return DATE_VALUE.test(candidate) ? candidate.slice(0, maxLength) : '';
}

/* --- fetch helper --------------------------------------------------------- */

/**
 * One GET with a timeout, returning parsed JSON or a reason.
 *
 * The timeout is not optional: a provider that accepts a connection and then
 * hangs would otherwise hold an admin form open until the Worker's own limit,
 * which reads to the operator as "the site is broken" rather than "the
 * provider is slow". Failing fast is what makes the manual fallback usable.
 */
async function fetchJson<T>(
	url: string,
	options: { fetchImpl: typeof fetch; timeoutMs: number; headers?: Record<string, string> },
): Promise<FetchResult<T>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await options.fetchImpl(url, {
			headers: { accept: 'application/json', ...options.headers },
			signal: controller.signal,
		});
		if (!response.ok) return { ok: false, reason: `http_${response.status}` };
		const data = (await response.json()) as T;
		return { ok: true, data };
	} catch (error) {
		return { ok: false, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network' };
	} finally {
		clearTimeout(timer);
	}
}

/* --- Spotify -------------------------------------------------------------- */

type SpotifyCredentials = { clientId: string; clientSecret: string };

/**
 * The Spotify Web API token, cached per isolate.
 *
 * Client Credentials is a server-only flow: the client id and secret are read
 * from the environment, exchanged for a short-lived token, and the token is
 * used for exactly this module's requests. It is never returned by an endpoint,
 * never written to a response body, and never reaches client code — the browser
 * only ever sees the draft this module produces.
 */
let spotifyTokenCache: { value: string; expiresAt: number } | null = null;

function spotifyCredentials(env: MusicLookupEnv): SpotifyCredentials | null {
	const clientId = typeof env.SPOTIFY_CLIENT_ID === 'string' ? env.SPOTIFY_CLIENT_ID.trim() : '';
	const clientSecret = typeof env.SPOTIFY_CLIENT_SECRET === 'string' ? env.SPOTIFY_CLIENT_SECRET.trim() : '';
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function spotifyAccessToken(
	credentials: SpotifyCredentials,
	options: { fetchImpl: typeof fetch; timeoutMs: number; now: () => number },
): Promise<string | null> {
	if (spotifyTokenCache && spotifyTokenCache.expiresAt > options.now() + 5_000) {
		return spotifyTokenCache.value;
	}

	const basic = btoa(`${credentials.clientId}:${credentials.clientSecret}`);
	const result = await fetchJson<{ access_token?: unknown; expires_in?: unknown }>(
		MUSIC_PROVIDER_URLS.spotify.tokenUrl,
		{
			fetchImpl: options.fetchImpl,
			timeoutMs: options.timeoutMs,
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				authorization: `Basic ${basic}`,
			},
		},
	);
	if (!result.ok || typeof result.data.access_token !== 'string') {
		// A refused token is not fatal: the oEmbed fallback and manual entry
		// both still work, so the cache is simply left empty.
		spotifyTokenCache = null;
		return null;
	}

	const expiresIn = Number(result.data.expires_in ?? 3600);
	const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600;
	spotifyTokenCache = { value: result.data.access_token, expiresAt: options.now() + lifetime * 1000 };
	return spotifyTokenCache.value;
}

/** Test seam: drop the cached token so a test starts from a cold cache. */
export function resetSpotifyTokenCache(): void {
	spotifyTokenCache = null;
}

type SpotifyTrackResponse = {
	name?: unknown;
	artists?: { name?: unknown }[];
	album?: { name?: unknown; release_date?: unknown };
};

function normalizeSpotifyTrack(raw: SpotifyTrackResponse): MusicMetadataDraft {
	const releaseDate = normalizeMusicDate(raw.album?.release_date);
	return {
		title: cleanMusicText(raw.name, MUSIC_PLAYLIST.maxTitleLength),
		artist: cleanMusicText(raw.artists?.[0]?.name, MUSIC_PLAYLIST.maxArtistLength),
		album: cleanMusicText(raw.album?.name, MUSIC_PLAYLIST.maxAlbumLength),
		...(releaseDate ? { releaseDate } : {}),
	};
}

/* --- YouTube -------------------------------------------------------------- */

type YouTubeSnippet = {
	title?: unknown;
	channelTitle?: unknown;
	publishedAt?: unknown;
};

type YouTubeVideoResponse = {
	items?: {
		snippet?: YouTubeSnippet;
	}[];
};

function normalizeYouTubeVideo(raw: YouTubeVideoResponse): MusicMetadataDraft {
	const item = Array.isArray(raw.items) ? raw.items[0] : undefined;
	if (!item) return {};
	const title = cleanMusicText(item.snippet?.title, MUSIC_PLAYLIST.maxTitleLength);
	// Deliberately a suggestion: see `artistIsSuggestion` below.
	const artist = cleanMusicText(item.snippet?.channelTitle, MUSIC_PLAYLIST.maxArtistLength);
	const publishedAt = normalizeMusicDate(item.snippet?.publishedAt);
	// Empty strings are omitted rather than stored: a field that is present but
	// blank is indistinguishable from a field the provider never answered, and
	// the panel treats "absent" and "blank" the same way.
	return {
		...(title ? { title } : {}),
		...(artist ? { artist } : {}),
		...(publishedAt ? { publishedAt } : {}),
	};
}

/* --- oEmbed -------------------------------------------------------------- */

type OEmbedResponse = { title?: unknown; author_name?: unknown };

/**
 * The shared oEmbed normalizer.
 *
 * `author_name` is the channel that uploaded a YouTube video and is treated as
 * a suggested artist there; Spotify's oEmbed does not credit one, so it is
 * ignored for Spotify. The `<html>` embed snippet oEmbed also returns is
 * ignored entirely: the player builds its own iframe from the validated id, so
 * third-party markup never reaches a page.
 */
function normalizeOEmbed(raw: OEmbedResponse, provider: MusicLinkProvider): MusicMetadataDraft {
	const title = cleanMusicText(raw.title, MUSIC_PLAYLIST.maxTitleLength);
	const artist =
		provider === 'youtube' ? cleanMusicText(raw.author_name, MUSIC_PLAYLIST.maxArtistLength) : '';
	return {
		...(title ? { title } : {}),
		...(artist ? { artist } : {}),
	};
}

/* --- resolution ----------------------------------------------------------- */

/**
 * Resolve a validated link into an editable draft.
 *
 * The returned draft is a set of SUGGESTIONS. The admin panel renders every
 * field in an input, the operator edits what they like, and the save endpoint
 * re-validates the result — so YouTube returning junk, or returning nothing at
 * all, costs the operator a few keystrokes rather than the feature.
 */
export async function resolveMusicMetadata(
	link: Extract<ParsedMusicLink, { ok: true }>,
	env: MusicLookupEnv,
	options: ResolveOptions = {},
): Promise<ResolvedMusicMetadata> {
	const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
	const now = options.now ?? (() => Date.now());
	const timeoutMs = MUSIC_PLAYLIST.lookupTimeoutMs;
	const lookups: MusicMetadataLookupReport[] = [];

	let fields: MusicMetadataDraft = {};
	let source: MusicMetadataLookup | 'manual' = 'manual';
	let artistIsSuggestion = false;

	if (link.provider === 'spotify') {
		const credentials = spotifyCredentials(env);

		if (credentials && MUSIC_LOOKUP.spotify.webApi) {
			const token = await spotifyAccessToken(credentials, { fetchImpl, timeoutMs, now });
			if (token) {
				const result = await fetchJson<SpotifyTrackResponse>(
					`${MUSIC_PROVIDER_URLS.spotify.apiBase}/tracks/${encodeURIComponent(link.id)}`,
					{ fetchImpl, timeoutMs, headers: { authorization: `Bearer ${token}` } },
				);
				if (result.ok) {
					const normalized = normalizeSpotifyTrack(result.data);
					lookups.push({
						lookup: 'spotify-web-api',
						outcome: normalized.title ? 'used' : 'empty',
						...(normalized.title ? {} : { detail: 'no_title' }),
					});
					if (normalized.title) {
						fields = normalized;
						source = 'spotify-web-api';
					}
				} else {
					lookups.push({ lookup: 'spotify-web-api', outcome: 'failed', detail: result.reason });
				}
			} else {
				lookups.push({
					lookup: 'spotify-web-api',
					outcome: 'failed',
					detail: 'client_credentials_refused',
				});
			}
		} else {
			lookups.push({
				lookup: 'spotify-web-api',
				outcome: 'skipped_not_configured',
				detail: credentials ? 'disabled_in_config' : 'SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set',
			});
		}

		if (!fields.title && MUSIC_LOOKUP.spotify.oEmbed) {
			// The URL is built from the canonical link, which was rebuilt from a
			// validated id — so this is a request to a fixed endpoint with a
			// known-safe query value, never a fetch of what was pasted.
			const result = await fetchJson<OEmbedResponse>(
				`${MUSIC_PROVIDER_URLS.spotify.oEmbed}?url=${encodeURIComponent(link.canonicalUrl)}`,
				{ fetchImpl, timeoutMs },
			);
			if (result.ok) {
				const normalized = normalizeOEmbed(result.data, 'spotify');
				lookups.push({
					lookup: 'spotify-oembed',
					outcome: normalized.title ? 'used' : 'empty',
					...(normalized.title ? {} : { detail: 'no_title' }),
				});
				if (normalized.title) {
					fields = { ...fields, ...normalized };
					source = 'spotify-oembed';
				}
			} else {
				lookups.push({ lookup: 'spotify-oembed', outcome: 'failed', detail: result.reason });
			}
		}
	} else {
		const apiKey = typeof env.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';

		if (apiKey && MUSIC_LOOKUP.youtube.dataApi) {
		const result = await fetchJson<YouTubeVideoResponse>(
			// `part=snippet` only: `contentDetails` would buy a duration the
			// player already reads from the IFrame API, at extra quota cost.
			`${MUSIC_PROVIDER_URLS.youtube.apiBase}/videos?part=snippet&id=${encodeURIComponent(link.id)}&key=${encodeURIComponent(apiKey)}`,
			{ fetchImpl, timeoutMs },
		);
		if (result.ok) {
			const normalized = normalizeYouTubeVideo(result.data);
			lookups.push({
				lookup: 'youtube-data-api',
				outcome: normalized.title ? 'used' : 'empty',
				...(normalized.title ? {} : { detail: 'video_not_found' }),
			});
			if (normalized.title) {
				fields = normalized;
				source = 'youtube-data-api';
				// A channel name is who uploaded it, which is not always who
				// made the music. The panel says so and lets it be edited.
				artistIsSuggestion = Boolean(normalized.artist);
			}
		} else {
			lookups.push({ lookup: 'youtube-data-api', outcome: 'failed', detail: result.reason });
		}
	} else {
		lookups.push({
			lookup: 'youtube-data-api',
			outcome: 'skipped_not_configured',
			detail: apiKey ? 'disabled_in_config' : 'YOUTUBE_API_KEY not set',
		});
	}

	if (!fields.title && MUSIC_LOOKUP.youtube.oEmbed) {
		// The URL is built from the canonical link, which was rebuilt from a
		// validated id — so this is a request to a fixed endpoint with a
		// known-safe query value, never a fetch of what was pasted.
		const result = await fetchJson<OEmbedResponse>(
			`${MUSIC_PROVIDER_URLS.youtube.oEmbed}?url=${encodeURIComponent(link.canonicalUrl)}&format=json`,
			{ fetchImpl, timeoutMs },
		);
		if (result.ok) {
			const normalized = normalizeOEmbed(result.data, 'youtube');
			lookups.push({
				lookup: 'youtube-oembed',
				outcome: normalized.title ? 'used' : 'empty',
				...(normalized.title ? {} : { detail: 'no_title' }),
			});
			if (normalized.title) {
				fields = { ...fields, ...normalized };
				source = 'youtube-oembed';
				artistIsSuggestion = Boolean(normalized.artist);
			}
		} else {
			lookups.push({ lookup: 'youtube-oembed', outcome: 'failed', detail: result.reason });
		}
		}
	}

	const hasDate = Boolean(fields.publishedAt || fields.releaseDate);
	const status: ResolvedMusicMetadata['status'] = !fields.title
		? 'unavailable'
		: fields.artist || fields.album || hasDate
			? 'ok'
			: 'partial';

	return {
		provider: link.provider,
		id: link.id,
		url: link.canonicalUrl,
		source,
		status,
		message: statusMessage(status, source, fields, lookups),
		fields,
		artistIsSuggestion,
		lookups,
	};
}

function statusMessage(
	status: ResolvedMusicMetadata['status'],
	source: ResolvedMusicMetadata['source'],
	fields: MusicMetadataDraft,
	lookups: MusicMetadataLookupReport[],
): string {
	if (status === 'unavailable') {
		const skipped = lookups.filter((entry) => entry.outcome === 'skipped_not_configured').length;
		const detail =
			skipped > 0
				? 'No provider credentials are configured, so no metadata could be looked up.'
				: 'The provider did not return usable metadata for this link.'
		return `${detail} Enter the title and any details you want, then save.`;
	}
	if (status === 'partial') {
		return `Resolved from ${sourceLabel(source)}. Only a title came back — artist, album and date are blank and editable.`;
	}
	const hasDate = Boolean(fields.publishedAt || fields.releaseDate);
	const missing = [
		fields.artist ? '' : 'artist',
		fields.album ? '' : 'album',
		hasDate ? '' : 'date',
	].filter(Boolean);
	return `Resolved from ${sourceLabel(source)}. Edit anything before saving${missing.length ? `; ${missing.join(', ')} left blank.` : '.'}`;
}

function sourceLabel(source: ResolvedMusicMetadata['source']): string {
	switch (source) {
		case 'spotify-web-api':
			return 'the Spotify Web API';
		case 'spotify-oembed':
			return 'Spotify oEmbed (limited)';
		case 'youtube-data-api':
			return 'the YouTube Data API';
		case 'youtube-oembed':
			return 'YouTube oEmbed (limited)';
		default:
			return 'manual entry';
	}
}
