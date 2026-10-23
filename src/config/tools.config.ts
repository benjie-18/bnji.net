/**
 * BNJI.NET — public configuration for browser tools on /projects/tools/.
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
	png: 'Lossless. Quality does not apply.',
	jpeg: 'No transparency: transparent pixels turn black.',
	webp: 'Keeps transparency, usually smaller than JPEG at equal quality.',
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

/* ------------------------------------------------------------------------- *
 * Image files — shared by every tool that reads one (/projects/tools/#image-converter
 * and /projects/tools/#color-picker).
 *
 * Same reasoning as TEXT_FILE_CONFIG below: the whitelist, the byte budget and
 * the decoded-pixel budget are one policy. Two tools carrying their own copy
 * would eventually disagree about what a browser may be asked to decode, and
 * the disagreement would show up as one tool accepting a file the other
 * refuses.
 * ------------------------------------------------------------------------- */
export const IMAGE_FILE_CONFIG = {
	/** Refuse before decoding. 25 MB is already far past "a photo". */
	maxBytes: 25 * 1024 * 1024,
	/** Decoded pixel budget: a 40 MP image is ~160 MB of bitmap. */
	maxSourcePixels: 40_000_000,
} as const;

export const TOOL_IMAGE_CONFIG = {
	/** Output budget, so an upscale cannot be used to allocate a huge canvas. */
	maxOutputPixels: 40_000_000,
	/** Quality slider domain. */
	quality: { min: 30, max: 100, step: 1, default: 82 },
	/** Hard ceiling on one edge. */
	maxDimension: 20_000,
} as const;

/* ------------------------------------------------------------------------- *
 * Text files — shared by every tool that reads one (/projects/tools/#word-counter and
 * /projects/tools/#text-diff). One whitelist, one byte limit and one decoder, so two
 * tools cannot disagree about what a "text file" is.
 * ------------------------------------------------------------------------- */

export const TEXT_FILE_CONFIG = {
	/**
	 * Refuse before reading. 2 MB is what half a million characters weigh at four
	 * bytes each, so this and a tool's own character limit are the same limit seen
	 * from two sides: the byte check stops a huge file from being decoded at all,
	 * and the character check (which runs after decoding) is the one that decides.
	 */
	maxBytes: 2 * 1024 * 1024,
} as const;

/* ------------------------------------------------------------------------- *
 * Word counter & text stats (/projects/tools/#word-counter)
 * ------------------------------------------------------------------------- */

/** How a run of text is broken into words. */
export type ToolWordMode = 'segmenter' | 'whitespace';

/**
 * Word-splitting modes, in the order the <select> shows them.
 *
 * The segmenter is the default because `split(/\s+/)` — what most counters do —
 * reports ONE word for a whole Chinese, Japanese or Thai sentence. Those scripts
 * do not put spaces between words, so counting them needs a real segmenter.
 */
export const WORD_MODES: readonly ToolWordMode[] = ['segmenter', 'whitespace'];

export const WORD_MODE_LABEL: Record<ToolWordMode, string> = {
	segmenter: 'Browser segmenter — counts scripts with no spaces',
	whitespace: 'Spaces only — the classic split',
};

/** One-line trade-off shown under the mode select as it changes. */
export const WORD_MODE_HINT: Record<ToolWordMode, string> = {
	segmenter: 'Your browser splits the text, so scripts with no spaces count properly.',
	whitespace: 'Counts the runs between spaces. Text with no spaces reads as one word.',
};

/**
 * Shown instead of the mode hint when the browser has no Intl.Segmenter at all
 * (Firefox before 125). The select is then pinned to the space split and
 * disabled, because a choice the browser cannot honour is worse than a disabled
 * one that says why — the rule the image tool applies to a format it cannot
 * encode.
 */
export const WORD_MODE_UNAVAILABLE_HINT =
	'This browser has no text segmenter (Intl.Segmenter), so words are counted by spaces and the choice is off.';

/**
 * Text inputs a browser can decode with `file.text()`. This is the honest list:
 * the tool does not read PDFs, Word documents, spreadsheets, images, archives or
 * video, and both the file picker and the validation below refuse them by name.
 *
 * Many browsers report an EMPTY type for .md/.csv/.log, so the extension is the
 * fallback whenever the type is missing — see `checkTextFile()`.
 */
export const TEXT_INPUT_TYPES: readonly string[] = [
	'text/plain',
	'text/markdown',
	'text/csv',
	'application/json',
];

/** Extensions accepted when the browser could not name a MIME type. */
export const TEXT_INPUT_EXTENSIONS: readonly string[] = [
	'.txt',
	'.text',
	'.md',
	'.markdown',
	'.csv',
	'.tsv',
	'.json',
	'.log',
];

/** `accept` attribute for the file input — one string, no drift from the lists. */
export const TEXT_INPUT_ACCEPT = [...TEXT_INPUT_EXTENSIONS, ...TEXT_INPUT_TYPES].join(',');

/** Human list used in the error copy, so the two can never disagree. */
export const TEXT_INPUT_LABELS = 'plain text, Markdown, CSV, TSV, JSON or a log file';

/**
 * Common English words the keyword list can skip.
 *
 * Without this the top of every English list is “the”, “of” and “and”, which
 * tells a writer nothing. It is a checkbox rather than a rule because a list of
 * stopwords is a list of assumptions, and the visitor should be able to see
 * theirs switched off. English only — the tool does not pretend otherwise.
 */
export const WORD_STOPWORDS: readonly string[] = [
	'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but',
	'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he', 'her',
	'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more',
	'my', 'no', 'not', 'now', 'of', 'on', 'one', 'or', 'other', 'our', 'out', 'say', 'she', 'so',
	'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
	'up', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'why', 'will', 'with', 'would',
	'you', 'your',
];

export const TOOL_WORDS_CONFIG = {
	/** Refuse before counting: ~500,000 characters is a 90,000-word book. */
	maxInputCharacters: 500_000,
	/** Keystrokes are coalesced, so a fast typist is not re-segmented per key. */
	recountDelayMs: 150,
	/** Silent-reading pace in words per minute (slider domain). */
	reading: { min: 100, max: 400, step: 5, default: 238 },
	/** Reading aloud runs slower than reading silently, so it gets its own domain. */
	speaking: { min: 80, max: 220, step: 5, default: 150 },
	/** How many keywords the frequency list shows. */
	keywords: { min: 1, max: 12, step: 1, default: 6 },
	/** Shorter than this a "keyword" is noise: “a”, “I”, “ok”. */
	minKeywordLength: 2,
} as const;

/* ------------------------------------------------------------------------- *
 * Text diff (/projects/tools/#text-diff)
 * ------------------------------------------------------------------------- */

/** How the comparison is laid out. */
export type ToolDiffView = 'unified' | 'split';

export const DIFF_VIEWS: readonly ToolDiffView[] = ['unified', 'split'];

export const DIFF_VIEW_LABEL: Record<ToolDiffView, string> = {
	unified: 'Unified — one column, changes in order',
	split: 'Side by side — two columns, aligned',
};

/** One-line trade-off shown under the view select as it changes. */
export const DIFF_VIEW_HINT: Record<ToolDiffView, string> = {
	unified: 'One column, readable on a phone. A removed line comes before its replacement.',
	split: 'Two columns, aligned line by line. They stack below about 48rem.',
};

export const TOOL_DIFF_CONFIG = {
	/** Refuse before comparing, per side: ~250,000 characters is a long contract. */
	maxInputCharacters: 250_000,
	/**
	 * Above this per side, typing no longer re-runs the comparison — the visitor
	 * presses Compare instead. A diff is O(n×m) where a word count is O(n), so the
	 * threshold is far below the limit; the panel is cleared when it is crossed,
	 * because a diff left on screen would describe text that is no longer there.
	 */
	autoCompareMaxCharacters: 20_000,
	recompareDelayMs: 350,
	/**
	 * The comparison table is n×m cells of four bytes, where n and m are the lines
	 * that actually differ (common head and tail are trimmed first, so two similar
	 * files cost almost nothing). 4,000,000 cells is ~16 MB and ~40 ms — the same
	 * shape of guard as the image tool's pixel budget, and for the same reason: one
	 * pathological pair must not be able to wedge a phone.
	 */
	maxDiffCells: 4_000_000,
	/** The same budget for the word-level pass inside one changed line pair. */
	maxWordDiffCells: 250_000,
	/** Rows actually put in the DOM, so an all-changed file cannot build 10,000 nodes. */
	maxRenderedRows: 1_500,
	/** Unchanged lines kept around a change, as in `diff -U<n>`. 0 shows changes only. */
	context: { min: 0, max: 12, step: 1, default: 3 },
} as const;

/* ------------------------------------------------------------------------- *
 * Color picker (/projects/tools/#color-picker)
 *
 * Every number here is a limit a visitor could hit, and every label is copy they
 * read. Nothing about colour is hard-coded in the module: the picker's job is to
 * show its own arithmetic, so the formats it converts between and the schemes
 * it offers are both listed here, in the order they appear.
 * ------------------------------------------------------------------------- */

/**
 * The formats the converter reads out.
 *
 * `hex`, `rgb` and `hsv` are editable (a hex field, three channel fields, and
 * the wheel plus its sliders); the rest are derived, because a format that
 * cannot round-trip exactly — CMYK has no RGB inverse without a press profile —
 * would only invite a value the tool then has to refuse.
 */
export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'hsv' | 'cmyk' | 'hwb' | 'oklch';

export const COLOR_FORMATS: readonly ColorFormat[] = [
	'hex',
	'rgb',
	'hsl',
	'hsv',
	'cmyk',
	'hwb',
	'oklch',
];

export const COLOR_FORMAT_LABEL: Record<ColorFormat, string> = {
	hex: 'HEX',
	rgb: 'RGB',
	hsl: 'HSL',
	hsv: 'HSV',
	cmyk: 'CMYK',
	hwb: 'HWB',
	oklch: 'OKLCH',
};

export const COLOR_FORMAT_HINT: Record<ColorFormat, string> = {
	hex: 'CSS hex — 3, 4, 6 or 8 digits.',
	rgb: 'The three channels, 0–255.',
	hsl: 'CSS hsl(). Lightness is not the wheel’s brightness.',
	hsv: 'What the wheel drives. Value 100% is the brightest it gets.',
	cmyk: 'Print. Derived from RGB — an approximation, not a press profile.',
	hwb: 'CSS hwb(): hue, then white and black mixed in.',
	oklch: 'CSS oklch(). Perceptually even.',
};

/**
 * Harmony schemes, each a set of hue rotations around the current colour.
 * Monochrome is the exception: it holds the hue and walks the brightness, which
 * is why it is generated separately rather than as a list of angles.
 */
export type ColorScheme =
	| 'complement'
	| 'analogous'
	| 'triadic'
	| 'square'
	| 'split'
	| 'monochrome';

export const COLOR_SCHEMES: readonly ColorScheme[] = [
	'complement',
	'analogous',
	'triadic',
	'square',
	'split',
	'monochrome',
];

export const COLOR_SCHEME_LABEL: Record<ColorScheme, string> = {
	complement: 'Complementary — opposite on the wheel',
	analogous: 'Analogous — neighbours on the wheel',
	triadic: 'Triadic — three equal steps',
	square: 'Square — four equal steps',
	split: 'Split complementary — either side of the opposite',
	monochrome: 'Monochrome — one hue, tints and shades',
};

export const COLOR_SCHEME_HINT: Record<ColorScheme, string> = {
	complement: 'Two colors 180° apart. Maximum contrast of hue.',
	analogous: 'Three colors 30° apart. Quiet and cohesive.',
	triadic: 'Three colors 120° apart. Balanced and vivid.',
	square: 'Four colors 90° apart. Two warm, two cool.',
	split: 'The color plus the two beside its opposite.',
	monochrome: 'One hue at five values: two tints, the color, two shades.',
};

export const TOOL_COLOR_CONFIG = {
	/**
	 * The colour the tool opens on. A hex here is data — the picker's starting
	 * value — not part of the design system, whose colours stay in tokens.css.
	 * Chosen so that every format row has a different thing to say (a hue that is
	 * not on a primary axis, saturation and brightness both middling-high), and so
	 * that every scheme starts from a colour with room to rotate into.
	 */
	defaultColor: '#e07a3f',
	/** What the current colour is contrasted against until the visitor changes it. */
	defaultBackground: '#ffffff',
	wheel: {
		/**
		 * The wheel is drawn per pixel into an ImageData, so its cost is the
		 * backing store's area: 640² is ~1.6 MB and draws in a few milliseconds,
		 * while an uncapped 3× phone would ask for a million pixels per resize.
		 */
		maxBacking: 640,
		/** Used when the element has no layout yet (or no canvas to measure). */
		fallbackCssSize: 240,
		/** Past 3× a backing store costs pixels and buys nothing an eye can see. */
		maxPixelRatio: 3,
		/** Redrawing the wheel is a per-pixel loop, so a resize is settled first. */
		resizeDebounceMs: 150,
	},
	/** Working palette. Memory only: like every other tool here, a reload starts empty. */
	maxPaletteEntries: 24,
	sample: {
		/** Longest edge of the on-screen preview, in CSS pixels. */
		previewMaxEdge: 560,
		/**
		 * The pick itself is taken from the file's own pixels — a 1×1 draw of the
		 * decoded image — so downscaling the preview cannot cost accuracy. Only
		 * the "common colors" scan uses this edge, and 160² is 25,600 pixels to
		 * count, which is instant.
		 */
		scanMaxEdge: 160,
		maxCommonColors: 8,
		/** 4 bits per channel: 4,096 buckets, enough to group without flattening. */
		bucketShift: 4,
		/** Two reported colors closer than this per channel are the same color twice. */
		minColorDistance: 24,
	},
	/** WCAG 2.x thresholds, so the verdicts quote a real standard instead of a hunch. */
	contrast: {
		aaNormal: 4.5,
		aaLarge: 3,
		aaaNormal: 7,
		aaaLarge: 4.5,
		/** CSS pixels at which WCAG counts text as large (18.66px bold rounds here). */
		largeTextPx: 24,
	},
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
