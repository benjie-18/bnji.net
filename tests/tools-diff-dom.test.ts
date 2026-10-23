/**
 * /projects/tools/ text diff: the REAL markup from TextDiff.astro driven by the REAL
 * controller in a REAL DOM.
 *
 * WHY THIS FILE EXISTS BESIDE tests/tools-diff.test.ts
 * ----------------------------------------------------
 * That file covers the decisions (how lines are compared, what is refused, what
 * the patch says) and drives the controller against the small DOM shim. Two
 * things a shim cannot show:
 *
 *   1. that the component's markup — as Astro actually renders it, expressions
 *      and all — carries the hooks, labels and ARIA targets the controller and a
 *      screen reader depend on; and
 *   2. that the controller works against a real DOM implementation, where
 *      `hidden`, `disabled`, `dataset`, `replaceChildren` and event dispatch
 *      have their browser meanings rather than the shim's approximations — and
 *      where a pasted `<img src=x onerror=…>` really would run, if any part of
 *      this tool ever reached for innerHTML.
 *
 * tests/tools-markup.test.ts compares the two halves as text; this file loads
 * them into jsdom and runs them. The markup is extracted from the .astro source
 * the same way the word counter's DOM test does it, and every Astro expression
 * is substituted from the same config the component imports — so nothing here
 * re-states a value that could drift, and the "no expression survived"
 * assertion fails loudly the day the component grows one this file does not
 * know about.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
	DIFF_VIEWS,
	DIFF_VIEW_HINT,
	DIFF_VIEW_LABEL,
	TEXT_FILE_CONFIG,
	TEXT_INPUT_ACCEPT,
	TEXT_INPUT_LABELS,
	TOOL_DIFF_CONFIG,
} from '../src/config/tools.config';
import { destroyTextDiff, initTextDiff } from '../src/scripts/tools-diff';

const { context, maxInputCharacters, autoCompareMaxCharacters, maxRenderedRows } = TOOL_DIFF_CONFIG;
const { maxBytes: maxFileBytes } = TEXT_FILE_CONFIG;
const tick = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The component's markup, with every Astro expression filled from config. */
function diffMarkup(): string {
	const source = readFileSync(new URL('../src/components/tools/TextDiff.astro', import.meta.url), 'utf8');
	const parts = source.split('---');
	assert.ok(parts.length >= 3, 'TextDiff.astro lost its frontmatter delimiters');
	let markup = parts[2]!;
	assert.ok(!markup.includes('<style>'), 'the tool is styled by styles/tools.css, not inline');

	// JSX comments are not markup.
	markup = markup.replace(/{\/\*[\s\S]*?\*\/}/g, '');
	// The one expression that produces elements rather than text.
	markup = markup.replace(
		'{DIFF_VIEWS.map((view) => <option value={view}>{DIFF_VIEW_LABEL[view]}</option>)}',
		DIFF_VIEWS.map((view) => `<option value="${view}">${DIFF_VIEW_LABEL[view]}</option>`).join(''),
	);
	const text: Record<string, string> = {
		'{TEXT_INPUT_ACCEPT}': TEXT_INPUT_ACCEPT,
		'{TEXT_INPUT_LABELS}': TEXT_INPUT_LABELS,
		'{DIFF_VIEW_HINT.unified}': DIFF_VIEW_HINT.unified,
		// Astro needs an explicit space expression between two inline elements.
		"{' '}": ' ',
		'{context.min}': String(context.min),
		'{context.max}': String(context.max),
		'{context.step}': String(context.step),
		'{context.default}': String(context.default),
		"{maxInputCharacters.toLocaleString('en-US')}": maxInputCharacters.toLocaleString('en-US'),
		"{autoCompareMaxCharacters.toLocaleString('en-US')}": autoCompareMaxCharacters.toLocaleString('en-US'),
		"{maxRenderedRows.toLocaleString('en-US')}": maxRenderedRows.toLocaleString('en-US'),
		"{(maxFileBytes / (1024 * 1024)).toLocaleString('en-US')}": (maxFileBytes / (1024 * 1024)).toLocaleString('en-US'),
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

function diffDom(): JSDOM {
	const dom = new JSDOM(`<!doctype html><html><body>${diffMarkup()}</body></html>`, {
		url: 'http://localhost:4321/projects/tools/',
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
	 * that — so without this the init throws before it binds anything.
	 */
	g.AbortController = dom.window.AbortController;
	return dom;
}

/** Init the real controller and guarantee it is torn down before the window closes. */
function mount(t: { after(fn: () => void): void }, dom: JSDOM): void {
	initTextDiff();
	t.after(() => {
		destroyTextDiff();
		dom.window.close();
	});
}

const q = (dom: JSDOM, selector: string): HTMLElement => {
	const node = dom.window.document.querySelector(selector);
	assert.ok(node, `TextDiff.astro is missing ${selector}`);
	return node as unknown as HTMLElement;
};

/** Trimmed: markup-extracted text carries the component's own indentation. */
const text = (dom: JSDOM, selector: string): string => (q(dom, selector).textContent ?? '').trim();

const input = <T>(dom: JSDOM, selector: string): T => q(dom, selector) as unknown as T;

/** Fill both boxes and let the debounce elapse, the way typing does. */
const paste = async (dom: JSDOM, left: string, right: string, settle = true): Promise<void> => {
	const leftBox = input<HTMLTextAreaElement>(dom, '[data-diff-left]');
	const rightBox = input<HTMLTextAreaElement>(dom, '[data-diff-right]');
	leftBox.value = left;
	rightBox.value = right;
	leftBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	if (settle) await tick(TOOL_DIFF_CONFIG.recompareDelayMs + 30);
};

const click = async (dom: JSDOM, selector: string): Promise<void> => {
	q(dom, selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick();
};

const change = async (dom: JSDOM, selector: string, ms = 8): Promise<void> => {
	q(dom, selector).dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await tick(ms);
};

const rowsOf = (dom: JSDOM): HTMLElement[] => [...q(dom, '[data-diff-view]').children] as HTMLElement[];
const rowTexts = (dom: JSDOM): string[] => rowsOf(dom).map((row) => (row.textContent ?? '').trim());

/* --- the rendered markup -------------------------------------------------- */

test('every hook the controller binds exists in the rendered markup', () => {
	const dom = diffDom();
	const controller = readFileSync(new URL('../src/scripts/tools-diff.ts', import.meta.url), 'utf8');
	const pattern = /querySelector(?:All)?(?:<[^>]*>)?\(\s*'\[([\w-]+)\]'/g;
	const selectors = [...controller.matchAll(pattern)].map((match) => match[1]!);
	assert.ok(selectors.length >= 25, 'the controller stopped querying its own markup');
	for (const selector of selectors) {
		assert.ok(dom.window.document.querySelector(`[${selector}]`), `rendered markup is missing [${selector}]`);
	}
	dom.window.close();
});

test('labels, descriptions and headings all point at something real', () => {
	const dom = diffDom();
	const { document } = dom.window;

	for (const label of [...document.querySelectorAll('label[for]')]) {
		const target = document.getElementById(label.getAttribute('for')!);
		assert.ok(target, `label[for=${label.getAttribute('for')}] points at nothing`);
		assert.match(target!.tagName, /^(INPUT|SELECT|TEXTAREA)$/, 'a label must name a control');
	}
	for (const node of [...document.querySelectorAll('[aria-describedby]')]) {
		for (const id of node.getAttribute('aria-describedby')!.split(/\s+/)) {
			assert.ok(document.getElementById(id), `aria-describedby="${id}" points at nothing`);
		}
	}
	const section = q(dom, '[data-text-diff]');
	const headingId = section.getAttribute('aria-labelledby');
	assert.ok(headingId && document.getElementById(headingId), 'the section is not labelled by its heading');
	// An h3 under the category's h2; still exactly one heading per tool.
	assert.equal(document.getElementById(headingId!)!.tagName, 'H3');
	assert.equal(section.querySelectorAll('h3.tool__title').length, 1, 'one tool, one heading');

	// The table is a group with a name, and the paragraph that explains how to
	// read a row is reachable from the tool's own heading level.
	const view = q(dom, '[data-diff-view]');
	assert.equal(view.getAttribute('role'), 'group');
	const viewLabel = view.getAttribute('aria-labelledby');
	assert.ok(viewLabel && document.getElementById(viewLabel), 'the table has no accessible name');
	assert.equal(document.getElementById(viewLabel!)!.tagName, 'H4');

	// Both drop targets: a screen-reader name, and the file input inside them.
	for (const side of ['left', 'right']) {
		const zone = q(dom, `[data-diff-${side}-drop]`);
		assert.match(zone.querySelector('.sr-only')?.textContent ?? '', /text file/i);
		assert.equal(zone.querySelectorAll('input[type="file"]').length, 1);
		assert.equal(zone.querySelector('input')?.getAttribute('accept'), TEXT_INPUT_ACCEPT);
	}
	dom.window.close();
});

test('the markup explains the markers, so colour is never the only signal', () => {
	const dom = diffDom();
	// Collapsed: the component wraps its own copy at the editor's width, and a
	// phrase split across two lines is still the phrase a visitor reads.
	/*
	 * The legend was cut to one line with the rest of the page's prose; what it
	 * must still do is name every marker in words, because the rows carry colour
	 * as well and colour alone is not a signal a screen reader or a monochrome
	 * printout can use.
	 */
	const how = text(dom, '#text-diff-view-how').replace(/\s+/g, ' ');
	assert.match(how, /left line, right line/i, 'a row is described in words');
	assert.match(how, /- removed/);
	assert.match(how, /\+ added/);
	assert.match(how, /~ matched with whitespace ignored/, 'even the fold is explained');
	assert.match(how, /no sign for a line both have/, 'and so is the unmarked case');
	// The table scrolls, so a keyboard has to be able to reach it.
	assert.equal(q(dom, '[data-diff-view]').getAttribute('tabindex'), '0');
	// The column captions are visual only: every row says both of its numbers.
	assert.equal(q(dom, '.tool__diff-head').getAttribute('aria-hidden'), 'true');
	dom.window.close();
});

test('the controls render the configured domains, and nothing else', () => {
	const dom = diffDom();

	const rendered = [...q(dom, '[data-diff-view-mode]').querySelectorAll('option')];
	assert.deepEqual(rendered.map((option) => option.getAttribute('value')), [...DIFF_VIEWS]);
	// The option labels carry the trade-off, so they come from config too.
	assert.deepEqual(rendered.map((option) => option.textContent), DIFF_VIEWS.map((view) => DIFF_VIEW_LABEL[view]));
	assert.equal(text(dom, '[data-diff-view-hint]'), DIFF_VIEW_HINT.unified);

	const slider = input<HTMLInputElement>(dom, '[data-diff-context]');
	assert.equal(slider.min, String(context.min));
	assert.equal(slider.max, String(context.max));
	assert.equal(slider.step, String(context.step));
	assert.equal(slider.value, String(context.default));
	assert.equal(text(dom, '[data-diff-context-value]'), `${context.default} lines`);

	assert.equal(input<HTMLInputElement>(dom, '[data-diff-inline-words]').checked, true, 'word marking is on by default');
	assert.equal(input<HTMLInputElement>(dom, '[data-diff-ignore-space]').checked, false, 'folding whitespace is opt-in');

	// The limits the tool refuses on are the limits the page states.
	const sourceHint = text(dom, '#diff-source-hint');
	assert.match(sourceHint, new RegExp(TEXT_INPUT_LABELS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.match(sourceHint, new RegExp(`${(maxFileBytes / (1024 * 1024)).toLocaleString('en-US')} MB`));
	assert.match(sourceHint, new RegExp(maxInputCharacters.toLocaleString('en-US')));
	const note = text(dom, '.tool__note');
	assert.match(note, new RegExp(autoCompareMaxCharacters.toLocaleString('en-US')));
	assert.match(note, new RegExp(maxRenderedRows.toLocaleString('en-US')));
	assert.match(note, /git apply/, 'the patch format is named');

	// No maxlength on either box: it would truncate a paste silently instead of
	// refusing it out loud.
	assert.equal(input<HTMLTextAreaElement>(dom, '[data-diff-left]').maxLength, -1);
	assert.equal(input<HTMLTextAreaElement>(dom, '[data-diff-right]').maxLength, -1);
	dom.window.close();
});

test('the results start hidden with honest placeholders', () => {
	const dom = diffDom();
	assert.equal(q(dom, '[data-diff-results]').hasAttribute('hidden'), true);
	assert.equal(q(dom, '[data-diff-error]').hasAttribute('hidden'), true);
	assert.equal(input<HTMLButtonElement>(dom, '[data-diff-copy]').disabled, true);
	assert.equal(text(dom, '[data-diff-added]'), '0');
	assert.equal(text(dom, '[data-diff-removed]'), '0');
	assert.equal(text(dom, '[data-diff-unchanged]'), '0');
	assert.equal(text(dom, '[data-diff-sections]'), '0');
	assert.equal(rowsOf(dom).length, 0, 'the table is empty, not absent');
	assert.equal(q(dom, '[data-text-diff]').dataset.view, 'unified', 'the CSS has its mode before any script runs');
	// The actions are plain glass buttons: GlassButton would drop the data hooks.
	const actions = q(dom, '.tool__actions');
	assert.equal(actions.querySelectorAll('button.glass-button').length, 3);
	assert.match(actions.querySelector('[data-diff-compare]')!.className, /glass-button--primary/);
	dom.window.close();
});

/* --- the real controller in a real DOM ------------------------------------ */

test('typing into the real markup fills the real table', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	await paste(dom, 'alpha\nbeta\ngamma', 'alpha\nBETA\ngamma\ndelta');

	assert.equal(q(dom, '[data-diff-results]').hasAttribute('hidden'), false);
	assert.equal(text(dom, '[data-diff-removed]'), '1');
	assert.equal(text(dom, '[data-diff-added]'), '2');
	assert.equal(text(dom, '[data-diff-unchanged]'), '2');
	assert.equal(text(dom, '[data-diff-sections]'), '2');

	const rows = rowsOf(dom);
	assert.deepEqual(
		rows.map((row) => row.className),
		[
			'tool__diff-row tool__diff-row--same',
			'tool__diff-row tool__diff-row--del',
			'tool__diff-row tool__diff-row--add',
			'tool__diff-row tool__diff-row--same',
			'tool__diff-row tool__diff-row--add',
		],
	);
	// The gutter is real text: numbers a screen reader reads, and a sign.
	const removed = rows[1]!;
	assert.deepEqual(
		[...removed.children].map((cell) => cell.textContent),
		['2', '', '-', 'beta'],
	);
	const added = rows[2]!;
	assert.deepEqual([...added.children].map((cell) => cell.textContent), ['', '2', '+', 'BETA']);
	assert.equal(removed.querySelectorAll('.tool__diff-piece--del').length, 1, 'the word that moved is marked');
	assert.equal(removed.querySelector('.tool__diff-piece--del')!.textContent, 'beta');
	assert.equal(added.querySelector('.tool__diff-piece--add')!.textContent, 'BETA');
	assert.equal(input<HTMLButtonElement>(dom, '[data-diff-copy]').disabled, false);
});

test('a pasted tag stays text in a real DOM', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	await paste(dom, '<img src=x onerror=window.__ran = true>', '<script>window.__ran = true</script>');
	await tick(30);

	assert.equal(rowsOf(dom).length, 2);
	assert.match(rowTexts(dom)[0]!, /<img src=x onerror=window\.__ran = true>/);
	assert.equal(q(dom, '[data-diff-view]').querySelectorAll('img').length, 0);
	assert.equal(q(dom, '[data-diff-view]').querySelectorAll('script').length, 0);
	assert.equal((dom.window as unknown as { __ran?: boolean }).__ran, undefined, 'nothing executed');
});

test('the view select re-renders the same rows into two columns', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	await paste(dom, 'a\nb\nc', 'a\nX\nc');
	assert.deepEqual(rowsOf(dom).map((row) => row.dataset.col), ['both', 'both', 'both', 'both']);

	const select = input<HTMLSelectElement>(dom, '[data-diff-view-mode]');
	select.value = 'split';
	await change(dom, '[data-diff-view-mode]');

	assert.equal(q(dom, '[data-text-diff]').dataset.view, 'split');
	assert.deepEqual(rowsOf(dom).map((row) => row.dataset.col), ['both', 'left', 'right', 'both']);
	assert.equal(text(dom, '[data-diff-view-hint]'), DIFF_VIEW_HINT.split);
	// The rows are the same rows: a view change moves pixels, not the diff.
	assert.equal(text(dom, '[data-diff-removed]'), '1');
	assert.deepEqual([...rowsOf(dom)[1]!.children].map((cell) => cell.textContent), ['2', '', '-', 'b']);
});

test('the context slider changes what is shown, and says how much is not', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
	await paste(dom, lines.replace('line 15', 'LINE 15'), lines);
	assert.equal(rowsOf(dom).length, 10, '3 lines of context either side, plus two skip rows');
	assert.equal(rowsOf(dom).filter((row) => row.classList.contains('tool__diff-row--skip')).length, 2);
	assert.match(rowTexts(dom)[0]!, /12 unchanged lines not shown/);

	const slider = input<HTMLInputElement>(dom, '[data-diff-context]');
	slider.value = '0';
	slider.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await tick(20);
	assert.equal(text(dom, '[data-diff-context-value]'), '0 lines');
	assert.equal(rowsOf(dom).length, 4, 'the two changed rows and the two runs they hide');
	assert.match(rowTexts(dom)[0]!, /15 unchanged lines not shown/);
});

test('ignoring whitespace re-compares, and still shows what was typed', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	await paste(dom, 'const  total = 1;\nend', 'const total = 1;\nend');
	assert.equal(text(dom, '[data-diff-removed]'), '1');

	const box = input<HTMLInputElement>(dom, '[data-diff-ignore-space]');
	box.checked = true;
	await change(dom, '[data-diff-ignore-space]', TOOL_DIFF_CONFIG.recompareDelayMs + 30);

	assert.equal(text(dom, '[data-diff-removed]'), '0');
	assert.equal(text(dom, '[data-diff-unchanged]'), '2');
	assert.match(rowTexts(dom)[0]!, /const {2}total = 1;/, 'the original spacing is what is on screen');
	// The fold is the tool's doing, so the row says so instead of looking equal.
	assert.equal(rowsOf(dom)[0]!.dataset.ws, 'true');
	assert.match(rowTexts(dom)[0]!, /~/);
	assert.equal(rowsOf(dom)[1]!.dataset.ws, undefined, 'an ordinary unchanged line carries no marker');
});

test('Compare announces, and an over-limit paste refuses out loud', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	await paste(dom, 'a\nb\nc', 'a\nX\nc', false);
	assert.equal(rowsOf(dom).length, 0, 'nothing before the debounce or the button');
	await click(dom, '[data-diff-compare]');
	assert.equal(text(dom, '[data-diff-status]'), '1 removed, 1 added and 2 unchanged, in 1 place.');

	await paste(dom, 'a'.repeat(maxInputCharacters + 1), 'b', false);
	await click(dom, '[data-diff-compare]');
	assert.equal(q(dom, '[data-diff-error]').hasAttribute('hidden'), false);
	assert.match(text(dom, '[data-diff-error]'), /The left text is 250,001 characters/);
	assert.match(text(dom, '[data-diff-error]'), /250,000-character limit/);
	assert.equal(text(dom, '[data-diff-status]'), 'Nothing compared.');
	assert.equal(q(dom, '[data-diff-results]').hasAttribute('hidden'), true, 'no stale rows survive a refusal');
	assert.equal(rowsOf(dom).length, 0);
	assert.equal(text(dom, '[data-diff-added]'), '0');
	assert.equal(input<HTMLButtonElement>(dom, '[data-diff-copy]').disabled, true);
});

test('past the auto-compare threshold the panel clears and says why', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	await paste(dom, 'a\nb', 'a\nX');
	assert.equal(rowsOf(dom).length, 3);

	const leftBox = input<HTMLTextAreaElement>(dom, '[data-diff-left]');
	leftBox.value = 'a'.repeat(autoCompareMaxCharacters + 1);
	leftBox.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await tick(20);
	assert.equal(rowsOf(dom).length, 0);
	assert.equal(q(dom, '[data-diff-results]').hasAttribute('hidden'), true);
	assert.match(text(dom, '[data-diff-status]'), /over 20,000 characters/);
	assert.match(text(dom, '[data-diff-status]'), /Press Compare/);
});

test('Reset empties both boxes, the controls and the table', async (t) => {
	const dom = diffDom();
	mount(t, dom);
	await paste(dom, 'a\nb', 'a\nX');
	assert.equal(rowsOf(dom).length, 3);
	const select = input<HTMLSelectElement>(dom, '[data-diff-view-mode]');
	select.value = 'split';
	await change(dom, '[data-diff-view-mode]');

	await click(dom, '[data-diff-reset]');
	assert.equal(input<HTMLTextAreaElement>(dom, '[data-diff-left]').value, '');
	assert.equal(input<HTMLTextAreaElement>(dom, '[data-diff-right]').value, '');
	assert.equal(text(dom, '[data-diff-left-meta]'), '');
	assert.equal(text(dom, '[data-diff-right-meta]'), '');
	assert.equal(rowsOf(dom).length, 0);
	assert.equal(q(dom, '[data-diff-results]').hasAttribute('hidden'), true);
	assert.equal(q(dom, '[data-diff-error]').hasAttribute('hidden'), true);
	assert.equal(text(dom, '[data-diff-removed]'), '0');
	assert.equal(select.value, 'unified');
	assert.equal(q(dom, '[data-text-diff]').dataset.view, 'unified');
	assert.equal(input<HTMLInputElement>(dom, '[data-diff-context]').value, String(context.default));
	assert.equal(text(dom, '[data-diff-context-value]'), `${context.default} lines`);
	assert.equal(input<HTMLInputElement>(dom, '[data-diff-inline-words]').checked, true);
	assert.equal(input<HTMLInputElement>(dom, '[data-diff-ignore-space]').checked, false);
	assert.equal(input<HTMLButtonElement>(dom, '[data-diff-copy]').disabled, true);
	assert.equal(text(dom, '[data-diff-status]'), 'Paste two texts, or drop two files. Nothing leaves this tab.');
});

test('the copy button reports what the clipboard really did', async (t) => {
	const dom = diffDom();
	mount(t, dom);

	// jsdom implements no clipboard, which is the same position as an insecure
	// context: the tool must not claim a patch that did not go anywhere.
	assert.equal(typeof (dom.window.navigator as unknown as { clipboard?: unknown }).clipboard, 'undefined');
	await paste(dom, 'a\nb\nc', 'a\nX\nc');
	await click(dom, '[data-diff-copy]');
	assert.match(text(dom, '[data-diff-status]'), /no clipboard API/);

	const written: string[] = [];
	Object.defineProperty(dom.window.navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (value: string) => {
				written.push(value);
			},
		},
	});
	await click(dom, '[data-diff-copy]');
	assert.equal(written.length, 1);
	assert.equal(
		written[0],
		['--- left', '+++ right', '@@ -1,3 +1,3 @@', ' a', '-b', '+X', ' c'].join('\n'),
		'the clipboard gets the patch, not a description of it',
	);
	assert.equal(text(dom, '[data-diff-status]'), 'Patch copied — 1 removed, 1 added, 1 hunk.');
});
