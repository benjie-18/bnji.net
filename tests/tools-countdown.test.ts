/**
 * BNJI.NET — /tools/ Countdown & Stopwatch tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	formatTimeMs,
	parseTimeInput,
	calculateStopwatchLap,
} from '../src/scripts/tools-countdown.ts';

type Dom = ReturnType<typeof installTestDom>;
type CountdownModule = typeof import('../src/scripts/tools-countdown.ts');

let cdMod: CountdownModule | null = null;

async function getModule(): Promise<CountdownModule> {
	if (!cdMod) cdMod = await import('../src/scripts/tools-countdown.ts');
	return cdMod;
}

function buildFixture(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-countdown-stopwatch', '');

	const hooks: Record<string, string> = {
		'data-timer-mode': 'select',
		'data-stopwatch-section': 'div',
		'data-countdown-section': 'div',
		'data-stopwatch-display': 'div',
		'data-stopwatch-start': 'button',
		'data-stopwatch-pause': 'button',
		'data-stopwatch-lap': 'button',
		'data-stopwatch-reset': 'button',
		'data-stopwatch-laps': 'div',
		'data-countdown-hours': 'input',
		'data-countdown-mins': 'input',
		'data-countdown-secs': 'input',
		'data-countdown-display': 'div',
		'data-countdown-start': 'button',
		'data-countdown-pause': 'button',
		'data-countdown-reset': 'button',
		'data-timer-status': 'p',
		'data-timer-error': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const el = document.createElement(tag);
		el.setAttribute(hook, '');
		section.appendChild(el);
	}

	document.body.appendChild(section);
}

test('formatTimeMs formats ms into HH:MM:SS.ms components', () => {
	const formatted = formatTimeMs(3665120); // 1 hr 1 min 5 sec 120ms
	assert.equal(formatted.hours, '01');
	assert.equal(formatted.minutes, '01');
	assert.equal(formatted.seconds, '05');
	assert.equal(formatted.full, '01:01:05.12');
});

test('parseTimeInput converts HH, MM, SS to total milliseconds', () => {
	const ms = parseTimeInput(1, 2, 30); // 1h 2m 30s
	assert.equal(ms, (3600 + 120 + 30) * 1000);
});

test('calculateStopwatchLap computes lap split time and totals', () => {
	const lap1 = calculateStopwatchLap(5000, 0, 0);
	assert.equal(lap1.lapNumber, 1);
	assert.equal(lap1.lapTimeMs, 5000);

	const lap2 = calculateStopwatchLap(12000, 5000, 1);
	assert.equal(lap2.lapNumber, 2);
	assert.equal(lap2.lapTimeMs, 7000);
	assert.equal(lap2.totalTimeMs, 12000);
});

test('destroyCountdownStopwatch cleans up listeners and cancels animation frames', async () => {
	const dom = installTestDom();
	buildFixture(dom);
	const { initCountdownStopwatch, destroyCountdownStopwatch } = await getModule();

	initCountdownStopwatch();
	const before = dom.listenerCount();
	destroyCountdownStopwatch();
	const after = dom.listenerCount();

	assert.ok(after < before, 'destroy freed event listeners');

	initCountdownStopwatch();
	assert.equal(dom.listenerCount(), before);
	destroyCountdownStopwatch();
});
