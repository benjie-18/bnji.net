/**
 * BNJI.NET — shared paint stickers: state replay, hit-testing and resize maths.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Stickers are the one part of the Paint canvas that is not a flat raster: they
 * are separate, stable-ID items that can be added, moved, resized and removed,
 * and every one of those edits has to survive three things the drawing tools
 * never face — local replay, undo, and a rebase against a snapshot another
 * visitor published while this one was drawing. That logic is pure data
 * handling, so it lives here rather than inside `initBoardPaint()`'s closure,
 * where no test could reach it. Same reason `board-physics.ts` exists.
 *
 * THE STORED MODEL
 * ----------------
 * A sticker is `{ id, image, x, y, width, height }` where `image` is a PNG data
 * URL whose INTRINSIC dimensions are exactly `width` × `height` — the server
 * rejects a publish otherwise (see `validateStickers` in pages/api/paint.ts).
 * So resizing a sticker is not just changing a rectangle: the bitmap has to be
 * re-encoded at the new size or the whole publish fails with `invalid_stickers`.
 * The controller owns that re-encoding; this module owns the numbers.
 *
 * CONFLICT RULE
 * -------------
 * Every mutating operation records the rectangle it started from. A rebase
 * applies it only while the shared sticker still matches that rectangle, so two
 * visitors editing the same sticker cannot silently overwrite each other: the
 * later one is skipped and announced, exactly as a conflicting move already is.
 */
import { PAINT_CONFIG } from '../config/paint.config';

export type PaintSticker = { id: string; image: string; x: number; y: number; width: number; height: number };

export type Point = { x: number; y: number };

/** A rectangle in logical canvas units. */
export type StickerRect = { x: number; y: number; width: number; height: number };

/** Which corner a drag started from. */
export type ResizeCorner = 'nw' | 'ne' | 'se' | 'sw';

export type StickerOperation =
	| { kind: 'sticker-add'; sticker: PaintSticker }
	| { kind: 'sticker-move'; id: string; beforeX: number; beforeY: number; x: number; y: number }
	| {
			kind: 'sticker-resize';
			id: string;
			beforeX: number;
			beforeY: number;
			beforeWidth: number;
			beforeHeight: number;
			x: number;
			y: number;
			width: number;
			height: number;
			/** The re-encoded PNG for the new size; intrinsic size must match width × height. */
			image: string;
	  }
	| { kind: 'sticker-remove'; id: string; beforeX: number; beforeY: number };

/**
 * Smallest sticker a drag may produce. The server accepts 1 × 1, but a sticker
 * that small cannot be seen or grabbed again, and the corner handles would be
 * the only thing left to hit — so the floor is a usability one, not a policy one.
 */
export const MIN_STICKER_SIZE = 6;

/** Visual edge of one corner handle, in CSS pixels of the on-screen canvas. */
export const HANDLE_SCREEN_PX = 16;

/**
 * Grabbable edge of one corner handle, in CSS pixels. WCAG 2.5.8 (Target Size
 * Minimum, AA) asks for 24 × 24; 26 leaves a hair of slack around the drawn
 * square, and the hit test is a radius around the corner centre, so the real
 * target is a 26px box.
 */
export const HANDLE_HIT_SCREEN_PX = 26;

/**
 * A handle never reaches past this fraction of the sticker. Without it the four
 * hit areas would overlap on a small sticker and the centre would stop being a
 * move target — the sticker would become impossible to drag.
 */
export const HANDLE_MAX_FRACTION = 0.45;

const CORNERS: readonly ResizeCorner[] = ['nw', 'ne', 'se', 'sw'];

const clamp = (value: number, min: number, max: number): number =>
	Math.min(Math.max(value, min), Math.max(min, max));

/** CSS pixels per logical canvas unit. Guards against a zero-width layout. */
export function displayScale(screenWidth: number, logicalWidth: number): number {
	return screenWidth > 0 && logicalWidth > 0 ? screenWidth / logicalWidth : 1;
}

/* --- replay ---------------------------------------------------------------- */

/**
 * The sticker list as this visitor currently sees it: the shared snapshot with
 * every local operation applied in order. Operations that no longer match the
 * rectangle they were recorded against are skipped, so a sticker another
 * visitor has since moved keeps THEIR position.
 */
export function applyStickerOperations(
	shared: readonly PaintSticker[],
	operations: readonly StickerOperation[],
): PaintSticker[] {
	const stickers = shared.map((sticker) => ({ ...sticker }));
	for (const operation of operations) {
		if (operation.kind === 'sticker-add') {
			if (!stickers.some((sticker) => sticker.id === operation.sticker.id)) {
				stickers.push({ ...operation.sticker });
			}
			continue;
		}
		const index = stickers.findIndex((sticker) => sticker.id === operation.id);
		if (index < 0) continue;
		const sticker = stickers[index];
		if (sticker.x !== operation.beforeX || sticker.y !== operation.beforeY) continue;
		if (operation.kind === 'sticker-remove') {
			stickers.splice(index, 1);
		} else if (operation.kind === 'sticker-resize') {
			if (sticker.width !== operation.beforeWidth || sticker.height !== operation.beforeHeight) continue;
			stickers[index] = {
				...sticker,
				x: operation.x,
				y: operation.y,
				width: operation.width,
				height: operation.height,
				image: operation.image,
			};
		} else {
			stickers[index] = { ...sticker, x: operation.x, y: operation.y };
		}
	}
	return stickers;
}

/**
 * Replay this visitor's pending operations over a NEWER shared snapshot,
 * dropping the ones that no longer apply. Returns the surviving operations and
 * how many were dropped, so the caller can tell the visitor what happened
 * instead of silently losing their work.
 */
export function rebaseStickerOperations(
	shared: readonly PaintSticker[],
	operations: readonly StickerOperation[],
): { operations: StickerOperation[]; conflicts: number } {
	const working = shared.map((sticker) => ({ ...sticker }));
	const kept: StickerOperation[] = [];
	let conflicts = 0;

	for (const operation of operations) {
		if (operation.kind === 'sticker-add') {
			const existing = working.find((sticker) => sticker.id === operation.sticker.id);
			if (existing) {
				// Same ID, different picture: somebody published this sticker
				// from another tab. Theirs wins; ours is not re-applied.
				if (existing.image !== operation.sticker.image) conflicts += 1;
				continue;
			}
			working.push({ ...operation.sticker });
			kept.push(operation);
			continue;
		}

		const index = working.findIndex((sticker) => sticker.id === operation.id);
		if (operation.kind === 'sticker-remove' && index < 0) continue;
		if (index < 0) {
			conflicts += 1;
			continue;
		}

		const sticker = working[index];
		if (sticker.x !== operation.beforeX || sticker.y !== operation.beforeY) {
			const alreadyThere = operation.kind === 'sticker-move' &&
				sticker.x === operation.x && sticker.y === operation.y;
			if (!alreadyThere) conflicts += 1;
			continue;
		}

		if (operation.kind === 'sticker-resize') {
			if (sticker.width !== operation.beforeWidth || sticker.height !== operation.beforeHeight) {
				conflicts += 1;
				continue;
			}
			working[index] = {
				...sticker,
				x: operation.x,
				y: operation.y,
				width: operation.width,
				height: operation.height,
				image: operation.image,
			};
			kept.push(operation);
			continue;
		}

		if (operation.kind === 'sticker-move') {
			working[index] = { ...sticker, x: operation.x, y: operation.y };
		} else {
			working.splice(index, 1);
		}
		kept.push(operation);
	}

	return { operations: kept, conflicts };
}

/** Topmost sticker under a point, matching the order they are drawn in. */
export function stickerAt(stickers: readonly PaintSticker[], point: Point): PaintSticker | undefined {
	for (let index = stickers.length - 1; index >= 0; index -= 1) {
		const sticker = stickers[index];
		if (
			point.x >= sticker.x && point.x <= sticker.x + sticker.width &&
			point.y >= sticker.y && point.y <= sticker.y + sticker.height
		) {
			return sticker;
		}
	}
	return undefined;
}

/** Per-kind counts for the publish summary and the admin activity trail. */
export function summarizeStickerActions(operations: readonly StickerOperation[]): Record<string, number> {
	const actions: Record<string, number> = {};
	for (const operation of operations) actions[operation.kind] = (actions[operation.kind] ?? 0) + 1;
	return actions;
}

/* --- corner handles -------------------------------------------------------- */

/**
 * Drawn edge of one handle, in logical units. Fixed in CSS pixels so a handle
 * is the same size on screen at every canvas scale, then capped so it never
 * swallows a small sticker.
 */
export function handleSize(sticker: StickerRect, scale: number): number {
	if (!(scale > 0)) return 0;
	const cap = Math.min(sticker.width, sticker.height) * HANDLE_MAX_FRACTION;
	return Math.max(1, Math.min(HANDLE_SCREEN_PX / scale, cap));
}

/** The four corner centres, in logical units. */
export function handleCentres(sticker: StickerRect): Record<ResizeCorner, Point> {
	return {
		nw: { x: sticker.x, y: sticker.y },
		ne: { x: sticker.x + sticker.width, y: sticker.y },
		se: { x: sticker.x + sticker.width, y: sticker.y + sticker.height },
		sw: { x: sticker.x, y: sticker.y + sticker.height },
	};
}

/**
 * How far from a corner centre a pointer still counts as grabbing that corner,
 * in logical units: the generous 26px target, trimmed to the fraction cap so the
 * four areas stay disjoint.
 *
 * The generous target is always the larger of the two candidate radii — the
 * drawn handle is 16 CSS px against this target's 26, so it can never be the
 * bigger one, and a `Math.max` between them would be unreachable. What keeps
 * the handle grabbable anyway is that the cap is a fraction of the STICKER, so
 * the target shrinks with the sticker rather than outgrowing it.
 *
 * The cap is also what keeps a phone-sized canvas honest. A 60x39 sticker on a
 * 340px canvas is about 17x11 CSS px, so four 24px targets around it cannot be
 * disjoint, and letting them overlap would take the sticker's move gesture with
 * it. Above roughly an 820px canvas the generous target fits and wins, so the
 * WCAG 2.5.8 AA minimum is met wherever the surface is big enough to allow it.
 */
export function handleHitRadius(sticker: StickerRect, scale: number): number {
	const generous = HANDLE_HIT_SCREEN_PX / scale / 2;
	const bounded = Math.min(sticker.width, sticker.height) * HANDLE_MAX_FRACTION;
	return Math.min(bounded, generous);
}

/**
 * Which corner a pointer is grabbing, or null for the sticker's interior.
 * Nearest corner within range wins, so the four targets never fight over a
 * pointer that lands between them.
 */
export function cornerAt(point: Point, sticker: StickerRect, scale: number): ResizeCorner | null {
	const centres = handleCentres(sticker);
	const radius = handleHitRadius(sticker, scale);
	let best: ResizeCorner | null = null;
	let bestDistance = Infinity;
	for (const corner of CORNERS) {
		const centre = centres[corner];
		const distance = Math.hypot(point.x - centre.x, point.y - centre.y);
		if (distance <= radius && distance < bestDistance) {
			best = corner;
			bestDistance = distance;
		}
	}
	return best;
}

/* --- resizing -------------------------------------------------------------- */

export type ResizeBounds = {
	/** Canvas size in logical units. */
	width: number;
	height: number;
	/** Largest sticker the server accepts, in logical units. */
	maxWidth: number;
	maxHeight: number;
};

export type ResizeOptions = {
	corner: ResizeCorner;
	/** Pointer position in logical canvas units. */
	pointer: Point;
	/**
	 * Keep the sticker's proportions. Default ON: a squashed sticker reads as a
	 * bug, so the ratio is preserved unless the visitor deliberately releases it
	 * (Shift while dragging).
	 */
	lockRatio?: boolean;
	bounds: ResizeBounds;
};

/**
 * The rectangle a corner drag produces.
 *
 * The corner OPPOSITE the one being dragged is the anchor and never moves —
 * that is the convention every design tool uses, and it is what makes dragging
 * the bottom-right corner feel like pulling that corner rather than scaling the
 * whole sticker around its middle.
 *
 * The result is clamped three ways: the box can never invert or collapse below
 * `MIN_STICKER_SIZE`, it can never exceed the server's sticker limits (a
 * publish carrying a larger one is rejected outright), and it always stays
 * inside the canvas. Clamping position rather than size keeps the anchor put.
 */
export function resizeSticker(sticker: StickerRect, options: ResizeOptions): StickerRect {
	const { corner, pointer, bounds } = options;
	const lockRatio = options.lockRatio !== false;
	const west = corner === 'nw' || corner === 'sw';
	const north = corner === 'nw' || corner === 'ne';

	const anchorX = west ? sticker.x + sticker.width : sticker.x;
	const anchorY = north ? sticker.y + sticker.height : sticker.y;
	// The floor never forces a sticker to GROW: a 3px sticker dragged back onto
	// its own corner must stay 3px, not jump to the minimum.
	const floorX = Math.min(MIN_STICKER_SIZE, sticker.width);
	const floorY = Math.min(MIN_STICKER_SIZE, sticker.height);

	// Raw edges implied by the pointer. The anchored edge is fixed; the dragged
	// one is clamped to the anchor, so the box can shrink to nothing but can
	// never cross it and flip inside out. Sitting exactly on the anchor - which
	// is where a drag begins, because the handle IS the corner - therefore
	// yields the current size rather than a collapsed one.
	const left = west ? clamp(pointer.x, 0, anchorX) : sticker.x;
	const right = west ? anchorX : clamp(pointer.x, anchorX, bounds.width);
	const top = north ? clamp(pointer.y, 0, anchorY) : sticker.y;
	const bottom = north ? anchorY : clamp(pointer.y, anchorY, bounds.height);

	let width = Math.max(floorX, right - left);
	let height = Math.max(floorY, bottom - top);

	if (lockRatio) {
		// Fit the largest proportional box inside the dragged rectangle: the
		// axis the pointer moved furthest along decides, the other follows.
		const scale = Math.min(width / sticker.width, height / sticker.height);
		width = Math.max(floorX, sticker.width * scale);
		height = Math.max(floorY, sticker.height * scale);
	}

	// Server limits, applied to both axes at once so a proportional box stays
	// proportional after the cap.
	const limit = Math.min(1, bounds.maxWidth / Math.max(width, 1), bounds.maxHeight / Math.max(height, 1));
	width = Math.max(floorX, Math.round(width * limit));
	height = Math.max(floorY, Math.round(height * limit));
	if (lockRatio) {
		// Rounding drifts the ratio by a pixel; re-derive the shorter axis.
		height = Math.max(floorY, Math.min(bounds.maxHeight, Math.round(width / (sticker.width / sticker.height))));
	}

	return {
		x: Math.round(clamp(west ? anchorX - width : left, 0, Math.max(0, bounds.width - width))),
		y: Math.round(clamp(north ? anchorY - height : top, 0, Math.max(0, bounds.height - height))),
		width,
		height,
	};
}

/** The server's sticker limits as a `ResizeBounds`, for the live canvas size. */
export function stickerResizeBounds(canvasWidth: number, canvasHeight: number): ResizeBounds {
	return {
		width: canvasWidth,
		height: canvasHeight,
		maxWidth: PAINT_CONFIG.maxStickerWidth,
		maxHeight: PAINT_CONFIG.maxStickerHeight,
	};
}
