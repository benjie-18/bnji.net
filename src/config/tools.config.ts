/**
 * BNJI.NET — public configuration for the browser tools on /tools/.
 *
 * Both tools run entirely inside the visitor's tab. No image, no file byte and
 * no character of text is ever uploaded, stored, proxied or logged: there is no
 * API route behind either tool, which is the whole privacy posture. Every limit
 * below is therefore a *client-side guard* — it exists to stop one enormous file
 * or one enormous paste from wedging a tab, not to meter an upload.
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

/* ------------------------------------------------------------------------- *
 * Text files — shared by every tool that reads one (/tools/#word-counter and
 * /tools/#text-diff). One whitelist, one byte limit and one decoder, so two
 * tools cannot disagree about what a "text file" is.
 * ------------------------------------------------------------------------- */

export const TEXT_FILE_CONFIG = {
	/**
	 * Refuse before reading. 2 MB is what half a million characters weigh at four
	 * bytes each, so this and a tool's own character limit are the same limit seen
	 * from two sides: the byte check stops a huge file being decoded at all, and
	 * the character check (which runs after decoding) is the one that decides.
	 */
	maxBytes: 2 * 1024 * 1024,
} as const;

/* ------------------------------------------------------------------------- *
 * Word counter & text stats (/tools/#word-counter)
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
	segmenter:
		'Your browser splits the text into words, so Chinese, Japanese and Thai count properly and “well-known” stays one word.',
	whitespace:
		'Counts the runs between spaces. Text with no spaces — Chinese, Japanese, Thai — reads as one long word.',
};

/**
 * Shown instead of the mode hint when the browser has no Intl.Segmenter at all
 * (Firefox before 125). The select is then pinned to the space split and
 * disabled, because a choice the browser cannot honour is worse than a disabled
 * one that says why — the rule the image tool applies to a format it cannot
 * encode.
 */
export const WORD_MODE_UNAVAILABLE_HINT =
	'This browser has no text segmenter (Intl.Segmenter), so words are counted by spaces and the choice is off. Text with no spaces — Chinese, Japanese, Thai — will read as one long word.';

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
 * Text diff (/tools/#text-diff)
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
	unified:
		'One column, so it stays readable on a phone. A removed line comes before the line that replaced it.',
	split: 'Two columns, aligned line by line. Below about 48rem the columns stack, and unified is the easier read.',
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
