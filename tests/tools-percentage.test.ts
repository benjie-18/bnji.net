/**
 * BNJI.NET — /projects/tools/ Percentage Calculator tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	calculatePercentage,
} from '../src/scripts/tools-percentage.ts';

type Dom = ReturnType<typeof installTestDom>;
type PercentageModule = typeof import('../src/scripts/tools-percentage.ts');

let percentageModule: PercentageModule | null = null;

async function percentage(): Promise<PercentageModule> {
	if (!percentageModule) percentageModule = await import('../src/scripts/tools-percentage.ts');
	return percentageModule;
}

function buildPercentageComponent(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-percentage-calculator', '');

	const hooks: Record<string, string> = {
		'data-percentage-mode': 'select',
		'data-percentage-x': 'input',
		'data-percentage-y': 'input',
		'data-percentage-x-label': 'label',
		'data-percentage-y-label': 'label',
		'data-percentage-result': 'p',
		'data-percentage-formula': 'p',
		'data-percentage-copy': 'button',
		'data-percentage-reset': 'button',
		'data-percentage-status': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}

	document.body.appendChild(section);
}

test('calculatePercentage mode "of" calculates X% of Y', () => {
	const res = calculatePercentage('of', 15, 200);
	assert.equal(res.ok, true);
	assert.equal(res.value, 30);
	assert.match(res.formula, /\(15% × 200\) \/ 100 = 30/);
});

test('calculatePercentage mode "is-what" calculates X as % of Y', () => {
	const res = calculatePercentage('is-what', 25, 100);
	assert.equal(res.ok, true);
	assert.equal(res.value, 25);
	assert.equal(res.formattedResult, '25%');

	const divZero = calculatePercentage('is-what', 25, 0);
	assert.equal(divZero.ok, false);
	assert.equal(divZero.error, 'Division by zero.');
});

test('calculatePercentage mode "change" calculates % change', () => {
	const inc = calculatePercentage('change', 50, 75);
	assert.equal(inc.ok, true);
	assert.equal(inc.value, 50);
	assert.match(inc.formattedResult, /\+50%/);

	const dec = calculatePercentage('change', 100, 80);
	assert.equal(dec.ok, true);
	assert.equal(dec.value, -20);
	assert.match(dec.formattedResult, /-20%/);

	const zeroBase = calculatePercentage('change', 0, 50);
	assert.equal(zeroBase.ok, false);
});

test('calculatePercentage mode "increase-decrease" calculates markup & discount', () => {
	const res = calculatePercentage('increase-decrease', 10, 100);
	assert.equal(res.ok, true);
	assert.equal(res.value, 110);
	assert.equal(res.secondaryValue, 90);
});

test('calculatePercentage handles non-finite inputs gracefully', () => {
	const res = calculatePercentage('of', Number.NaN, 100);
	assert.equal(res.ok, false);
	assert.equal(res.error, 'Invalid input numbers.');
});

test('destroyPercentageCalculator releases bound event listeners', async () => {
	const dom = installTestDom();
	buildPercentageComponent(dom);
	const { initPercentageCalculator, destroyPercentageCalculator } = await percentage();

	initPercentageCalculator();
	const before = dom.listenerCount();

	destroyPercentageCalculator();
	const after = dom.listenerCount();
	assert.ok(after < before);

	initPercentageCalculator();
	assert.equal(dom.listenerCount(), before);
	destroyPercentageCalculator();
});

test('initPercentageCalculator is idempotent', async () => {
	const dom = installTestDom();
	buildPercentageComponent(dom);
	const { initPercentageCalculator, destroyPercentageCalculator } = await percentage();

	initPercentageCalculator();
	const once = dom.listenerCount();
	initPercentageCalculator();
	assert.equal(dom.listenerCount(), once);
	destroyPercentageCalculator();
});
