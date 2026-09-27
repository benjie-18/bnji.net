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
type PaintOperation =
	| { kind: 'stroke'; tool: 'pen' | 'eraser'; points: Point[]; color: string; size: number }
	| { kind: 'shape'; shape: 'line' | 'rectangle' | 'ellipse'; start: Point; end: Point; color: string; size: number }
	| { kind: 'text'; point: Point; text: string; color: string; size: number };

type SharedState = { revision: number; image: string | null; updatedAt: number };
type PendingRequest = { revision: number; requestId: string; image: string };
type ActiveDrawing = {
	pointerId: number;
	tool: string;
	start: Point;
	current: Point;
	points: Point[];
	color: string;
	size: number;
};

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
	const inputCanvas = root.querySelector<HTMLCanvasElement>('[data-paint-input]');
	const surface = root.querySelector<HTMLElement>('[data-paint-surface]');
	const status = root.querySelector<HTMLElement>('[data-paint-status]');
	const syncButton = root.querySelector<HTMLButtonElement>('[data-paint-sync]');
	const undoButton = root.querySelector<HTMLButtonElement>('[data-paint-undo]');
	const exportButton = root.querySelector<HTMLButtonElement>('[data-paint-export]');
	const fullscreenButton = root.querySelector<HTMLButtonElement>('[data-paint-fullscreen]');
	const sizeInput = root.querySelector<HTMLInputElement>('[data-paint-size]');
	const sizeOutput = root.querySelector<HTMLOutputElement>('[data-paint-size-output]');
	const textInput = root.querySelector<HTMLInputElement>('[data-paint-text]');
	const textWrap = root.querySelector<HTMLElement>('[data-paint-text-wrap]');

	if (
		!baseCanvas || !localCanvas || !inputCanvas || !surface || !status || !syncButton ||
		!undoButton || !exportButton || !fullscreenButton || !sizeInput || !sizeOutput || !textInput || !textWrap
	) {
		return;
	}

	const baseContext = baseCanvas.getContext('2d');
	const localContext = localCanvas.getContext('2d');
	const previewContext = inputCanvas.getContext('2d');
	if (!baseContext || !localContext || !previewContext) {
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

	let revision = 0;
	let etag = '';
	let activeTool = 'pen';
	let activeColor = colorButtons[0] ? getComputedStyle(colorButtons[0]).backgroundColor : '#17232b';
	let brushSize = Number(sizeInput.value) || 8;
	let activeDrawing: ActiveDrawing | null = null;
	let pendingRequest: PendingRequest | null = null;
	let syncing = false;
	let paintInView = false;
	let pollTimer: number | null = null;

	const announce = (message: string): void => {
		status.textContent = message;
	};

	const updateUndo = (): void => {
		undoButton.disabled = pendingOperations.length === 0 || syncing;
	};

	const clearPreview = (): void => previewContext.clearRect(0, 0, width, height);

	const drawPath = (
		context: CanvasRenderingContext2D,
		points: Point[],
		color: string,
		size: number,
	): void => {
		if (points.length === 0) return;
		context.save();
		context.strokeStyle = color;
		context.fillStyle = color;
		context.lineWidth = size;
		context.lineCap = 'round';
		context.lineJoin = 'round';
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
		context.restore();
	};

	const drawOperation = (context: CanvasRenderingContext2D, operation: PaintOperation): void => {
		if (operation.kind === 'stroke') {
			drawPath(context, operation.points, operation.tool === 'eraser' ? paper : operation.color, operation.size);
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
		if (tool === 'pen' || tool === 'eraser') {
			drawPath(previewContext, points, tool === 'eraser' ? paper : color, size);
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

	const applySharedState = async (state: SharedState, nextEtag?: string | null): Promise<void> => {
		await loadBaseImage(state.image);
		revision = state.revision;
		etag = nextEtag ?? `W/"paint-${state.revision}"`;
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
		syncButton.disabled = value;
		syncButton.setAttribute('aria-busy', String(value));
		updateUndo();
	};

	const syncAndRefresh = async (): Promise<void> => {
		if (syncing) return;
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
					pendingRequest = { revision, requestId: crypto.randomUUID(), image };
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
					await applySharedState(result, response.headers.get('etag'));
					pendingRequest = null;
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

	inputCanvas.addEventListener('pointerdown', (event) => {
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		event.preventDefault();
		const point = getPoint(event);

		if (activeTool === 'text') {
			const text = textInput.value.trim();
			if (!text) {
				announce('Enter some text before placing it.');
				return;
			}
			const operation: PaintOperation = {
				kind: 'text',
				point,
				text,
				color: activeColor,
				size: brushSize,
			};
			pendingOperations.push(operation);
			drawOperation(localContext, operation);
			updateUndo();
			announce('Text added locally. Sync & refresh to share it.');
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
		};
		inputCanvas.setPointerCapture(event.pointerId);
		drawActivePreview();
	});

	inputCanvas.addEventListener('pointermove', (event) => {
		if (!activeDrawing || activeDrawing.pointerId !== event.pointerId) return;
		const point = getPoint(event);
		activeDrawing.current = point;
		if (activeDrawing.tool === 'pen' || activeDrawing.tool === 'eraser') {
			const previous = activeDrawing.points[activeDrawing.points.length - 1];
			if (activeDrawing.points.length < MAX_STROKE_POINTS && Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) {
				activeDrawing.points.push(point);
			}
		}
		drawActivePreview();
	});

	const finishDrawing = (event: PointerEvent): void => {
		if (!activeDrawing || activeDrawing.pointerId !== event.pointerId) return;
		const drawing = activeDrawing;
		const end = getPoint(event);
		activeDrawing = null;
		clearPreview();

		let operation: PaintOperation;
		if (drawing.tool === 'pen' || drawing.tool === 'eraser') {
			const last = drawing.points[drawing.points.length - 1];
			if (Math.hypot(end.x - last.x, end.y - last.y) > 0.5) drawing.points.push(end);
			operation = {
				kind: 'stroke',
				tool: drawing.tool,
				points: drawing.points,
				color: drawing.color,
				size: drawing.size,
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
		announce(`${pendingOperations.length} unsynced ${pendingOperations.length === 1 ? 'mark' : 'marks'}. Sync & refresh to share.`);
	};

	inputCanvas.addEventListener('pointerup', finishDrawing);
	inputCanvas.addEventListener('pointercancel', (event) => {
		if (!activeDrawing || activeDrawing.pointerId !== event.pointerId) return;
		activeDrawing = null;
		clearPreview();
	});

	for (const button of toolButtons) {
		button.addEventListener('click', () => {
			activeTool = button.dataset.paintTool ?? 'pen';
			for (const option of toolButtons) {
				option.setAttribute('aria-pressed', String(option === button));
			}
			textWrap.hidden = activeTool !== 'text';
		});
	}

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

	const updateFullscreenButton = (): void => {
		const fullscreen = document.fullscreenElement === surface;
		fullscreenButton.setAttribute('aria-pressed', String(fullscreen));
		fullscreenButton.textContent = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
	};

	fullscreenButton.addEventListener('click', () => {
		if (document.fullscreenElement === surface) {
			void document.exitFullscreen();
		} else if (surface.requestFullscreen) {
			void surface.requestFullscreen().catch(() => announce('Fullscreen is not available in this browser.'));
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
