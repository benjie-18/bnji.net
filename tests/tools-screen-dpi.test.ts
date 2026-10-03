/**
 * BNJI.NET — /tools/ screen / DPI calculator tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	calculateScreenSpecs,
	formatAspectRatio,
	gcd,
} from '../src/scripts/tools-screen-dpi.ts';

type Dom = ReturnType<typeof installTestDom>;
type ScreenModule = typeof import('../src/scripts/tools-screen-dpi.ts');

let screenModule: ScreenModule | null = null;

async function getModule(): Promise<ScreenModule> {
	if (!screenModule) screenModule = await import('../src/scripts/tools-screen-dpi.ts');
	return screenModule;
}

function buildScreenDom(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-screen-calculator', '');

	const hooks: Record<string, string> = {
		'data-screen-preset': 'select',
		'data-screen-width': 'input',
		'data-screen-height': 'input',
		'data-screen-diagonal': 'input',
		'data-screen-reset': 'button',
		'data-screen-status': 'p',
		'data-screen-error': 'p',
		'data-screen-results': 'div',
		'data-screen-output-ppi': 'p',
		'data-screen-output-dims': 'p',
		'data-screen-output-meta': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}

	document.body.appendChild(section);
}

test('gcd calculates greatest common divisor', () => {
	assert.equal(gcd(1920, 1080), 120);
	assert.equal(gcd(2560, 1440), 160);
});

test('formatAspectRatio correctly formats aspect ratios', () => {
	assert.equal(formatAspectRatio(1920, 1080), '16:9');
	assert.equal(formatAspectRatio(1920, 1200), '16:10');
	assert.equal(formatAspectRatio(1024, 768), '4:3');
});

test('calculateScreenSpecs computes accurate display metrics for 1080p 24"', () => {
	const specs = calculateScreenSpecs(1920, 1080, 24);
	assert.ok(specs);
	assert.equal(specs.ppi, 91.8);
	assert.equal(specs.widthInches, 20.92);
	assert.equal(specs.heightInches, 11.77);
	assert.equal(specs.aspectRatioStr, '16:9');
	assert.equal(specs.totalPixels, 2073600);
	assert.equal(specs.megapixels, 2.07);
});

test('calculateScreenSpecs rejects zero/negative dimensions or absurd inputs', () => {
	assert.equal(calculateScreenSpecs(0, 1080, 24), null);
	assert.equal(calculateScreenSpecs(1920, -1080, 24), null);
	assert.equal(calculateScreenSpecs(1920, 1080, 0), null);
	assert.equal(calculateScreenSpecs(99999, 1080, 24), null);
});

test('Screen DPI controller teardown releases event listeners', async () => {
	const dom = installTestDom();
	buildScreenDom(dom);
	const { initScreenDpiCalculator, destroyScreenDpiCalculator } = await getModule();

	initScreenDpiCalculator();
	const initialListeners = dom.listenerCount();
	assert.ok(initialListeners > 0);

	destroyScreenDpiCalculator();
	assert.ok(dom.listenerCount() < initialListeners);
});
