/**
 * BNJI.NET — the /projects/tools/ word counter's decisions.
 *
 * A browser cannot be started here, so this file covers everything that is pure
 * — what counts as a word, what counts as a sentence, how a duration is worded,
 * what gets refused before it is counted — and then drives the real controller
 * against the DOM shim for the parts only a controller can get wrong: the
 * debounce, the release path, a pace slider that must not re-segment the text,
 * an over-limit paste that must not leave stale numbers on screen, and a copy
 * button that must never claim a copy the clipboard refused.
 *
 * The refusals and the disagreements are the point. A counter that splits on
 * spaces reports ONE word for a whole Japanese sentence, and a counter that
 * says "copied" when the write failed has lied about the only thing it did.
 *
 * The no-segmenter branch (a browser without Intl.Segmenter, which loses the
 * choice and says why) cannot be reached from this file: the module probes once
 * and caches, as a browser only ever answers once. It has its own file,
 * tests/tools-words-fallback.test.ts, which runs in its own process with the
 * segmenter deleted before the module is imported.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import { TOOL_WORDS_CONFIG } from '../src/config/tools.config.ts';
import {
	checkInputText,
	checkTextFile,
	codePointLength,
	countCharacters,
	countLines,
	countParagraphs,
	countText,
	emptyStats,
	estimateTime,
	formatAverage,
	formatCount,
	formatMinutes,
	formatShare,
	isTextFile,
	looksLikeMojibake,
	normaliseKeyword,
	splitSentences,
	splitSentencesByPunctuation,
	splitWords,
	splitWordsByWhitespace,
	summaryText,
	supportsWordSegmenter,
	topWords,
} from '../src/scripts/tools-words.ts';

type Dom = ReturnType<typeof installTestDom>;
type WordsModule = typeof import('../src/scripts/tools-words.ts');

let wordsModule: WordsModule | null = null;

async function words(): Promise<WordsModule> {
	if (!wordsModule) wordsModule = await import('../src/scripts/tools-words.ts');
	return wordsModule;
}

/** The counter's markup, mirroring src/components/tools/WordCounter.astro. */
function buildCounter(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-word-counter', '');

	const hooks: Record<string, string> = {
		'data-word-text': 'textarea',
		'data-word-limit': 'span',
		'data-word-drop': 'label',
		'data-word-source': 'input',
		'data-word-source-meta': 'p',
		'data-word-mode': 'select',
		'data-word-mode-hint': 'p',
		'data-word-reading': 'input',
		'data-word-reading-value': 'span',
		'data-word-speaking': 'input',
		'data-word-speaking-value': 'span',
		'data-word-keywords': 'input',
		'data-word-stopwords': 'input',
		'data-word-count': 'button',
		'data-word-copy': 'button',
		'data-word-reset': 'button',
		'data-word-status': 'p',
		'data-word-error': 'p',
		'data-word-results': 'div',
		'data-word-words': 'dd',
		'data-word-characters': 'dd',
		'data-word-characters-no-space': 'dd',
		'data-word-sentences': 'dd',
		'data-word-paragraphs': 'dd',
		'data-word-lines': 'dd',
		'data-word-reading-time': 'dd',
		'data-word-speaking-time': 'dd',
		'data-word-unique': 'dd',
		'data-word-longest': 'dd',
		'data-word-average-word': 'dd',
		'data-word-average-sentence': 'dd',
		'data-word-keyword-list': 'ol',
		'data-word-keywords-none': 'p',
	};
	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}
	// The controls the controller reads defaults from. The component renders these
	// as real attributes; a fixture without them would silently test the fallbacks.
	section.querySelector('[data-word-error]').hidden = true;
	section.querySelector('[data-word-results]').hidden = true;
	section.querySelector('[data-word-stopwords]').checked = true;
	section.querySelector('[data-word-keywords]').value = String(TOOL_WORDS_CONFIG.keywords.default);
	section.querySelector('[data-word-reading]').value = String(TOOL_WORDS_CONFIG.reading.default);
	section.querySelector('[data-word-speaking]').value = String(TOOL_WORDS_CONFIG.speaking.default);

	document.body.appendChild(section);
}

/** Install the shim, build the fixture, init the controller, and always tear down. */
async function withCounter(run: (dom: Dom) => void | Promise<void>): Promise<void> {
	const dom = installTestDom();
	buildCounter(dom);
	const { initWordCounter, destroyWordCounter } = await words();
	initWordCounter();
	try {
		await run(dom);
	} finally {
		destroyWordCounter();
	}
}

const fire = (element: { dispatchEvent: (event: Record<string, unknown>) => unknown }, type: string, extra = {}) =>
	element.dispatchEvent({ type, preventDefault: () => {}, ...extra });

/** Type into the box and let the debounce elapse. */
function type(dom: Dom, text: string, settle = true): void {
	const box = dom.q('[data-word-text]');
	box.value = text;
	fire(box, 'input');
	if (settle) dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
}

const stat = (dom: Dom, hook: string): string => dom.q(`[${hook}]`)?.textContent ?? '';
const status = (dom: Dom): string => dom.q('[data-word-status]')?.textContent ?? '';
const error = (dom: Dom): string => dom.q('[data-word-error]')?.textContent ?? '';

const PASSAGE = 'Hello world. This is a test.\n\nSecond paragraph here.';
const JAPANESE = '今日は良い天気です。明日も晴れるでしょう。';

/* --- what a word is ------------------------------------------------------- */

test('the segmenter counts a script with no spaces; the space split cannot', () => {
	// This is the whole reason the mode exists: two Japanese sentences with no
	// spaces in them are ONE token to a split on whitespace.
	assert.ok(supportsWordSegmenter(), 'this runtime has Intl.Segmenter');
	assert.equal(splitWords(JAPANESE, 'whitespace').length, 1);
	assert.ok(splitWords(JAPANESE, 'segmenter').length > 5, 'the segmenter finds the words inside it');
	// And the numbers say which engine produced them.
	assert.equal(countText(JAPANESE, { mode: 'whitespace' }).words, 1);
	assert.ok(countText(JAPANESE, { mode: 'segmenter' }).words > 5);
});

test('both modes agree on ordinary English, punctuation included', () => {
	const text = '“Well-known,” she said — don’t you agree? (Yes.)';
	const segmented = splitWords(text, 'segmenter');
	const spaced = splitWords(text, 'whitespace');
	assert.deepEqual(segmented, spaced, 'two modes of one tool must not disagree about English');
	assert.deepEqual(segmented, ['Well-known', 'she', 'said', 'don’t', 'you', 'agree', 'Yes']);
});

test('a hyphen or apostrophe inside a word keeps the word together', () => {
	assert.deepEqual(splitWords('well-known'), ['well-known']);
	assert.deepEqual(splitWords('2024–2025'), ['2024–2025']);
	assert.deepEqual(splitWords('don’t'), ['don’t']);
	// …but a hyphen BETWEEN two words is two words, and a trailing one is noise.
	assert.deepEqual(splitWords('well - known'), ['well', 'known']);
	assert.deepEqual(splitWords('hello-'), ['hello']);
});

test('punctuation and symbols are not words', () => {
	for (const mode of ['segmenter', 'whitespace'] as const) {
		assert.deepEqual(splitWords('--- ••• …… !? —', mode), [], mode);
	}
	assert.deepEqual(splitWordsByWhitespace('«hello», (world!)'), ['hello', 'world']);
});

test('empty and whitespace-only text has no words', () => {
	assert.deepEqual(splitWords(''), []);
	assert.deepEqual(splitWords('   \n\t '), []);
	assert.equal(normaliseKeyword('“Hello,”'), 'hello');
});

/* --- sentences, paragraphs, lines ----------------------------------------- */

test('a sentence ends at a terminator or a line break', () => {
	assert.deepEqual(splitSentences('One. Two! Three?\nFour'), ['One.', 'Two!', 'Three?', 'Four']);
	assert.deepEqual(splitSentences(''), []);
	assert.deepEqual(splitSentences('   '), []);
	// A line of dashes is not a sentence, and neither is a stray full stop.
	assert.deepEqual(splitSentences('---'), []);
});

test('the punctuation fallback agrees on plain prose', () => {
	const text = 'One. Two! Three?\nFour';
	assert.equal(splitSentencesByPunctuation(text).length, splitSentences(text).length);
	assert.deepEqual(splitSentencesByPunctuation(text), ['One', 'Two', 'Three', 'Four']);
});

test('a paragraph is a blank-line-separated block, a line is what an editor shows', () => {
	assert.equal(countParagraphs('a\nb\n\nc'), 2);
	assert.equal(countParagraphs('a\r\n\r\nb'), 2, 'Windows line breaks are still line breaks');
	assert.equal(countParagraphs(''), 0);
	assert.equal(countParagraphs('   \n  '), 0, 'whitespace is not a paragraph');

	assert.equal(countLines(''), 0);
	assert.equal(countLines('a'), 1);
	assert.equal(countLines('a\nb'), 2);
	assert.equal(countLines('a\nb\n'), 2, 'a trailing newline ends a line, it does not start one');
	assert.equal(countLines('a\n\nb'), 3, 'blank lines are lines');
});

/* --- characters ----------------------------------------------------------- */

test('a character is a code point, not a UTF-16 unit', () => {
	assert.equal(codePointLength('🙂'), 1);
	assert.equal('🙂'.length, 2, 'which is exactly what String#length would have got wrong');
	assert.deepEqual(countCharacters('a🙂b'), { characters: 3, noSpaces: 3 });
	assert.deepEqual(countCharacters('a b'), { characters: 3, noSpaces: 2 });
	assert.deepEqual(countCharacters(''), { characters: 0, noSpaces: 0 });
});

/* --- the count ------------------------------------------------------------ */

test('a short passage counts the way a person would', () => {
	const stats = countText(PASSAGE);
	assert.equal(stats.words, 9);
	assert.equal(stats.characters, PASSAGE.length);
	assert.equal(stats.charactersNoSpaces, 43);
	assert.equal(stats.sentences, 3);
	assert.equal(stats.paragraphs, 2);
	assert.equal(stats.lines, 3);
	assert.equal(stats.longestWord, 'paragraph');
	assert.equal(stats.uniqueWords, 9);
	assert.equal(stats.averageWordLength, 40 / 9);
	assert.equal(stats.averageSentenceLength, 3);
	assert.equal(stats.mode, 'segmenter');
});

test('empty text is all zeros, and the averages do not divide by nothing', () => {
	const stats = emptyStats();
	assert.deepEqual(stats, {
		mode: 'segmenter',
		words: 0,
		characters: 0,
		charactersNoSpaces: 0,
		sentences: 0,
		paragraphs: 0,
		lines: 0,
		longestWord: '',
		averageWordLength: 0,
		averageSentenceLength: 0,
		uniqueWords: 0,
	});
	assert.equal(Number.isFinite(stats.averageWordLength), true);
	assert.equal(Number.isFinite(stats.averageSentenceLength), true);
});

test('the longest word wins on length, ties going to the first', () => {
	assert.equal(countText('cat dogbird elephant').longestWord, 'elephant');
	assert.equal(countText('abcd wxyz').longestWord, 'abcd');
});

/* --- keywords ------------------------------------------------------------- */

test('common words are skipped by default and listed when asked', () => {
	const text = 'the cat and the dog and the bird';
	const filtered = topWords(text);
	assert.deepEqual(filtered.map((entry) => entry.word), ['bird', 'cat', 'dog']);
	const unfiltered = topWords(text, { ignoreStopwords: false });
	assert.deepEqual(unfiltered.map((entry) => entry.word), ['the', 'and', 'bird', 'cat', 'dog']);
	assert.equal(unfiltered[0]?.count, 3);
});

test('the list is ordered by count, then alphabetically', () => {
	const list = topWords('beta alpha beta gamma gamma delta delta delta');
	assert.deepEqual(
		list.map((entry) => `${entry.word}:${entry.count}`),
		['delta:3', 'beta:2', 'gamma:2', 'alpha:1'],
	);
});

test('a share is a percent of every word, stopwords included', () => {
	// 8 words, 3 of them "the": the share of "the" is of the whole text, not of
	// the listed words, or the percentages would not add up to anything.
	const list = topWords('the cat and the dog and the bird', { ignoreStopwords: false });
	assert.equal(list[0]?.share, 37.5);
});

test('a limit of 0 switches the list off, and the limit is honoured', () => {
	assert.deepEqual(topWords('hello world again there', { limit: 0 }), []);
	assert.equal(topWords('alpha beta gamma delta epsilon zeta', { limit: 3 }).length, 3);
	// An empty field arrives as NaN and must mean "the default", not "off".
	assert.equal(topWords('hello world', { limit: Number.NaN }).length, 2);
	assert.deepEqual(topWords(''), []);
});

test('case, quotes and short tokens do not make a keyword', () => {
	assert.deepEqual(topWords('“Hello,” hello! Hello?'), [{ word: 'hello', count: 3, share: 100 }]);
	// "I" is one character: below the floor, so it is noise rather than a keyword.
	assert.deepEqual(topWords('I am ok', { ignoreStopwords: false }).map((entry) => entry.word), ['am', 'ok']);
});

/* --- durations and formatting --------------------------------------------- */

test('a duration reads as words, not decimals', () => {
	assert.equal(formatMinutes(0), '—');
	assert.equal(formatMinutes(Number.NaN), '—');
	assert.equal(formatMinutes(0.4), 'under a minute');
	assert.equal(formatMinutes(5), '5 min');
	assert.equal(formatMinutes(59.6), '1 h', 'rounding must not produce "60 min"');
	assert.equal(formatMinutes(125), '2 h 5 min');
	assert.equal(formatMinutes(120), '2 h');
});

test('no words and no usable pace both mean no time at all', () => {
	assert.deepEqual(estimateTime(0, 238), { minutes: 0, label: '—' });
	assert.deepEqual(estimateTime(500, 0), { minutes: 0, label: '—' });
	assert.deepEqual(estimateTime(500, Number.NaN), { minutes: 0, label: '—' });
	// The estimate is the word count over the pace, and the label says so.
	assert.equal(estimateTime(1190, 238).minutes, 5);
	assert.equal(estimateTime(1190, 238).label, '5 min');
	assert.equal(estimateTime(1234, 238).label, '5 min');
});

test('counts are grouped, averages are one decimal, shares stay readable', () => {
	assert.equal(formatCount(0), '0');
	assert.equal(formatCount(1234), '1,234');
	assert.equal(formatCount(500_000), '500,000');
	assert.equal(formatCount(Number.NaN), '0');
	assert.equal(formatAverage(5.12), '5.1');
	assert.equal(formatAverage(0), '—');
	assert.equal(formatShare(37.5), '38%');
	assert.equal(formatShare(4.16), '4.2%', 'a small share needs its decimal to mean anything');
	assert.equal(formatShare(0), '0%');
});

/* --- refusals ------------------------------------------------------------- */

test('text over the limit is refused, with the limit stated', () => {
	const limit = TOOL_WORDS_CONFIG.maxInputCharacters;
	assert.deepEqual(checkInputText('hello'), { ok: true });
	assert.deepEqual(checkInputText('a'.repeat(limit)), { ok: true }, 'the limit itself is allowed');
	const over = checkInputText('a'.repeat(limit + 1));
	assert.equal(over.ok, false);
	if (!over.ok) {
		assert.match(over.message, /500,001 characters/);
		assert.match(over.message, /500,000-character limit/);
		assert.match(over.message, /nothing was counted/);
	}
});

test('a text file is recognised by type or by name', () => {
	// Browsers disagree about both: many report an EMPTY type for .md/.csv/.log,
	// and some answer application/octet-stream. Either signal is enough.
	assert.ok(isTextFile({ name: 'notes.md', type: 'text/markdown' }));
	assert.ok(isTextFile({ name: 'notes.md', type: '' }));
	assert.ok(isTextFile({ name: 'weird.log', type: 'application/octet-stream' }));
	assert.ok(isTextFile({ name: 'unknown.xyz', type: 'text/x-something' }));
	assert.ok(isTextFile({ name: 'data.json', type: 'application/json' }));
	assert.equal(isTextFile({ name: 'book.pdf', type: 'application/pdf' }), false);
	assert.equal(isTextFile({ name: 'noext', type: '' }), false);
});

test('non-text files are refused by name, with the supported list', () => {
	const refused = [
		{ name: 'book.pdf', type: 'application/pdf', size: 1024 },
		{ name: 'letter.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1024 },
		{ name: 'photo.png', type: 'image/png', size: 1024 },
		{ name: 'archive.zip', type: 'application/zip', size: 1024 },
		{ name: 'clip.mp4', type: 'video/mp4', size: 1024 },
		{ name: 'mystery', type: '', size: 1024 },
	];
	for (const file of refused) {
		const result = checkTextFile(file);
		assert.equal(result.ok, false, file.name);
		if (result.ok) continue;
		assert.match(result.message, /not a text file this tool reads/);
		assert.match(result.message, /plain text, Markdown, CSV, TSV, JSON or a log file/);
		assert.match(result.message, /not PDFs/);
	}
});

test('an empty or oversized file is refused before it is read', () => {
	const empty = checkTextFile({ name: 'notes.txt', type: 'text/plain', size: 0 });
	assert.equal(empty.ok, false);
	if (!empty.ok) assert.match(empty.message, /empty/);

	const huge = checkTextFile({ name: 'big.txt', type: 'text/plain', size: 3 * 1024 * 1024 });
	assert.equal(huge.ok, false);
	if (!huge.ok) {
		assert.match(huge.message, /3\.0 MB/);
		assert.match(huge.message, /2\.0 MB/, 'the limit is stated in the same units as the file');
	}
});

test('a file that decoded to mojibake is flagged rather than silently counted', () => {
	assert.equal(looksLikeMojibake('the \uFFFD quick'), true);
	assert.equal(looksLikeMojibake('the quick'), false);
	assert.equal(looksLikeMojibake(''), false);
});

/* --- the clipboard summary ------------------------------------------------ */

test('the summary carries the same numbers the panel shows', () => {
	const stats = countText(PASSAGE);
	const summary = summaryText(stats, {
		readingWpm: 238,
		speakingWpm: 150,
		keywords: topWords(PASSAGE),
		sourceName: 'notes.md',
	});
	assert.match(summary, /^Source: notes\.md$/m);
	assert.match(summary, /^Words: 9$/m);
	assert.match(summary, /^Characters: 52 \(43 without spaces\)$/m);
	assert.match(summary, /^Sentences: 3 · Paragraphs: 2 · Lines: 3$/m);
	assert.match(summary, /^Reading time: under a minute at 238 wpm$/m, 'the pace is printed with the time');
	assert.match(summary, /^Speaking time: under a minute at 150 wpm$/m);
	assert.match(summary, /^Longest word: paragraph \(9 characters\)$/m);
	assert.match(summary, /^Most frequent: hello \(1\)/m);
	assert.doesNotMatch(summary, /undefined|NaN/);
});

test('the summary omits a line it cannot fill', () => {
	const summary = summaryText(emptyStats(), { readingWpm: 238, speakingWpm: 150 });
	assert.doesNotMatch(summary, /^Source:/m);
	assert.doesNotMatch(summary, /^Most frequent/m, 'an empty keyword list is not printed as an empty promise');
	assert.match(summary, /^Longest word: —$/m);
	assert.match(summary, /^Reading time: — at 238 wpm$/m);
});

/* --- the controller's own lifecycle --------------------------------------- */

test('destroyWordCounter releases the listeners it bound, and re-arms init', async () => {
	const dom = installTestDom();
	buildCounter(dom);
	const { initWordCounter, destroyWordCounter } = await words();

	initWordCounter();
	assert.ok(dom.q('[data-word-count]'), 'the fixture rendered the count button');

	// The AbortController signal is what makes this observable at all: without a
	// teardown, every listener bound at init would still be attached.
	const before = dom.listenerCount();
	destroyWordCounter();
	const after = dom.listenerCount();
	assert.ok(after < before, `destroy left ${before - after} listeners attached`);

	// And a second init binds a FRESH subtree rather than stacking a second set of
	// handlers on the first one.
	initWordCounter();
	assert.equal(dom.listenerCount(), before, 'a re-init binds exactly one set of handlers again');
	destroyWordCounter();
});

test('the counter init is idempotent, like every other boot() entry', async () => {
	const dom = installTestDom();
	buildCounter(dom);
	const { initWordCounter, destroyWordCounter } = await words();

	initWordCounter();
	const once = dom.listenerCount();
	initWordCounter();
	assert.equal(dom.listenerCount(), once, 'a second init bound nothing more');
	destroyWordCounter();
});

test('it starts empty: results hidden, copy disabled, no error, nothing pending', async () => {
	await withCounter((dom) => {
		assert.equal(dom.q('[data-word-results]').hidden, true);
		assert.equal(dom.q('[data-word-copy]').disabled, true);
		assert.equal(dom.q('[data-word-error]').hidden, true);
		assert.equal(error(dom), '');
		assert.equal(status(dom), 'Type or paste text. Nothing leaves this tab.');
		assert.equal(stat(dom, 'data-word-words'), '0');
		assert.equal(stat(dom, 'data-word-reading-time'), '—');
		assert.equal(stat(dom, 'data-word-limit'), '0 / 500,000 characters');
		assert.equal(dom.clock.pending(), 0);
	});
});

test('typing counts once the debounce elapses, and keystrokes coalesce', async () => {
	await withCounter((dom) => {
		const box = dom.q('[data-word-text]');
		box.value = 'one two three';
		for (let index = 0; index < 5; index += 1) fire(box, 'input');
		// Five keystrokes are one scheduled count, not five.
		assert.equal(dom.clock.pending(), 1, 'the debounce did not coalesce');
		assert.equal(stat(dom, 'data-word-words'), '0', 'nothing is counted before the debounce fires');

		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs - 1);
		assert.equal(stat(dom, 'data-word-words'), '0', 'counted too early');
		dom.advance(2);

		assert.equal(dom.clock.pending(), 0);
		assert.equal(stat(dom, 'data-word-words'), '3');
		assert.equal(stat(dom, 'data-word-characters'), '13');
		assert.equal(stat(dom, 'data-word-characters-no-space'), '11');
		assert.equal(stat(dom, 'data-word-unique'), '3');
		assert.equal(stat(dom, 'data-word-longest'), 'three');
		assert.equal(stat(dom, 'data-word-average-word'), '3.7', '11 letters over 3 words');
		assert.equal(dom.q('[data-word-results]').hidden, false);
		assert.equal(dom.q('[data-word-copy]').disabled, false);
		assert.equal(stat(dom, 'data-word-limit'), '13 / 500,000 characters');
		// A live recount says nothing: a screen reader would otherwise hear every
		// keystroke. The numbers are the readout.
		assert.equal(status(dom), 'Type or paste text. Nothing leaves this tab.');
	});
});

test('the Count button counts now and says so', async () => {
	await withCounter((dom) => {
		dom.q('[data-word-text]').value = 'count me please';
		fire(dom.q('[data-word-count]'), 'click');
		assert.equal(stat(dom, 'data-word-words'), '3');
		assert.match(status(dom), /^Counted 3 words and 15 characters\.$/);
		assert.equal(dom.clock.pending(), 0, 'an explicit count schedules nothing');
	});
});

test('clearing the box hides the results again', async () => {
	await withCounter((dom) => {
		type(dom, 'something to count');
		assert.equal(dom.q('[data-word-results]').hidden, false);
		type(dom, '   ');
		assert.equal(dom.q('[data-word-results]').hidden, true, 'whitespace is not text');
		assert.equal(stat(dom, 'data-word-words'), '0');
		assert.equal(dom.q('[data-word-copy]').disabled, true);
	});
});

test('reading and speaking times follow their own pace', async () => {
	await withCounter((dom) => {
		type(dom, 'word '.repeat(600).trim());
		assert.equal(stat(dom, 'data-word-words'), '600');
		assert.equal(stat(dom, 'data-word-reading-time'), '3 min', '600 words at 238 wpm');
		assert.equal(stat(dom, 'data-word-speaking-time'), '4 min', '600 words at 150 wpm');
		assert.equal(stat(dom, 'data-word-reading-value'), '238 wpm');
	});
});

test('a pace slider moves two cells and re-segments nothing', async () => {
	await withCounter((dom) => {
		type(dom, 'word '.repeat(600).trim());
		assert.equal(dom.clock.pending(), 0);

		const reading = dom.q('[data-word-reading]');
		reading.value = '100';
		fire(reading, 'input');

		assert.equal(stat(dom, 'data-word-reading-value'), '100 wpm');
		assert.equal(stat(dom, 'data-word-reading-time'), '6 min');
		// The text did not change, so the word count must not have been recomputed
		// and nothing may have been scheduled.
		assert.equal(stat(dom, 'data-word-words'), '600');
		assert.equal(dom.clock.pending(), 0, 'a pace slider scheduled a recount');
		assert.equal(stat(dom, 'data-word-speaking-time'), '4 min', 'the other pace is untouched');

		// A pace outside the configured domain is clamped, not honoured.
		reading.value = '99999';
		fire(reading, 'input');
		assert.equal(stat(dom, 'data-word-reading-value'), `${TOOL_WORDS_CONFIG.reading.max} wpm`);
	});
});

test('the mode select changes the count for text with no spaces', async () => {
	await withCounter((dom) => {
		type(dom, JAPANESE);
		assert.ok(Number.parseInt(stat(dom, 'data-word-words').replace(/,/g, ''), 10) > 5);

		const mode = dom.q('[data-word-mode]');
		mode.value = 'whitespace';
		fire(mode, 'change');
		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
		assert.equal(stat(dom, 'data-word-words'), '1');

		mode.value = 'segmenter';
		fire(mode, 'change');
		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
		assert.ok(Number.parseInt(stat(dom, 'data-word-words').replace(/,/g, ''), 10) > 5);
	});
});

test('the keyword controls rebuild the list', async () => {
	await withCounter((dom) => {
		type(dom, 'the cat and the dog and the bird');
		const list = dom.q('[data-word-keyword-list]');
		assert.equal(list.childNodes.length, 3);
		assert.match(list.childNodes[0].textContent, /bird/);
		assert.match(list.childNodes[0].textContent, /1 × · 13%/);
		assert.equal(dom.q('[data-word-keywords-none]').hidden, true);

		// Switching the common-words filter off shows "the" on top.
		const stopwords = dom.q('[data-word-stopwords]');
		stopwords.checked = false;
		fire(stopwords, 'change');
		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
		assert.equal(list.childNodes.length, 5);
		assert.match(list.childNodes[0].textContent, /^the/);

		// And a limit of 0 switches the list off with its own explanation.
		const howMany = dom.q('[data-word-keywords]');
		howMany.value = '0';
		fire(howMany, 'input');
		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
		assert.equal(list.childNodes.length, 0);
		assert.equal(dom.q('[data-word-keywords-none]').hidden, false);
		assert.match(dom.q('[data-word-keywords-none]').textContent, /switched off|is off/);

		// Clearing the field means "the default", not "off".
		howMany.value = '';
		fire(howMany, 'input');
		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
		assert.equal(list.childNodes.length, 5, 'an empty field fell back to the default limit');
	});
});

test('text where every word is common says so instead of showing nothing', async () => {
	await withCounter((dom) => {
		type(dom, 'the and of the');
		assert.equal(dom.q('[data-word-keyword-list]').childNodes.length, 0);
		const none = dom.q('[data-word-keywords-none]');
		assert.equal(none.hidden, false);
		assert.match(none.textContent, /common English word/);
	});
});

test('an over-limit paste is refused, and no stale number survives it', async () => {
	await withCounter((dom) => {
		type(dom, 'a short countable line');
		assert.equal(stat(dom, 'data-word-words'), '4');
		assert.equal(dom.q('[data-word-results]').hidden, false);

		type(dom, 'a'.repeat(TOOL_WORDS_CONFIG.maxInputCharacters + 1));

		assert.equal(dom.q('[data-word-error]').hidden, false);
		assert.match(error(dom), /500,001 characters/);
		assert.match(status(dom), /^Nothing counted\.$/);
		// The refused text is what the visitor is looking at, so the panel must not
		// keep describing the text that is no longer in the box.
		assert.equal(dom.q('[data-word-results]').hidden, true);
		assert.equal(stat(dom, 'data-word-words'), '0');
		assert.equal(dom.q('[data-word-copy]').disabled, true);
		// The readout still shows how far over they are, and marks it.
		assert.match(stat(dom, 'data-word-limit'), /^500,001 \/ 500,000 characters$/);
		assert.equal(dom.q('[data-word-limit]').dataset.over, 'true');

		// Shrinking the text back clears the error and counts again.
		type(dom, 'back to normal');
		assert.equal(dom.q('[data-word-error]').hidden, true);
		assert.equal(stat(dom, 'data-word-words'), '3');
		assert.equal(dom.q('[data-word-limit]').dataset.over, 'false');
	});
});

test('a text file is read into the box and counted', async () => {
	await withCounter(async (dom) => {
		const input = dom.q('[data-word-source]');
		input.files = [{ name: 'notes.md', type: 'text/markdown', size: 1536, text: async () => PASSAGE }];
		fire(input, 'change');
		await dom.settle();

		assert.equal(dom.q('[data-word-text]').value, PASSAGE, 'the visitor can edit what they loaded');
		assert.equal(stat(dom, 'data-word-source-meta'), 'notes.md · text/markdown · 1.5 KB');
		assert.equal(stat(dom, 'data-word-words'), '9');
		assert.match(status(dom), /^Loaded notes\.md — 1\.5 KB, 9 words\.$/);
	});
});

test('a refused file leaves the box and its counts alone', async () => {
	await withCounter(async (dom) => {
		type(dom, 'still here');
		const input = dom.q('[data-word-source]');
		input.files = [{ name: 'book.pdf', type: 'application/pdf', size: 1024, text: async () => 'never read' }];
		fire(input, 'change');
		await dom.settle();

		assert.equal(dom.q('[data-word-text]').value, 'still here');
		assert.equal(stat(dom, 'data-word-words'), '2', 'the count that is on screen still describes the box');
		assert.match(error(dom), /not a text file this tool reads/);
		assert.equal(stat(dom, 'data-word-source-meta'), '', 'a refused file is not announced as loaded');
	});
});

test('a file that fails to decode is reported, not swallowed', async () => {
	await withCounter(async (dom) => {
		const input = dom.q('[data-word-source]');
		input.files = [{ name: 'broken.txt', type: 'text/plain', size: 10, text: async () => { throw new Error('nope'); } }];
		fire(input, 'change');
		await dom.settle();
		assert.match(error(dom), /Could not read “broken\.txt”/);
	});
});

test('mojibake is counted and named', async () => {
	await withCounter(async (dom) => {
		const input = dom.q('[data-word-source]');
		input.files = [{ name: 'utf16.txt', type: 'text/plain', size: 12, text: async () => 'a\uFFFDb' }];
		fire(input, 'change');
		await dom.settle();
		assert.match(status(dom), /does not look like UTF-8 text/);
		// The replacement character is not a letter, so what arrived is counted as
		// it stands: two words around a character nobody meant to type.
		assert.equal(stat(dom, 'data-word-words'), '2');
		assert.equal(stat(dom, 'data-word-characters'), '3');
	});
});

test('a second file replaces the first, and the loser writes nothing', async () => {
	await withCounter(async (dom) => {
		const input = dom.q('[data-word-source]');
		const slow = { name: 'slow.txt', type: 'text/plain', size: 10, text: () => new Promise((resolve) => setTimeout(() => resolve('slow file text here'), 50)) };
		const fast = { name: 'fast.txt', type: 'text/plain', size: 10, text: async () => 'fast one two' };

		input.files = [slow];
		fire(input, 'change');
		input.files = [fast];
		fire(input, 'change');
		await dom.settle();
		assert.equal(stat(dom, 'data-word-source-meta'), 'fast.txt · text/plain · 10 B');
		assert.equal(stat(dom, 'data-word-words'), '3');

		// The slow read lands afterwards and must not overwrite the winner.
		dom.advance(60);
		await dom.settle();
		assert.equal(stat(dom, 'data-word-source-meta'), 'fast.txt · text/plain · 10 B');
		assert.equal(stat(dom, 'data-word-words'), '3');
		assert.equal(dom.q('[data-word-text]').value, 'fast one two');
	});
});

test('a dropped file is read the same way, and dragover is cancelled', async () => {
	await withCounter(async (dom) => {
		const zone = dom.q('[data-word-drop]');
		let prevented = false;
		fire(zone, 'dragover', { preventDefault: () => { prevented = true; } });
		assert.equal(prevented, true, 'without this the browser navigates to the dropped file');
		assert.equal(zone.dataset.dragOver, 'true');

		fire(zone, 'drop', {
			preventDefault: () => {},
			dataTransfer: { files: [{ name: 'dropped.txt', type: 'text/plain', size: 8, text: async () => 'dropped text' }] },
		});
		await dom.settle();
		assert.equal(zone.dataset.dragOver, 'false');
		assert.equal(dom.q('[data-word-text]').value, 'dropped text');
		assert.equal(stat(dom, 'data-word-words'), '2');
	});
});

test('Reset empties the box, the controls and the panel, and leaves nothing pending', async () => {
	await withCounter((dom) => {
		type(dom, 'some words to clear', false);
		assert.equal(dom.clock.pending(), 1);
		dom.q('[data-word-reading]').value = '400';
		dom.q('[data-word-mode]').value = 'whitespace';
		dom.q('[data-word-stopwords]').checked = false;
		dom.q('[data-word-source-meta]').textContent = 'notes.md · text/plain · 1.0 KB';
		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
		assert.equal(dom.q('[data-word-results]').hidden, false);

		// A pending debounce at reset time is the case that matters: the timer must
		// not fire against a box that has just been emptied.
		type(dom, 'and more', false);
		fire(dom.q('[data-word-reset]'), 'click');

		assert.equal(dom.clock.pending(), 0, 'reset left a recount scheduled');
		assert.equal(dom.q('[data-word-text]').value, '');
		assert.equal(dom.q('[data-word-results]').hidden, true);
		assert.equal(stat(dom, 'data-word-words'), '0');
		assert.equal(stat(dom, 'data-word-longest'), '—');
		assert.equal(stat(dom, 'data-word-source-meta'), '');
		assert.equal(stat(dom, 'data-word-limit'), '0 / 500,000 characters');
		assert.equal(dom.q('[data-word-copy]').disabled, true);
		assert.equal(dom.q('[data-word-mode]').value, 'segmenter');
		assert.equal(dom.q('[data-word-reading]').value, String(TOOL_WORDS_CONFIG.reading.default));
		assert.equal(dom.q('[data-word-stopwords]').checked, true);
		assert.equal(status(dom), 'Type or paste text. Nothing leaves this tab.');

		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 10);
		assert.equal(stat(dom, 'data-word-words'), '0', 'a timer fired after reset and counted the old text');
	});
});

test('leaving the page clears the text, the way reset does', async () => {
	await withCounter((dom) => {
		type(dom, 'a manuscript in progress');
		assert.equal(dom.q('[data-word-text]').value, 'a manuscript in progress');
		dom.document.__fireWindowEvent('pagehide');
		assert.equal(dom.q('[data-word-text]').value, '');
		assert.equal(dom.q('[data-word-results]').hidden, true);
	});
});

/* --- the copy button ------------------------------------------------------ */

/** Swap the global navigator for one with a clipboard, and put it back after. */
async function withClipboard(clipboard: unknown, run: (dom: Dom) => Promise<void> | void): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
	try {
		await withCounter(run);
	} finally {
		if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
	}
}

test('copy says copied only when the clipboard write resolved', async () => {
	const written: string[] = [];
	await withClipboard({ writeText: async (value: string) => { written.push(value); } }, async (dom) => {
		type(dom, PASSAGE);
		fire(dom.q('[data-word-copy]'), 'click');
		await dom.settle();

		assert.equal(written.length, 1);
		assert.match(written[0], /^Words: 9$/m, 'the clipboard gets the same numbers the panel shows');
		assert.match(written[0], /^Characters: 52 \(43 without spaces\)$/m);
		assert.match(written[0], /^Reading time: under a minute at 238 wpm$/m);
		assert.match(status(dom), /^Summary copied — 9 words, 52 characters\.$/);
	});
});

test('a refused clipboard write is a failure, not a success', async () => {
	await withClipboard({ writeText: async () => { throw new Error('denied'); } }, async (dom) => {
		type(dom, PASSAGE);
		fire(dom.q('[data-word-copy]'), 'click');
		await dom.settle();
		assert.match(status(dom), /clipboard refused the copy/);
		assert.match(status(dom), /nothing was copied/);
		assert.doesNotMatch(status(dom), /^Summary copied/);
	});
});

test('a browser with no clipboard API is told so', async () => {
	await withClipboard(undefined, async (dom) => {
		type(dom, PASSAGE);
		fire(dom.q('[data-word-copy]'), 'click');
		await dom.settle();
		assert.match(status(dom), /no clipboard API/);
		assert.doesNotMatch(status(dom), /^Summary copied/);
	});
});

test('copy is dead until there is something to copy', async () => {
	await withCounter(async (dom) => {
		assert.equal(dom.q('[data-word-copy]').disabled, true);
		fire(dom.q('[data-word-copy]'), 'click');
		await dom.settle();
		assert.equal(status(dom), 'Type or paste text. Nothing leaves this tab.', 'a dead click changed nothing');
	});
});
