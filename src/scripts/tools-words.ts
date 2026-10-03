/**
 * BNJI.NET — /tools/ word counter & text stats.
 *
 * The whole tool is arithmetic over four browser primitives: a <textarea> (the
 * input), File.text() (an optional file), Intl.Segmenter (word and sentence
 * boundaries) and navigator.clipboard (the copy button). Nothing here talks to
 * the network and nothing here talks to storage: no fetch, no form post, no
 * localStorage key and no Worker route behind it, which is the privacy claim the
 * page makes to the visitor.
 *
 * PRIVACY CONTRACT. The text a visitor types is never written anywhere. There is
 * no object URL to revoke and no bitmap to close, so the leak this module has to
 * guard against is a different one: a *copy* that outlives the visit. So the
 * debounce timer is cleared on reset, teardown and pagehide, the textarea is
 * emptied on the same three paths, and the loaded file's text is held in the
 * textarea only — never in a second buffer, never in storage.
 *
 * HONESTY CONTRACT. Four places where a counter normally lies, and what this one
 * does instead:
 *   - a browser with no Intl.Segmenter cannot count Chinese, Japanese or Thai by
 *     words, so the segmenter mode is not offered there: the select is pinned to
 *     the space split, disabled, and says why. A mode the browser cannot deliver
 *     is worse than a disabled one that explains itself — the rule the image tool
 *     applies to a format it cannot encode;
 *   - a hyphen or an apostrophe inside a word keeps that word together
 *     ("well-known", "don’t"), because every other counter — and the space split
 *     in this same module — reads them as one word, and two modes of one tool
 *     disagreeing about "well-known" is a bug dressed as a feature;
 *   - reading and speaking times are the word count divided by the pace the
 *     visitor set, and the pace is printed next to the time. Zero words is an em
 *     dash, never "0 min": text that does not exist has no reading time;
 *   - "copied" is said only when the clipboard write actually resolved. A missing
 *     API or a refused write is reported as a failure, never as a success.
 *
 * ONE SOURCE OF NUMBERS. `render()` writes the panel from a `TextStats` object
 * and `summaryText()` writes the clipboard from that same object, so the numbers
 * a visitor reads and the numbers they paste elsewhere cannot drift apart.
 */
import {
	TOOL_WORDS_CONFIG,
	WORD_MODE_HINT,
	WORD_MODE_UNAVAILABLE_HINT,
	WORD_STOPWORDS,
	type ToolWordMode,
} from '../config/tools.config';
/*
 * The text-file vocabulary both text tools hold in common — what a text file is,
 * how many bytes one may weigh, how mojibake is caught, how a number is grouped
 * — lives in ./tools-shared. Importing it beats copying it: two definitions is
 * two chances to drift, and every tool already ships in the same boot() chunk.
 */
import {
	checkTextFile,
	codePointLength,
	COPY_REFUSED,
	COPY_UNAVAILABLE,
	copyText,
	formatBytes,
	formatCount,
	isTextFile,
	looksLikeMojibake,
	type TextFile,
	type ToolCheck,
} from './tools-shared';

/* Re-exported so this module stays the word counter's whole public surface: its
 * callers, and its tests, import the tool's helpers from the tool. */
export { checkTextFile, codePointLength, formatCount, isTextFile, looksLikeMojibake };
export type { TextFile, ToolCheck };

/* ------------------------------------------------------------------------- *
 * Pure helpers. Exported because the interesting decisions — what counts as a
 * word, what counts as a sentence, how a duration is worded, what gets refused
 * — are testable without a browser, and this sandbox has none.
 * ------------------------------------------------------------------------- */

/** A token is a word only if it carries a letter or a digit: "---" is not one. */
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Punctuation that lives INSIDE one word rather than between two. */
const WORD_JOINER = /^[-\u2010-\u2015'’]+$/;
const TRAILING_JOINER = /[-\u2010-\u2015'’]+$/u;
/** Everything that is not a letter or a digit, for trimming a token's edges. */
const NON_WORD_EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;


export type CharacterCount = { characters: number; noSpaces: number };

export function countCharacters(text: string): CharacterCount {
	return {
		characters: codePointLength(text),
		// `\s` is the same whitespace class the word split uses, so "characters
		// without spaces" and the word count can never disagree about what a
		// space is.
		noSpaces: codePointLength(text.replace(/\s+/g, '')),
	};
}

/* --- segmentation -------------------------------------------------------- */

/**
 * Created once and kept: a Segmenter is stateless, so there is nothing to
 * invalidate, and re-creating one per keystroke would be pure waste. `destroy`
 * deliberately does NOT clear it, unlike the image tool's encoder-support cache,
 * which caches a *probe result* that could change with the page's lifetime.
 */
let cachedWordSegmenter: Intl.Segmenter | null = null;
let cachedSentenceSegmenter: Intl.Segmenter | null = null;
let segmenterProbed = false;

function wordSegmenter(): Intl.Segmenter | null {
	if (cachedWordSegmenter) return cachedWordSegmenter;
	if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
	try {
		// `undefined` locale: segment with the browser's own language, which is
		// the only sensible guess for text this tool knows nothing about.
		cachedWordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
	} catch {
		cachedWordSegmenter = null;
	}
	return cachedWordSegmenter;
}

function sentenceSegmenter(): Intl.Segmenter | null {
	if (cachedSentenceSegmenter) return cachedSentenceSegmenter;
	if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
	try {
		cachedSentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
	} catch {
		cachedSentenceSegmenter = null;
	}
	return cachedSentenceSegmenter;
}

/**
 * Whether this browser can split words properly. Exported because the UI has to
 * decide, before it offers the choice, whether the choice can be honoured.
 */
export function supportsWordSegmenter(): boolean {
	if (segmenterProbed) return cachedWordSegmenter !== null;
	segmenterProbed = true;
	return wordSegmenter() !== null;
}

/**
 * The space split, and the fallback for a browser with no segmenter.
 *
 * Tokens are trimmed of surrounding punctuation so that "«hello»" counts as
 * "hello" — otherwise the longest-word readout shows a word with quotes on it —
 * and a token that is nothing but punctuation drops out entirely.
 */
export function splitWordsByWhitespace(text: string): string[] {
	if (!text) return [];
	const words: string[] = [];
	for (const token of text.split(/\s+/)) {
		const trimmed = token.replace(NON_WORD_EDGE, '');
		if (trimmed.length > 0 && HAS_WORD_CHARACTER.test(trimmed)) words.push(trimmed);
	}
	return words;
}

/**
 * The segmenter split, or null when the browser has none — null rather than a
 * silent fallback, so the caller can say which engine produced the numbers.
 */
function segmentWords(text: string): string[] | null {
	const segmenter = wordSegmenter();
	if (!segmenter) return null;
	const words: string[] = [];
	let current = '';
	/** True only when the last thing seen was a joiner, so the word stays open. */
	let openByJoiner = false;
	const flush = () => {
		const trimmed = current.replace(TRAILING_JOINER, '');
		if (trimmed.length > 0) words.push(trimmed);
		current = '';
		openByJoiner = false;
	};
	for (const part of segmenter.segment(text)) {
		if (part.isWordLike) {
			/*
			 * Two word-like segments with nothing between them are TWO words: that
			 * is exactly what the segmenter is for in a script with no spaces, where
			 * "今日は良い天気です" is five words and not one. Gluing them would make
			 * this mode report fewer words than the space split, which is the one bug
			 * the mode exists to avoid.
			 */
			if (current.length > 0 && !openByJoiner) flush();
			current += part.segment;
			continue;
		}
		/*
		 * ICU reports "well-known" as word / hyphen / word, which would make this
		 * tool count two words where every other counter counts one. A joiner
		 * therefore keeps the word open; anything else — a space, a comma, a full
		 * stop — closes it.
		 */
		if (current.length > 0 && WORD_JOINER.test(part.segment)) {
			current += part.segment;
			openByJoiner = true;
			continue;
		}
		flush();
	}
	flush();
	return words;
}

export function splitWords(text: string, mode: ToolWordMode = 'segmenter'): string[] {
	if (!text) return [];
	if (mode === 'segmenter') {
		const segmented = segmentWords(text);
		if (segmented) return segmented;
	}
	return splitWordsByWhitespace(text);
}

/**
 * Sentences without a segmenter: split on terminators and line breaks. Both
 * engines end a sentence at "Mr.", so the fallback is not worse here — it is
 * simply the same opinion reached with a regular expression.
 */
export function splitSentencesByPunctuation(text: string): string[] {
	if (!text) return [];
	return text
		.split(/\s*[.!?…]+\s*|\n+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0 && HAS_WORD_CHARACTER.test(part));
}

export function splitSentences(text: string): string[] {
	if (!text.trim()) return [];
	const segmenter = sentenceSegmenter();
	if (!segmenter) return splitSentencesByPunctuation(text);
	const sentences: string[] = [];
	for (const part of segmenter.segment(text)) {
		const value = part.segment.trim();
		// A trailing "." with nothing before it is not a sentence, and neither is
		// a line of dashes.
		if (value.length > 0 && HAS_WORD_CHARACTER.test(value)) sentences.push(value);
	}
	return sentences;
}

/**
 * Newline-separated lines, the way an editor shows them — blank ones included.
 * A trailing newline ends the last line instead of starting an empty one.
 */
export function countLines(text: string): number {
	if (!text) return 0;
	const lines = text.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines.length;
}

/**
 * Blocks separated by a blank line, which is what a paragraph means in prose and
 * in Markdown. Single line breaks are NOT paragraph breaks, so a poem of twelve
 * lines is one paragraph — and `lines` above is there to say twelve.
 */
export function countParagraphs(text: string): number {
	if (!text) return 0;
	return text.split(/\n\s*\n+/).filter((block) => block.trim().length > 0).length;
}

/* --- the count itself ---------------------------------------------------- */

export type CountOptions = { mode?: ToolWordMode };

export type TextStats = {
	/** The mode that actually produced these numbers (never one the browser lacks). */
	mode: ToolWordMode;
	words: number;
	characters: number;
	charactersNoSpaces: number;
	sentences: number;
	paragraphs: number;
	lines: number;
	/** The longest word, or '' when there is none. First one wins a tie. */
	longestWord: string;
	/** Letters per word; 0 when there are no words. */
	averageWordLength: number;
	/** Words per sentence; 0 when there are no sentences. */
	averageSentenceLength: number;
	uniqueWords: number;
};

/** Every zero, so "nothing counted" is a real result rather than a special case. */
export function emptyStats(mode: ToolWordMode = 'segmenter'): TextStats {
	return countText('', { mode });
}

export function countText(text: string, options: CountOptions = {}): TextStats {
	const requested = options.mode ?? 'segmenter';
	const words = splitWords(text, requested);
	// Reported honestly: asking for the segmenter in a browser that has none
	// yields the space split, and the numbers say so.
	const mode: ToolWordMode =
		requested === 'segmenter' && !supportsWordSegmenter() ? 'whitespace' : requested;
	const characters = countCharacters(text);
	const sentences = splitSentences(text).length;

	let longestWord = '';
	let longestLength = 0;
	let letters = 0;
	const unique = new Set<string>();
	for (const word of words) {
		const length = codePointLength(word);
		if (length > longestLength) {
			longestLength = length;
			longestWord = word;
		}
		letters += length;
		unique.add(word.toLowerCase());
	}

	return {
		mode,
		words: words.length,
		characters: characters.characters,
		charactersNoSpaces: characters.noSpaces,
		sentences,
		paragraphs: countParagraphs(text),
		lines: countLines(text),
		longestWord,
		averageWordLength: words.length > 0 ? letters / words.length : 0,
		averageSentenceLength: sentences > 0 ? words.length / sentences : 0,
		uniqueWords: unique.size,
	};
}

/* --- keywords ------------------------------------------------------------ */

/** Lowercase and unquoted, so "Hello," "hello" and "«hello»" are one keyword. */
export function normaliseKeyword(word: string): string {
	return word.toLowerCase().replace(NON_WORD_EDGE, '');
}

export type TopWordsOptions = {
	mode?: ToolWordMode;
	/** 0 turns the list off. */
	limit?: number;
	ignoreStopwords?: boolean;
	minLength?: number;
};

export type Keyword = {
	word: string;
	count: number;
	/** Percent of EVERY word in the text, stopwords included, so the shares mean something. */
	share: number;
};

export function topWords(text: string, options: TopWordsOptions = {}): Keyword[] {
	const limit = clampKeywordLimit(options.limit);
	if (limit <= 0 || !text) return [];
	const ignoreStopwords = options.ignoreStopwords ?? true;
	const minLength = options.minLength ?? TOOL_WORDS_CONFIG.minKeywordLength;
	const words = splitWords(text, options.mode ?? 'segmenter');
	if (words.length === 0) return [];

	const counts = new Map<string, number>();
	for (const raw of words) {
		const word = normaliseKeyword(raw);
		if (codePointLength(word) < minLength) continue;
		if (ignoreStopwords && WORD_STOPWORDS.includes(word)) continue;
		counts.set(word, (counts.get(word) ?? 0) + 1);
	}

	return [...counts.entries()]
		.map(([word, count]) => ({ word, count, share: (count / words.length) * 100 }))
		// Count first, then A→Z: a Map keeps insertion order, which would make
		// the list depend on where in the text a word happened to appear first.
		.sort((left, right) => right.count - left.count || left.word.localeCompare(right.word))
		.slice(0, limit);
}

function clampKeywordLimit(value: number | undefined): number {
	const { min, max, default: fallback } = TOOL_WORDS_CONFIG.keywords;
	if (value === undefined || !Number.isFinite(value)) return fallback;
	// 0 is allowed on purpose: it means "no keyword list".
	return Math.min(max, Math.max(0, Math.round(value)));
}

/* --- durations and formatting -------------------------------------------- */

export type TimeEstimate = { minutes: number; label: string };

/**
 * A duration in words a visitor can read at a glance. Sub-minute counts say
 * "under a minute" rather than "0 min", and anything from an hour up is broken
 * into hours and minutes.
 */
export function formatMinutes(minutes: number): string {
	if (!Number.isFinite(minutes) || minutes <= 0) return '—';
	const rounded = Math.round(minutes);
	if (rounded === 0) return 'under a minute';
	if (rounded < 60) return `${rounded} min`;
	const hours = Math.floor(rounded / 60);
	const rest = rounded % 60;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * The word count divided by a pace — an estimate, and the pace is printed beside
 * it wherever this label appears, so it never reads as a measurement.
 *
 * Zero words is an em dash: text that does not exist has no reading time, and
 * "0 min" invites the visitor to think the tool measured something.
 */
export function estimateTime(words: number, wordsPerMinute: number): TimeEstimate {
	if (!Number.isFinite(words) || words <= 0) return { minutes: 0, label: '—' };
	if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) return { minutes: 0, label: '—' };
	const minutes = words / wordsPerMinute;
	return { minutes, label: formatMinutes(minutes) };
}

/** Averages read with one decimal, and an average of nothing is an em dash. */
export function formatAverage(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return '—';
	return value.toFixed(1);
}

/** A share under 10% needs its decimal to be worth reading. */
export function formatShare(percent: number): string {
	if (!Number.isFinite(percent) || percent <= 0) return '0%';
	return `${percent < 10 ? percent.toFixed(1) : String(Math.round(percent))}%`;
}

/* --- refusals ------------------------------------------------------------ */

/**
 * Refuse a text before it is segmented, and say why in the visitor's terms.
 * Half a million characters is a 90,000-word book; past that a single keystroke
 * would re-segment it on a phone and the tab would stop answering.
 */
export function checkInputText(text: string): ToolCheck {
	const characters = codePointLength(text);
	const limit = TOOL_WORDS_CONFIG.maxInputCharacters;
	if (characters > limit) {
		return {
			ok: false,
			message: `That is ${formatCount(characters)} characters, over this tool's ${formatCount(limit)}-character limit, so nothing was counted — segmenting it would stall the tab.`,
		};
	}
	return { ok: true };
}


/* --- the clipboard summary ----------------------------------------------- */

export type SummaryOptions = {
	readingWpm: number;
	speakingWpm: number;
	keywords?: readonly Keyword[];
	sourceName?: string | null;
};

/**
 * The plain-text block the copy button puts on the clipboard, built from the same
 * `TextStats` the panel was rendered from — one source of numbers, so what a
 * visitor reads and what they paste cannot disagree.
 */
export function summaryText(stats: TextStats, options: SummaryOptions): string {
	const lines: string[] = [];
	if (options.sourceName) lines.push(`Source: ${options.sourceName}`);
	lines.push(`Words: ${formatCount(stats.words)}`);
	lines.push(
		`Characters: ${formatCount(stats.characters)} (${formatCount(stats.charactersNoSpaces)} without spaces)`,
	);
	lines.push(
		`Sentences: ${formatCount(stats.sentences)} · Paragraphs: ${formatCount(stats.paragraphs)} · Lines: ${formatCount(stats.lines)}`,
	);
	lines.push(
		`Reading time: ${estimateTime(stats.words, options.readingWpm).label} at ${formatCount(options.readingWpm)} wpm`,
	);
	lines.push(
		`Speaking time: ${estimateTime(stats.words, options.speakingWpm).label} at ${formatCount(options.speakingWpm)} wpm`,
	);
	lines.push(
		stats.longestWord
			? `Longest word: ${stats.longestWord} (${formatCount(codePointLength(stats.longestWord))} characters)`
			: 'Longest word: —',
	);
	lines.push(
		`Average word: ${formatAverage(stats.averageWordLength)} letters · Average sentence: ${formatAverage(stats.averageSentenceLength)} words`,
	);
	const keywords = options.keywords ?? [];
	// The line is omitted rather than printed empty: a summary that ends in
	// "Most frequent:" is a promise the tool did not keep.
	if (keywords.length > 0) {
		lines.push(`Most frequent: ${keywords.map((entry) => `${entry.word} (${formatCount(entry.count)})`).join(', ')}`);
	}
	return lines.join('\n');
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
/** Set by init, cleared by destroy — the one place the tool is released. */
let teardown: (() => void) | null = null;

export function initWordCounter(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-word-counter]');
	if (!root) return;
	started = true;

	// One signal for every listener, the way tools-image.ts does it: a teardown is
	// then a single abort() instead of a list of removeEventListener calls that
	// can drift out of sync with the bindings.
	const controller = new AbortController();
	const { signal } = controller;

	const textInput = root.querySelector<HTMLTextAreaElement>('[data-word-text]');
	const limitReadout = root.querySelector<HTMLElement>('[data-word-limit]');
	const dropZone = root.querySelector<HTMLElement>('[data-word-drop]');
	const fileInput = root.querySelector<HTMLInputElement>('[data-word-source]');
	const sourceMeta = root.querySelector<HTMLElement>('[data-word-source-meta]');
	/*
	 * The mode select is typed through a structural alias on purpose: this DOM
	 * lib declares HTMLSelectElement#remove() as returning void, which makes
	 * HTMLSelectElement structurally incompatible with Element, so
	 * querySelector<HTMLSelectElement> does not typecheck. Same workaround as
	 * tools-image.ts's format select.
	 */
	const modeSelect = root.querySelector('[data-word-mode]') as
		| (HTMLElement & { value: string; disabled: boolean })
		| null;
	const modeHint = root.querySelector<HTMLElement>('[data-word-mode-hint]');
	const readingInput = root.querySelector<HTMLInputElement>('[data-word-reading]');
	const readingValue = root.querySelector<HTMLElement>('[data-word-reading-value]');
	const speakingInput = root.querySelector<HTMLInputElement>('[data-word-speaking]');
	const speakingValue = root.querySelector<HTMLElement>('[data-word-speaking-value]');
	const keywordLimitInput = root.querySelector<HTMLInputElement>('[data-word-keywords]');
	const stopwordsInput = root.querySelector<HTMLInputElement>('[data-word-stopwords]');
	const countButton = root.querySelector<HTMLButtonElement>('[data-word-count]');
	const copyButton = root.querySelector<HTMLButtonElement>('[data-word-copy]');
	const resetButton = root.querySelector<HTMLButtonElement>('[data-word-reset]');
	const statusLine = root.querySelector<HTMLElement>('[data-word-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-word-error]');
	const results = root.querySelector<HTMLElement>('[data-word-results]');
	const statWords = root.querySelector<HTMLElement>('[data-word-words]');
	const statCharacters = root.querySelector<HTMLElement>('[data-word-characters]');
	const statCharactersNoSpaces = root.querySelector<HTMLElement>('[data-word-characters-no-space]');
	const statSentences = root.querySelector<HTMLElement>('[data-word-sentences]');
	const statParagraphs = root.querySelector<HTMLElement>('[data-word-paragraphs]');
	const statLines = root.querySelector<HTMLElement>('[data-word-lines]');
	const statReadingTime = root.querySelector<HTMLElement>('[data-word-reading-time]');
	const statSpeakingTime = root.querySelector<HTMLElement>('[data-word-speaking-time]');
	const statUnique = root.querySelector<HTMLElement>('[data-word-unique]');
	const statLongest = root.querySelector<HTMLElement>('[data-word-longest]');
	const statAverageWord = root.querySelector<HTMLElement>('[data-word-average-word]');
	const statAverageSentence = root.querySelector<HTMLElement>('[data-word-average-sentence]');
	const keywordList = root.querySelector<HTMLOListElement>('[data-word-keyword-list]');
	const keywordsNone = root.querySelector<HTMLElement>('[data-word-keywords-none]');

	/* --- state ----------------------------------------------------------- */

	let stats: TextStats | null = null;
	let keywords: Keyword[] = [];
	/** The file the textarea currently holds, if it came from one. */
	let sourceName: string | null = null;
	let busy = false;
	/**
	 * Bumped by every load and reset. Reading a file is asynchronous, so a second
	 * drop — or a Reset — can land while one is still being decoded; whichever
	 * arrives last owns the tool, and the loser must not write its text over the
	 * winner's.
	 */
	let generation = 0;
	let recountTimer: number | undefined;

	/* --- small view helpers --------------------------------------------- */

	const setStatus = (message: string) => {
		if (statusLine) statusLine.textContent = message;
	};

	const showError = (message: string) => {
		if (errorLine) {
			errorLine.textContent = message;
			errorLine.hidden = false;
		}
		setStatus('Nothing counted.');
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const setBusy = (value: boolean) => {
		busy = value;
		if (countButton) countButton.disabled = value;
		if (resetButton) resetButton.disabled = value;
		if (copyButton) copyButton.disabled = value || stats === null;
		if (statusLine) statusLine.dataset.busy = value ? 'true' : 'false';
	};

	const currentText = (): string => textInput?.value ?? '';

	const currentMode = (): ToolWordMode => {
		/*
		 * The select's value is not trusted on its own: a browser with no
		 * segmenter cannot be talked into using one, whatever the DOM says.
		 */
		if (!supportsWordSegmenter()) return 'whitespace';
		return modeSelect?.value === 'whitespace' ? 'whitespace' : 'segmenter';
	};

	const readingWpm = (): number => clampPace(readingInput?.value, TOOL_WORDS_CONFIG.reading);
	const speakingWpm = (): number => clampPace(speakingInput?.value, TOOL_WORDS_CONFIG.speaking);

	/**
	 * An empty field is "whatever the default is", not zero: clearing a number
	 * input mid-edit must not switch the keyword list off, which is what
	 * `Number('') === 0` would do.
	 */
	const keywordLimit = (): number | undefined => {
		const raw = keywordLimitInput?.value ?? '';
		return raw.trim() === '' ? undefined : Number(raw);
	};

	const keywordOptions = (): TopWordsOptions => ({
		mode: currentMode(),
		limit: keywordLimit(),
		ignoreStopwords: stopwordsInput?.checked ?? true,
	});

	const renderLimit = (characters: number) => {
		if (!limitReadout) return;
		limitReadout.textContent = `${formatCount(characters)} / ${formatCount(TOOL_WORDS_CONFIG.maxInputCharacters)} characters`;
		// Over the limit is a state, not an event: the readout stays red until the
		// text shrinks, so the visitor can see how far over they are.
		limitReadout.dataset.over = characters > TOOL_WORDS_CONFIG.maxInputCharacters ? 'true' : 'false';
	};

	/** Pace labels and the two time cells — the only things a pace slider moves. */
	const renderPaces = () => {
		const reading = readingWpm();
		const speaking = speakingWpm();
		if (readingValue) readingValue.textContent = `${formatCount(reading)} wpm`;
		if (speakingValue) speakingValue.textContent = `${formatCount(speaking)} wpm`;
		const words = stats?.words ?? 0;
		if (statReadingTime) statReadingTime.textContent = estimateTime(words, reading).label;
		if (statSpeakingTime) statSpeakingTime.textContent = estimateTime(words, speaking).label;
	};

	const renderKeywords = (entries: readonly Keyword[], words: number) => {
		if (!keywordList) return;
		keywordList.replaceChildren();
		if (!keywordsNone) return;
		if (entries.length === 0) {
			keywordsNone.hidden = false;
			/*
			 * Three different empties, and each needs its own words: no text yet,
			 * a list the visitor switched off, and text where every word is on the
			 * common-words list. One generic "nothing here" would send them looking
			 * for a bug that is not there.
			 */
			if (words === 0) keywordsNone.textContent = 'Nothing to list yet.';
			else if (clampKeywordLimit(keywordLimit()) === 0)
				keywordsNone.textContent = 'The keyword list is off — “how many words” is 0.';
			else
				keywordsNone.textContent =
					'Every word here is a short or common English word — switch “ignore common words” off to list them.';
			return;
		}
		keywordsNone.hidden = true;
		for (const entry of entries) {
			const item = document.createElement('li');
			item.className = 'tool__keyword';
			const word = document.createElement('span');
			word.className = 'tool__keyword-word';
			word.textContent = entry.word;
			const count = document.createElement('span');
			count.className = 'tool__keyword-count mono';
			count.textContent = `${formatCount(entry.count)} × · ${formatShare(entry.share)}`;
			item.appendChild(word);
			item.appendChild(count);
			keywordList.appendChild(item);
		}
	};

	/** The only writer of the stat cells, and of `stats` itself. */
	const render = (next: TextStats, nextKeywords: readonly Keyword[], visible: boolean) => {
		stats = next;
		keywords = [...nextKeywords];
		const write = (cell: HTMLElement | null, value: string) => {
			if (cell) cell.textContent = value;
		};
		write(statWords, formatCount(next.words));
		write(statCharacters, formatCount(next.characters));
		write(statCharactersNoSpaces, formatCount(next.charactersNoSpaces));
		write(statSentences, formatCount(next.sentences));
		write(statParagraphs, formatCount(next.paragraphs));
		write(statLines, formatCount(next.lines));
		write(statUnique, formatCount(next.uniqueWords));
		write(statLongest, next.longestWord || '—');
		write(statAverageWord, formatAverage(next.averageWordLength));
		write(statAverageSentence, formatAverage(next.averageSentenceLength));
		renderPaces();
		renderKeywords(nextKeywords, next.words);
		if (results) results.hidden = !visible;
		if (copyButton) copyButton.disabled = busy || !visible;
	};

	/**
	 * Back to every-zero, results hidden. `emptyStats()` is rendered rather than
	 * each cell being cleared by hand, so the empty panel and a counted panel are
	 * written by the same code and cannot drift.
	 */
	const clearStats = () => {
		render(emptyStats(currentMode()), [], false);
		stats = null;
		if (copyButton) copyButton.disabled = true;
	};

	const syncModeControls = () => {
		const mode = currentMode();
		if (modeHint) {
			modeHint.textContent = supportsWordSegmenter() ? WORD_MODE_HINT[mode] : WORD_MODE_UNAVAILABLE_HINT;
		}
	};

	const reset = () => {
		generation += 1;
		if (recountTimer !== undefined) {
			window.clearTimeout(recountTimer);
			recountTimer = undefined;
		}
		if (textInput) textInput.value = '';
		if (fileInput) fileInput.value = '';
		// The select is only reset where it is the visitor's to move.
		if (modeSelect && supportsWordSegmenter()) modeSelect.value = 'segmenter';
		if (readingInput) readingInput.value = String(TOOL_WORDS_CONFIG.reading.default);
		if (speakingInput) speakingInput.value = String(TOOL_WORDS_CONFIG.speaking.default);
		if (keywordLimitInput) keywordLimitInput.value = String(TOOL_WORDS_CONFIG.keywords.default);
		if (stopwordsInput) stopwordsInput.checked = true;
		sourceName = null;
		if (sourceMeta) sourceMeta.textContent = '';
		clearError();
		clearStats();
		renderLimit(0);
		setBusy(false);
		syncModeControls();
		setStatus('Type or paste text. Nothing leaves this tab.');
	};

	/* --- the pipeline ---------------------------------------------------- */

	/** Returns whether the text was actually counted — a refusal says why itself. */
	const recount = (options: { announce?: boolean } = {}): boolean => {
		if (busy) return false;
		const text = currentText();
		const check = checkInputText(text);
		renderLimit(codePointLength(text));
		if (!check.ok) {
			/*
			 * The numbers are cleared rather than left up: unlike the image tool,
			 * where a refused drop leaves the previous conversion on screen, here
			 * the refused text IS what the visitor is looking at, so a surviving
			 * count would describe text that is no longer in the box.
			 */
			clearStats();
			showError(check.message);
			return false;
		}
		clearError();
		const visible = text.trim().length > 0;
		const next = countText(text, { mode: currentMode() });
		const nextKeywords = visible ? topWords(text, keywordOptions()) : [];
		render(next, nextKeywords, visible);
		if (options.announce) {
			setStatus(
				visible
					? `Counted ${formatCount(next.words)} words and ${formatCount(next.characters)} characters.`
					: 'Nothing to count yet.',
			);
		}
		return true;
	};

	/** Keystrokes are coalesced, so a fast typist is not re-segmented per key. */
	const scheduleRecount = () => {
		if (recountTimer !== undefined) window.clearTimeout(recountTimer);
		recountTimer = window.setTimeout(() => {
			recountTimer = undefined;
			recount();
		}, TOOL_WORDS_CONFIG.recountDelayMs);
	};

	const load = async (file: TextFile) => {
		clearError();
		const check = checkTextFile(file);
		if (!check.ok) {
			showError(check.message);
			return;
		}
		if (typeof file.text !== 'function') {
			showError(
				'This browser cannot read a file as text (File.text is unavailable), so the file was not loaded.',
			);
			return;
		}

		// Claim the slot BEFORE the first await (see `generation` above).
		const token = (generation += 1);
		setBusy(true);
		setStatus(`Reading ${file.name}…`);

		let text: string;
		try {
			text = await file.text();
		} catch {
			if (token !== generation) return;
			setBusy(false);
			showError(`Could not read “${file.name}”. The browser refused to decode it as text.`);
			return;
		}
		// Superseded mid-read: this text belongs to nobody, and the textarea is
		// left holding whatever the winner put there.
		if (token !== generation) return;

		if (textInput) textInput.value = text;
		sourceName = file.name;
		if (sourceMeta) {
			sourceMeta.textContent = `${file.name} · ${file.type || 'text'} · ${formatBytes(file.size)}`;
		}
		setBusy(false);
		// A file can pass the byte check and still break the character limit (2 MB
		// of four-byte UTF-8 is over half a million characters). When it does,
		// recount has already said so — a "Loaded …" line on top of that error
		// would read as a success.
		if (!recount()) return;
		if (token !== generation) return;

		const mojibake = looksLikeMojibake(text)
			? ' It does not look like UTF-8 text, so those characters may be mojibake.'
			: '';
		setStatus(
			`Loaded ${file.name} — ${formatBytes(file.size)}, ${formatCount(stats?.words ?? 0)} words.${mojibake}`,
		);
	};

	const copy = async () => {
		if (!stats) return;
		const summary = summaryText(stats, {
			readingWpm: readingWpm(),
			speakingWpm: speakingWpm(),
			keywords,
			sourceName,
		});
		// No clipboard API is not a failed copy, it is no copy: say so, and
		// point at the panel instead of pretending.
		const outcome = await copyText(summary);
		if (outcome === 'unavailable') {
			setStatus(`${COPY_UNAVAILABLE} The numbers above are the summary.`);
			return;
		}
		if (outcome === 'refused') {
			setStatus(`${COPY_REFUSED} Read the numbers from the panel above.`);
			return;
		}
		setStatus(
			`Summary copied — ${formatCount(stats.words)} words, ${formatCount(stats.characters)} characters.`,
		);
	};

	/* --- events ---------------------------------------------------------- */

	textInput?.addEventListener('input', scheduleRecount, { signal });

	fileInput?.addEventListener(
		'change',
		() => {
			const file = fileInput.files?.[0];
			if (file) void load(file);
		},
		{ signal },
	);

	modeSelect?.addEventListener(
		'change',
		() => {
			syncModeControls();
			scheduleRecount();
		},
		{ signal },
	);

	/*
	 * A pace slider changes two cells, not the text, so it is applied directly:
	 * re-segmenting half a million characters because a slider moved would be a
	 * jank the visitor caused without doing anything to their text.
	 */
	readingInput?.addEventListener('input', renderPaces, { signal });
	speakingInput?.addEventListener('input', renderPaces, { signal });

	keywordLimitInput?.addEventListener('input', scheduleRecount, { signal });
	stopwordsInput?.addEventListener('change', scheduleRecount, { signal });

	countButton?.addEventListener(
		'click',
		() => recount({ announce: true }),
		{ signal },
	);
	copyButton?.addEventListener('click', () => void copy(), { signal });
	resetButton?.addEventListener('click', reset, { signal });

	// Drag and drop is the other way in. dragover must be cancelled or the
	// browser navigates to the dropped file instead of handing it over.
	dropZone?.addEventListener(
		'dragover',
		(event) => {
			event.preventDefault();
			if (dropZone) dropZone.dataset.dragOver = 'true';
		},
		{ signal },
	);
	dropZone?.addEventListener(
		'dragleave',
		() => {
			if (dropZone) dropZone.dataset.dragOver = 'false';
		},
		{ signal },
	);
	dropZone?.addEventListener(
		'drop',
		(event) => {
			event.preventDefault();
			if (dropZone) dropZone.dataset.dragOver = 'false';
			const file = event.dataTransfer?.files?.[0];
			if (file) void load(file);
		},
		{ signal },
	);

	// Leaving the page is the last release path: a half-typed manuscript should
	// not survive in a textarea that is about to be thrown away with a pending
	// debounce timer pointing at it.
	window.addEventListener('pagehide', reset, { signal });

	teardown = () => {
		controller.abort();
		if (recountTimer !== undefined) window.clearTimeout(recountTimer);
		recountTimer = undefined;
		reset();
	};

	syncModeControls();
	/*
	 * A browser that cannot segment words gets the mode it can actually have,
	 * pinned and disabled with the reason in the hint — not a select that offers
	 * a choice the tool cannot deliver.
	 */
	if (!supportsWordSegmenter() && modeSelect) {
		modeSelect.value = 'whitespace';
		modeSelect.disabled = true;
	}
	clearStats();
	setBusy(false);
	renderLimit(0);
	renderPaces();
	setStatus('Type or paste text. Nothing leaves this tab.');
}

/**
 * Release every listener this tool owns, empty the textarea and re-arm the init,
 * so a second call binds a fresh subtree. Used by the tests and by anything that
 * ever swaps the page's content without a reload.
 *
 * The segmenter cache is deliberately kept: it holds real objects, not probe
 * results, so there is nothing stale to throw away.
 */
export function destroyWordCounter(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}

/** Pace sliders are clamped to their configured domain, whatever the DOM says. */
function clampPace(
	raw: string | number | undefined,
	domain: { min: number; max: number; default: number },
): number {
	const value = Number(raw ?? domain.default);
	if (!Number.isFinite(value)) return domain.default;
	return Math.min(domain.max, Math.max(domain.min, Math.round(value)));
}
