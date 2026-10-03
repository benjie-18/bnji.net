/**
 * BNJI.NET — public configuration for the browser tools on /tools/.
 *
 * The tools run entirely inside the visitor's tab. No image, byte or parameter
 * is ever uploaded, stored, proxied or logged: there is no API route
 * behind these tools, which is the whole privacy posture. Every limit below is
 * therefore a *client-side guard* — it exists to stop extreme inputs from
 * wedging a tab, not to meter an upload or API request.
 *
 * PUBLIC: everything in this file ships in the client bundle, so it contains no
 * secrets and nothing environment-specific.
 */

/* ========================================================================= *
 * Image Converter Configuration
 * ========================================================================= */

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

/* ========================================================================= *
 * Date Difference Calculator Configuration
 * ========================================================================= */

export type DateCalcMode = 'diff' | 'add_subtract';
export type DateAddUnit = 'days' | 'weeks' | 'months' | 'years';

export const DATE_CALC_CONFIG = {
	maxYearSpan: 1000,
} as const;

/* ========================================================================= *
 * Cooking Unit Converter Configuration
 * ========================================================================= */

export type CookingUnitCategory = 'volume' | 'weight';

export type CookingUnit =
	| 'tsp'
	| 'tbsp'
	| 'fl_oz'
	| 'cup'
	| 'pt'
	| 'qt'
	| 'gal'
	| 'ml'
	| 'l'
	| 'g'
	| 'kg'
	| 'oz'
	| 'lb';

export interface CookingUnitInfo {
	id: CookingUnit;
	name: string;
	category: CookingUnitCategory;
	/** Conversion ratio relative to base unit (ml for volume, g for weight) */
	baseRatio: number;
}

export const COOKING_UNITS: readonly CookingUnitInfo[] = [
	// Volume (Base: ml)
	{ id: 'tsp', name: 'Teaspoon (tsp)', category: 'volume', baseRatio: 4.92892 },
	{ id: 'tbsp', name: 'Tablespoon (tbsp)', category: 'volume', baseRatio: 14.7868 },
	{ id: 'fl_oz', name: 'Fluid Ounce (fl oz)', category: 'volume', baseRatio: 29.5735 },
	{ id: 'cup', name: 'Cup (US)', category: 'volume', baseRatio: 236.588 },
	{ id: 'pt', name: 'Pint (US pt)', category: 'volume', baseRatio: 473.176 },
	{ id: 'qt', name: 'Quart (US qt)', category: 'volume', baseRatio: 946.353 },
	{ id: 'gal', name: 'Gallon (US gal)', category: 'volume', baseRatio: 3785.41 },
	{ id: 'ml', name: 'Milliliter (ml)', category: 'volume', baseRatio: 1 },
	{ id: 'l', name: 'Liter (l)', category: 'volume', baseRatio: 1000 },
	// Weight (Base: g)
	{ id: 'g', name: 'Gram (g)', category: 'weight', baseRatio: 1 },
	{ id: 'kg', name: 'Kilogram (kg)', category: 'weight', baseRatio: 1000 },
	{ id: 'oz', name: 'Ounce (oz)', category: 'weight', baseRatio: 28.3495 },
	{ id: 'lb', name: 'Pound (lb)', category: 'weight', baseRatio: 453.592 },
];

export interface IngredientDensity {
	id: string;
	name: string;
	/** Density in grams per milliliter (g/ml) */
	densityGml: number;
}

export const INGREDIENT_DENSITIES: readonly IngredientDensity[] = [
	{ id: 'water', name: 'Water / Liquid (1.00 g/ml)', densityGml: 1.0 },
	{ id: 'flour_ap', name: 'Flour (All-Purpose) (~0.53 g/ml)', densityGml: 0.53 },
	{ id: 'sugar_granulated', name: 'Sugar (Granulated) (~0.85 g/ml)', densityGml: 0.85 },
	{ id: 'sugar_powdered', name: 'Sugar (Powdered) (~0.56 g/ml)', densityGml: 0.56 },
	{ id: 'sugar_brown', name: 'Sugar (Brown, Packed) (~0.93 g/ml)', densityGml: 0.93 },
	{ id: 'butter', name: 'Butter (~0.96 g/ml)', densityGml: 0.96 },
	{ id: 'milk', name: 'Milk (~1.03 g/ml)', densityGml: 1.03 },
	{ id: 'oil', name: 'Vegetable / Olive Oil (~0.92 g/ml)', densityGml: 0.92 },
	{ id: 'honey', name: 'Honey / Syrup (~1.42 g/ml)', densityGml: 1.42 },
	{ id: 'salt', name: 'Table Salt (~1.22 g/ml)', densityGml: 1.22 },
	{ id: 'rice', name: 'Rice (Uncooked) (~0.85 g/ml)', densityGml: 0.85 },
	{ id: 'oats', name: 'Rolled Oats (~0.41 g/ml)', densityGml: 0.41 },
];

/* ========================================================================= *
 * Screen / DPI Calculator Configuration
 * ========================================================================= */

export interface ScreenPreset {
	name: string;
	width: number;
	height: number;
	diagonal: number;
}

export const SCREEN_PRESETS: readonly ScreenPreset[] = [
	{ name: '1080p Full HD (24")', width: 1920, height: 1080, diagonal: 24 },
	{ name: '1080p Full HD (27")', width: 1920, height: 1080, diagonal: 27 },
	{ name: '1440p QHD (27")', width: 2560, height: 1440, diagonal: 27 },
	{ name: '4K UHD (27")', width: 3840, height: 2160, diagonal: 27 },
	{ name: '4K UHD (32")', width: 3840, height: 2160, diagonal: 32 },
	{ name: 'MacBook Air/Pro 13.3"', width: 2560, height: 1600, diagonal: 13.3 },
	{ name: 'MacBook Pro 16"', width: 3456, height: 2234, diagonal: 16.2 },
	{ name: 'iPhone Standard 6.1"', width: 1170, height: 2532, diagonal: 6.1 },
];

export const TOOL_SCREEN_CONFIG = {
	maxPixelDimension: 32_000,
	maxDiagonalInches: 300,
} as const;
