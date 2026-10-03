/**
 * BNJI.NET — /tools/ date difference calculator tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	addOrSubtractDate,
	calculateDateDifference,
	formatDateHuman,
	formatDateIso,
	parseDateInput,
} from '../src/scripts/tools-date-difference.ts';

type Dom = ReturnType<typeof installTestDom>;
type DateModule = typeof import('../src/scripts/tools-date-difference.ts');

let dateModule: DateModule | null = null;

async function getModule(): Promise<DateModule> {
	if (!dateModule) dateModule = await import('../src/scripts/tools-date-difference.ts');
	return dateModule;
}

function buildDateCalculatorDom(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-date-calculator', '');

	const hooks: Record<string, string> = {
		'data-date-mode': 'select',
		'data-date-diff-section': 'div',
		'data-date-start': 'input',
		'data-date-end': 'input',
		'data-date-include-end': 'input',
		'data-date-add-section': 'div',
		'data-date-base': 'input',
		'data-date-op': 'select',
		'data-date-amount': 'input',
		'data-date-unit': 'select',
		'data-date-today-start': 'button',
		'data-date-today-end': 'button',
		'data-date-today-base': 'button',
		'data-date-calculate': 'button',
		'data-date-reset': 'button',
		'data-date-status': 'p',
		'data-date-error': 'p',
		'data-date-results': 'div',
		'data-date-output-ymd': 'p',
		'data-date-output-totals': 'p',
		'data-date-output-add': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}

	document.body.appendChild(section);
}

test('parseDateInput handles valid and invalid date strings', () => {
	assert.ok(parseDateInput('2024-01-01'));
	assert.equal(parseDateInput(''), null);
	assert.equal(parseDateInput('invalid-date'), null);
});

test('formatDateIso formats dates to YYYY-MM-DD', () => {
	const d = new Date(2024, 0, 15);
	assert.equal(formatDateIso(d), '2024-01-15');
});

test('calculateDateDifference calculates exact YMD and total units', () => {
	const res = calculateDateDifference('2024-01-01', '2025-03-15');
	assert.ok(res);
	assert.equal(res.years, 1);
	assert.equal(res.months, 2);
	assert.equal(res.days, 14);
	assert.equal(res.totalDays, 439);
	assert.equal(res.isNegative, false);
});

test('calculateDateDifference handles reversed date order safely', () => {
	const res = calculateDateDifference('2025-03-15', '2024-01-01');
	assert.ok(res);
	assert.equal(res.isNegative, true);
	assert.equal(res.years, 1);
});

test('calculateDateDifference accounts for includeEndDay option', () => {
	const resNormal = calculateDateDifference('2024-01-01', '2024-01-02', false);
	const resInc = calculateDateDifference('2024-01-01', '2024-01-02', true);

	assert.ok(resNormal && resInc);
	assert.equal(resNormal.totalDays, 1);
	assert.equal(resInc.totalDays, 2);
});

test('addOrSubtractDate correctly adds and subtracts units', () => {
	const addRes = addOrSubtractDate('2024-01-01', 10, 'days', 'add');
	assert.ok(addRes);
	assert.equal(addRes.dateString, '2024-01-11');

	const subRes = addOrSubtractDate('2024-01-01', 2, 'weeks', 'subtract');
	assert.ok(subRes);
	assert.equal(subRes.dateString, '2023-12-18');
});

test('Date difference DOM controller teardown releases listeners and resets state', async () => {
	const dom = installTestDom();
	buildDateCalculatorDom(dom);
	const { initDateDifferenceCalculator, destroyDateDifferenceCalculator } = await getModule();

	initDateDifferenceCalculator();
	const initialListeners = dom.listenerCount();
	assert.ok(initialListeners > 0);

	destroyDateDifferenceCalculator();
	assert.ok(dom.listenerCount() < initialListeners);
});
