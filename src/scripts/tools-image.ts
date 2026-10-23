/**
 * BNJI.NET — /projects/tools/ image converter & optimizer.
 *
 * The whole tool is a pipeline over four browser primitives: File (the picker),
 * createImageBitmap (decode), a canvas (resize + re-encode) and
 * canvas.toBlob (encode). Nothing in this module talks to the network — there
 * is no fetch, no form post and no Worker route behind it, which is the
 * privacy claim the page makes to the visitor.
 *
 * MEMORY CONTRACT. Three resources are owned here and each has exactly one
 * release path, because a converter that leaks holds a full decoded bitmap
 * alive for the lifetime of the tab:
 *   - the source object URL  -> revoked on replacement, reset and teardown
 *   - the source ImageBitmap -> .close()'d on replacement, reset and teardown
 *   - the output object URL  -> revoked on replacement, reset and teardown
 * `releaseSource()`/`releaseOutput()` are the only writers of those handles, so
 * "clean up on every exit" is a property of the module rather than of each
 * call site.
 *
 * HONESTY CONTRACT. Three places where a converter normally lies, and what
 * this one does instead:
 *   - a browser that cannot encode the requested format silently returns PNG
 *     from toBlob, so the blob's MIME type is compared against the request and
 *     a mismatch is an error, never a quietly different download;
 *   - a bigger output is reported as bigger. The status line never says
 *     "compressed" unless the output really is smaller;
 *   - PNG gets no quality slider, because canvas ignores quality for PNG and a
 *     slider that does nothing is worse than a disabled one that says why.
 */
import {
	IMAGE_EXTENSION,
	IMAGE_FORMAT_HINT,
	IMAGE_FORMAT_NAME,
	IMAGE_MIME,
	IMAGE_QUALITY_FORMATS,
	TOOL_IMAGE_CONFIG,
	type ToolImageFormat,
} from '../config/tools.config';
import {
	checkDecodedImage,
	checkImageFile,
	formatBytes,
	type ImagePurpose,
} from './tools-shared';

/* ------------------------------------------------------------------------- *
 * Pure helpers. Exported because the interesting decisions — what to refuse,
 * what to call the file, how to describe the size delta — are testable
 * without a browser, and this sandbox has none.
 * ------------------------------------------------------------------------- */

export type FileCheck = { ok: true } | { ok: false; message: string };

/** What this tool does with a file it accepts, phrased for the shared refusals. */
const IMAGE_PURPOSE: ImagePurpose = { verb: 'converts', nothing: 'convert' };

/**
 * Refuse a file before it is decoded, and say why in the visitor's terms.
 *
 * The policy — whitelist, byte budget, and the sentences both live in
 * ./tools-shared, because the colour picker reads images too and two tools must
 * not disagree about what a browser may be asked to decode. This stays as the
 * image tool's own name for it, so the tool's callers and its tests still import
 * the tool.
 */
export function checkInputFile(file: { name: string; type: string; size: number }): FileCheck {
	return checkImageFile(file, IMAGE_PURPOSE);
}

/* `formatBytes` moved to ./tools-shared, where the primitives the browser tools
 * hold in common now live. Re-exported so this module stays the image tool's
 * whole public surface: its callers, and its tests, import the tool's helpers
 * from the tool. */
export { formatBytes };

export type SizeChange = { saved: boolean; percent: number; label: string };

/**
 * Describe a before/after byte pair without ever claiming a saving that did
 * not happen. `label` is what the visitor reads, so "larger" cases say so
 * outright instead of showing a negative percentage and hoping.
 */
export function describeSizeChange(before: number, after: number): SizeChange {
	if (before <= 0 || after <= 0) return { saved: false, percent: 0, label: 'no size to compare' };
	if (after === before) return { saved: false, percent: 0, label: 'same size' };
	if (after < before) {
		const percent = Math.round((1 - after / before) * 100);
		return { saved: true, percent, label: `${percent}% smaller` };
	}
	const percent = Math.round((after / before - 1) * 100);
	return { saved: false, percent, label: `${percent}% larger — no saving` };
}

export type ResizeBox = { width?: number | null; height?: number | null };
export type ResizePlan = { width: number; height: number };

/**
 * Turn the two optional dimension fields into a target box, always preserving
 * the source aspect ratio.
 *
 * One field given -> the other follows from the ratio. Both given -> the box
 * is treated as a "fit inside" bound (contain), because scaling each axis
 * independently is how a converter produces a stretched photo. Returns null
 * when neither field is set, which is the "keep the original size" case.
 */
export function resizePlan(
	source: { width: number; height: number },
	requested: ResizeBox,
): ResizePlan | null {
	const requestedWidth = usableDimension(requested.width);
	const requestedHeight = usableDimension(requested.height);

	const clamp = (value: number) =>
		Math.min(TOOL_IMAGE_CONFIG.maxDimension, Math.max(1, Math.round(value)));
	const ratio = source.width / source.height;

	if (requestedWidth !== null) {
		if (requestedHeight !== null) {
			// Both given: the box is a bound to fit inside, not two independent
			// scales — the latter is how a converter stretches a photo.
			const scale = Math.min(requestedWidth / source.width, requestedHeight / source.height);
			return { width: clamp(source.width * scale), height: clamp(source.height * scale) };
		}
		return { width: clamp(requestedWidth), height: clamp(requestedWidth / ratio) };
	}
	if (requestedHeight !== null) return { width: clamp(requestedHeight * ratio), height: clamp(requestedHeight) };
	return null;
}

/**
 * A field counts as "set" only when it holds a whole number of at least one
 * pixel. A half-typed value ("12" while the visitor means "1280") or a cleared
 * field arrives as NaN or 0, and treating either as a real request would
 * resize the image to nothing.
 */
function usableDimension(value: number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	if (!Number.isFinite(value)) return null;
	const rounded = Math.round(value);
	return rounded >= 1 ? rounded : null;
}

/** The MIME type inside a data: URL, or '' when it is not one. */
export function mimeFromDataUrl(dataUrl: string): string {
	const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
	return match ? match[1] : '';
}

/** Raster suffixes the picker can hand us, matched case-insensitively. */
const RASTER_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i;

/**
 * The download name for a converted file. A raster extension is *replaced*
 * rather than stacked, so "photo.jpeg" becomes "photo.webp" and not
 * "photo.jpeg.jpg"; any other suffix is left alone and the format's extension
 * is appended, because the tool has no business editing a name it does not
 * understand.
 */
export function outputFileName(sourceName: string, format: ToolImageFormat): string {
	return `${sourceName.replace(RASTER_EXTENSION, '')}.${IMAGE_EXTENSION[format]}`;
}

/** canvas.toBlob as a promise; rejects when the browser has no encoder at all. */
function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		if (typeof canvas.toBlob !== 'function') {
			reject(new Error('this browser cannot encode a canvas'));
			return;
		}
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('the encoder produced nothing'))),
			mime,
			quality,
		);
	});
}

/**
 * Whether this browser can actually encode a format. Chrome and Safari both
 * answer "no" to WebP on old builds, and toBlob then hands back a PNG without
 * complaining — so the only reliable test is to encode one pixel and look at
 * what came back.
 */
const encodeSupportCache = new Map<ToolImageFormat, boolean>();

function canEncodeFormat(format: ToolImageFormat): boolean {
	if (typeof document === 'undefined') return false;
	const cached = encodeSupportCache.get(format);
	if (cached !== undefined) return cached;
	try {
		const canvas = document.createElement('canvas');
		if (typeof canvas.toDataURL !== 'function') return false;
		const supported = mimeFromDataUrl(canvas.toDataURL(IMAGE_MIME[format])) === IMAGE_MIME[format];
		encodeSupportCache.set(format, supported);
		return supported;
	} catch {
		encodeSupportCache.set(format, false);
		return false;
	}
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

type Source = {
	name: string;
	bytes: number;
	width: number;
	height: number;
	bitmap: ImageBitmap;
};

type Output = {
	name: string;
	format: ToolImageFormat;
	bytes: number;
	width: number;
	height: number;
	url: string;
};

let started = false;
/** Set by init, cleared by destroy — the one place resources are released. */
let teardown: (() => void) | null = null;

export function initImageConverter(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-image-converter]');
	if (!root) return;
	started = true;

	// One signal for every listener, the way music.ts does it: a teardown is
	// then a single abort() instead of a list of removeEventListener calls that
	// can drift out of sync with the bindings.
	const controller = new AbortController();
	const { signal } = controller;

	const fileInput = root.querySelector<HTMLInputElement>('[data-image-source]');
	const dropZone = root.querySelector<HTMLElement>('[data-image-drop]');
	/*
	 * The format select is typed through a structural alias on purpose: this DOM
	 * lib declares HTMLSelectElement#remove() as returning void, which makes
	 * HTMLSelectElement structurally incompatible with Element, so
	 * querySelector<HTMLSelectElement> does not typecheck. Same workaround as
	 * admin-dashboard.ts's valueOf(), kept local because this select is both
	 * read and written here.
	 */
	const formatSelect = root.querySelector('[data-image-format]') as
		| (HTMLElement & { value: string })
		| null;
	const formatHint = root.querySelector<HTMLElement>('[data-image-format-hint]');
	const qualityInput = root.querySelector<HTMLInputElement>('[data-image-quality]');
	const qualityValue = root.querySelector<HTMLElement>('[data-image-quality-value]');
	const qualityHint = root.querySelector<HTMLElement>('[data-image-quality-hint]');
	const widthInput = root.querySelector<HTMLInputElement>('[data-image-width]');
	const heightInput = root.querySelector<HTMLInputElement>('[data-image-height]');
	const lockInput = root.querySelector<HTMLInputElement>('[data-image-lock]');
	const convertButton = root.querySelector<HTMLButtonElement>('[data-image-convert]');
	const downloadButton = root.querySelector<HTMLButtonElement>('[data-image-download]');
	const resetButton = root.querySelector<HTMLButtonElement>('[data-image-reset]');
	const statusLine = root.querySelector<HTMLElement>('[data-image-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-image-error]');
	const results = root.querySelector<HTMLElement>('[data-image-results]');
	const sourcePreview = root.querySelector<HTMLImageElement>('[data-image-source-preview]');
	const sourceMeta = root.querySelector<HTMLElement>('[data-image-source-meta]');
	const outputPreview = root.querySelector<HTMLImageElement>('[data-image-output-preview]');
	const outputMeta = root.querySelector<HTMLElement>('[data-image-output-meta]');

	/* --- state ----------------------------------------------------------- */

	let source: Source | null = null;
	let sourceUrl: string | null = null;
	let output: Output | null = null;
	let busy = false;
	/**
	 * Bumped by every load/reset. An in-flight convert compares its token
	 * before touching the DOM, so a conversion that finishes after the visitor
	 * has swapped files cannot overwrite the new one's readouts.
	 */
	let generation = 0;
	let autoTimer: number | undefined;

	/* --- small view helpers --------------------------------------------- */

	const setStatus = (message: string) => {
		if (statusLine) statusLine.textContent = message;
	};

	const showError = (message: string) => {
		if (errorLine) {
			errorLine.textContent = message;
			errorLine.hidden = false;
		}
		setStatus('Nothing converted.');
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const setBusy = (value: boolean) => {
		busy = value;
		if (convertButton) convertButton.disabled = value;
		if (resetButton) resetButton.disabled = value;
		if (downloadButton) downloadButton.disabled = value || output === null;
		if (statusLine) statusLine.dataset.busy = value ? 'true' : 'false';
	};

	const currentFormat = (): ToolImageFormat => {
		const value = formatSelect?.value ?? 'png';
		return value === 'jpeg' || value === 'webp' ? value : 'png';
	};

	const qualityPercent = (): number => {
		const raw = Number(qualityInput?.value ?? TOOL_IMAGE_CONFIG.quality.default);
		const { min, max } = TOOL_IMAGE_CONFIG.quality;
		return Math.min(max, Math.max(min, Number.isFinite(raw) ? raw : min));
	};

	const requestedBox = (): ResizeBox => ({
		width: Number(widthInput?.value) || null,
		height: Number(heightInput?.value) || null,
	});

	/* --- release paths (see the memory contract at the top) --------------- */

	const releaseOutput = () => {
		if (!output) return;
		URL.revokeObjectURL(output.url);
		output = null;
		if (downloadButton) downloadButton.disabled = true;
	};

	const releaseSource = () => {
		if (sourceUrl) {
			URL.revokeObjectURL(sourceUrl);
			sourceUrl = null;
		}
		if (source) {
			// close() frees the decoded bitmap immediately instead of waiting
			// for the GC, which is the difference between a 40 MP photo and a
			// 160 MB allocation lingering in the tab.
			source.bitmap.close();
			source = null;
		}
	};

	const clearResults = () => {
		if (results) results.hidden = true;
		if (sourcePreview) {
			sourcePreview.removeAttribute('src');
			if (sourceMeta) sourceMeta.textContent = '';
		}
		if (outputPreview) {
			outputPreview.removeAttribute('src');
			if (outputMeta) outputMeta.textContent = '';
		}
	};

	const reset = () => {
		generation += 1;
		if (autoTimer !== undefined) {
			window.clearTimeout(autoTimer);
			autoTimer = undefined;
		}
		releaseSource();
		releaseOutput();
		clearResults();
		if (fileInput) fileInput.value = '';
		if (formatSelect) formatSelect.value = 'png';
		if (qualityInput) qualityInput.value = String(TOOL_IMAGE_CONFIG.quality.default);
		if (widthInput) widthInput.value = '';
		if (heightInput) heightInput.value = '';
		if (lockInput) lockInput.checked = true;
		clearError();
		syncFormatControls();
		setBusy(false);
		setStatus('Choose an image to convert. Nothing leaves this tab.');
	};

	/* --- control wiring -------------------------------------------------- */

	/** Quality only means something for the encoders that honour it. */
	const syncFormatControls = () => {
		const format = currentFormat();
		const supportsQuality = IMAGE_QUALITY_FORMATS.includes(format);
		if (formatHint) formatHint.textContent = IMAGE_FORMAT_HINT[format];
		if (qualityInput) qualityInput.disabled = !supportsQuality;
		if (qualityValue) qualityValue.textContent = `${qualityPercent()}%`;
		if (qualityHint) {
			qualityHint.textContent = supportsQuality
				? `Applies to ${IMAGE_FORMAT_NAME[format]}. Lower is smaller and lossier.`
				: `Quality does not apply to ${IMAGE_FORMAT_NAME[format]} — the browser ignores it, so the slider is off.`;
		}
	};

	/**
	 * Mirror one dimension field into the other while aspect ratio is locked.
	 * Setting .value programmatically fires no input event, so this cannot
	 * ping-pong between the two fields.
	 */
	const mirrorDimension = (changed: HTMLInputElement | null) => {
		if (!lockInput?.checked || !source) return;
		if (changed === widthInput) {
			const width = Number(widthInput?.value);
			if (!Number.isFinite(width) || width <= 0) {
				if (heightInput) heightInput.value = '';
				return;
			}
			const height = Math.round((width * source.height) / source.width);
			if (heightInput) heightInput.value = String(height);
		} else if (changed === heightInput) {
			const height = Number(heightInput?.value);
			if (!Number.isFinite(height) || height <= 0) {
				if (widthInput) widthInput.value = '';
				return;
			}
			const width = Math.round((height * source.width) / source.height);
			if (widthInput) widthInput.value = String(width);
		}
	};

	/** Re-encode after a control change, coalesced so a slider drag is one run. */
	const scheduleAutoConvert = () => {
		if (!source) return;
		if (autoTimer !== undefined) window.clearTimeout(autoTimer);
		autoTimer = window.setTimeout(() => {
			autoTimer = undefined;
			void convert();
		}, 250);
	};

	/* --- the pipeline ---------------------------------------------------- */

	const convert = async () => {
		if (!source || busy) return;
		const active = source;
		const format = currentFormat();
		const token = generation;

		if (!canEncodeFormat(format)) {
			showError(
				`This browser cannot encode ${IMAGE_FORMAT_NAME[format]}, so nothing was attempted — sending a different format instead would be a silent surprise. Pick another output format.`,
			);
			return;
		}

		const plan = resizePlan(active, requestedBox());
		if (plan && plan.width * plan.height > TOOL_IMAGE_CONFIG.maxOutputPixels) {
			showError(
				`That resize asks for ${plan.width}×${plan.height}, over this tool's ${TOOL_IMAGE_CONFIG.maxOutputPixels.toLocaleString()}-pixel output budget. Use smaller dimensions.`,
			);
			return;
		}

		clearError();
		setBusy(true);
		setStatus(`Converting to ${format.toUpperCase()}…`);

		let canvas: HTMLCanvasElement | null = null;
		try {
			canvas = document.createElement('canvas');
			canvas.width = plan?.width ?? active.width;
			canvas.height = plan?.height ?? active.height;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('this browser refused a 2D canvas');
			context.imageSmoothingEnabled = true;
			context.imageSmoothingQuality = 'high';
			// JPEG has no alpha channel, so a transparent bitmap is flattened
			// against the canvas's transparent default and reads as black. That
			// is what a real JPEG conversion looks like, and the format hint
			// says so — no matte is painted here to pretend otherwise.
			context.drawImage(active.bitmap, 0, 0, canvas.width, canvas.height);

			const quality = IMAGE_QUALITY_FORMATS.includes(format)
				? qualityPercent() / 100
				: undefined;
			const blob = await encodeCanvas(canvas, IMAGE_MIME[format], quality);

			// A browser that cannot encode the format answers with a PNG blob.
			// Returning that as if it were the request is the classic silent
			// conversion bug, so it is reported instead.
			if (blob.type !== IMAGE_MIME[format]) {
				if (token === generation) {
					showError(
						`This browser cannot encode ${format.toUpperCase()}: it produced ${blob.type || 'an unknown type'} instead, so nothing was downloaded. Pick another output format.`,
					);
				}
				return;
			}
			if (token !== generation) return;

			releaseOutput();
			output = {
				name: outputFileName(active.name, format),
				format,
				bytes: blob.size,
				width: canvas.width,
				height: canvas.height,
				url: URL.createObjectURL(blob),
			};

			const change = describeSizeChange(active.bytes, blob.size);
			if (outputPreview) outputPreview.src = output.url;
			if (outputMeta) {
				outputMeta.textContent = `${canvas.width}×${canvas.height} · ${format.toUpperCase()} · ${formatBytes(blob.size)} · ${change.label}`;
			}
			if (results) results.hidden = false;
			if (downloadButton) downloadButton.disabled = false;

			setStatus(
				`Converted ${active.name} to ${format.toUpperCase()}: ${formatBytes(active.bytes)} → ${formatBytes(blob.size)} (${change.label}).`,
			);
		} catch (error) {
			if (token !== generation) return;
			const reason = error instanceof Error ? error.message : String(error);
			showError(`Conversion failed (${reason}). Try a smaller resize or another format.`);
		} finally {
			// Releasing the canvas's backing store is the only way to hand the
			// (possibly 40 MP) pixel buffer back before the next conversion.
			if (canvas) {
				canvas.width = 0;
				canvas.height = 0;
			}
			if (token === generation) setBusy(false);
		}
	};

	const load = async (file: File) => {
		clearError();
		const check = checkInputFile(file);
		if (!check.ok) {
			showError(check.message);
			return;
		}
		if (typeof createImageBitmap !== 'function') {
			showError(
				'This browser cannot decode images for conversion (createImageBitmap is unavailable), so the tool cannot run here.',
			);
			return;
		}

		/*
		 * Claim the slot BEFORE the first await. Decoding is asynchronous, so a
		 * second drop — or a Reset — can land while this one is still decoding;
		 * whichever arrives last owns the tool, and the loser must not write its
		 * readouts (or its bitmap) over the winner's.
		 */
		const token = (generation += 1);
		setBusy(true);
		setStatus(`Reading ${file.name}…`);

		let bitmap: ImageBitmap;
		try {
			bitmap = await createImageBitmap(file);
		} catch {
			if (token !== generation) return;
			setBusy(false);
			showError(
				`Could not decode “${file.name}”. The file may be corrupt, or it may use a variant of the format this browser cannot read.`,
			);
			return;
		}

		if (token !== generation) {
			// Superseded mid-decode. This bitmap belongs to nobody now, and
			// close() is the only thing that returns its pixels to the browser
			// before the GC gets around to it.
			bitmap.close();
			return;
		}

		const budget = checkDecodedImage({
			name: file.name,
			width: bitmap.width,
			height: bitmap.height,
		});
		if (!budget.ok) {
			bitmap.close();
			setBusy(false);
			showError(budget.message);
			return;
		}

		// Past every check: only now is the previous file replaced, so a
		// rejected drop leaves the current conversion on screen.
		releaseSource();
		releaseOutput();
		source = {
			name: file.name,
			bytes: file.size,
			width: bitmap.width,
			height: bitmap.height,
			bitmap,
		};
		sourceUrl = URL.createObjectURL(file);

		if (sourcePreview) sourcePreview.src = sourceUrl;
		if (sourceMeta) {
			sourceMeta.textContent = `${bitmap.width}×${bitmap.height} · ${file.type} · ${formatBytes(file.size)}`;
		}
		if (results) results.hidden = false;
		setBusy(false);
		setStatus(
			`Loaded ${file.name} — ${bitmap.width}×${bitmap.height}, ${formatBytes(file.size)}. Convert to see the result.`,
		);
		void convert();
	};

	const download = () => {
		if (!output) return;
		const anchor = document.createElement('a');
		anchor.href = output.url;
		anchor.download = output.name;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
		setStatus(`Saved ${output.name} (${formatBytes(output.bytes)}).`);
	};

	/* --- events ---------------------------------------------------------- */

	fileInput?.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (file) void load(file);
	}, { signal });

	formatSelect?.addEventListener('change', () => {
		syncFormatControls();
		scheduleAutoConvert();
	}, { signal });

	qualityInput?.addEventListener('input', () => {
		if (qualityValue) qualityValue.textContent = `${qualityPercent()}%`;
		scheduleAutoConvert();
	}, { signal });

	for (const input of [widthInput, heightInput]) {
		input?.addEventListener('input', () => {
			mirrorDimension(input);
			scheduleAutoConvert();
		}, { signal });
	}

	lockInput?.addEventListener('change', () => {
		// Turning the lock on should immediately agree the two fields with the
		// loaded image rather than waiting for the next keystroke.
		if (lockInput.checked && source) mirrorDimension(widthInput);
		scheduleAutoConvert();
	}, { signal });

	// Drag and drop is the only other way in. dragover must be cancelled or
	// the browser navigates to the dropped file instead of handing it over.
	dropZone?.addEventListener('dragover', (event) => {
		event.preventDefault();
		if (dropZone) dropZone.dataset.dragOver = 'true';
	}, { signal });
	dropZone?.addEventListener('dragleave', () => {
		if (dropZone) dropZone.dataset.dragOver = 'false';
	}, { signal });
	dropZone?.addEventListener('drop', (event) => {
		event.preventDefault();
		if (dropZone) dropZone.dataset.dragOver = 'false';
		const file = event.dataTransfer?.files?.[0];
		if (file) void load(file);
	}, { signal });

	convertButton?.addEventListener('click', () => void convert(), { signal });
	downloadButton?.addEventListener('click', download, { signal });
	resetButton?.addEventListener('click', reset, { signal });

	// Unloading the page is the last release path: without it a visitor who
	// converts a 40 MP photo and then navigates away leaves the bitmap and both
	// object URLs to the GC's discretion.
	window.addEventListener('pagehide', reset, { signal });

	teardown = () => {
		controller.abort();
		if (autoTimer !== undefined) window.clearTimeout(autoTimer);
		autoTimer = undefined;
		reset();
	};

	syncFormatControls();
	setBusy(false);
	setStatus('Choose an image to convert. Nothing leaves this tab.');
}

/**
 * Release every handle this tool owns and re-arm the init, so a second call
 * binds a fresh subtree. Used by the tests and by anything that ever swaps the
 * page's content without a reload.
 */
export function destroyImageConverter(): void {
	encodeSupportCache.clear();
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
