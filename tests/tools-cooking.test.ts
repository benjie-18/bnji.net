/**
 * BNJI.NET — /tools/ cooking unit converter tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	convertCookingValue,
	formatCookingNumber,
	getCookingUnit,
} from '../src/scripts/tools-cooking.ts';

type Dom = ReturnType<typeof installTestDom>;
type CookingModule = typeof import('../src/scripts/tools-cooking.ts');

let cookingModule: CookingModule | null = null;

async function getModule(): Promise<CookingModule> {
	if (!cookingModule) cookingModule = await import('../src/scripts/tools-cooking.ts');
	return cookingModule;
}

function buildCookingDom(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-cooking-converter', '');

	const hooks: Record<string, string> = {
		'data-cooking-amount': 'input',
		'data-cooking-from': 'select',
		'data-cooking-to': 'select',
		'data-cooking-ingredient': 'select',
		'data-cooking-swap': 'button',
		'data-cooking-reset': 'button',
		'data-cooking-status': 'p',
		'data-cooking-error': 'p',
		'data-cooking-results': 'div',
		'data-cooking-output-value': 'p',
		'data-cooking-output-meta': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}

	document.body.appendChild(section);
}

test('getCookingUnit retrieves registered unit details', () => {
	const cup = getCookingUnit('cup');
	assert.ok(cup);
	assert.equal(cup.category, 'volume');

	const gram = getCookingUnit('g');
	assert.ok(gram);
	assert.equal(gram.category, 'weight');
});

test('convertCookingValue converts same-category volume units directly', () => {
	const res = convertCookingValue(1, 'cup', 'tbsp');
	assert.ok(res);
	assert.equal(res.requiresDensity, false);
	assert.ok(Math.abs(res.value - 16) < 0.1);
});

test('convertCookingValue converts same-category weight units directly', () => {
	const res = convertCookingValue(1, 'kg', 'g');
	assert.ok(res);
	assert.equal(res.requiresDensity, false);
	assert.equal(res.value, 1000);
});

test('convertCookingValue converts cross-category volume-to-weight using density', () => {
	const res = convertCookingValue(1, 'cup', 'g', 'flour_ap');
	assert.ok(res);
	assert.equal(res.requiresDensity, true);
	// 1 US cup (~236.588 ml) * ~0.53 g/ml flour ~= 125.39 g
	assert.ok(res.value > 120 && res.value < 130);
});

test('convertCookingValue rejects invalid numbers or negative values', () => {
	assert.equal(convertCookingValue(-5, 'cup', 'g'), null);
	assert.equal(convertCookingValue(Number.NaN, 'cup', 'g'), null);
});

test('formatCookingNumber produces readable output strings', () => {
	assert.equal(formatCookingNumber(0), '0');
	assert.equal(formatCookingNumber(1000), '1,000');
});

test('Cooking converter DOM controller teardown releases listeners', async () => {
	const dom = installTestDom();
	buildCookingDom(dom);
	const { initCookingConverter, destroyCookingConverter } = await getModule();

	initCookingConverter();
	const initialListeners = dom.listenerCount();
	assert.ok(initialListeners > 0);

	destroyCookingConverter();
	assert.ok(dom.listenerCount() < initialListeners);
});
