/**
 * BNJI.NET — the paint board's sticker resize wiring.
 *
 * The maths itself is covered by paint-stickers.test.ts, but that module is
 * deliberately canvas-free, which means nothing checks that the controller
 * actually USES it, that the CSS cursor rules and the script agree on the
 * attribute that drives them, or that the documented interaction still matches
 * the code. Those are the joins where a rename silently kills the feature while
 * every other check stays green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const CONTROLLER = 'src/scripts/board-paint.ts';
const COMPONENT = 'src/components/BoardPaint.astro';
const STYLES = 'src/styles/paint.css';
const API = 'src/pages/api/paint.ts';

/** Strip comments so a rule is not "documented" by its own explanation. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the controller uses the pure sticker module rather than its own copy', () => {
	const script = code(source(CONTROLLER));
	for (const fn of ['applyStickerOperations', 'cornerAt', 'handleCentres', 'handleSize', 'resizeSticker', 'stickerAt', 'stickerResizeBounds']) {
		assert.ok(script.includes(fn), `${CONTROLLER} no longer uses ${fn} from paint-stickers.ts`);
	}
	// The old closure-local replay was the whole point of extracting the module;
	// a copy coming back would mean the tested maths and the shipped maths differ.
	assert.ok(!/const effectiveStickers = \(\): PaintSticker\[\] => \{\s*const stickers = sharedStickers\.map/.test(script),
		'the sticker replay has been re-implemented inside the controller');
});

test('a resize re-encodes the bitmap instead of only changing the rectangle', () => {
	// The server requires the stored PNG's own pixel dimensions to match the
	// sticker's width and height, so a rectangle-only resize would be rejected
	// with invalid_stickers on every publish.
	const script = code(source(CONTROLLER));
	assert.ok(script.includes("canvas.toDataURL('image/png')"), 'no re-encode on resize');
	assert.ok(script.includes('stickerMasters'), 'the master bitmap cache is gone');
	assert.ok(/encodeStickerAt\([^)]*\)\s*;/.test(script), 'nothing calls the re-encoder');
	assert.ok(!/stickerImages\.get\([^)]*\)[\s\S]{0,200}drawImage\(bitmap, 0, 0/.test(script),
		'the render cache is being re-encoded from, which would compound resampling');
});

test('the selection chrome is drawn on a layer that is never published or exported', () => {
	// compositeImage() flattens base + local for publishing, and the export adds
	// the sticker canvas. Handles drawn on either would end up in the artwork.
	const script = code(source(CONTROLLER));
	assert.ok(script.includes('drawSelectionChrome'), 'no selection chrome');
	const chrome = /const drawSelectionChrome = [\s\S]*?\n\t};/.exec(script);
	assert.ok(chrome, 'drawSelectionChrome not found');
	assert.ok(/previewContext\.(strokeRect|fillRect)/.test(chrome[0]), 'the chrome is not drawn on the preview layer');
	assert.ok(!/stickerContext\.(strokeRect|fillRect)/.test(chrome[0]), 'the chrome must not go on the published sticker layer');
	assert.ok(!/localContext\.(strokeRect|fillRect)/.test(chrome[0]), 'the chrome must not go on the published local layer');
});

test('the resize gesture is guarded against a publish and a pointer loss', () => {
	const script = code(source(CONTROLLER));
	// Syncing mid-drag would rebase away the rectangle the gesture is anchored to.
	assert.ok(/if \(activeDrawing \|\| activeStickerDrag \|\| activeStickerResize \|\|/.test(script),
		'a resize no longer blocks Sync & refresh');
	// A cancelled resize must be dropped, not committed at the last pointermove.
	assert.ok(/pointercancel[\s\S]{0,1200}activeStickerResize = null/.test(script), 'pointercancel does not abandon the resize');
});

test('the keyboard path can resize without a pointer', () => {
	const script = code(source(CONTROLLER));
	assert.ok(/event\.altKey[\s\S]{0,400}resizeSelectedWithKeyboard/.test(script), 'Alt + arrow no longer resizes');
	assert.ok(/lockRatio: !event\.shiftKey/.test(script), 'Shift no longer releases the ratio during a drag');
});

test('every cursor the script sets has a rule in the stylesheet', () => {
	// The cursor vocabulary lives in CSS and is addressed through one attribute;
	// a rename on either side leaves the pointer silently showing the default.
	const script = code(source(CONTROLLER));
	const css = source(STYLES);
	for (const cursor of ['nwse', 'nesw', 'grab', 'grabbing']) {
		assert.ok(new RegExp(`data-sticker-cursor='${cursor}'`).test(css), `${STYLES} has no rule for ${cursor}`);
	}
	const set = /setStickerCursor\(/g;
	assert.ok([...script.matchAll(set)].length >= 4, 'the script barely touches the cursor');
	for (const cursor of ['nwse', 'nesw', 'grab', 'grabbing']) {
		assert.ok(new RegExp(`'${cursor}'`).test(script), `the script never sets ${cursor}`);
	}
});

test('the component documents the resize interaction it implements', () => {
	// The instructions paragraph is the canvas's accessible description, so it is
	// the only place a visitor can learn the gesture exists.
	const markup = source(COMPONENT);
	const instructions = /id="paint-instructions">([\s\S]*?)<\/p>/.exec(markup);
	assert.ok(instructions, 'no instructions paragraph');
	const text = instructions[1];
	assert.ok(/corner handle/i.test(text), 'the instructions do not mention the corner handles');
	assert.ok(/Shift/.test(text), 'the instructions do not mention the Shift override');
	assert.ok(/arrow key/i.test(text), 'the instructions do not mention the keyboard path');
	assert.ok(/opposite corner/i.test(text), 'the instructions do not explain what stays put');
});

test('the server accepts, counts and overrides a sticker-resize action', () => {
	const api = code(source(API));
	assert.ok(api.includes("'sticker-resize'"), 'ACTION_TYPES has no sticker-resize');
	assert.ok(/old\.width !== sticker\.width \|\| old\.height !== sticker\.height/.test(api),
		'stickerActionCounts still compares position only, so a pure resize is invisible');
	assert.ok(/delete actions\['sticker-resize'\]/.test(api),
		'the client-supplied count is not discarded, so it could be forged');
});

test('the server still rejects a bitmap whose dimensions do not match', () => {
	// The guard that makes the re-encode necessary must not have been relaxed to
	// make the feature easier to ship.
	const api = code(source(API));
	assert.ok(/expectedWidth/.test(api) && /expectedHeight/.test(api), 'the PNG dimension check is gone');
});
