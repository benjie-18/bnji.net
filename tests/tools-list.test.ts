/**
 * BNJI.NET — /projects/tools/ List Randomizer tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	parseList,
	shuffleList,
	formatList,
} from '../src/scripts/tools-list.ts';

type Dom = ReturnType<typeof installTestDom>;
type ListModule = typeof import('../src/scripts/tools-list.ts');

let listMod: ListModule | null = null;

async function getModule(): Promise<ListModule> {
	if (!listMod) listMod = await import('../src/scripts/tools-list.ts');
	return listMod;
}

function buildFixture(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-list-randomizer', '');

	const hooks: Record<string, string> = {
		'data-list-input': 'textarea',
		'data-list-trim': 'input',
		'data-list-blank': 'input',
		'data-list-dupe': 'input',
		'data-list-numbers': 'input',
		'data-list-shuffle': 'button',
		'data-list-reverse': 'button',
		'data-list-sort-az': 'button',
		'data-list-sort-za': 'button',
		'data-list-copy': 'button',
		'data-list-clear': 'button',
		'data-list-status': 'p',
		'data-list-error': 'p',
		'data-list-output': 'textarea',
		'data-list-results': 'div',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const el = document.createElement(tag);
		el.setAttribute(hook, '');
		section.appendChild(el);
	}

	document.body.appendChild(section);
}

test('parseList handles whitespace, blank lines, and duplicates', () => {
	const raw = '  Apple \n\n Banana \n Apple \n Cherry  ';
	const parsed = parseList(raw, {
		trimWhitespace: true,
		removeBlankLines: true,
		removeDuplicates: true,
	});

	assert.deepEqual(parsed, ['Apple', 'Banana', 'Cherry']);
});

test('shuffleList preserves list elements', () => {
	const original = ['One', 'Two', 'Three', 'Four', 'Five'];
	const shuffled = shuffleList(original);

	assert.equal(shuffled.length, original.length);
	assert.deepEqual([...shuffled].sort(), [...original].sort());
});

test('formatList applies line numbers when requested', () => {
	const items = ['Cat', 'Dog'];
	const plain = formatList(items, { addLineNumbers: false });
	assert.equal(plain, 'Cat\nDog');

	const numbered = formatList(items, { addLineNumbers: true });
	assert.equal(numbered, '1. Cat\n2. Dog');
});

test('destroyListRandomizer cleans up listeners and re-arms init', async () => {
	const dom = installTestDom();
	buildFixture(dom);
	const { initListRandomizer, destroyListRandomizer } = await getModule();

	initListRandomizer();
	const before = dom.listenerCount();
	destroyListRandomizer();
	const after = dom.listenerCount();

	assert.ok(after < before, 'destroy freed event listeners');

	initListRandomizer();
	assert.equal(dom.listenerCount(), before);
	destroyListRandomizer();
});
