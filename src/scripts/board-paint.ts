/**
 * Shared message-board paint canvas.
 *
 * One opaque server snapshot sits below a transparent, local-only overlay.
 * Publishing uses optimistic revision checks: if somebody else publishes
 * first, their snapshot becomes the new base and this visitor's overlay is
 * applied above it before retrying. This is a small, bounded alternative to
 * storing an ever-growing log of every pointer event.
 */
import { PAINT_CONFIG } from '../config/paint.config';
import {
	applyStickerOperations,
	cornerAt,
	displayScale,
	handleCentres,
	handleSize,
	resizeSticker,
	stickerAt,
	rebaseStickerOperations as rebaseStickerQueue,
	summarizeStickerActions,
	stickerResizeBounds,
	type PaintSticker,
	type Point,
	type ResizeCorner,
	type StickerOperation,
	type StickerRect,
} from './paint-stickers';

type DrawingOperation =
	| { kind: 'stroke'; tool: 'pen' | 'eraser' | 'spray' | 'glow'; points: Point[]; color: string; size: number; seed?: number }
	| { kind: 'shape'; shape: 'line' | 'rectangle' | 'ellipse'; start: Point; end: Point; color: string; size: number }
	| { kind: 'text'; point: Point; text: string; color: string; size: number };
type PaintOperation = DrawingOperation | StickerOperation;

/**
 * A resize in flight: the rectangle the sticker had when the visitor grabbed a
 * corner, plus the rectangle being dragged out of it.
 */
type ActiveStickerResize = {
	pointerId: number;
	id: string;
	corner: ResizeCorner;
	beforeX: number;
	beforeY: number;
	beforeWidth: number;
	beforeHeight: number;
	x: number;
	y: number;
	width: number;
	height: number;
};

type SharedState = { revision: number; image: string | null; stickers?: PaintSticker[]; updatedAt: number };
type PendingRequest = { revision: number; requestId: string; image: string; stickers: PaintSticker[]; actions: Record<string, number> };
type ActiveDrawing = {
	pointerId: number;
	tool: string;
	start: Point;
	current: Point;
	points: Point[];
	color: string;
	size: number;
	seed: number;
};
type ActiveStickerDrag = { pointerId: number; id: string; offsetX: number; offsetY: number; beforeX: number; beforeY: number; x: number; y: number };

const MAX_STROKE_POINTS = 2400;
const MAX_REBASE_ATTEMPTS = 4;
let started = false;

export function initBoardPaint(): void {
	if (started) return;
	started = true;

	const root = document.querySelector<HTMLElement>('[data-board-paint]');
	if (!root || root.dataset.paintEnabled !== 'true') return;

	const baseCanvas = root.querySelector<HTMLCanvasElement>('[data-paint-base]');
	const localCanvas = root.querySelector<HTMLCanvasElement>('[data-paint-local]');
	const stickerCanvas = root.querySelector<HTMLCanvasElement>('[data-paint-stickers]');
	const inputCanvas = root.querySelector<HTMLCanvasElement>('[data-paint-input]');
	const status = root.querySelector<HTMLElement>('[data-paint-status]');
	const syncButton = root.querySelector<HTMLButtonElement>('[data-paint-sync]');
	const undoButton = root.querySelector<HTMLButtonElement>('[data-paint-undo]');
	const exportButton = root.querySelector<HTMLButtonElement>('[data-paint-export]');
	const fullscreenButton = root.querySelector<HTMLButtonElement>('[data-paint-fullscreen]');
	const sizeInput = root.querySelector<HTMLInputElement>('[data-paint-size]');
	const sizeOutput = root.querySelector<HTMLOutputElement>('[data-paint-size-output]');
	const textInput = root.querySelector<HTMLInputElement>('[data-paint-text]');
	const textWrap = root.querySelector<HTMLElement>('[data-paint-text-wrap]');
	const stickerFile = root.querySelector<HTMLInputElement>('[data-paint-sticker-file]');
	const stickerUploadButton = root.querySelector<HTMLButtonElement>('[data-paint-sticker-upload]');
	const toolIndicator = root.querySelector<HTMLElement>('[data-paint-tool-indicator]');

	if (
		!baseCanvas || !localCanvas || !stickerCanvas || !inputCanvas || !status || !syncButton ||
		!undoButton || !exportButton || !fullscreenButton || !sizeInput || !sizeOutput || !textInput || !textWrap ||
		!stickerFile || !stickerUploadButton
	) {
		return;
	}

	const baseContext = baseCanvas.getContext('2d');
	const localContext = localCanvas.getContext('2d');
	const stickerContext = stickerCanvas.getContext('2d');
	const previewContext = inputCanvas.getContext('2d');
	if (!baseContext || !localContext || !stickerContext || !previewContext) {
		status.textContent = 'This browser could not start the paint canvas.';
		return;
	}

	const board = document.querySelector<HTMLElement>('[data-board]');
	const toolButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-paint-tool]'));
	const colorButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-paint-color]'));
	const paper = getComputedStyle(root).getPropertyValue('--paint-canvas-paper').trim() || '#ffffff';
	// Selection chrome borrows the accent, which is already themed for both the
	// dark and light palettes, rather than inventing a colour of its own.
	let selectionColor = getComputedStyle(root).getPropertyValue('--accent-strong').trim();
	const width = PAINT_CONFIG.width;
	const height = PAINT_CONFIG.height;
	const pendingOperations: PaintOperation[] = [];
	const stickerImages = new Map<string, HTMLImageElement>();
	/**
	 * The upload-time bitmap for each sticker.
	 *
	 * The render cache above is reused for the live drag preview, which means
	 * drawing a resized sticker through it is fine - but re-ENCODING from it
	 * would resample an already-resampled image, so a shrink-then-grow would
	 * come back blurred. Masters are therefore kept separately and never
	 * overwritten, and every resize is re-encoded from the original.
	 */
	const stickerMasters = new Map<string, HTMLImageElement>();
	const stickerBounds = stickerResizeBounds(width, height);

	let sharedStickers: PaintSticker[] = [];
	let activeStickerDrag: ActiveStickerDrag | null = null;
	let activeStickerResize: ActiveStickerResize | null = null;
	let selectedStickerId: string | null = null;
	let erasingPointerId: number | null = null;
	let revision = 0;
	let etag = '';
	let activeTool = 'pen';
	let activeColor = colorButtons[0] ? getComputedStyle(colorButtons[0]).backgroundColor : '#17232b';
	let brushSize = Number(sizeInput.value) || 8;
	let activeDrawing: ActiveDrawing | null = null;
	let pendingRequest: PendingRequest | null = null;
	let syncing = false;
	let stickerProcessing = false;
	let paintInView = false;
	let pollTimer: number | null = null;

	const announce = (message: string): void => {
		status.textContent = message;
	};

	const toolGroup = root.querySelector<HTMLElement>('[data-paint-tools]');
	let indicatorLeft = -1;
	const placeToolIndicator = (instant = false): void => {
		if (!toolGroup || !toolIndicator) return;
		const activeButton = toolButtons.find((button) => button.dataset.paintTool === activeTool);
		if (!activeButton) return;
		const groupBox = toolGroup.getBoundingClientRect();
		const buttonBox = activeButton.getBoundingClientRect();
		const left = buttonBox.left - groupBox.left;
		toolIndicator.dataset.direction = indicatorLeft < 0 || left >= indicatorLeft ? 'forward' : 'back';
		if (instant || indicatorLeft < 0) toolIndicator.dataset.instant = '';
		else delete toolIndicator.dataset.instant;
		toolIndicator.style.setProperty('--tool-l', `${left}px`);
		toolIndicator.style.setProperty('--tool-r', `${groupBox.width - (left + buttonBox.width)}px`);
		toolIndicator.style.setProperty('--tool-t', `${buttonBox.top - groupBox.top}px`);
		toolIndicator.style.setProperty('--tool-b', `${groupBox.height - (buttonBox.bottom - groupBox.top)}px`);
		toolIndicator.dataset.ready = '';
		indicatorLeft = left;
		if (toolIndicator.dataset.instant !== undefined) {
			requestAnimationFrame(() => requestAnimationFrame(() => {
				if (toolIndicator) delete toolIndicator.dataset.instant;
			}));
		}
	};

	const setActiveTool = (tool: string): void => {
		activeTool = tool;
		root.dataset.activePaintTool = tool;
		for (const button of toolButtons) button.setAttribute('aria-pressed', String(button.dataset.paintTool === tool));
		textWrap.hidden = tool !== 'text';
		placeToolIndicator();
		// Handles belong to the sticker tool, so leaving it must clear them.
		renderOverlay();
	};

	if (toolGroup && typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => placeToolIndicator(true)).observe(toolGroup);
	}
	// The handles are sized in CSS pixels, so they have to be redrawn when the
	// canvas itself changes size.
	window.addEventListener('resize', () => {
		placeToolIndicator(true);
		renderOverlay();
	}, { passive: true });
	window.addEventListener('bnji:settingschange', () => {
		placeToolIndicator(true);
		selectionColor = getComputedStyle(root).getPropertyValue('--accent-strong').trim();
		renderOverlay();
	});

	const updateUndo = (): void => {
		undoButton.disabled = pendingOperations.length === 0 || syncing;
	};

	const summarizeActions = (): Record<string, number> => {
		// A sticker action name IS its operation kind, so the module that owns
		// the sticker model owns that half too — one definition, tested there.
		const actions = summarizeStickerActions(stickerOperations());
		for (const operation of pendingOperations) {
			if (isStickerOperation(operation)) continue;
			const action = operation.kind === 'stroke' ? operation.tool : operation.kind === 'shape' ? operation.shape : 'text';
			actions[action] = (actions[action] ?? 0) + 1;
		}
		return actions;
	};

	const clearPreview = (): void => previewContext.clearRect(0, 0, width, height);
	const isStickerOperation = (operation: PaintOperation): operation is Exclude<PaintOperation, DrawingOperation> => operation.kind.startsWith('sticker-');

	/** The sticker operations in the queue, with the drawing ones dropped. */
	const stickerOperations = (): StickerOperation[] => pendingOperations.filter(isStickerOperation);

	const effectiveStickers = (): PaintSticker[] => applyStickerOperations(sharedStickers, stickerOperations());

	/** Where a sticker is drawn right now, including an in-flight gesture. */
	const liveRect = (sticker: PaintSticker): StickerRect => {
		if (activeStickerResize?.id === sticker.id) {
			return { x: activeStickerResize.x, y: activeStickerResize.y, width: activeStickerResize.width, height: activeStickerResize.height };
		}
		if (activeStickerDrag?.id === sticker.id) {
			return { ...sticker, x: activeStickerDrag.x, y: activeStickerDrag.y };
		}
		return sticker;
	};

	/** Keep the upload-time bitmap for a sticker that is still around. */
	const rememberStickerMaster = (sticker: PaintSticker): void => {
		if (stickerMasters.has(sticker.id)) return;
		const master = new Image();
		master.onload = renderStickerLayer;
		master.src = sticker.image;
		stickerMasters.set(sticker.id, master);
	};

	/** Forget masters for stickers that are gone from the canvas and the queue. */
	const pruneStickerMasters = (): void => {
		if (stickerMasters.size <= PAINT_CONFIG.maxStickerCount) return;
		const live = new Set(effectiveStickers().map((sticker) => sticker.id));
		for (const operation of stickerOperations()) {
			live.add(operation.kind === 'sticker-add' ? operation.sticker.id : operation.id);
		}
		for (const id of Array.from(stickerMasters.keys())) if (!live.has(id)) stickerMasters.delete(id);
	};

	/**
	 * Re-encode a sticker at a new size.
	 *
	 * The server requires the stored PNG's real pixel dimensions to match the
	 * sticker's width and height, so a resize is not a rectangle-only change:
	 * without this, every publish after a resize would be rejected.
	 */
	const encodeStickerAt = (id: string, nextWidth: number, nextHeight: number): string | null => {
		const master = stickerMasters.get(id);
		if (!master || !master.complete || master.naturalWidth === 0) return null;
		const canvas = document.createElement('canvas');
		canvas.width = nextWidth;
		canvas.height = nextHeight;
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = 'high';
		context.drawImage(master, 0, 0, nextWidth, nextHeight);
		return canvas.toDataURL('image/png');
	};

	/**
	 * Redraw the stickers, and the chrome that describes them.
	 *
	 * The two live on different layers — the stickers are published and
	 * exported, the chrome never is — so a sticker that moves, resizes or
	 * disappears has to be followed by both. Redrawing only the sticker layer
	 * is how the selection outline ends up hovering over where the sticker
	 * used to be, which is what this used to do after a drag.
	 */
	const renderStickerLayer = (): void => {
		stickerContext.clearRect(0, 0, width, height);
		for (const original of effectiveStickers()) {
			const rect = liveRect(original);
			rememberStickerMaster(original);
			let bitmap = stickerImages.get(original.id);
			if (!bitmap || bitmap.src !== original.image) {
				bitmap = new Image();
				stickerImages.set(original.id, bitmap);
				bitmap.onload = renderStickerLayer;
				bitmap.src = original.image;
			}
			if (bitmap.complete && bitmap.naturalWidth > 0) {
				// The stored bitmap is drawn at the live size, so a resize is
				// previewed by the browser's own scaler and only the committed
				// result is ever re-encoded.
				stickerContext.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
			}
		}
		pruneStickerMasters();
		renderOverlay();
	};

	const compressSticker = async (file: File): Promise<PaintSticker> => {
		if (!file.type.startsWith('image/')) throw new Error('Choose an image file for the sticker.');
		if (file.size > PAINT_CONFIG.maxStickerSourceBytes) throw new Error('That image is too large to process as a sticker.');
		const bitmap = await createImageBitmap(file);
		try {
			if (bitmap.width * bitmap.height > PAINT_CONFIG.maxStickerSourcePixels) {
				throw new Error('That image has too many pixels to process safely.');
			}
			const scale = Math.min(1, PAINT_CONFIG.maxStickerWidth / bitmap.width, PAINT_CONFIG.maxStickerHeight / bitmap.height);
			const stickerWidth = Math.max(1, Math.round(bitmap.width * scale));
			const stickerHeight = Math.max(1, Math.round(bitmap.height * scale));
			const resized = document.createElement('canvas');
			resized.width = stickerWidth;
			resized.height = stickerHeight;
			const context = resized.getContext('2d');
			if (!context) throw new Error('Could not resize that sticker image.');
			context.drawImage(bitmap, 0, 0, stickerWidth, stickerHeight);
			const image = resized.toDataURL('image/png');
			if (image.length > PAINT_CONFIG.maxStickerImageChars) throw new Error('That sticker is too detailed after resizing.');
			return {
				id: crypto.randomUUID(),
				image,
				x: Math.round((width - stickerWidth) / 2),
				y: Math.round((height - stickerHeight) / 2),
				width: stickerWidth,
				height: stickerHeight,
			};
		} finally {
			bitmap.close();
		}
	};

	const rebaseStickerOperations = (): boolean => {
		const rebased = rebaseStickerQueue(sharedStickers, stickerOperations());
		const conflicts = rebased.conflicts;
		pendingOperations.splice(0, pendingOperations.length, ...rebased.operations);
		if (conflicts > 0) {
			updateUndo();
			announce(`${conflicts} local sticker change${conflicts === 1 ? '' : 's'} conflicted with a newer shared edit and were skipped; the other visitor's version was kept.`);
		}
		return conflicts > 0;
	};

	const drawPath = (
		context: CanvasRenderingContext2D,
		points: Point[],
		color: string,
		size: number,
		tool: 'pen' | 'eraser' | 'spray' | 'glow' = 'pen',
		seed = 1,
	): void => {
		if (points.length === 0) return;
		context.save();
		context.strokeStyle = color;
		context.fillStyle = color;
		context.lineWidth = size;
		context.lineCap = 'round';
		context.lineJoin = 'round';
		if (tool === 'spray') {
			let randomState = seed || 1;
			const random = (): number => {
				randomState = (randomState * 1664525 + 1013904223) >>> 0;
				return randomState / 0x100000000;
			};
			context.globalAlpha = 0.72;
			for (const point of points) {
				for (let particle = 0; particle < 5; particle++) {
					const angle = random() * Math.PI * 2;
					const distance = random() * size * 1.6;
					context.beginPath();
					context.arc(point.x + Math.cos(angle) * distance, point.y + Math.sin(angle) * distance, Math.max(0.7, size * 0.08), 0, Math.PI * 2);
					context.fill();
				}
			}
		} else {
			if (tool === 'glow') {
				context.shadowColor = color;
				context.shadowBlur = size * 1.5;
			}
			if (points.length === 1) {
				context.beginPath();
				context.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2);
				context.fill();
			} else {
				context.beginPath();
				context.moveTo(points[0].x, points[0].y);
				for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
				context.stroke();
			}
		}
		context.restore();
	};

	const drawOperation = (context: CanvasRenderingContext2D, operation: PaintOperation): void => {
		if (isStickerOperation(operation)) return;
		if (operation.kind === 'stroke') {
			drawPath(context, operation.points, operation.tool === 'eraser' ? paper : operation.color, operation.size, operation.tool, operation.seed);
			return;
		}

		context.save();
		context.strokeStyle = operation.color;
		context.fillStyle = operation.color;
		context.lineWidth = operation.size;
		context.lineCap = 'round';
		context.lineJoin = 'round';

		if (operation.kind === 'text') {
			context.font = `600 ${Math.max(16, operation.size * 3)}px system-ui, sans-serif`;
			context.textBaseline = 'top';
			context.fillText(operation.text, operation.point.x, operation.point.y, width - operation.point.x);
		} else if (operation.shape === 'line') {
			context.beginPath();
			context.moveTo(operation.start.x, operation.start.y);
			context.lineTo(operation.end.x, operation.end.y);
			context.stroke();
		} else if (operation.shape === 'rectangle') {
			context.strokeRect(
				operation.start.x,
				operation.start.y,
				operation.end.x - operation.start.x,
				operation.end.y - operation.start.y,
			);
		} else {
			const radiusX = Math.max(1, Math.abs(operation.end.x - operation.start.x) / 2);
			const radiusY = Math.max(1, Math.abs(operation.end.y - operation.start.y) / 2);
			context.beginPath();
			context.ellipse(
				(operation.start.x + operation.end.x) / 2,
				(operation.start.y + operation.end.y) / 2,
				radiusX,
				radiusY,
				0,
				0,
				Math.PI * 2,
			);
			context.stroke();
		}
		context.restore();
	};

	const repaintLocal = (): void => {
		localContext.clearRect(0, 0, width, height);
		for (const operation of pendingOperations) drawOperation(localContext, operation);
		renderStickerLayer();
		updateUndo();
	};

	/**
	 * Everything transient on the preview layer: the stroke in progress, and
	 * the selection chrome for the selected sticker.
	 *
	 * This layer is the only safe home for the chrome. The sticker layer is
	 * flattened into the published bitmap and the exported PNG, and the local
	 * layer carries real edits - so handles drawn there would end up published.
	 */
	const renderOverlay = (): void => {
		clearPreview();
		drawActivePreview();
		drawSelectionChrome();
	};

	const getPoint = (event: PointerEvent): Point => {
		const rect = inputCanvas.getBoundingClientRect();
		return {
			x: Math.max(0, Math.min(width, ((event.clientX - rect.left) / rect.width) * width)),
			y: Math.max(0, Math.min(height, ((event.clientY - rect.top) / rect.height) * height)),
		};
	};

	/** The canvas as laid out now, relative to the 1200 x 750 logical grid. */
	const canvasScale = (): number => displayScale(inputCanvas.getBoundingClientRect().width, width);

	const selectedSticker = (): PaintSticker | undefined =>
		effectiveStickers().find((sticker) => sticker.id === selectedStickerId);

	/**
	 * Selection chrome: an outline and four corner handles.
	 *
	 * Only drawn while the sticker tool is active, so the canvas does not look
	 * like something that can be grabbed while the visitor is drawing.
	 */
	const drawSelectionChrome = (): void => {
		if (activeTool !== 'sticker' || activeDrawing) return;
		const selected = selectedSticker();
		if (!selected) return;
		const rect = liveRect(selected);
		const scale = canvasScale();
		const size = handleSize(rect, scale);

		previewContext.save();
		// A hairline stays a hairline on a 4K display instead of vanishing.
		previewContext.lineWidth = Math.max(1 / scale, 0.5);
		previewContext.strokeStyle = selectionColor;
		previewContext.fillStyle = selectionColor;
		previewContext.strokeRect(rect.x, rect.y, rect.width, rect.height);
		for (const centre of Object.values(handleCentres(rect))) {
			previewContext.fillRect(centre.x - size / 2, centre.y - size / 2, size, size);
		}
		previewContext.restore();
	};

	/** Which corner handle, if any, is under the pointer right now. */
	const cornerUnderPointer = (point: Point): ResizeCorner | null => {
		const selected = selectedSticker();
		if (!selected) return null;
		return cornerAt(point, liveRect(selected), canvasScale());
	};

	/**
	 * A pointer over a handle or a sticker should look grabbable. The cursor is
	 * mirrored onto the root element so the rules can live in the stylesheet
	 * rather than being set one style at a time from script.
	 */
	const setStickerCursor = (cursor: string): void => {
		if (root.dataset.stickerCursor === cursor) return;
		if (cursor) root.dataset.stickerCursor = cursor;
		else delete root.dataset.stickerCursor;
	};

	const updateStickerCursor = (point: Point): void => {
		if (activeTool !== 'sticker' || activeDrawing) {
			setStickerCursor('');
			return;
		}
		const corner = cornerUnderPointer(point);
		if (corner) {
			setStickerCursor(corner === 'nw' || corner === 'se' ? 'nwse' : 'nesw');
			return;
		}
		setStickerCursor(stickerAt(effectiveStickers(), point) ? 'grab' : '');
	};

	const drawActivePreview = (): void => {
		if (!activeDrawing) return;
		const { tool, start, current, points, color, size } = activeDrawing;
		if (tool === 'pen' || tool === 'eraser' || tool === 'spray' || tool === 'glow') {
			drawPath(previewContext, points, tool === 'eraser' ? paper : color, size, tool, activeDrawing.seed);
		} else {
			drawOperation(previewContext, {
				kind: 'shape',
				shape: tool as 'line' | 'rectangle' | 'ellipse',
				start,
				end: current,
				color,
				size,
			});
		}
	};

	const loadBaseImage = (image: string | null): Promise<void> =>
		new Promise((resolve) => {
			baseContext.fillStyle = paper;
			baseContext.fillRect(0, 0, width, height);
			if (!image) {
				resolve();
				return;
			}

			const bitmap = new Image();
			bitmap.onload = () => {
				baseContext.clearRect(0, 0, width, height);
				baseContext.drawImage(bitmap, 0, 0, width, height);
				resolve();
			};
			bitmap.onerror = () => {
				announce('The shared image could not be decoded. You can still draw and publish a replacement.');
				resolve();
			};
			bitmap.src = image;
		});

	const applySharedState = async (state: SharedState, nextEtag?: string | null): Promise<boolean> => {
		await loadBaseImage(state.image);
		sharedStickers = Array.isArray(state.stickers) ? state.stickers : [];
		revision = state.revision;
		etag = nextEtag ?? `W/"paint-${state.revision}"`;
		const hadConflicts = rebaseStickerOperations();
		renderStickerLayer();
		return hadConflicts;
	};

	const refreshSharedState = async (force = false): Promise<boolean> => {
		const headers = new Headers();
		if (!force && etag) headers.set('If-None-Match', etag);
		const response = await fetch('/api/paint', {
			method: 'GET',
			headers,
			cache: 'no-store',
			credentials: 'same-origin',
		});
		if (response.status === 304) return false;
		if (!response.ok) throw new Error(response.status === 503 ? 'Shared paint storage is unavailable.' : 'Could not refresh the shared canvas.');

		const state = (await response.json()) as SharedState;
		await applySharedState(state, response.headers.get('etag'));
		return true;
	};

	const setBoardVisible = (visible: boolean): void => {
		if (board) board.hidden = !visible;
	};

	const stopPolling = (): void => {
		if (pollTimer !== null) {
			window.clearInterval(pollTimer);
			pollTimer = null;
		}
	};

	const poll = (): void => {
		if (document.hidden || !paintInView || syncing) return;
		void refreshSharedState().then((changed) => {
			if (changed && pendingOperations.length > 0) {
				announce(`Canvas refreshed; ${pendingOperations.length} local ${pendingOperations.length === 1 ? 'mark remains' : 'marks remain'} unsynced.`);
			}
		}).catch(() => {
			// Keep the last complete snapshot; the manual Sync & refresh action
			// will surface any persistent storage error to the visitor.
		});
	};

	const startPolling = (): void => {
		if (document.hidden || !paintInView || pollTimer !== null) return;
		poll();
		pollTimer = window.setInterval(poll, PAINT_CONFIG.pollIntervalMs);
	};

	const compositeImage = (): string => {
		const composite = document.createElement('canvas');
		composite.width = width;
		composite.height = height;
		const context = composite.getContext('2d');
		if (!context) throw new Error('Could not compose the canvas image.');
		context.fillStyle = paper;
		context.fillRect(0, 0, width, height);
		context.drawImage(baseCanvas, 0, 0);
		context.drawImage(localCanvas, 0, 0);
		return composite.toDataURL('image/png');
	};

	const setSyncing = (value: boolean): void => {
		syncing = value;
		syncButton.disabled = value || stickerProcessing;
		stickerUploadButton.disabled = value || stickerProcessing;
		inputCanvas.setAttribute('aria-disabled', String(value));
		root.dataset.paintSyncing = String(value);
		syncButton.setAttribute('aria-busy', String(value));
		updateUndo();
	};

	const syncAndRefresh = async (): Promise<void> => {
		if (syncing) return;
		if (activeDrawing || activeStickerDrag || activeStickerResize || erasingPointerId !== null || stickerProcessing) {
			announce('Finish the current drawing or sticker edit before publishing.');
			return;
		}
		setSyncing(true);

		try {
			if (pendingOperations.length === 0 && !pendingRequest) {
				const changed = await refreshSharedState(true);
				announce(changed ? `Canvas refreshed to revision ${revision}.` : 'Canvas is already up to date.');
				return;
			}

			for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt++) {
				if (!pendingRequest) {
					const image = compositeImage();
					if (image.length > PAINT_CONFIG.maxImageChars) {
						announce(`This drawing is too detailed to sync. Keep the PNG under ${Math.round(PAINT_CONFIG.maxImageChars / 1000)} KB.`);
						return;
					}
					pendingRequest = {
						revision,
						requestId: crypto.randomUUID(),
						image,
						stickers: effectiveStickers(),
						actions: summarizeActions(),
					};
				}

				let response: Response;
				try {
					response = await fetch('/api/paint', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						cache: 'no-store',
						body: JSON.stringify(pendingRequest),
					});
				} catch {
					// Keep the exact request ID and image: if the Worker committed
					// before the connection dropped, retrying it is idempotent.
					announce('Sync could not reach the server. Your drawing is safe here; try again.');
					return;
				}

				const result = (await response.json().catch(() => ({}))) as SharedState & {
					error?: string;
					retryAfter?: number;
					maxImageChars?: number;
				};

				if (response.headers.get('x-paint-already-applied') === 'true') {
					await applySharedState(result, response.headers.get('etag'));
					pendingOperations.length = 0;
					pendingRequest = null;
					repaintLocal();
					announce(`Your previous publish was already saved. Canvas refreshed to revision ${revision}.`);
					return;
				}

				if (response.status === 409) {
					const hadStickerConflicts = await applySharedState(result, response.headers.get('etag'));
					pendingRequest = null;
					if (pendingOperations.length === 0) {
						announce(hadStickerConflicts
							? 'The newer shared sticker version was kept; no local changes remain to publish.'
							: 'The shared canvas changed, and there are no local edits left to publish.');
						return;
					}
					continue;
				}

				if (!response.ok) {
					if (response.status < 500) pendingRequest = null;
					if (result.error === 'rate_limited') {
						announce(`Sync limit reached. Try again in ${result.retryAfter ?? 60} seconds.`);
					} else if (result.error === 'image_too_large' || response.status === 413) {
					announce(`This drawing is too detailed to sync. Keep the PNG under ${Math.round(PAINT_CONFIG.maxImageChars / 1000)} KB.`);
				} else if (response.status === 503) {
					announce('Shared paint storage is unavailable. Your local drawing is still here.');
				} else {
					announce('Could not publish this drawing. Your local marks are still here.');
				}
					return;
				}

				revision = result.revision;
				etag = response.headers.get('etag') ?? `W/"paint-${revision}"`;
				await loadBaseImage(pendingRequest.image);
				sharedStickers = Array.isArray(result.stickers) ? result.stickers : pendingRequest.stickers;
				pendingOperations.length = 0;
				pendingRequest = null;
				repaintLocal();
				announce(`Published and refreshed. Shared canvas is now at revision ${revision}.`);
				return;
			}

			announce('Other drawings kept arriving. Your marks are safe; press Sync & refresh again to finish merging.');
		} catch (error) {
			announce(error instanceof Error ? error.message : 'Could not refresh the shared canvas.');
		} finally {
			setSyncing(false);
		}
	};

	const removeStickerAt = (point: Point): boolean => {
		const sticker = stickerAt(effectiveStickers(), point);
		if (!sticker) return false;
		pendingOperations.push({ kind: 'sticker-remove', id: sticker.id, beforeX: sticker.x, beforeY: sticker.y });
		// Dropping the selected sticker must also drop its handles.
		if (selectedStickerId === sticker.id) selectedStickerId = null;
		renderStickerLayer();
		updateUndo();
		announce('Sticker erased locally. Sync & refresh to share the change.');
		return true;
	};

	/**
	 * Commit a finished resize.
	 *
	 * The bitmap is re-encoded from the sticker's upload-time master, because
	 * the server checks that the stored PNG's own pixel dimensions match the
	 * sticker's width and height. If it cannot be encoded - or the result would
	 * be too large to store - the operation is simply not queued, and the
	 * sticker falls back to the size the server has.
	 */
	const commitStickerResize = (resize: ActiveStickerResize): void => {
		if (resize.width === resize.beforeWidth && resize.height === resize.beforeHeight) return;
		const image = encodeStickerAt(resize.id, resize.width, resize.height);
		if (!image) {
			announce('That sticker could not be resized, so it kept its current size.');
			return;
		}
		if (image.length > PAINT_CONFIG.maxStickerImageChars) {
			announce('That size made the sticker too detailed to store, so it kept its current size.');
			return;
		}
		const next: PaintSticker = { id: resize.id, image, x: resize.x, y: resize.y, width: resize.width, height: resize.height };
		const stickers = effectiveStickers().map((sticker) => (sticker.id === resize.id ? next : sticker));
		if (JSON.stringify(stickers).length > PAINT_CONFIG.maxStickerPayloadChars) {
			announce('The shared sticker storage is full, so this resize was not kept.');
			return;
		}
		pendingOperations.push({
			kind: 'sticker-resize',
			id: resize.id,
			beforeX: resize.beforeX,
			beforeY: resize.beforeY,
			beforeWidth: resize.beforeWidth,
			beforeHeight: resize.beforeHeight,
			x: resize.x,
			y: resize.y,
			width: resize.width,
			height: resize.height,
			image,
		});
		updateUndo();
		announce(`Sticker resized to ${resize.width} × ${resize.height} locally. Sync & refresh to publish.`);
	};

	/**
	 * Resize the selected sticker from the keyboard.
	 *
	 * The axis the visitor touched leads and the other follows the ratio, so
	 * the result is always a size that exists rather than a free rectangle.
	 * The position is held still: a keyboard resize should not move anything.
	 */
	const resizeSelectedWithKeyboard = (selected: PaintSticker, direction: Point, freeRatio: boolean): void => {
		const ratio = selected.width / selected.height;
		let nextWidth = selected.width + direction.x;
		let nextHeight = selected.height + direction.y;
		if (!freeRatio) {
			if (direction.x !== 0) nextHeight = Math.round(nextWidth / ratio);
			else nextWidth = Math.round(nextHeight * ratio);
		}
		nextWidth = Math.max(1, Math.min(stickerBounds.maxWidth, nextWidth));
		nextHeight = Math.max(1, Math.min(stickerBounds.maxHeight, nextHeight));
		if (nextWidth === selected.width && nextHeight === selected.height) return;

		const image = encodeStickerAt(selected.id, nextWidth, nextHeight);
		if (!image || image.length > PAINT_CONFIG.maxStickerImageChars) {
			announce('That size could not be stored for this sticker.');
			return;
		}
		const x = Math.max(0, Math.min(width - nextWidth, selected.x));
		const y = Math.max(0, Math.min(height - nextHeight, selected.y));
		pendingOperations.push({
			kind: 'sticker-resize',
			id: selected.id,
			beforeX: selected.x,
			beforeY: selected.y,
			beforeWidth: selected.width,
			beforeHeight: selected.height,
			x,
			y,
			width: nextWidth,
			height: nextHeight,
			image,
		});
		renderStickerLayer();
		updateUndo();
		announce(`Sticker resized to ${nextWidth} × ${nextHeight} locally. Sync & refresh to publish.`);
	};

	const finishDrawing = (event: PointerEvent): void => {
		if (activeStickerResize?.pointerId === event.pointerId) {
			const resize = activeStickerResize;
			activeStickerResize = null;
			setStickerCursor('');
			commitStickerResize(resize);
			renderStickerLayer();
			renderOverlay();
			return;
		}
		if (activeStickerDrag?.pointerId === event.pointerId) {
			const drag = activeStickerDrag;
			activeStickerDrag = null;
			if (drag.x !== drag.beforeX || drag.y !== drag.beforeY) {
				pendingOperations.push({ kind: 'sticker-move', id: drag.id, beforeX: drag.beforeX, beforeY: drag.beforeY, x: drag.x, y: drag.y });
				updateUndo();
				announce('Sticker moved locally. Sync & refresh to share the change.');
			}
			renderStickerLayer();
			return;
		}
		if (erasingPointerId === event.pointerId) {
			erasingPointerId = null;
			return;
		}
		if (!activeDrawing || activeDrawing.pointerId !== event.pointerId) return;
		const drawing = activeDrawing;
		const end = getPoint(event);
		activeDrawing = null;
		renderOverlay();

		let operation: DrawingOperation;
		if (drawing.tool === 'pen' || drawing.tool === 'eraser' || drawing.tool === 'spray' || drawing.tool === 'glow') {
			const last = drawing.points[drawing.points.length - 1];
			if (Math.hypot(end.x - last.x, end.y - last.y) > 0.5) drawing.points.push(end);
			operation = {
				kind: 'stroke',
				tool: drawing.tool,
				points: drawing.points,
				color: drawing.color,
				size: drawing.size,
				...(drawing.tool === 'spray' ? { seed: drawing.seed } : {}),
			};
		} else {
			operation = {
				kind: 'shape',
				shape: drawing.tool as 'line' | 'rectangle' | 'ellipse',
				start: drawing.start,
				end,
				color: drawing.color,
				size: drawing.size,
			};
		}

		pendingOperations.push(operation);
		drawOperation(localContext, operation);
		updateUndo();
		announce(`${pendingOperations.length} unsynced local mark${pendingOperations.length === 1 ? '' : 's'}. Sync & refresh to publish.`);
	};

	inputCanvas.addEventListener('pointerdown', (event) => {
		if (syncing || (event.pointerType === 'mouse' && event.button !== 0)) return;
		event.preventDefault();
		const point = getPoint(event);

		if (activeTool === 'sticker') {
			const stickers = effectiveStickers();

			// A corner of the selected sticker is checked FIRST, and against the
			// sticker itself rather than the stack: handles sit on top of their
			// own sticker, and a handle on the selected sticker must win even if
			// another sticker happens to overlap it.
			const selected = stickers.find((sticker) => sticker.id === selectedStickerId);
			const corner = selected ? cornerAt(point, liveRect(selected), canvasScale()) : null;
			if (selected && corner) {
				const rect = liveRect(selected);
				activeStickerResize = {
					pointerId: event.pointerId,
					id: selected.id,
					corner,
					beforeX: rect.x,
					beforeY: rect.y,
					beforeWidth: rect.width,
					beforeHeight: rect.height,
					...rect,
				};
				inputCanvas.setPointerCapture(event.pointerId);
				setStickerCursor('grabbing');
				renderStickerLayer();
				return;
			}

			const sticker = stickerAt(stickers, point);
			if (!sticker) {
				// Clicking bare canvas drops the selection, so the handles stop
				// hovering over the canvas for the rest of the session.
				if (selectedStickerId !== null) {
					selectedStickerId = null;
					renderOverlay();
				}
				announce('Choose a sticker image, then drag it into place.');
				return;
			}
			selectedStickerId = sticker.id;
			activeStickerDrag = {
				pointerId: event.pointerId,
				id: sticker.id,
				offsetX: point.x - sticker.x,
				offsetY: point.y - sticker.y,
				beforeX: sticker.x,
				beforeY: sticker.y,
				x: sticker.x,
				y: sticker.y,
			};
			inputCanvas.setPointerCapture(event.pointerId);
			renderStickerLayer();
			renderOverlay();
			return;
		}

		if (activeTool === 'eraser' && stickerAt(effectiveStickers(), point)) {
			erasingPointerId = event.pointerId;
			inputCanvas.setPointerCapture(event.pointerId);
			removeStickerAt(point);
			return;
		}

		if (activeTool === 'text') {
			const text = textInput.value.trim();
			if (!text) {
				announce('Enter some text before placing it.');
				return;
			}
			const operation: DrawingOperation = { kind: 'text', point, text, color: activeColor, size: brushSize };
			pendingOperations.push(operation);
			drawOperation(localContext, operation);
			updateUndo();
			announce('Text added locally. Sync & refresh to publish.');
			return;
		}

		activeDrawing = {
			pointerId: event.pointerId,
			tool: activeTool,
			start: point,
			current: point,
			points: [point],
			color: activeColor,
			size: brushSize,
			seed: Math.floor(Math.random() * 0x100000000),
		};
		inputCanvas.setPointerCapture(event.pointerId);
		drawActivePreview();
	});

	inputCanvas.addEventListener('pointerleave', () => {
		// A captured pointer keeps reporting moves while the gesture runs, so
		// leaving the canvas mid-drag must not reset the cursor underneath it.
		if (activeDrawing || activeStickerDrag || activeStickerResize || erasingPointerId !== null) return;
		setStickerCursor('');
	});

	inputCanvas.addEventListener('pointermove', (event) => {
		const point = getPoint(event);

		if (activeStickerResize?.pointerId === event.pointerId) {
			// Every frame is recomputed from the rectangle the drag started
			// from, never from the previous frame's result, so rounding cannot
			// accumulate into a drift over a long drag.
			const next = resizeSticker(
				{
					x: activeStickerResize.beforeX,
					y: activeStickerResize.beforeY,
					width: activeStickerResize.beforeWidth,
					height: activeStickerResize.beforeHeight,
				},
				{
					corner: activeStickerResize.corner,
					pointer: point,
					// Shift is read live: the lock is on by default and holding
					// Shift releases it for as long as it is held.
					lockRatio: !event.shiftKey,
					bounds: stickerBounds,
				},
			);
			activeStickerResize.x = next.x;
			activeStickerResize.y = next.y;
			activeStickerResize.width = next.width;
			activeStickerResize.height = next.height;
			renderStickerLayer();
			return;
		}

		if (activeStickerDrag?.pointerId === event.pointerId) {
			const sticker = effectiveStickers().find((item) => item.id === activeStickerDrag?.id);
			if (sticker && activeStickerDrag) {
				activeStickerDrag.x = Math.max(0, Math.min(width - sticker.width, point.x - activeStickerDrag.offsetX));
				activeStickerDrag.y = Math.max(0, Math.min(height - sticker.height, point.y - activeStickerDrag.offsetY));
				renderStickerLayer();
			}
			return;
		}
		if (erasingPointerId === event.pointerId) {
			removeStickerAt(point);
			return;
		}
		updateStickerCursor(point);
		if (!activeDrawing || activeDrawing.pointerId !== event.pointerId) return;
		if (activeDrawing.tool === 'eraser') removeStickerAt(point);
		activeDrawing.current = point;
		if (['pen', 'eraser', 'spray', 'glow'].includes(activeDrawing.tool)) {
			const previous = activeDrawing.points[activeDrawing.points.length - 1];
			if (activeDrawing.points.length < MAX_STROKE_POINTS && Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) {
				activeDrawing.points.push(point);
			}
		}
		drawActivePreview();
	});

	inputCanvas.addEventListener('pointerup', finishDrawing);
	inputCanvas.addEventListener('pointercancel', (event) => {
		if (activeStickerDrag?.pointerId === event.pointerId) {
			activeStickerDrag = null;
			renderStickerLayer();
		}
		if (erasingPointerId === event.pointerId) erasingPointerId = null;
		if (activeStickerResize?.pointerId === event.pointerId) {
			// A cancelled resize is dropped rather than committed: the sticker
			// simply returns to the size the server has.
			activeStickerResize = null;
			setStickerCursor('');
			renderStickerLayer();
		}
		if (!activeDrawing || activeDrawing.pointerId !== event.pointerId) return;
		activeDrawing = null;
		renderOverlay();
	});

	for (const button of toolButtons) {
		button.addEventListener('click', () => {
			setActiveTool(button.dataset.paintTool ?? 'pen');
		});
	}
	setActiveTool('pen');

	stickerUploadButton.addEventListener('click', () => {
		setActiveTool('sticker');
		stickerFile.click();
	});
	stickerFile.addEventListener('change', () => {
		const file = stickerFile.files?.[0];
		stickerFile.value = '';
		if (!file) return;
		stickerProcessing = true;
		syncButton.disabled = true;
		stickerUploadButton.disabled = true;
		void compressSticker(file).then((sticker) => {
			const stickers = effectiveStickers();
			if (stickers.length >= PAINT_CONFIG.maxStickerCount) {
				announce(`This shared canvas supports up to ${PAINT_CONFIG.maxStickerCount} stickers.`);
				return;
			}
			if (JSON.stringify([...stickers, sticker]).length > PAINT_CONFIG.maxStickerPayloadChars) {
				announce('The sticker set is at its shared storage limit. Remove a sticker before adding another.');
				return;
			}
			pendingOperations.push({ kind: 'sticker-add', sticker });
			// Selecting it straight away shows its handles, so the next drag can
			// resize it without a click first.
			selectedStickerId = sticker.id;
			renderStickerLayer();
			updateUndo();
			announce('Sticker added locally. Drag a corner to resize it; Sync & refresh to publish.');
		}).catch((error: unknown) => {
			announce(error instanceof Error ? error.message : 'Could not process that sticker image.');
		}).finally(() => {
			stickerProcessing = false;
			syncButton.disabled = syncing;
			stickerUploadButton.disabled = syncing;
		});
	});

	inputCanvas.addEventListener('keydown', (event) => {
		if (syncing || (activeTool !== 'sticker' && activeTool !== 'eraser')) return;
		const stickers = effectiveStickers();
		const selected = stickers.find((sticker) => sticker.id === selectedStickerId) ?? stickers[0];
		if (!selected) return;
		selectedStickerId = selected.id;
		if (activeTool === 'eraser' && (event.key === 'Delete' || event.key === 'Backspace')) {
			event.preventDefault();
			removeStickerAt({ x: selected.x + selected.width / 2, y: selected.y + selected.height / 2 });
			return;
		}
		const directions: Record<string, Point> = {
			ArrowLeft: { x: -1, y: 0 },
			ArrowRight: { x: 1, y: 0 },
			ArrowUp: { x: 0, y: -1 },
			ArrowDown: { x: 0, y: 1 },
		};
		const direction = directions[event.key];
		if (!direction || activeTool !== 'sticker') return;

		// Alt + arrow resizes. Proportional by default, exactly like the corner
		// drag; Ctrl or Cmd releases the ratio for the cases where a deliberate
		// squash is the point. Shift keeps its existing "bigger step" meaning
		// rather than borrowing the pointer's "release the ratio" one.
		if (event.altKey) {
			event.preventDefault();
			resizeSelectedWithKeyboard(selected, direction, event.ctrlKey || event.metaKey);
			return;
		}

		event.preventDefault();
		const step = event.shiftKey ? 10 : 1;
		const x = Math.max(0, Math.min(width - selected.width, selected.x + direction.x * step));
		const y = Math.max(0, Math.min(height - selected.height, selected.y + direction.y * step));
		if (x === selected.x && y === selected.y) return;
		pendingOperations.push({ kind: 'sticker-move', id: selected.id, beforeX: selected.x, beforeY: selected.y, x, y });
		renderStickerLayer();
		updateUndo();
		announce('Sticker moved locally. Sync & refresh to publish the change.');
	});

	for (const button of colorButtons) {
		button.addEventListener('click', () => {
			activeColor = getComputedStyle(button).backgroundColor;
			for (const option of colorButtons) {
				option.setAttribute('aria-pressed', String(option === button));
			}
		});
	}

	sizeInput.addEventListener('input', () => {
		brushSize = Number(sizeInput.value);
		sizeOutput.value = `${brushSize} px`;
	});

	undoButton.addEventListener('click', () => {
		if (pendingOperations.length === 0) return;
		pendingOperations.pop();
		repaintLocal();
		announce(pendingOperations.length > 0 ? `${pendingOperations.length} unsynced marks remain.` : 'Local marks undone. Shared canvas is unchanged.');
	});

	syncButton.addEventListener('click', () => void syncAndRefresh());

	exportButton.addEventListener('click', () => {
		try {
			const composite = document.createElement('canvas');
			composite.width = width;
			composite.height = height;
			const context = composite.getContext('2d');
			if (!context) throw new Error('Could not export the canvas.');
			context.fillStyle = paper;
			context.fillRect(0, 0, width, height);
			context.drawImage(baseCanvas, 0, 0);
			context.drawImage(localCanvas, 0, 0);
			context.drawImage(stickerCanvas, 0, 0);
			composite.toBlob((blob) => {
				if (!blob) {
					announce('Could not export the canvas image.');
					return;
				}
				const url = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = url;
				link.download = 'shared-board-paint.png';
				link.click();
				window.setTimeout(() => URL.revokeObjectURL(url), 1000);
				announce('Canvas exported as PNG.');
			}, 'image/png');
		} catch {
			announce('Could not export the canvas image.');
		}
	});

	let wasFullscreen = false;
	const updateFullscreenButton = (): void => {
		const fullscreen = document.fullscreenElement === root;
		fullscreenButton.setAttribute('aria-pressed', String(fullscreen));
		fullscreenButton.textContent = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
		if (wasFullscreen && !fullscreen) {
			window.requestAnimationFrame(() => fullscreenButton.focus());
		}
		wasFullscreen = fullscreen;
	};

	fullscreenButton.addEventListener('click', () => {
		if (document.fullscreenElement === root) {
			void document.exitFullscreen();
		} else if (root.requestFullscreen) {
			void root.requestFullscreen().catch(() => announce('Fullscreen is not available in this browser.'));
		} else {
			announce('Fullscreen is not available in this browser.');
		}
	});
	document.addEventListener('fullscreenchange', updateFullscreenButton);

	const refreshBoardLayer = (): void => {
		// Give the canvas section room in normal document flow: once it enters
		// view, hide the board's fixed sky/composer so this independent feature
		// is not covered by the full-screen board layer.
		if (!board) return;
		const bounds = root.getBoundingClientRect();
		const inPaintArea = bounds.top < window.innerHeight && bounds.bottom > 0;
		setBoardVisible(!inPaintArea);
	};

	if (typeof IntersectionObserver !== 'undefined') {
		const observer = new IntersectionObserver((entries) => {
			paintInView = entries.some((entry) => entry.isIntersecting);
			refreshBoardLayer();
			if (paintInView) startPolling();
			else stopPolling();
		});
		observer.observe(root);
	} else {
		paintInView = true;
		startPolling();
		window.addEventListener('scroll', refreshBoardLayer, { passive: true });
	}

	document.addEventListener('visibilitychange', () => {
		if (document.hidden) stopPolling();
		else startPolling();
	});

	void refreshSharedState(true)
		.then(() => announce('Shared canvas ready. Your marks will publish when you sync.'))
		.catch((error: unknown) => {
			announce(error instanceof Error ? error.message : 'Could not load the shared canvas.');
		});

	// The initial board view is above the paint section; ensure the fixed board
	// remains visible until the visitor scrolls down to the new section.
	refreshBoardLayer();
}
