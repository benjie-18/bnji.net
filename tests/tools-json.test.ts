/**
 * BNJI.NET — the /tools/ JSON formatter's behaviour.
 *
 * The interesting half of this tool is what it refuses to do: a malformed paste
 * must survive the failed parse, and the error must point at a line and column
 * rather than saying "invalid JSON". Those are exactly the things a
 * pure-function test cannot reach, so this file drives the real controller
 * against the DOM shim in tests/support/dom.mjs.
 *
 * The markup below mirrors JsonFormatter.astro's selectors, so a rename in the
 * component fails here instead of silently matching nothing.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installTestDom } from './support/dom.mjs';
import {
	findJsonErrorOffset,
	formatJsonText,
	lineAndColumn,
	offsetOfLineColumn,
} from '../src/scripts/tools-json.ts';

type Dom = ReturnType<typeof installTestDom>;
type JsonModule = typeof import('../src/scripts/tools-json.ts');

let jsonModule: JsonModule | null = null;
let active: Dom | null = null;

async function json(): Promise<JsonModule> {
	if (!jsonModule) jsonModule = await import('../src/scripts/tools-json.ts');
	return jsonModule;
}

/** The tool's markup, mirroring src/components/tools/JsonFormatter.astro. */
function buildFormatter(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-json-formatter', '');

	const editor = document.createElement('textarea');
	editor.setAttribute('data-json-editor', '');
	section.appendChild(editor);

	for (const action of ['format', 'minify', 'copy', 'clear']) {
		const button = document.createElement('button');
		button.setAttribute('data-json-', action);
		button.setAttribute('data-json-' + action, '');
		section.appendChild(button);
	}

	const status = document.createElement('p');
	status.setAttribute('data-json-status', '');
	section.appendChild(status);

	const error = document.createElement('p');
	error.setAttribute('data-json-error', '');
	error.hidden = true;
	section.appendChild(error);

	const note = document.createElement('p');
	note.setAttribute('data-json-note', '');
	note.hidden = true;
	section.appendChild(note);

	document.body.appendChild(section);
}

/** Boot the tool against a fresh DOM and an empty editor. */
async function boot(initial = ''): Promise<Dom> {
	const dom = installTestDom();
	buildFormatter(dom);
	const { initJsonFormatter } = await json();
	initJsonFormatter();
	const editor = dom.q('[data-json-editor]');
	if (editor) editor.value = initial;
	active = dom;
	return dom;
}

/** Click an action and let the copy path's microtasks settle. */
async function act(dom: Dom, action: string): Promise<void> {
	dom.q(`[data-json-${action}]`)?.dispatchEvent({ type: 'click' });
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

const status = (dom: Dom): string => dom.q('[data-json-status]')?.textContent ?? '';
const error = (dom: Dom): string => dom.q('[data-json-error]')?.textContent ?? '';
const errorHidden = (dom: Dom): boolean => dom.q('[data-json-error]')?.hidden ?? true;
const note = (dom: Dom): string => dom.q('[data-json-note]')?.textContent ?? '';
const value = (dom: Dom): string => dom.q('[data-json-editor]')?.value ?? '';

/* --- the walker behind the line/column promise --------------------------- */

test('valid documents are reported as valid, not as an offset', () => {
	for (const text of ['{}', '[]', 'null', '42', '"x"', '{"a":[1,{"b":null}]}', ' \n\t{"a":1} ']) {
		assert.equal(findJsonErrorOffset(text), null, text);
	}
});

test('the walker finds the offset a browser that reports none would omit', () => {
	// Modern V8 gives no position for these, so this is the path that produces
	// the line/column the page promises.
	assert.equal(findJsonErrorOffset('nope'), 0);
	assert.equal(findJsonErrorOffset('[1,2,]'), 5);
	assert.equal(findJsonErrorOffset('{"a" 1}'), 5);
	assert.equal(findJsonErrorOffset('{"a":01}'), 6);
	assert.equal(findJsonErrorOffset('{"a":1'), 6);
	assert.equal(findJsonErrorOffset(''), 0);
	assert.equal(findJsonErrorOffset('{} {}'), 3);
	// The unclosed brace: the offset lands just past it, which is where the
	// missing property name belongs.
	assert.equal(findJsonErrorOffset('{'), 1);
	assert.equal(findJsonErrorOffset('{"a":[1,2}'), 9);
});

test('the walker agrees with V8 wherever V8 reports a position', () => {
	// This is the property that keeps the two code paths from disagreeing: the
	// walker is only used when the browser says nothing, so it has to land on
	// the same offset when the browser does speak.
	const texts = ['{"a" 1}', '{"a":01}', '{"a":1', '{} {}', '[1 2]'];
	for (const text of texts) {
		let reported: number | null = null;
		try {
			JSON.parse(text);
		} catch (error) {
			const match = /position (\d+)/.exec((error as Error).message);
			reported = match ? Number(match[1]) : null;
		}
		assert.equal(findJsonErrorOffset(text), reported, text);
	}
});

test('offsets and line/column round-trip', () => {
	const text = '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}';
	assert.deepEqual(lineAndColumn(text, 0), { line: 1, column: 1 });
	assert.deepEqual(lineAndColumn(text, 14), { line: 3, column: 3 });
	assert.deepEqual(lineAndColumn(text, 999), { line: 6, column: 2 });
	for (const offset of [0, 5, 11, 14, 20, text.length]) {
		const { line, column } = lineAndColumn(text, offset);
		assert.equal(offsetOfLineColumn(text, line, column), offset);
	}
});

test('the formatter reports the shape of what it parsed', () => {
	assert.equal(formatJsonText('{"a":1,"b":2}').ok, true);
	const outcome = formatJsonText('[1]');
	assert.ok(outcome.ok);
	if (outcome.ok) assert.equal(outcome.shape, 'an array of 1 item');
	const failure = formatJsonText('{');
	assert.equal(failure.ok, false);
	if (!failure.ok) assert.match(failure.error, /^Line 1, column 2 — /);
});

afterEach(() => {
	jsonModule?.destroyJsonFormatter();
	active?.uninstall();
	active = null;
});

/* --- states -------------------------------------------------------------- */

test('an empty editor starts in the empty state, with no error', async () => {
	const dom = await boot();
	assert.equal(value(dom), '');
	assert.match(status(dom), /^Empty/);
	assert.equal(errorHidden(dom), true);
	assert.equal(error(dom), '');
});

test('Format on empty input reports the empty state instead of failing', async () => {
	const dom = await boot('   ');
	await act(dom, 'format');
	assert.match(status(dom), /^Empty/);
	assert.equal(errorHidden(dom), true);
	// Whitespace is not a document; the editor is left exactly as it was.
	assert.equal(value(dom), '   ');
});

/* --- the happy paths ----------------------------------------------------- */

test('Format pretty-prints and describes what it parsed', async () => {
	const dom = await boot('{"a":1,"b":[2,3],"c":{"d":true}}');
	await act(dom, 'format');
	assert.equal(value(dom), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ],\n  "c": {\n    "d": true\n  }\n}');
	assert.match(status(dom), /^Formatted — valid JSON, an object with 3 keys/);
	assert.equal(errorHidden(dom), true);
});

test('Minify collapses onto one line', async () => {
	const dom = await boot('{\n  "a": 1,\n  "b": [ 2, 3 ]\n}');
	await act(dom, 'minify');
	assert.equal(value(dom), '{"a":1,"b":[2,3]}');
	assert.match(status(dom), /^Minified — valid JSON/);
});

test('a top-level scalar is a valid document, not an error', async () => {
	const dom = await boot('42');
	await act(dom, 'format');
	assert.equal(value(dom), '42');
	assert.match(status(dom), /the number 42/);
});

test('Clear empties the editor and returns to the empty state', async () => {
	const dom = await boot('{"a":1}');
	await act(dom, 'format');
	await act(dom, 'clear');
	assert.equal(value(dom), '');
	assert.match(status(dom), /^Empty/);
	assert.equal(errorHidden(dom), true);
});

/* --- the failure paths --------------------------------------------------- */

test('malformed JSON is kept character for character, with a line and column', async () => {
	const source = '{\n  "a": 1,\n  "b": 2,\n}';
	const dom = await boot(source);
	await act(dom, 'format');

	assert.equal(value(dom), source, 'a failed parse must not touch the input');
	assert.equal(errorHidden(dom), false);
	// The trailing comma is on line 4, and the column points at the closing
	// brace that cannot follow it.
	assert.match(error(dom), /^Line 4, column 1 — /);
	assert.match(status(dom), /unchanged/);
});

test('an unterminated string is reported where the newline broke it', async () => {
	// V8 names the offending control character, which is more precise than the
	// opening quote this tool's own walker would point at.
	const dom = await boot('{\n  "a": "oops\n}');
	await act(dom, 'format');
	assert.equal(value(dom), '{\n  "a": "oops\n}');
	assert.match(error(dom), /^Line 2, column 13 — /);
});

test('a non-JSON paste is reported without being discarded', async () => {
	const dom = await boot('not json at all');
	await act(dom, 'minify');
	assert.equal(value(dom), 'not json at all');
	assert.match(error(dom), /^Line 1, column 1 — /);
});

test('trailing content after a complete value is an error', async () => {
	const dom = await boot('{} {}');
	await act(dom, 'format');
	assert.equal(value(dom), '{} {}');
	assert.match(error(dom), /^Line 1, column 4 — /);
});

test('a duplicate key is valid JSON and is formatted, not rejected', async () => {
	const dom = await boot('{"a":1,"a":2}');
	await act(dom, 'format');
	assert.match(status(dom), /^Formatted/);
	assert.equal(errorHidden(dom), true);
});

test('an error is cleared by the next successful parse', async () => {
	const dom = await boot('{"a":}');
	await act(dom, 'format');
	assert.equal(errorHidden(dom), false);

	const editor = dom.q('[data-json-editor]');
	if (editor) editor.value = '{"a":1}';
	await act(dom, 'format');
	assert.equal(errorHidden(dom), true);
	assert.equal(error(dom), '');
});

/* --- copy ---------------------------------------------------------------- */

test('Copy without a clipboard selects the text and says what to press', async () => {
	const dom = await boot('{"a":1}');
	await act(dom, 'copy');
	// No navigator.clipboard and no execCommand in the shim, so the fallback
	// note is the path that must be taken — and it must name the keystroke.
	assert.match(note(dom), /Ctrl or ⌘ \+ C/);
	assert.match(status(dom), /keystroke/);
});

test('Copy on an empty editor says there is nothing to copy', async () => {
	const dom = await boot('');
	await act(dom, 'copy');
	assert.match(status(dom), /Nothing to copy/);
	assert.equal(note(dom), '');
});
