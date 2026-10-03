/**
 * BNJI.NET — public configuration for browser tools on /tools/.
 *
 * All tools run entirely inside the visitor's tab. No image, file byte, or
 * input value is ever uploaded, stored, proxied or logged.
 *
 * PUBLIC: everything in this file ships in the client bundle, so it contains no
 * secrets and nothing environment-specific.
 */

/* ------------------------------------------------------------------------- *
 * 1. Image Converter & Optimizer Configuration
 * ------------------------------------------------------------------------- */

/** Encoder names the page offers. Maps 1:1 to a canvas MIME type below. */
export type ToolImageFormat = 'png' | 'jpeg' | 'webp';

/**
 * Output formats, in the order the <select> shows them.
 */
export const IMAGE_FORMATS: readonly ToolImageFormat[] = ['png', 'jpeg', 'webp'];

/**
 * Encoders that honour canvas' quality argument.
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
 * Raster inputs a browser can decode.
 */
export const IMAGE_INPUT_TYPES: readonly string[] = [
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'image/bmp',
	'image/avif',
];

/** `accept` attribute for the file input. */
export const IMAGE_INPUT_ACCEPT = IMAGE_INPUT_TYPES.join(',');

/** Human list used in the error copy. */
export const IMAGE_INPUT_LABELS = 'PNG, JPEG, WebP, GIF, BMP or AVIF';

export const TOOL_IMAGE_CONFIG = {
	/** Refuse before decoding. 25 MB is already far past "a photo". */
	maxInputBytes: 25 * 1024 * 1024,
	/** Source pixel budget: a 40 MP decode is ~160 MB of bitmap. */
	maxSourcePixels: 40_000_000,
	/** Output budget. */
	maxOutputPixels: 40_000_000,
	/** Quality slider domain. */
	quality: { min: 30, max: 100, step: 1, default: 82 },
	/** Hard ceiling on one edge. */
	maxDimension: 20_000,
} as const;

/* ------------------------------------------------------------------------- *
 * 2. Image Metadata Remover & Inspector Configuration
 * ------------------------------------------------------------------------- */

export const TOOL_METADATA_CONFIG = {
	maxInputBytes: 25 * 1024 * 1024,
	supportedTypes: [
		'image/jpeg',
		'image/png',
		'image/webp',
		'image/tiff',
	] as readonly string[],
	supportedLabels: 'JPEG, PNG, WebP or TIFF',
} as const;

/* ------------------------------------------------------------------------- *
 * 3. Unit Converter Configuration
 * ------------------------------------------------------------------------- */

export type UnitCategory = 'length' | 'mass' | 'temperature' | 'data' | 'area' | 'speed';

export type UnitDefinition = {
	id: string;
	label: string;
	symbol: string;
	/** Factor to convert to base unit, or 'custom' for non-linear scale like temperature */
	factorToBase?: number;
};

export const UNIT_CATEGORIES: readonly { id: UnitCategory; label: string }[] = [
	{ id: 'length', label: 'Length & Distance' },
	{ id: 'mass', label: 'Mass & Weight' },
	{ id: 'temperature', label: 'Temperature' },
	{ id: 'data', label: 'Data Storage' },
	{ id: 'area', label: 'Area' },
	{ id: 'speed', label: 'Speed' },
];

export const UNIT_DEFINITIONS: Record<UnitCategory, readonly UnitDefinition[]> = {
	length: [
		{ id: 'mm', label: 'Millimeter', symbol: 'mm', factorToBase: 0.001 },
		{ id: 'cm', label: 'Centimeter', symbol: 'cm', factorToBase: 0.01 },
		{ id: 'm', label: 'Meter (Base)', symbol: 'm', factorToBase: 1 },
		{ id: 'km', label: 'Kilometer', symbol: 'km', factorToBase: 1000 },
		{ id: 'in', label: 'Inch', symbol: 'in', factorToBase: 0.0254 },
		{ id: 'ft', label: 'Foot', symbol: 'ft', factorToBase: 0.3048 },
		{ id: 'yd', label: 'Yard', symbol: 'yd', factorToBase: 0.9144 },
		{ id: 'mi', label: 'Mile', symbol: 'mi', factorToBase: 1609.344 },
	],
	mass: [
		{ id: 'mg', label: 'Milligram', symbol: 'mg', factorToBase: 0.000001 },
		{ id: 'g', label: 'Gram', symbol: 'g', factorToBase: 0.001 },
		{ id: 'kg', label: 'Kilogram (Base)', symbol: 'kg', factorToBase: 1 },
		{ id: 't', label: 'Metric Ton', symbol: 't', factorToBase: 1000 },
		{ id: 'oz', label: 'Ounce', symbol: 'oz', factorToBase: 0.028349523125 },
		{ id: 'lb', label: 'Pound', symbol: 'lb', factorToBase: 0.45359237 },
	],
	temperature: [
		{ id: 'c', label: 'Celsius', symbol: '°C' },
		{ id: 'f', label: 'Fahrenheit', symbol: '°F' },
		{ id: 'k', label: 'Kelvin', symbol: 'K' },
	],
	data: [
		{ id: 'b', label: 'Byte (Base)', symbol: 'B', factorToBase: 1 },
		{ id: 'kb', label: 'Kilobyte', symbol: 'KB', factorToBase: 1024 },
		{ id: 'mb', label: 'Megabyte', symbol: 'MB', factorToBase: 1024 ** 2 },
		{ id: 'gb', label: 'Gigabyte', symbol: 'GB', factorToBase: 1024 ** 3 },
		{ id: 'tb', label: 'Terabyte', symbol: 'TB', factorToBase: 1024 ** 4 },
	],
	area: [
		{ id: 'sqm', label: 'Square Meter (Base)', symbol: 'm²', factorToBase: 1 },
		{ id: 'sqkm', label: 'Square Kilometer', symbol: 'km²', factorToBase: 1_000_000 },
		{ id: 'sqft', label: 'Square Foot', symbol: 'ft²', factorToBase: 0.09290304 },
		{ id: 'sqmi', label: 'Square Mile', symbol: 'mi²', factorToBase: 2_589_988.110336 },
		{ id: 'acre', label: 'Acre', symbol: 'ac', factorToBase: 4046.8564224 },
		{ id: 'ha', label: 'Hectare', symbol: 'ha', factorToBase: 10_000 },
	],
	speed: [
		{ id: 'mps', label: 'Meter per second (Base)', symbol: 'm/s', factorToBase: 1 },
		{ id: 'kph', label: 'Kilometer per hour', symbol: 'km/h', factorToBase: 1 / 3.6 },
		{ id: 'mph', label: 'Mile per hour', symbol: 'mph', factorToBase: 0.44704 },
		{ id: 'knot', label: 'Knot', symbol: 'kn', factorToBase: 0.5144444444444444 },
	],
};

/* ------------------------------------------------------------------------- *
 * 4. Percentage Calculator Configuration
 * ------------------------------------------------------------------------- */

export type PercentageMode = 'of' | 'is-what' | 'change' | 'increase-decrease';

export type PercentageModeOption = {
	id: PercentageMode;
	label: string;
	description: string;
};

export const PERCENTAGE_MODES: readonly PercentageModeOption[] = [
	{
		id: 'of',
		label: 'What is X% of Y?',
		description: 'Calculate a percentage value of a target number.',
	},
	{
		id: 'is-what',
		label: 'X is what % of Y?',
		description: 'Find the proportion or percentage of one number relative to another.',
	},
	{
		id: 'change',
		label: '% Change from X to Y',
		description: 'Determine percentage increase or decrease between two values.',
	},
	{
		id: 'increase-decrease',
		label: 'Value after X% Increase/Decrease on Y',
		description: 'Apply a percentage markup or discount to a base value.',
	},
];
