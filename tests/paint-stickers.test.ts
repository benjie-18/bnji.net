/**
 * BNJI.NET — the paint sticker maths.
 *
 * Everything here is pure, so the tests can be exhaustive about the things that
 * are easy to get subtly wrong and impossible to notice by eye:
 *
 *   - which corner is the anchor, and that it genuinely does not move;
 *   - that a box can never invert (dragging a corner past its opposite edge is
 *     the classic way a resize implementation produces a negative width and a
 *     sticker that vanishes or mirrors);
 *   - that a proportional resize stays proportional through the server's
 *     width/height caps and through integer rounding;
 *   - that the four corner hit areas stay disjoint, so a small sticker is still
 *     draggable from its middle;
 *   - that replaying, undoing and rebasing local operations agree with each
 *     other, including when another visitor has moved the same sticker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	MIN_STICKER_SIZE,
	applyStickerOperations,
	cornerAt,
	displayScale,
	HANDLE_MAX_FRACTION,
	HANDLE_SCREEN_PX,
	handleCentres,
	handleHitRadius,
	handleSize,
	type Point,
	rebaseStickerOperations,
	resizeSticker,
	stickerAt,
	stickerResizeBounds,
	summarizeStickerActions,
	type PaintSticker,
	type ResizeCorner,
	type StickerOperation,
} from '../src/scripts/paint-stickers.ts';

/** A 1200 × 750 canvas with the server's 240 × 156 sticker resize ceiling. */
const BOUNDS = stickerResizeBounds(1200, 750);

const sticker = (over: Partial<PaintSticker> = {}): PaintSticker => ({
	id: 'sticker-1',
	image: 'data:image/png;base64,AAAA',
	x: 100,
	y: 100,
	width: 60,
	height: 39,
	...over,
});

/** A pointer far outside the canvas, on the outward side of each corner. */
const outward = (corner: ResizeCorner): Point => ({
	x: corner === 'nw' || corner === 'sw' ? -500 : 2000,
	y: corner === 'nw' || corner === 'ne' ? -500 : 2000,
});

/** The scale a ~1000px-wide render of the 1200px canvas produces. */
const DESKTOP = displayScale(1000, 1200);
/** The scale a ~340px-wide phone render produces. */
const PHONE = displayScale(340, 1200);

/* --- hit testing ---------------------------------------------------------- */

test('cornerAt finds each corner and ignores the interior', () => {
	const target = sticker();
	for (const corner of ['nw', 'ne', 'se', 'sw'] as ResizeCorner[]) {
		const centre = handleCentres(target)[corner];
		assert.equal(cornerAt(centre, target, DESKTOP), corner, `${corner} centre`);
	}
	assert.equal(cornerAt({ x: 130, y: 120 }, target, DESKTOP), null, 'the middle is a move target');
});

test('cornerAt picks the nearest corner, so overlapping targets never fight', () => {
	// A sticker at the phone scale is a handful of CSS pixels; the generous hit
	// target is trimmed to keep the four areas disjoint, and the pointer must
	// still resolve to exactly one of them.
	const tiny = sticker({ x: 600, y: 300, width: 10, height: 10 });
	for (const corner of ['nw', 'ne', 'se', 'sw'] as ResizeCorner[]) {
		const centre = handleCentres(tiny)[corner];
		assert.equal(cornerAt(centre, tiny, PHONE), corner, `${corner} on a 10px sticker`);
	}
	assert.equal(cornerAt({ x: 605, y: 305 }, tiny, PHONE), null, 'the centre stays a move target');
});

test('handle hit areas stay disjoint for every sticker shape and canvas size', () => {
	// This is the property the whole corner model rests on: the radius is capped
	// at 45% of the SHORTER side, and any two corners are at least the shorter
	// side apart, so the four targets can never overlap and the middle of the
	// sticker always stays a move target. `cornerAt`'s nearest-corner tie-break
	// is the belt to this pair of braces — it is unreachable while this holds,
	// and it is what keeps the function honest if the cap is ever raised.
	const shapes = [MIN_STICKER_SIZE, 8, 20, 39, 60];
	for (const width of shapes) {
		for (const height of shapes) {
			for (const canvasWidth of [240, 340, 1000, 1200, 2400]) {
				const target = sticker({ width, height });
				const scale = displayScale(canvasWidth, 1200);
				const radius = handleHitRadius(target, scale);
				const centres = handleCentres(target);
				const corners: ResizeCorner[] = ['nw', 'ne', 'se', 'sw'];
				for (let i = 0; i < corners.length; i += 1) {
					for (let j = i + 1; j < corners.length; j += 1) {
						const gap = Math.hypot(
							centres[corners[i]!].x - centres[corners[j]!].x,
							centres[corners[i]!].y - centres[corners[j]!].y,
						);
						assert.ok(
							2 * radius <= gap,
							`${corners[i]}/${corners[j]} overlap at ${width}x${height} on a ${canvasWidth}px canvas`,
						);
					}
				}
			}
		}
	}
});

test('a handle is a fixed on-screen size, capped by the sticker it belongs to', () => {
	// Uncapped: a fixed CSS-pixel target, whatever the canvas scale.
	for (const scale of [DESKTOP, PHONE]) {
		const onScreen = handleSize({ x: 0, y: 0, width: 600, height: 400 }, scale) * scale;
		assert.ok(Math.abs(onScreen - HANDLE_SCREEN_PX) < 0.001, `fixed on screen at scale ${scale}`);
	}

	// Capped: on a real sticker the cap wins, so a handle never swallows the
	// sticker it belongs to - and it shrinks with it, which is what keeps a
	// 20px sticker's middle reachable.
	const big = sticker({ width: 60, height: 39 });
	assert.ok(handleSize(big, DESKTOP) <= 39 * HANDLE_MAX_FRACTION, 'capped by the sticker');
	const small = sticker({ width: 20, height: 20 });
	assert.ok(handleSize(small, DESKTOP) < handleSize(big, DESKTOP), 'a smaller sticker gets a smaller handle');
	assert.ok(handleSize(small, DESKTOP) * DESKTOP <= 20 * HANDLE_MAX_FRACTION * DESKTOP + 0.001, 'still inside the sticker');
});

test('a handle clears the WCAG 24px minimum whenever the sticker allows it', () => {
	// 24x24 CSS px is the WCAG 2.5.8 AA minimum; the drawn handle is only 16, so
	// the HIT radius is what carries the difference. This asserts the real
	// on-screen diameter, because that is the number a finger is judged by.
	const target = sticker({ width: 60, height: 39 });
	for (const canvasWidth of [1000, 1200, 1800]) {
		const scale = displayScale(canvasWidth, 1200);
		const onScreen = handleHitRadius(target, scale) * 2 * scale;
		assert.ok(onScreen >= 24 - 0.001, `a ${canvasWidth}px canvas gives a ${onScreen.toFixed(1)}px target`);
	}
});

test('on a phone-sized canvas the disjointness cap wins, and that is the trade', () => {
	// A 60x39 sticker on a 340px canvas is about 17x11 CSS px. Four 24px targets
	// around it cannot be disjoint, and swallowing the middle would take the
	// move gesture with it — so the cap wins and the target shrinks with the
	// sticker. Pinned here so the choice is visible rather than accidental.
	const target = sticker({ width: 60, height: 39 });
	const scale = displayScale(340, 1200);
	const onScreen = handleHitRadius(target, scale) * 2 * scale;
	assert.ok(onScreen < 24, 'the phone target is smaller than the desktop one');
	assert.ok(handleHitRadius(target, scale) <= 39 * HANDLE_MAX_FRACTION + 0.001, 'but still capped, never overlapping');
	assert.ok(handleHitRadius(target, scale) * 2 * scale > handleSize(target, scale) * scale,
		'and still larger than the handle you can see');
});

test('a handle hit target never exceeds the cap, however large the canvas is', () => {
	// The 26px target is generous on purpose, but an unbounded one would let
	// the four corners overlap and swallow the sticker's moveable middle.
	const target = sticker({ width: 60, height: 39 });
	for (const scale of [DESKTOP, displayScale(4000, 1200)]) {
		assert.ok(handleHitRadius(target, scale) <= 39 * HANDLE_MAX_FRACTION + 0.001, 'capped by the sticker');
	}
});

test('a handle smaller than the hit target is still fully grabbable', () => {
	// A target you cannot see is worse than a small one, so the drawn handle is
	// the floor: on a phone the 16px handle wins over the trimmed 26px target.
	const small = sticker({ width: 8, height: 8 });
	const radius = handleHitRadius(small, PHONE);
	const drawn = handleSize(small, PHONE) / 2;
	assert.ok(radius >= drawn - 0.001, 'the drawn handle is inside its own hit target');
});

test('displayScale survives a zero-width layout instead of dividing by zero', () => {
	assert.equal(displayScale(0, 1200), 1);
	assert.equal(displayScale(600, 0), 1);
	assert.equal(displayScale(600, 1200), 0.5);
});

/* --- resizing ------------------------------------------------------------- */

test('dragging the south-east corner anchors the north-west corner', () => {
	const target = sticker();
	const next = resizeSticker(target, { corner: 'se', pointer: { x: 130, y: 125 }, bounds: BOUNDS });
	assert.equal(next.x, target.x, 'the anchored corner does not move');
	assert.equal(next.y, target.y);
	assert.equal(next.width, 30, 'the pointer sets the width');
	assert.equal(next.height, 20, 'and the height follows it proportionally');
});

test('dragging the north-west corner anchors the south-east corner', () => {
	const target = sticker();
	const next = resizeSticker(target, { corner: 'nw', pointer: { x: 130, y: 125 }, bounds: BOUNDS });
	assert.equal(next.x + next.width, target.x + target.width, 'the anchored corner does not move');
	assert.equal(next.y + next.height, target.y + target.height);
	// The pointer implies 30 x 14, but the ratio is the tighter constraint, so
	// the box is 22 x 14 and the anchored corner is what gives.
	assert.equal(next.width, 22);
	assert.equal(next.height, 14);
});

test('every corner keeps its opposite corner pinned', () => {
	const target = sticker({ x: 400, y: 300, width: 40, height: 20 });
	for (const corner of ['nw', 'ne', 'se', 'sw'] as ResizeCorner[]) {
		const next = resizeSticker(target, { corner, pointer: { x: 420, y: 310 }, bounds: BOUNDS });
		const opposite: Record<ResizeCorner, ResizeCorner> = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' };
		const before = handleCentres(target)[opposite[corner]];
		const after = handleCentres(next)[opposite[corner]];
		assert.deepEqual(after, before, `${corner} must leave ${opposite[corner]} where it was`);
	}
});

test('a proportional resize stays proportional, including through the caps', () => {
	// Centred with room to spare in every direction: the 240x156 ceiling is
	// what stops the growth, not a canvas edge. (A sticker near the top-left
	// corner cannot grow north-west past x=0/y=0 however large the ceiling.)
	const target = sticker({ x: 400, y: 300 });
	for (const corner of ['nw', 'ne', 'se', 'sw'] as ResizeCorner[]) {
		// Each corner grows outward, into the canvas.
		const next = resizeSticker(target, { corner, pointer: outward(corner), bounds: BOUNDS });
		assert.equal(next.width, BOUNDS.maxWidth, `${corner} grew to the server width ceiling`);
		assert.equal(next.height, BOUNDS.maxHeight, `${corner} grew to the height ceiling with it`);
		assert.ok(Math.abs(next.width / next.height - target.width / target.height) < 0.02, `${corner} kept the ratio`);
	}
});

test('a proportional resize never distorts a non-square sticker', () => {
	const wide = sticker({ width: 60, height: 20 });
	for (const corner of ['nw', 'ne', 'se', 'sw'] as ResizeCorner[]) {
		const next = resizeSticker(wide, { corner, pointer: outward(corner), bounds: BOUNDS });
		assert.ok(Math.abs(next.width / next.height - 3) < 0.05, `${corner} kept the 3:1 ratio`);
	}
});

test('Shift releases the ratio and the box follows the pointer exactly', () => {
	const target = sticker();
	const next = resizeSticker(target, {
		corner: 'se',
		pointer: { x: 145, y: 108 },
		lockRatio: false,
		bounds: BOUNDS,
	});
	assert.equal(next.width, 45);
	assert.equal(next.height, 8);
	assert.ok(Math.abs(next.width / next.height - 60 / 39) > 0.5, 'the ratio really is free');
});

test('dragging a corner past its opposite edge cannot invert or collapse the box', () => {
	const target = sticker();
	for (const corner of ['nw', 'ne', 'se', 'sw'] as ResizeCorner[]) {
		// Far past the opposite edge, in both axes.
		for (const pointer of [{ x: 900, y: 700 }, { x: 0, y: 0 }]) {
			const next = resizeSticker(target, { corner, pointer, bounds: BOUNDS });
			assert.ok(next.width >= MIN_STICKER_SIZE, `${corner} width stayed positive`);
			assert.ok(next.height >= MIN_STICKER_SIZE, `${corner} height stayed positive`);
			assert.ok(next.width <= BOUNDS.maxWidth && next.height <= BOUNDS.maxHeight, 'within the server caps');
			assert.ok(next.x >= 0 && next.y >= 0, 'inside the canvas');
			assert.ok(next.x + next.width <= BOUNDS.width, 'right edge inside the canvas');
			assert.ok(next.y + next.height <= BOUNDS.height, 'bottom edge inside the canvas');
		}
	}
});

test('a sticker pinned to the canvas edge grows inward, not off-canvas', () => {
	const target = sticker({ x: 0, y: 0, width: 20, height: 20 });
	const next = resizeSticker(target, { corner: 'se', pointer: { x: 1195, y: 745 }, bounds: BOUNDS });
	assert.equal(next.x, 0, 'the anchored edge stays on the canvas edge');
	assert.equal(next.y, 0);
	assert.ok(next.x + next.width <= BOUNDS.width, 'never overflows the canvas');
	assert.ok(next.y + next.height <= BOUNDS.height);
});

test('a resize never exceeds the server sticker limits, free or proportional', () => {
	const target = sticker({ x: 0, y: 0, width: 60, height: 39 });
	for (const lockRatio of [true, false]) {
		const next = resizeSticker(target, {
			corner: 'se',
			pointer: { x: 1200, y: 750 },
			lockRatio,
			bounds: BOUNDS,
		});
		assert.ok(next.width <= BOUNDS.maxWidth, `width within the cap (lockRatio=${lockRatio})`);
		assert.ok(next.height <= BOUNDS.maxHeight, `height within the cap (lockRatio=${lockRatio})`);
	}
});

test('sizes are whole numbers, because the server only accepts integers', () => {
	const target = sticker({ width: 37, height: 23 });
	for (const corner of ['nw', 'ne', 'se', 'sw'] as ResizeCorner[]) {
		for (const lockRatio of [true, false]) {
			const next = resizeSticker(target, { corner, pointer: { x: 173, y: 211 }, lockRatio, bounds: BOUNDS });
			assert.ok(Number.isInteger(next.width) && Number.isInteger(next.height), 'integer dimensions');
			assert.ok(Number.isInteger(next.x) && Number.isInteger(next.y), 'integer position');
		}
	}
});

test('a pointer that does not move the corner returns the same rectangle', () => {
	// The drag BEGINS with the pointer on the corner it grabbed, so this is the
	// very first pointermove of every resize. Returning anything else here would
	// make the sticker jump the instant the visitor's hand twitches.
	const target = sticker();
	const centre = handleCentres(target).se;
	const next = resizeSticker(target, { corner: 'se', pointer: centre, bounds: BOUNDS });
	assert.deepEqual(next, { x: target.x, y: target.y, width: target.width, height: target.height });
});

test('a sticker already below the floor is not forced to grow', () => {
	const tiny = sticker({ x: 500, y: 400, width: 3, height: 2 });
	const next = resizeSticker(tiny, { corner: 'se', pointer: { x: 500, y: 400 }, bounds: BOUNDS });
	assert.equal(next.width, 3);
	assert.equal(next.height, 2);
});

/* --- replay, undo and rebase --------------------------------------------- */

test('operations replay in order and the last one wins', () => {
	const shared: PaintSticker[] = [sticker()];
	const operations: StickerOperation[] = [
		{ kind: 'sticker-move', id: 'sticker-1', beforeX: 100, beforeY: 100, x: 200, y: 150 },
		{ kind: 'sticker-move', id: 'sticker-1', beforeX: 200, beforeY: 150, x: 300, y: 150 },
	];
	assert.deepEqual(applyStickerOperations(shared, operations), [{ ...sticker(), x: 300, y: 150 }]);
});

test('undoing the last operation restores the previous rectangle', () => {
	const shared: PaintSticker[] = [sticker()];
	const operations: StickerOperation[] = [
		{ kind: 'sticker-move', id: 'sticker-1', beforeX: 100, beforeY: 100, x: 200, y: 150 },
		{ kind: 'sticker-resize', id: 'sticker-1', beforeX: 200, beforeY: 150, beforeWidth: 60, beforeHeight: 39, x: 200, y: 150, width: 30, height: 20, image: 'data:image/png;base64,BBBB' },
	];
	const full = applyStickerOperations(shared, operations);
	assert.equal(full[0].width, 30, 'the resize applied');
	const undone = applyStickerOperations(shared, operations.slice(0, 1));
	assert.deepEqual(undone[0], { ...sticker(), x: 200, y: 150 }, 'popping the resize restores the shared size');
});

test('a resize operation carries its own image, so undo needs no second lookup', () => {
	const shared: PaintSticker[] = [sticker()];
	const resized: StickerOperation = {
		kind: 'sticker-resize',
		id: 'sticker-1',
		beforeX: 100,
		beforeY: 100,
		beforeWidth: 60,
		beforeHeight: 39,
		x: 100,
		y: 100,
		width: 30,
		height: 20,
		image: 'data:image/png;base64,CCCC',
	};
	const applied = applyStickerOperations(shared, [resized]);
	assert.equal(applied[0].image, 'data:image/png;base64,CCCC', 'the re-encoded bitmap travels with the operation');
	assert.equal(applied[0].width, 30);
});

test('an operation recorded against a stale rectangle is skipped, not applied', () => {
	const shared: PaintSticker[] = [{ ...sticker(), x: 400 }];
	const stale: StickerOperation[] = [
		{ kind: 'sticker-move', id: 'sticker-1', beforeX: 100, beforeY: 100, x: 200, y: 150 },
		{ kind: 'sticker-resize', id: 'sticker-1', beforeX: 100, beforeY: 100, beforeWidth: 60, beforeHeight: 39, x: 100, y: 100, width: 20, height: 13, image: 'x' },
	];
	assert.deepEqual(applyStickerOperations(shared, stale), [{ ...sticker(), x: 400 }]);
});

test('a resize recorded against a stale size is skipped even when the position matches', () => {
	const shared: PaintSticker[] = [{ ...sticker(), width: 40, height: 26 }];
	const stale: StickerOperation = {
		kind: 'sticker-resize',
		id: 'sticker-1',
		beforeX: 100,
		beforeY: 100,
		beforeWidth: 60,
		beforeHeight: 39,
		x: 100,
		y: 100,
		width: 20,
		height: 13,
		image: 'x',
	};
	const applied = applyStickerOperations(shared, [stale]);
	assert.equal(applied[0].width, 40, 'the shared size survives');
	assert.equal(applied[0].height, 26);
});

test('stickerAt returns the topmost sticker, matching the draw order', () => {
	const under = sticker({ id: 'under', x: 100, y: 100, width: 60, height: 39 });
	const over = sticker({ id: 'over', x: 120, y: 110, width: 60, height: 39 });
	const hit = { x: 130, y: 120 };
	assert.equal(stickerAt([under, over], hit)?.id, 'over');
	assert.equal(stickerAt([over, under], hit)?.id, 'under');
	assert.equal(stickerAt([under, over], { x: 500, y: 500 }), undefined);
});

test('a rebase keeps the operations that still apply and counts the rest', () => {
	const shared: PaintSticker[] = [sticker()];
	const operations: StickerOperation[] = [
		{ kind: 'sticker-move', id: 'sticker-1', beforeX: 100, beforeY: 100, x: 200, y: 150 },
		{ kind: 'sticker-resize', id: 'sticker-1', beforeX: 200, beforeY: 150, beforeWidth: 60, beforeHeight: 39, x: 200, y: 150, width: 30, height: 20, image: 'y' },
	];
	const rebased = rebaseStickerOperations(shared, operations);
	assert.equal(rebased.conflicts, 0, 'both still apply to the same snapshot');
	assert.equal(rebased.operations.length, 2);
	assert.deepEqual(applyStickerOperations(shared, rebased.operations)[0], { ...sticker(), x: 200, y: 150, width: 30, height: 20, image: 'y' });
});

test('a rebase drops a resize another visitor already made, and says so', () => {
	const shared: PaintSticker[] = [{ ...sticker(), width: 45, height: 29 }];
	const mine: StickerOperation = {
		kind: 'sticker-resize',
		id: 'sticker-1',
		beforeX: 100,
		beforeY: 100,
		beforeWidth: 60,
		beforeHeight: 39,
		x: 100,
		y: 100,
		width: 20,
		height: 13,
		image: 'z',
	};
	const rebased = rebaseStickerOperations(shared, [mine]);
	assert.equal(rebased.conflicts, 1, 'the visitor is told their edit was skipped');
	assert.equal(rebased.operations.length, 0);
	assert.equal(applyStickerOperations(shared, rebased.operations)[0].width, 45, 'the other visitor keeps their size');
});

test('a rebase keeps an unrelated sticker untouched while dropping the conflict', () => {
	const mine = sticker({ id: 'mine' });
	const theirs = sticker({ id: 'theirs', x: 500, y: 400 });
	const operations: StickerOperation[] = [
		{ kind: 'sticker-move', id: 'mine', beforeX: mine.x, beforeY: mine.y, x: 300, y: 200 },
		{ kind: 'sticker-move', id: 'theirs', beforeX: 100, beforeY: 100, x: 600, y: 500 },
	];
	const rebased = rebaseStickerOperations([mine, theirs], operations);
	assert.equal(rebased.conflicts, 1, 'only the stale one conflicts');
	assert.equal(rebased.operations.length, 1);
	assert.equal(rebased.operations[0].kind, 'sticker-move', 'the still-valid operation survives');
});

test('summarizeStickerActions counts each kind for the activity trail', () => {
	const operations: StickerOperation[] = [
		{ kind: 'sticker-add', sticker: sticker({ id: 'a' }) },
		{ kind: 'sticker-add', sticker: sticker({ id: 'b' }) },
		{ kind: 'sticker-move', id: 'a', beforeX: 0, beforeY: 0, x: 1, y: 1 },
		{ kind: 'sticker-resize', id: 'a', beforeX: 1, beforeY: 1, beforeWidth: 60, beforeHeight: 39, x: 1, y: 1, width: 30, height: 20, image: 'i' },
		{ kind: 'sticker-remove', id: 'b', beforeX: 0, beforeY: 0 },
	];
	assert.deepEqual(summarizeStickerActions(operations), {
		'sticker-add': 2,
		'sticker-move': 1,
		'sticker-resize': 1,
		'sticker-remove': 1,
	});
	assert.deepEqual(summarizeStickerActions([]), {});
});

test('adding the same sticker twice is idempotent', () => {
	const shared: PaintSticker[] = [];
	const added = sticker();
	const operations: StickerOperation[] = [
		{ kind: 'sticker-add', sticker: added },
		{ kind: 'sticker-add', sticker: added },
	];
	assert.deepEqual(applyStickerOperations(shared, operations), [added]);
});
