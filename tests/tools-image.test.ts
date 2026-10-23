/**
 * BNJI.NET — the /projects/tools/ image converter's decisions.
 *
 * The canvas half of this tool cannot run here (no browser in this sandbox), so
 * this file covers everything that is pure: what gets refused before decoding,
 * what the download is called, how the size delta is worded, and how a resize
 * box becomes pixel dimensions.
 *
 * The refusals are the point. A converter that accepts anything is a converter
 * that implies it converts anything, and "output larger than input" is the case
 * where a converter is tempted to say "compressed" anyway.
 *
 * The last two tests drive the real controller against the DOM shim, for the one
 * thing a pure function cannot show: that `destroyImageConverter()` actually
 * releases the listeners it bound. Every other module with a `destroy()` has a
 * test for it; this one shipped without, so its teardown was unverified.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	checkInputFile,
	describeSizeChange,
	formatBytes,
	mimeFromDataUrl,
	outputFileName,
	resizePlan,
} from '../src/scripts/tools-image.ts';

type Dom = ReturnType<typeof installTestDom>;
type ImageModule = typeof import('../src/scripts/tools-image.ts');

let imageModule: ImageModule | null = null;

async function image(): Promise<ImageModule> {
	if (!imageModule) imageModule = await import('../src/scripts/tools-image.ts');
	return imageModule;
}

/** The converter's markup, mirroring src/components/tools/ImageConverter.astro. */
function buildConverter(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-image-converter', '');

	const hooks: Record<string, string> = {
		'data-image-source': 'input',
		'data-image-drop': 'div',
		'data-image-format': 'select',
		'data-image-format-hint': 'p',
		'data-image-quality': 'input',
		'data-image-quality-value': 'span',
		'data-image-quality-hint': 'p',
		'data-image-width': 'input',
		'data-image-height': 'input',
		'data-image-lock': 'input',
		'data-image-convert': 'button',
		'data-image-download': 'button',
		'data-image-reset': 'button',
		'data-image-status': 'p',
		'data-image-error': 'p',
		'data-image-results': 'div',
		'data-image-source-preview': 'img',
		'data-image-source-meta': 'p',
		'data-image-output-preview': 'img',
		'data-image-output-meta': 'p',
	};
	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}

	document.body.appendChild(section);
}

const MB = 1024 * 1024;

function file(name: string, type: string, size: number) {
	return { name, type, size };
}

test('a supported raster file is accepted', () => {
	for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif']) {
		assert.deepEqual(checkInputFile(file('a.img', type, 1024)), { ok: true }, type);
	}
});

test('non-raster files are refused by name, with the supported list', () => {
	for (const type of ['application/pdf', 'text/plain', 'video/mp4', 'audio/mpeg', '', 'application/zip']) {
		const result = checkInputFile(file('thing', type, 1024));
		assert.equal(result.ok, false, type);
		if (result.ok) continue;
		assert.match(result.message, /not a format this tool converts/);
		assert.match(result.message, /PNG, JPEG, WebP, GIF, BMP or AVIF/);
		assert.match(result.message, /not PDFs/);
	}
});

test('an oversized file is refused with the limit stated', () => {
	const result = checkInputFile(file('huge.png', 'image/png', 40 * MB));
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /25\.0 MB/);
});

test('an empty file is refused instead of failing to decode', () => {
	const result = checkInputFile(file('empty.png', 'image/png', 0));
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.message, /empty/);
});

test('byte counts are human and monotonic', () => {
	assert.equal(formatBytes(0), '0 B');
	assert.equal(formatBytes(900), '900 B');
	assert.equal(formatBytes(1536), '1.5 KB');
	assert.equal(formatBytes(15 * MB), '15.0 MB');
	assert.equal(formatBytes(2.5 * 1024 * MB), '2.5 GB');
});

test('a smaller output is described as a saving', () => {
	const change = describeSizeChange(2 * MB, 500 * 1024);
	assert.equal(change.saved, true);
	assert.equal(change.label, '76% smaller');
});

test('a larger output is never called compression', () => {
	const change = describeSizeChange(400 * 1024, 1.2 * MB);
	assert.equal(change.saved, false);
	assert.equal(change.label, '207% larger — no saving');
	assert.doesNotMatch(change.label, /smaller|compress/);
});

test('an identical output says so plainly', () => {
	const change = describeSizeChange(1024, 1024);
	assert.equal(change.saved, false);
	assert.equal(change.label, 'same size');
});

test('a resize keeps the aspect ratio from whichever side is given', () => {
	const source = { width: 4000, height: 3000 };
	assert.deepEqual(resizePlan(source, { width: 1000 }), { width: 1000, height: 750 });
	assert.deepEqual(resizePlan(source, { height: 600 }), { width: 800, height: 600 });
});

test('two dimensions fit inside the box rather than stretching to it', () => {
	// 4000x3000 into 1000x1000 is 1000x750, not 1000x1000.
	assert.deepEqual(resizePlan({ width: 4000, height: 3000 }, { width: 1000, height: 1000 }), {
		width: 1000,
		height: 750,
	});
});

test('a cleared or partial dimension field means "no resize"', () => {
	const source = { width: 800, height: 600 };
	assert.equal(resizePlan(source, {}), null);
	assert.equal(resizePlan(source, { width: null, height: null }), null);
	// Half-typed ("12" of "1280") and zero are not requests.
	assert.equal(resizePlan(source, { width: 0 }), null);
	assert.equal(resizePlan(source, { width: Number.NaN }), null);
});

test('an absurd dimension is clamped, not honoured', () => {
	const plan = resizePlan({ width: 100, height: 100 }, { width: 999_999 });
	assert.ok(plan);
	assert.equal(plan?.width, 20_000);
	assert.equal(plan?.height, 20_000);
});

test('the download name carries the right extension for the format', () => {
	assert.equal(outputFileName('photo.png', 'jpeg'), 'photo.jpg');
	assert.equal(outputFileName('photo.jpeg', 'webp'), 'photo.webp');
	assert.equal(outputFileName('photo', 'png'), 'photo.png');
	// An unknown suffix is not stripped — only a raster extension is replaced.
	assert.equal(outputFileName('archive.tar.gz', 'png'), 'archive.tar.gz.png');
	assert.equal(outputFileName('My Photo.PNG', 'webp'), 'My Photo.webp');
});

test('the MIME inside a data URL is what decides encoder support', () => {
	assert.equal(mimeFromDataUrl('data:image/webp;base64,UklGRg=='), 'image/webp');
	assert.equal(mimeFromDataUrl('data:image/png,raw'), 'image/png');
	// A browser that cannot encode the format answers with a PNG data URL, and
	// that mismatch is exactly what the caller has to detect.
	assert.equal(mimeFromDataUrl('data:image/png;base64,AAA') === 'image/webp', false);
	assert.equal(mimeFromDataUrl('not-a-data-url'), '');
});

/* --- the controller's own lifecycle --------------------------------------- */

test('destroyImageConverter releases the listeners it bound, and re-arms init', async () => {
	const dom = installTestDom();
	buildConverter(dom);
	const { initImageConverter, destroyImageConverter } = await image();

	initImageConverter();
	const convert = dom.q('[data-image-convert]');
	assert.ok(convert, 'the fixture rendered the convert button');

	// Count the listeners the shim holds for the subtree before and after. The
	// AbortController signal is what makes this observable at all: without a
	// teardown, every listener bound at init would still be attached.
	const before = dom.listenerCount();
	destroyImageConverter();
	const after = dom.listenerCount();
	assert.ok(after < before, `destroy left ${after - before} listeners attached`);

	// And a second init binds a FRESH subtree rather than stacking a second set
	// of handlers on the first one.
	initImageConverter();
	assert.equal(dom.listenerCount(), before, 'a re-init binds exactly one set of handlers again');
	destroyImageConverter();
});

test('the converter init is idempotent, like every other boot() entry', async () => {
	const dom = installTestDom();
	buildConverter(dom);
	const { initImageConverter, destroyImageConverter } = await image();

	initImageConverter();
	const once = dom.listenerCount();
	initImageConverter();
	assert.equal(dom.listenerCount(), once, 'a second init bound nothing more');
	destroyImageConverter();
});
