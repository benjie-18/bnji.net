/**
 * BNJI.NET — the word counter in a browser with no Intl.Segmenter.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * `supportsWordSegmenter()` probes once and caches, because a browser answers
 * that question once. So the branch cannot be reached from
 * tests/tools-words.test.ts, where every other test has already asked. Node's
 * test runner gives each file its own process, which makes this the one place
 * the segmenter can be deleted before the module is imported — and it is a real
 * branch: Firefox before 125 has no Intl.Segmenter at all.
 *
 * What has to hold there is the honesty contract: the tool must not offer a mode
 * it cannot deliver, must not silently downgrade without saying so, and must
 * still count. Everything below is that, and nothing here needs a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import { TOOL_WORDS_CONFIG, WORD_MODE_HINT, WORD_MODE_UNAVAILABLE_HINT } from '../src/config/tools.config.ts';

/*
 * Deleted before the import below, and never restored: this process exists to
 * test the absence. `Intl.Segmenter` is non-optional in the DOM lib, so the
 * delete goes through a structural alias to keep `tsc` honest about it.
 */
const intl = Intl as unknown as { Segmenter?: unknown };
const hadSegmenter = typeof intl.Segmenter === 'function';
delete intl.Segmenter;

const {
	countText,
	initWordCounter,
	destroyWordCounter,
	splitSentences,
	splitSentencesByPunctuation,
	splitWords,
	splitWordsByWhitespace,
	supportsWordSegmenter,
} = await import('../src/scripts/tools-words.ts');

type Dom = ReturnType<typeof installTestDom>;

const JAPANESE = '今日は良い天気です。明日も晴れるでしょう。';
const ENGLISH = 'Hello world. This is a test.\n\nSecond paragraph here.';

test('this file really is running without a segmenter', () => {
	assert.ok(hadSegmenter, 'the runtime had one to delete, so this is a real absence and not a typo');
	assert.equal(typeof intl.Segmenter, 'undefined');
	assert.equal(supportsWordSegmenter(), false);
});

test('asking for the segmenter gets the space split, and the numbers say so', () => {
	// No silent difference: the words are what the fallback produces.
	assert.deepEqual(splitWords(JAPANESE, 'segmenter'), splitWordsByWhitespace(JAPANESE));
	assert.equal(splitWords(JAPANESE, 'segmenter').length, 1);
	// …and `mode` reports the engine that actually ran, so a caller cannot claim
	// a segmentation the browser never performed.
	assert.equal(countText(JAPANESE, { mode: 'segmenter' }).mode, 'whitespace');
	assert.equal(countText(JAPANESE, { mode: 'whitespace' }).mode, 'whitespace');
});

test('sentences fall back to terminators and still count', () => {
	assert.deepEqual(splitSentences(ENGLISH), splitSentencesByPunctuation(ENGLISH));
	assert.equal(splitSentences(ENGLISH).length, 3);
	assert.equal(countText(ENGLISH, { mode: 'segmenter' }).sentences, 3);
});

test('English is unaffected — the fallback is not a worse counter here', () => {
	const stats = countText(ENGLISH);
	assert.equal(stats.words, 9);
	assert.equal(stats.characters, ENGLISH.length);
	assert.equal(stats.paragraphs, 2);
	assert.equal(stats.lines, 3);
	assert.equal(stats.longestWord, 'paragraph');
});

test('the controller pins the mode it can deliver, disables the choice and says why', async () => {
	const dom = installTestDom();
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
	// The component renders the segmenter first and selected, which is exactly the
	// offer this browser cannot honour.
	section.querySelector('[data-word-mode]').value = 'segmenter';
	section.querySelector('[data-word-error]').hidden = true;
	section.querySelector('[data-word-results]').hidden = true;
	document.body.appendChild(section);

	initWordCounter();
	try {
		const mode = dom.q('[data-word-mode]');
		assert.equal(mode.value, 'whitespace', 'the choice was pinned to what the browser can do');
		assert.equal(mode.disabled, true, 'a mode the browser cannot deliver must not be offered');
		assert.equal(dom.q('[data-word-mode-hint]').textContent, WORD_MODE_UNAVAILABLE_HINT);
		assert.notEqual(WORD_MODE_UNAVAILABLE_HINT, WORD_MODE_HINT.segmenter);
		assert.match(WORD_MODE_UNAVAILABLE_HINT, /no text segmenter/);

		// It still counts, and the numbers are the fallback's.
		const box = dom.q('[data-word-text]');
		box.value = JAPANESE;
		box.dispatchEvent({ type: 'input', preventDefault: () => {} });
		dom.advance(TOOL_WORDS_CONFIG.recountDelayMs + 1);
		assert.equal(dom.q('[data-word-words]').textContent, '1');
		assert.equal(dom.q('[data-word-results]').hidden, false, 'a limitation is not a reason to show nothing');

		// Reset must not hand back a choice the browser still cannot honour.
		dom.q('[data-word-reset]').dispatchEvent({ type: 'click', preventDefault: () => {} });
		assert.equal(mode.value, 'whitespace');
		assert.equal(mode.disabled, true);
		assert.equal(dom.q('[data-word-mode-hint]').textContent, WORD_MODE_UNAVAILABLE_HINT);
	} finally {
		destroyWordCounter();
	}
});
