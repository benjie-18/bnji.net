/**
 * /tools/ word counter: the REAL markup from WordCounter.astro driven by the
 * REAL controller in a REAL DOM.
 *
 * WHY THIS FILE EXISTS BESIDE tests/tools-words.test.ts
 * ----------------------------------------------------
 * That file covers the decisions (what a word is, what gets refused) and drives
 * the controller against the small DOM shim. Two things a shim cannot show:
 *
 *   1. that the component's markup — as Astro actually renders it, expressions
 *      and all — carries the hooks, labels and ARIA targets the controller and
 *      a screen reader depend on; and
 *   2. that the controller works against a real DOM implementation, where
 *      `hidden`, `disabled`, `dataset` and event dispatch have their browser
 *      meanings rather than the shim's approximations.
 *
 * tests/tools-markup.test.ts compares the two halves as text; this file loads
 * them into jsdom and runs them. The markup is extracted from the .astro source
 * the same way friends-ui.test.ts does it, and every Astro expression is
 * substituted from the same config the component imports — so nothing here
 * re-states a value that could drift, and the "no expression survived" assertion
 * fails loudly the day the component grows one this file does not know about.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
	TEXT_FILE_CONFIG,
	TEXT_INPUT_ACCEPT,
	TEXT_INPUT_LABELS,
	TOOL_WORDS_CONFIG,
	WORD_MODES,
	WORD_MODE_HINT,
	WORD_MODE_LABEL,
	WORD_STOPWORDS,
} from '../src/config/tools.config';
import { destroyWordCounter, initWordCounter } from '../src/scripts/tools-words';

const { reading, speaking, keywords, maxInputCharacters } = TOOL_WORDS_CONFIG;
const { maxBytes: maxFileBytes } = TEXT_FILE_CONFIG;
const tick = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const PASSAGE = 'Hello world. This is a test.\n\nSecond paragraph here.';

/** The component's markup, with every Astro expression filled from config. */
function counterMarkup(): string {
	const source = readFileSync(new URL('../src/components/tools/WordCounter.astro', import.meta.url), 'utf8');
	const parts = source.split('---');
	assert.ok(parts.length >= 3, 'WordCounter.astro lost its frontmatter delimiters');
	let markup = parts[2]!;
	assert.ok(!markup.includes('<style>'), 'the tool is styled by styles/tools.css, not inline');

	// JSX comments are not markup.
	markup = markup.replace(/{\/\*[\s\S]*?\*\/}/g, '');
	// The one expression that produces elements rather than text.
	markup = markup.replace(
		'{WORD_MODES.map((mode) => <option value={mode}>{WORD_MODE_LABEL[mode]}</option>)}',
		WORD_MODES.map((mode) => `<option value="${mode}">${WORD_MODE_LABEL[mode]}</option>`).join(''),
	);
	const text: Record<string, string> = {
		'{TEXT_INPUT_ACCEPT}': TEXT_INPUT_ACCEPT,
		'{TEXT_INPUT_LABELS}': TEXT_INPUT_LABELS,
		'{WORD_MODE_HINT.segmenter}': WORD_MODE_HINT.segmenter,
		'{WORD_STOPWORDS.length}': String(WORD_STOPWORDS.length),
		"{maxInputCharacters.toLocaleString('en-US')}": maxInputCharacters.toLocaleString('en-US'),
		"{(maxFileBytes / (1024 * 1024)).toLocaleString('en-US')}": (maxFileBytes / (1024 * 1024)).toLocaleString('en-US'),
		'{reading.min}': String(reading.min),
		'{reading.max}': String(reading.max),
		'{reading.step}': String(reading.step),
		'{reading.default}': String(reading.default),
		'{speaking.min}': String(speaking.min),
		'{speaking.max}': String(speaking.max),
		'{speaking.step}': String(speaking.step),
		'{speaking.default}': String(speaking.default),
		'{keywords.min}': String(keywords.min),
		'{keywords.max}': String(keywords.max),
		'{keywords.step}': String(keywords.step),
		'{keywords.default}': String(keywords.default),
	};
	for (const [expression, value] of Object.entries(text)) markup = markup.replaceAll(expression, value);

	/*
	 * The guard that keeps this fixture honest: a leftover expression would be
	 * handed to jsdom as literal text, the hook it belonged to would be missing,
	 * and every assertion below would still pass against a page nobody ships.
	 */
	assert.doesNotMatch(markup, /{[^}]*}/, 'an Astro expression survived into the jsdom fixture');
	return markup;
}

function counterDom(): JSDOM {
	const dom = new JSDOM(`<!doctype html><html><body>${counterMarkup()}</body></html>`, {
		url: 'http://localhost:4321/tools/',
	});
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	// Node 22 defines `navigator` with a getter only, so it has to be replaced
	// rather than assigned — and the controller reads it for the clipboard.
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
	/*
	 * One realm, as in a browser. jsdom's addEventListener rejects an
	 * AbortSignal from Node's realm ("member 'signal' that is not of type
	 * 'AbortSignal'"), and the controller tears its listeners down with exactly
	 * that — so without this the init throws before it binds anything. A real
	 * page never has two realms; a Node process driving a jsdom window does.
	 */
	g.AbortController = dom.window.AbortController;
	return dom;
}

/** Init the real controller and guarantee it is torn down before the window closes. */
function mount(t: { after(fn: () => void): void }, dom: JSDOM): void {
	initWordCounter();
	t.after(() => {
		destroyWordCounter();
		dom.window.close();
	});
}

const q = (dom: JSDOM, selector: string): HTMLElement => {
	const node = dom.window.document.querySelector(selector);
	assert.ok(node, `WordCounter.astro is missing ${selector}`);
	return node as unknown as HTMLElement;
};

/** Trimmed: markup-extracted text carries the component's own indentation. */
const text = (dom: JSDOM, selector: string): string => (q(dom, selector).textContent ?? '').trim();

const typeInto = async (dom: JSDOM, value: string): Promise<void> => {
	const box = q(dom, '[data-word-text]') as unknown as HTMLTextAreaElement;
	box.value = value;
	box.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await tick(TOOL_WORDS_CONFIG.recountDelayMs + 30);
};

const click = async (dom: JSDOM, selector: string): Promise<void> => {
	q(dom, selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick();
};

/* --- the rendered markup -------------------------------------------------- */

test('every hook the controller binds exists in the rendered markup', () => {
	const dom = counterDom();
	const controller = readFileSync(new URL('../src/scripts/tools-words.ts', import.meta.url), 'utf8');
	const pattern = /querySelector(?:All)?(?:<[^>]*>)?\(\s*'\[([\w-]+)\]'/g;
	const selectors = [...controller.matchAll(pattern)].map((match) => match[1]!);
	assert.ok(selectors.length >= 30, 'the controller stopped querying its own markup');
	for (const selector of selectors) {
		assert.ok(dom.window.document.querySelector(`[${selector}]`), `rendered markup is missing [${selector}]`);
	}
	dom.window.close();
});

test('labels, descriptions and headings all point at something real', () => {
	const dom = counterDom();
	const { document } = dom.window;

	// Every visible label reaches the control it names — a `for` that points
	// nowhere is a control with no accessible name.
	for (const label of [...document.querySelectorAll('label[for]')]) {
		const target = document.getElementById(label.getAttribute('for')!);
		assert.ok(target, `label[for=${label.getAttribute('for')}] points at nothing`);
		assert.match(target!.tagName, /^(INPUT|SELECT|TEXTAREA)$/, 'a label must name a control');
	}
	// Every described-by and labelled-by target exists.
	for (const node of [...document.querySelectorAll('[aria-describedby]')]) {
		for (const id of node.getAttribute('aria-describedby')!.split(/\s+/)) {
			assert.ok(document.getElementById(id), `aria-describedby="${id}" points at nothing`);
		}
	}
	const section = q(dom, '[data-word-counter]');
	const headingId = section.getAttribute('aria-labelledby');
	assert.ok(headingId && document.getElementById(headingId), 'the section is not labelled by its heading');
	assert.equal(document.getElementById(headingId!)!.tagName, 'H2');
	assert.equal(section.querySelectorAll('h2').length, 1, 'one tool, one heading');
	// The screen-reader-only name on the drop target, and the file input inside it.
	assert.match(q(dom, '[data-word-drop] .sr-only').textContent ?? '', /text file/i);
	assert.equal(q(dom, '[data-word-drop]').querySelectorAll('input[type="file"]').length, 1);
	dom.window.close();
});

test('the controls render the configured domains, and nothing else', () => {
	const dom = counterDom();

	const rendered = [...q(dom, '[data-word-mode]').querySelectorAll('option')];
	assert.deepEqual(rendered.map((option) => option.getAttribute('value')), [...WORD_MODES]);
	// The option labels carry the trade-off, so they come from config too.
	assert.deepEqual(rendered.map((option) => option.textContent), WORD_MODES.map((mode) => WORD_MODE_LABEL[mode]));
	assert.equal(text(dom, '[data-word-mode-hint]'), WORD_MODE_HINT.segmenter);

	const readingInput = q(dom, '[data-word-reading]') as unknown as HTMLInputElement;
	assert.equal(readingInput.min, String(reading.min));
	assert.equal(readingInput.max, String(reading.max));
	assert.equal(readingInput.step, String(reading.step));
	assert.equal(readingInput.value, String(reading.default));
	const speakingInput = q(dom, '[data-word-speaking]') as unknown as HTMLInputElement;
	assert.equal(speakingInput.min, String(speaking.min));
	assert.equal(speakingInput.value, String(speaking.default));
	assert.equal(text(dom, '[data-word-reading-value]'), `${reading.default} wpm`);
	assert.equal(text(dom, '[data-word-speaking-value]'), `${speaking.default} wpm`);

	const howMany = q(dom, '[data-word-keywords]') as unknown as HTMLInputElement;
	assert.equal(howMany.min, String(keywords.min));
	assert.equal(howMany.max, String(keywords.max));
	assert.equal(howMany.value, String(keywords.default));
	assert.equal((q(dom, '[data-word-stopwords]') as unknown as HTMLInputElement).checked, true);
	assert.match(text(dom, '.tool__check'), new RegExp(String(WORD_STOPWORDS.length)));

	// The picker offers exactly the accepted set: the attribute and the refusal
	// copy come from the same config, so they cannot disagree.
	assert.equal(q(dom, '[data-word-source]').getAttribute('accept'), TEXT_INPUT_ACCEPT);
	assert.match(text(dom, '#word-source-hint'), new RegExp(TEXT_INPUT_LABELS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.match(text(dom, '[data-word-limit]'), new RegExp(`${maxInputCharacters.toLocaleString('en-US')} characters`));

	// No maxlength: it would truncate a paste silently instead of refusing it.
	assert.equal((q(dom, '[data-word-text]') as unknown as HTMLTextAreaElement).maxLength, -1);
	// The live readout sits inside the label, so it stays out of the accessible
	// name; the Characters tile carries the same number for a screen reader.
	assert.equal(q(dom, '[data-word-limit]').getAttribute('aria-hidden'), 'true');
	assert.equal(text(dom, '[data-word-characters]'), '0');
	dom.window.close();
});

test('the results start hidden with honest placeholders', () => {
	const dom = counterDom();
	assert.equal(q(dom, '[data-word-results]').hasAttribute('hidden'), true);
	assert.equal(q(dom, '[data-word-error]').hasAttribute('hidden'), true);
	assert.equal((q(dom, '[data-word-copy]') as unknown as HTMLButtonElement).disabled, true);
	assert.equal(text(dom, '[data-word-words]'), '0');
	assert.equal(text(dom, '[data-word-reading-time]'), '—');
	assert.equal(text(dom, '[data-word-longest]'), '—');
	// The actions are plain glass buttons: GlassButton would drop the data hooks.
	const actions = q(dom, '.tool__actions');
	assert.equal(actions.querySelectorAll('button.glass-button').length, 3);
	assert.match(actions.querySelector('[data-word-count]')!.className, /glass-button--primary/);
	dom.window.close();
});

/* --- the real controller in a real DOM ------------------------------------ */

test('typing into the real markup fills the real panel', async (t) => {
	const dom = counterDom();
	mount(t, dom);
	await typeInto(dom, PASSAGE);

	assert.equal(q(dom, '[data-word-results]').hasAttribute('hidden'), false);
	assert.equal(text(dom, '[data-word-words]'), '9');
	assert.equal(text(dom, '[data-word-characters]'), String(PASSAGE.length));
	assert.equal(text(dom, '[data-word-characters-no-space]'), '43');
	assert.equal(text(dom, '[data-word-sentences]'), '3');
	assert.equal(text(dom, '[data-word-paragraphs]'), '2');
	assert.equal(text(dom, '[data-word-lines]'), '3');
	assert.equal(text(dom, '[data-word-unique]'), '9');
	assert.equal(text(dom, '[data-word-longest]'), 'paragraph');
	assert.equal(text(dom, '[data-word-average-word]'), '4.4');
	assert.equal(text(dom, '[data-word-average-sentence]'), '3.0');
	assert.equal(text(dom, '[data-word-reading-time]'), 'under a minute');
	assert.equal(text(dom, '[data-word-limit]'), `${PASSAGE.length} / ${maxInputCharacters.toLocaleString('en-US')} characters`);
	assert.equal(q(dom, '[data-word-limit]').dataset.over, 'false');
	assert.equal((q(dom, '[data-word-copy]') as unknown as HTMLButtonElement).disabled, false);

	// The keyword list is real DOM the controller built.
	const items = [...q(dom, '[data-word-keyword-list]').querySelectorAll('li')];
	assert.equal(items.length, 5);
	assert.equal(items[0]!.querySelector('.tool__keyword-word')!.textContent, 'hello');
	assert.match(items[0]!.querySelector('.tool__keyword-count')!.textContent ?? '', /1 × · \d/);
	assert.equal(q(dom, '[data-word-keywords-none]').hasAttribute('hidden'), true);
});

test('a script with no spaces counts in a real browser DOM too', async (t) => {
	const dom = counterDom();
	mount(t, dom);
	const japanese = '今日は良い天気です。明日も晴れるでしょう。';
	await typeInto(dom, japanese);
	const segmented = Number.parseInt(text(dom, '[data-word-words]').replaceAll(',', ''), 10);
	assert.ok(segmented > 5, `the segmenter found ${segmented} words`);

	const mode = q(dom, '[data-word-mode]') as unknown as HTMLSelectElement;
	mode.value = 'whitespace';
	mode.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await tick(TOOL_WORDS_CONFIG.recountDelayMs + 30);
	assert.equal(text(dom, '[data-word-words]'), '1', 'the space split cannot see these words');
	assert.equal(text(dom, '[data-word-mode-hint]'), WORD_MODE_HINT.whitespace, 'the hint explains the trade-off');
});

test('an over-limit paste refuses out loud in the real DOM', async (t) => {
	const dom = counterDom();
	mount(t, dom);
	await typeInto(dom, 'four words right here');
	assert.equal(text(dom, '[data-word-words]'), '4');

	await typeInto(dom, 'a'.repeat(maxInputCharacters + 1));
	assert.equal(q(dom, '[data-word-error]').hasAttribute('hidden'), false);
	assert.match(text(dom, '[data-word-error]'), /500,000-character limit/);
	assert.equal(text(dom, '[data-word-status]'), 'Nothing counted.');
	assert.equal(q(dom, '[data-word-results]').hasAttribute('hidden'), true, 'no stale numbers survive a refusal');
	assert.equal(text(dom, '[data-word-words]'), '0');
	assert.equal(q(dom, '[data-word-limit]').dataset.over, 'true');
	assert.equal((q(dom, '[data-word-copy]') as unknown as HTMLButtonElement).disabled, true);
});

test('a pace slider moves the times without recounting, in the real DOM', async (t) => {
	const dom = counterDom();
	mount(t, dom);
	await typeInto(dom, 'word '.repeat(600).trim());
	assert.equal(text(dom, '[data-word-words]'), '600');
	assert.equal(text(dom, '[data-word-reading-time]'), '3 min');

	const pace = q(dom, '[data-word-reading]') as unknown as HTMLInputElement;
	pace.value = '100';
	pace.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await tick(5);
	assert.equal(text(dom, '[data-word-reading-value]'), '100 wpm');
	assert.equal(text(dom, '[data-word-reading-time]'), '6 min');
	assert.equal(text(dom, '[data-word-words]'), '600');
	assert.equal(text(dom, '[data-word-speaking-time]'), '4 min');
});

test('Reset empties the box and the panel in the real DOM', async (t) => {
	const dom = counterDom();
	mount(t, dom);
	await typeInto(dom, PASSAGE);
	assert.equal(q(dom, '[data-word-results]').hasAttribute('hidden'), false);

	await click(dom, '[data-word-reset]');
	assert.equal((q(dom, '[data-word-text]') as unknown as HTMLTextAreaElement).value, '');
	assert.equal(q(dom, '[data-word-results]').hasAttribute('hidden'), true);
	assert.equal(q(dom, '[data-word-error]').hasAttribute('hidden'), true);
	assert.equal(text(dom, '[data-word-words]'), '0');
	assert.equal(text(dom, '[data-word-source-meta]'), '');
	assert.equal((q(dom, '[data-word-copy]') as unknown as HTMLButtonElement).disabled, true);
	assert.equal(text(dom, '[data-word-status]'), 'Type or paste text. Nothing leaves this tab.');
});

test('the copy button reports what the clipboard really did', async (t) => {
	const dom = counterDom();
	mount(t, dom);

	// jsdom implements no clipboard, which is the same position as an insecure
	// context: the tool must not claim a copy that did not happen.
	assert.equal(typeof (dom.window.navigator as unknown as { clipboard?: unknown }).clipboard, 'undefined');
	await typeInto(dom, PASSAGE);
	await click(dom, '[data-word-copy]');
	assert.match(text(dom, '[data-word-status]'), /no clipboard API/);

	// With one present, the summary that lands on it is the panel's own numbers.
	const written: string[] = [];
	Object.defineProperty(dom.window.navigator, 'clipboard', {
		configurable: true,
		value: { writeText: async (value: string) => { written.push(value); } },
	});
	await click(dom, '[data-word-copy]');
	assert.equal(written.length, 1);
	assert.match(written[0]!, /^Words: 9$/m);
	assert.match(written[0]!, /^Sentences: 3 · Paragraphs: 2 · Lines: 3$/m);
	assert.match(written[0]!, /^Reading time: under a minute at 238 wpm$/m);
	assert.match(written[0]!, /^Most frequent: hello \(1\)/m);
	assert.match(text(dom, '[data-word-status]'), /^Summary copied — 9 words, 52 characters\.$/);
});
