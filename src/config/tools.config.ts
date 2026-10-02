/**
 * BNJI.NET — public configuration for the browser tool on /tools/.
 *
 * The tool runs entirely inside the visitor's tab. No image and no
 * file byte is ever uploaded, stored, proxied or logged: there is no API route
 * behind the tool, which is the whole privacy posture. Every limit below is
 * therefore a *client-side guard* — it exists to stop one enormous file from
 * wedging a tab, not to meter an upload.
 *
 * PUBLIC: everything in this file ships in the client bundle, so it contains no
 * secrets and nothing environment-specific.
 */

/** Encoder names the page offers. Maps 1:1 to a canvas MIME type below. */
export type ToolImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * Output formats, in the order the <select> shows them.
 *
 * Deliberately short: these are the three formats every current browser can
 * encode. The tool never claims to convert to anything else, and never claims
 * to accept anything the browser cannot decode.
 */
export const IMAGE_FORMATS: readonly ToolImageFormat[] = ['png', 'jpeg', 'webp'];

/**
 * Encoders that honour canvas' quality argument. PNG is lossless, so a quality
 * slider on it would be a lie — the UI disables the control for PNG instead of
 * hiding it, so the visitor can see why.
 */
export const IMAGE_QUALITY_FORMATS: readonly ToolImageFormat[] = ['jpeg', 'webp'];

export const IMAGE_MIME: Record<ToolImageFormat, string> = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
};

/** The extension each format's download must carry (JPEG is .jpg, not .jpeg). */
export const IMAGE_EXTENSION: Record<ToolImageFormat, string> = {
	png: 'png',
	jpeg: 'jpg',
	webp: 'webp',
};

export const IMAGE_FORMAT_LABEL: Record<ToolImageFormat, string> = {
	png: 'PNG — lossless, keeps transparency',
	jpeg: 'JPEG — smallest for photos, no transparency',
	webp: 'WebP — modern, smallest at equal quality',
};

/** Bare format name, for error copy that must not restate the trade-off. */
export const IMAGE_FORMAT_NAME: Record<ToolImageFormat, string> = {
	png: 'PNG',
	jpeg: 'JPEG',
	webp: 'WebP',
};

/** One-line trade-off shown under the format select as it changes. */
export const IMAGE_FORMAT_HINT: Record<ToolImageFormat, string> = {
	png: 'Lossless. Quality does not apply, so the slider is off.',
	jpeg: 'No transparency: transparent pixels become black.',
	webp: 'Supports transparency and usually beats JPEG at the same quality.',
};

/**
 * Raster inputs a browser can decode. This is the honest list: the tool does
 * not convert PDFs, documents, archives, video or anything else, and the file
 * picker plus the validation below both refuse them by name.
 */
export const IMAGE_INPUT_TYPES: readonly string[] = [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'image/bmp',
	'image/avif',
];

/** `accept` attribute for the file input — one string, no drift from the list. */
export const IMAGE_INPUT_ACCEPT = IMAGE_INPUT_TYPES.join(',');

/** Human list used in the error copy, so the two can never disagree. */
export const IMAGE_INPUT_LABELS = 'PNG, JPEG, WebP, GIF, BMP or AVIF';

export const TOOL_IMAGE_CONFIG = {
	/** Refuse before decoding. 25 MB is already far past "a photo". */
	maxInputBytes: 25 * 1024 * 1024,
	/** Source pixel budget: a 40 MP decode is ~160 MB of bitmap. */
	maxSourcePixels: 40_000_000,
	/** Output budget, so an upscale cannot be used to allocate a huge canvas. */
	maxOutputPixels: 40_000_000,
	/** Quality slider domain, in percent (canvas wants 0..1). */
	quality: { min: 30, max: 100, step: 1, default: 82 },
	/** Hard ceiling on one edge, so a typo cannot ask for a 99999px canvas. */
	maxDimension: 20_000,
} as const;

/** Common IANA time zones for the Time Zone Converter selector */
export const COMMON_TIMEZONES = [
	{ label: 'Coordinated Universal Time (UTC)', zone: 'UTC' },
	{ label: 'London, Dublin (GMT / BST)', zone: 'Europe/London' },
	{ label: 'Paris, Berlin, Rome (CET / CEST)', zone: 'Europe/Paris' },
	{ label: 'Athens, Helsinki, Cairo (EET / EEST)', zone: 'Europe/Athens' },
	{ label: 'Dubai, Abu Dhabi (GST)', zone: 'Asia/Dubai' },
	{ label: 'Tokyo, Osaka (JST)', zone: 'Asia/Tokyo' },
	{ label: 'Sydney, Melbourne (AEST / AEDT)', zone: 'Australia/Sydney' },
	{ label: 'Auckland, Wellington (NZST / NZDT)', zone: 'Pacific/Auckland' },
	{ label: 'Honolulu, Hawaii (HST)', zone: 'Pacific/Honolulu' },
	{ label: 'Los Angeles, San Francisco (PST / PDT)', zone: 'America/Los_Angeles' },
	{ label: 'Denver, Phoenix (MST / MDT)', zone: 'America/Denver' },
	{ label: 'Chicago, Dallas (CST / CDT)', zone: 'America/Chicago' },
	{ label: 'New York, Toronto (EST / EDT)', zone: 'America/New_York' },
	{ label: 'São Paulo, Rio de Janeiro (BRT / BRST)', zone: 'America/Sao_Paulo' },
] as const;

export const TOOL_TIMEZONE_CONFIG = {
	defaultSourceZone: 'UTC',
	defaultTargetZone: 'America/New_York',
} as const;

export const TOOL_RANDOM_CONFIG = {
	minNumber: -1_000_000_000,
	maxNumber: 1_000_000_000,
	maxCount: 1_000,
	defaultMin: 1,
	defaultMax: 100,
	defaultCount: 1,
	maxPickerItems: 5_000,
} as const;

export const TOOL_LIST_CONFIG = {
	maxLines: 10_000,
	maxChars: 1_000_000,
} as const;

export const TOOL_COUNTDOWN_CONFIG = {
	maxHours: 99,
	maxMinutes: 59,
	maxSeconds: 59,
	maxLaps: 100,
	presets: [
		{ label: '1m', seconds: 60 },
		{ label: '5m', seconds: 300 },
		{ label: '10m', seconds: 600 },
		{ label: '15m', seconds: 900 },
		{ label: '30m', seconds: 1800 },
		{ label: '1h', seconds: 3600 },
	],
} as const;
