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

type Point = { x: number; y: number };
type PaintSticker = { id: string; image: string; x: number; y: number; width: number; height: number };
type DrawingOperation =
	| { kind: 'stroke'; tool: 'pen' | 'eraser' | 'spray' | 'glow'; points: Point[]; color: string; size: number; seed?: number }
	| { kind: 'shape'; shape: 'line' | 'rectangle' | 'ellipse'; start: Point; end: Point; color: string; size: number }
	| { kind: 'text'; point: Point; text: string; color: string; size: number };
type PaintOperation = DrawingOperation
	| { kind: 'sticker-add'; sticker: PaintSticker }
	| { kind: 'sticker-move'; id: string; beforeX: number; beforeY: number; x: number; y: number }
	| { kind: 'sticker-remove'; id: string; beforeX: number; beforeY: number };

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
	const width = PAINT_CONFIG.width;
	const height = PAINT_CONFIG.height;
	const pendingOperations: PaintOperation[] = [];
	const stickerImages = new Map<string, HTMLImageElement>();

	let sharedStickers: PaintSticker[] = [];
	let activeStickerDrag: ActiveStickerDrag | null = null;
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
	};

	if (toolGroup && typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => placeToolIndicator(true)).observe(toolGroup);
	}
	window.addEventListener('resize', () => placeToolIndicator(true), { passive: true });
	window.addEventListener('bnji:settingschange', () => placeToolIndicator(true));

	const updateUndo = (): void => {
		undoButton.disabled = pendingOperations.length === 0 || syncing;
	};

	const summarizeActions = (): Record<string, number> => {
		const actions: Record<string, number> = {};
		for (const operation of pendingOperations) {
			const action = operation.kind === 'stroke'
				? operation.tool
				: operation.kind === 'shape'
					? operation.shape
					: operation.kind === 'text'
						? 'text'
						: operation.kind;
			actions[action] = (actions[action] ?? 0) + 1;
		}
		return actions;
	};

	const clearPreview = (): void => previewContext.clearRect(0, 0, width, height);
	const isStickerOperation = (operation: PaintOperation): operation is Exclude<PaintOperation, DrawingOperation> => operation.kind.startsWith('sticker-');

	const effectiveStickers = (): PaintSticker[] => {
		const stickers = sharedStickers.map((sticker) => ({ ...sticker }));
		for (const operation of pendingOperations) {
			if (!isStickerOperation(operation)) continue;
			if (operation.kind === 'sticker-add') {
				if (!stickers.some((sticker) => sticker.id === operation.sticker.id)) stickers.push({ ...operation.sticker });
			} else {
				const index = stickers.findIndex((sticker) => sticker.id === operation.id);
				if (index < 0) continue;
				const sticker = stickers[index];
				if (sticker.x !== operation.beforeX || sticker.y !== operation.beforeY) continue;
				if (operation.kind === 'sticker-move') {
					stickers[index] = { ...sticker, x: operation.x, y: operation.y };
				} else {
					stickers.splice(index, 1);
				}
			}
		}
		return stickers;
	};

	const stickerAt = (point: Point): PaintSticker | undefined =>
		effectiveStickers().slice().reverse().find((sticker) =>
			point.x >= sticker.x && point.x <= sticker.x + sticker.width &&
			point.y >= sticker.y && point.y <= sticker.y + sticker.height,
		);

	const renderStickerLayer = (): void => {
		stickerContext.clearRect(0, 0, width, height);
		for (const original of effectiveStickers()) {
			const sticker = activeStickerDrag?.id === original.id
				? { ...original, x: activeStickerDrag.x, y: activeStickerDrag.y }
				: original;
			let bitmap = stickerImages.get(sticker.id);
			if (!bitmap || bitmap.src !== sticker.image) {
				bitmap = new Image();
				stickerImages.set(sticker.id, bitmap);
				bitmap.onload = renderStickerLayer;
				bitmap.src = sticker.image;
			}
			if (bitmap.complete && bitmap.naturalWidth > 0) {
				stickerContext.drawImage(bitmap, sticker.x, sticker.y, sticker.width, sticker.height);
			}
		}
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
		const working = sharedStickers.map((sticker) => ({ ...sticker }));
		const kept: PaintOperation[] = [];
		let conflicts = 0;
		for (const operation of pendingOperations) {
			if (!isStickerOperation(operation)) {
				kept.push(operation);
				continue;
			}
			if (operation.kind === 'sticker-add') {
				const existing = working.find((sticker) => sticker.id === operation.sticker.id);
				if (existing) {
					if (existing.image !== operation.sticker.image) conflicts++;
					continue;
				}
				working.push({ ...operation.sticker });
				kept.push(operation);
				continue;
			}
			const index = working.findIndex((sticker) => sticker.id === operation.id);
			if (operation.kind === 'sticker-remove' && index < 0) continue;
			if (index < 0) {
				conflicts++;
				continue;
			}
			const sticker = working[index];
			if (sticker.x !== operation.beforeX || sticker.y !== operation.beforeY) {
				if (!(operation.kind === 'sticker-move' && sticker.x === operation.x && sticker.y === operation.y)) conflicts++;
				continue;
			}
			if (operation.kind === 'sticker-move') {
				working[index] = { ...sticker, x: operation.x, y: operation.y };
				kept.push(operation);
			} else {
				working.splice(index, 1);
				kept.push(operation);
			}
		}
		pendingOperations.splice(0, pendingOperations.length, ...kept);
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
		clearPreview();
		updateUndo();
	};

	const getPoint = (event: PointerEvent): Point => {
		const rect = inputCanvas.getBoundingClientRect();
		return {
			x: Math.max(0, Math.min(width, ((event.clientX - rect.left) / rect.width) * width)),
			y: Math.max(0, Math.min(height, ((event.clientY - rect.top) / rect.height) * height)),
		};
	};

	const drawActivePreview = (): void => {
		clearPreview();
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
		if (activeDrawing || activeStickerDrag || erasingPointerId !== null || stickerProcessing) {
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
		const sticker = stickerAt(point);
		if (!sticker) return false;
		pendingOperations.push({ kind: 'sticker-remove', id: sticker.id, beforeX: sticker.x, beforeY: sticker.y });
		renderStickerLayer();
		updateUndo();
		announce('Sticker erased locally. Sync & refresh to share the change.');
		return true;
	};

	const finishDrawing = (event: PointerEvent): void => {
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
		clearPreview();

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
			const sticker = stickerAt(point);
			if (!sticker) {
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
			return;
		}

		if (activeTool === 'eraser' && stickerAt(point)) {
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

	inputCanvas.addEventListener('pointermove', (event) => {
		const point = getPoint(event);
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
		if (!activeDrawing || activeDrawing.pointerId !== event.pointerId) return;
		activeDrawing = null;
		clearPreview();
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
			selectedStickerId = sticker.id;
			renderStickerLayer();
			updateUndo();
			announce('Sticker added locally. Drag it into place; Sync & refresh to publish it.');
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
