/**
 * BNJI.NET — the /projects/tools/ repertory: categories, their tools, and the key that
 * jumps to each category.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Fourteen tools on one page is a scroll, not a catalogue. The page renders the
 * repertory, the category headings AND the tool order from this one list, so
 * "what is on /projects/tools/" has a single answer: a tool added here appears in the
 * index, in a category and on the page — and a tool missing from the map in
 * src/pages/projects/tools.astro is a type error rather than a silently unlisted tool.
 *
 * Content only: ids, names and grouping. The behaviour (filtering, deep links,
 * shortcut keys) lives in src/scripts/tools-index.ts and reads the DOM, so this
 * file never has to know about the page it describes.
 */

/** The `id` of each tool's <section> — also its anchor. */
export type ToolId =
	| 'image-converter'
	| 'image-metadata'
	| 'color-picker'
	| 'word-counter'
	| 'text-diff'
	| 'list-randomizer'
	| 'random-picker'
	| 'unit-converter'
	| 'cooking-converter'
	| 'percentage-calculator'
	| 'screen-calculator'
	| 'date-calculator'
	| 'timezone-converter'
	| 'countdown-stopwatch';

/** A category's slug: its section is `#cat-<id>`. */
export type ToolCategoryId = 'images' | 'text' | 'numbers' | 'time';

export type ToolEntry = {
	id: ToolId;
	/** What the repertory and the tool's own heading both say. */
	name: string;
};

export type ToolCategory = {
	id: ToolCategoryId;
	/** Mono index for the section eyebrow, e.g. "01". */
	index: string;
	/** Mono eyebrow label, e.g. "IMAGES & COLOR". */
	label: string;
	/** Heading and chip text. */
	title: string;
	/** Digit that switches to this category. Kept as a string: it is printed. */
	shortcut: string;
	tools: readonly ToolEntry[];
};

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
	{
		id: 'images',
		index: '01',
		label: 'IMAGES & COLOR',
		title: 'Images & color',
		shortcut: '1',
		tools: [
			{ id: 'image-converter', name: 'Image converter' },
			{ id: 'image-metadata', name: 'Image metadata' },
			{ id: 'color-picker', name: 'Color picker' },
		],
	},
	{
		id: 'text',
		index: '02',
		label: 'TEXT & LISTS',
		title: 'Text & lists',
		shortcut: '2',
		tools: [
			{ id: 'word-counter', name: 'Word counter' },
			{ id: 'text-diff', name: 'Text diff' },
			{ id: 'list-randomizer', name: 'List randomizer' },
			{ id: 'random-picker', name: 'Random picker' },
		],
	},
	{
		id: 'numbers',
		index: '03',
		label: 'CONVERT & CALCULATE',
		title: 'Convert & calculate',
		shortcut: '3',
		tools: [
			{ id: 'unit-converter', name: 'Unit converter' },
			{ id: 'cooking-converter', name: 'Cooking converter' },
			{ id: 'percentage-calculator', name: 'Percentage calculator' },
			{ id: 'screen-calculator', name: 'Screen / DPI calculator' },
		],
	},
	{
		id: 'time',
		index: '04',
		label: 'TIME & DATES',
		title: 'Time & dates',
		shortcut: '4',
		tools: [
			{ id: 'date-calculator', name: 'Date difference' },
			{ id: 'timezone-converter', name: 'Time zone converter' },
			{ id: 'countdown-stopwatch', name: 'Countdown / stopwatch' },
		],
	},
];

/** Every tool, in page order. */
export const TOOLS: readonly ToolEntry[] = TOOL_CATEGORIES.flatMap((category) => category.tools);

/** Total, for copy that says how many tools the page holds. */
export const TOOL_COUNT = TOOLS.length;
