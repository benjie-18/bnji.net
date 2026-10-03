/**
 * BNJI.NET — /tools/ Random Number & Item Picker tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	generateRandomNumbers,
	pickRandomItems,
	getRandomInt,
} from '../src/scripts/tools-random.ts';

type Dom = ReturnType<typeof installTestDom>;
type RandomModule = typeof import('../src/scripts/tools-random.ts');

let randModule: RandomModule | null = null;

async function getModule(): Promise<RandomModule> {
	if (!randModule) randModule = await import('../src/scripts/tools-random.ts');
	return randModule;
}

function buildFixture(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-random-picker', '');

	const hooks: Record<string, string> = {
		'data-random-mode': 'select',
		'data-random-number-section': 'div',
		'data-random-item-section': 'div',
		'data-random-min': 'input',
		'data-random-max': 'input',
		'data-random-num-count': 'input',
		'data-random-num-dupes': 'input',
		'data-random-num-sort': 'input',
		'data-random-items': 'textarea',
		'data-random-item-count': 'input',
		'data-random-item-dupes': 'input',
		'data-random-generate': 'button',
		'data-random-reset': 'button',
		'data-random-status': 'p',
		'data-random-error': 'p',
		'data-random-results': 'div',
		'data-random-output-list': 'div',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const el = document.createElement(tag);
		el.setAttribute(hook, '');
		section.appendChild(el);
	}

	document.body.appendChild(section);
}

test('getRandomInt produces numbers within [min, max]', () => {
	for (let i = 0; i < 50; i++) {
		const val = getRandomInt(5, 10);
		assert.ok(val >= 5 && val <= 10);
	}
});

test('generateRandomNumbers creates requested quantity and honors bounds', () => {
	const res = generateRandomNumbers(1, 10, 5, true, true);
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.equal(res.numbers.length, 5);
	for (const num of res.numbers) {
		assert.ok(num >= 1 && num <= 10);
	}
	// Verify sorted
	const sorted = [...res.numbers].sort((a, b) => a - b);
	assert.deepEqual(res.numbers, sorted);
});

test('generateRandomNumbers rejects invalid min/max or impossible unique requests', () => {
	const minMaxRes = generateRandomNumbers(10, 5, 1, true, false);
	assert.equal(minMaxRes.ok, false);

	const impossibleRes = generateRandomNumbers(1, 3, 5, false, false);
	assert.equal(impossibleRes.ok, false);
	if (!impossibleRes.ok) assert.match(impossibleRes.error, /unique/i);
});

test('pickRandomItems picks items from multiline string', () => {
	const text = 'Alpha\nBeta\nGamma\nDelta';
	const res = pickRandomItems(text, 2, false);
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.equal(res.items.length, 2);
	for (const item of res.items) {
		assert.ok(['Alpha', 'Beta', 'Gamma', 'Delta'].includes(item));
	}
});

test('pickRandomItems rejects empty list or oversized unique picks', () => {
	const emptyRes = pickRandomItems('', 1, false);
	assert.equal(emptyRes.ok, false);

	const impossibleRes = pickRandomItems('One\nTwo', 5, false);
	assert.equal(impossibleRes.ok, false);
});

test('destroyRandomPicker cleans up listeners and re-arms init', async () => {
	const dom = installTestDom();
	buildFixture(dom);
	const { initRandomPicker, destroyRandomPicker } = await getModule();

	initRandomPicker();
	const before = dom.listenerCount();
	destroyRandomPicker();
	const after = dom.listenerCount();

	assert.ok(after < before, 'destroy freed event listeners');

	initRandomPicker();
	assert.equal(dom.listenerCount(), before);
	destroyRandomPicker();
});
