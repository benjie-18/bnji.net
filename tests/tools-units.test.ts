/**
 * BNJI.NET — /projects/tools/ Unit Converter tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	convertUnits,
	formatConversionFormula,
} from '../src/scripts/tools-units.ts';

type Dom = ReturnType<typeof installTestDom>;
type UnitsModule = typeof import('../src/scripts/tools-units.ts');

let unitsModule: UnitsModule | null = null;

async function units(): Promise<UnitsModule> {
	if (!unitsModule) unitsModule = await import('../src/scripts/tools-units.ts');
	return unitsModule;
}

function buildUnitsComponent(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-unit-converter', '');

	const hooks: Record<string, string> = {
		'data-unit-category': 'select',
		'data-unit-from-type': 'select',
		'data-unit-to-type': 'select',
		'data-unit-from-value': 'input',
		'data-unit-to-value': 'input',
		'data-unit-swap': 'button',
		'data-unit-reset': 'button',
		'data-unit-formula': 'p',
		'data-unit-status': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}

	document.body.appendChild(section);
}

test('convertUnits converts length accurately', () => {
	assert.equal(convertUnits(1, 'length', 'm', 'cm'), 100);
	assert.equal(convertUnits(1, 'length', 'km', 'm'), 1000);
	assert.equal(convertUnits(1, 'length', 'in', 'mm'), 25.4);
	assert.equal(convertUnits(1, 'length', 'ft', 'in'), 12);
});

test('convertUnits converts mass accurately', () => {
	assert.equal(convertUnits(1, 'mass', 'kg', 'g'), 1000);
	assert.equal(convertUnits(1000, 'mass', 'g', 'kg'), 1);
	assert.equal(convertUnits(1, 'mass', 't', 'kg'), 1000);
});

test('convertUnits converts temperature accurately including edge cases', () => {
	assert.equal(convertUnits(0, 'temperature', 'c', 'f'), 32);
	assert.equal(convertUnits(100, 'temperature', 'c', 'f'), 212);
	assert.equal(convertUnits(0, 'temperature', 'c', 'k'), 273.15);
	assert.equal(convertUnits(32, 'temperature', 'f', 'c'), 0);
	assert.equal(convertUnits(273.15, 'temperature', 'k', 'c'), 0);
});

test('convertUnits converts data storage accurately', () => {
	assert.equal(convertUnits(1024, 'data', 'b', 'kb'), 1);
	assert.equal(convertUnits(1, 'data', 'gb', 'mb'), 1024);
	assert.equal(convertUnits(1, 'data', 'tb', 'gb'), 1024);
});

test('convertUnits handles invalid inputs gracefully', () => {
	assert.equal(convertUnits(Number.NaN, 'length', 'm', 'cm'), null);
	assert.equal(convertUnits(Infinity, 'mass', 'kg', 'g'), null);
});

test('formatConversionFormula creates clear explanatory strings', () => {
	const formulaTemp = formatConversionFormula(0, 'temperature', 'c', 'f', 32);
	assert.equal(formulaTemp, '0°C × (9/5) + 32 = 32°F');

	const formulaLen = formatConversionFormula(1, 'length', 'm', 'cm', 100);
	assert.equal(formulaLen, '1 m × 100 = 100 cm');
});

test('destroyUnitConverter releases bound event listeners', async () => {
	const dom = installTestDom();
	buildUnitsComponent(dom);
	const { initUnitConverter, destroyUnitConverter } = await units();

	initUnitConverter();
	const before = dom.listenerCount();

	destroyUnitConverter();
	const after = dom.listenerCount();
	assert.ok(after < before);

	initUnitConverter();
	assert.equal(dom.listenerCount(), before);
	destroyUnitConverter();
});

test('initUnitConverter is idempotent', async () => {
	const dom = installTestDom();
	buildUnitsComponent(dom);
	const { initUnitConverter, destroyUnitConverter } = await units();

	initUnitConverter();
	const once = dom.listenerCount();
	initUnitConverter();
	assert.equal(dom.listenerCount(), once);
	destroyUnitConverter();
});
