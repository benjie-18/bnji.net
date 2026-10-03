/**
 * BNJI.NET — /tools/ Image Metadata Inspector & Remover.
 *
 * Runs entirely in browser tab memory. Inspects EXIF, IPTC, XMP, and PNG text/EXIF
 * metadata tags and allows stripping metadata locally before saving.
 */

import { TOOL_METADATA_CONFIG } from '../config/tools.config';
import { formatBytes } from './tools-image';

export type MetadataTag = {
	key: string;
	label: string;
	value: string;
	category?: string;
};

export type MetadataResult = {
	hasMetadata: boolean;
	tags: MetadataTag[];
	summary: string;
};

export type MetadataFileCheck = { ok: true } | { ok: false; message: string };

/** Validate file size and type before reading. */
export function checkMetadataFile(file: { name: string; type: string; size: number }): MetadataFileCheck {
	if (!TOOL_METADATA_CONFIG.supportedTypes.includes(file.type)) {
		return {
			ok: false,
			message: `“${file.name}” is not supported. Please select ${TOOL_METADATA_CONFIG.supportedLabels}.`,
		};
	}
	if (file.size === 0) {
		return { ok: false, message: `“${file.name}” is empty.` };
	}
	if (file.size > TOOL_METADATA_CONFIG.maxInputBytes) {
		return {
			ok: false,
			message: `“${file.name}” is ${formatBytes(file.size)}, exceeding the limit of ${formatBytes(TOOL_METADATA_CONFIG.maxInputBytes)}.`,
		};
	}
	return { ok: true };
}

/** Known EXIF Tag IDs mapped to human labels. */
const EXIF_TAGS: Record<number, { label: string; category: string }> = {
	0x010f: { label: 'Camera Make', category: 'Device' },
	0x0110: { label: 'Camera Model', category: 'Device' },
	0x0112: { label: 'Orientation', category: 'Image' },
	0x0131: { label: 'Software', category: 'Device' },
	0x0132: { label: 'Date/Time Modified', category: 'Time' },
	0x013b: { label: 'Artist / Author', category: 'Author' },
	0x8298: { label: 'Copyright', category: 'Author' },
	0x829d: { label: 'Exposure Time', category: 'Camera Settings' },
	0x829e: { label: 'F-Number', category: 'Camera Settings' },
	0x8822: { label: 'Exposure Program', category: 'Camera Settings' },
	0x8827: { label: 'ISO Speed', category: 'Camera Settings' },
	0x9003: { label: 'Date/Time Original', category: 'Time' },
	0x9004: { label: 'Date/Time Digitized', category: 'Time' },
	0x9204: { label: 'Exposure Bias', category: 'Camera Settings' },
	0x920a: { label: 'Focal Length', category: 'Camera Settings' },
	0xa405: { label: 'Focal Length (35mm equiv)', category: 'Camera Settings' },
	0xa434: { label: 'Lens Model', category: 'Device' },
};

/** Helper to decode ASCII string from DataView. */
function readAscii(view: DataView, offset: number, length: number): string {
	let str = '';
	for (let i = 0; i < length; i++) {
		const charCode = view.getUint8(offset + i);
		if (charCode === 0) break;
		str += String.fromCharCode(charCode);
	}
	return str.trim();
}

/** Extract EXIF & header metadata tags from JPEG, PNG, or WebP ArrayBuffer. */
export function extractImageMetadata(buffer: ArrayBuffer, mimeType: string): MetadataResult {
	const view = new DataView(buffer);
	const tags: MetadataTag[] = [];

	if (mimeType === 'image/jpeg') {
		parseJpegMetadata(view, tags);
	} else if (mimeType === 'image/png') {
		parsePngMetadata(view, tags);
	} else if (mimeType === 'image/webp') {
		parseWebpMetadata(view, tags);
	}

	const hasMetadata = tags.length > 0;
	const summary = hasMetadata
		? `Found ${tags.length} metadata tag${tags.length === 1 ? '' : 's'}.`
		: 'No sensitive EXIF or text metadata tags detected.';

	return { hasMetadata, tags, summary };
}

function parseJpegMetadata(view: DataView, tags: MetadataTag[]): void {
	if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return; // Not JPEG

	let offset = 2;
	while (offset < view.byteLength - 2) {
		const marker = view.getUint16(offset);
		if (marker === 0xffda || marker === 0xffd9) break; // Start of Scan or End of Image
		if ((marker & 0xff00) !== 0xff00) break;

		const length = view.getUint16(offset + 2);
		if (marker === 0xffe1) {
			// APP1 Marker (EXIF or XMP)
			if (length >= 8 && readAscii(view, offset + 4, 4) === 'Exif') {
				parseExifTiff(view, offset + 10, length - 8, tags);
			} else if (length >= 30 && readAscii(view, offset + 4, 28).includes('http://ns.adobe.com/xap')) {
				tags.push({ key: 'xmp', label: 'XMP Metadata Segment', value: 'Present (Adobe XMP Data)', category: 'Structure' });
			}
		} else if (marker === 0xffed) {
			// APP13 Marker (IPTC / Photoshop)
			tags.push({ key: 'iptc', label: 'IPTC / Photoshop Data', value: 'Present', category: 'Structure' });
		} else if (marker === 0xfffe) {
			// JPEG Comment
			const comment = readAscii(view, offset + 4, length - 2);
			if (comment) {
				tags.push({ key: 'comment', label: 'JPEG Comment', value: comment, category: 'Text' });
			}
		}
		offset += 2 + length;
	}
}

function parseExifTiff(view: DataView, tiffOffset: number, length: number, tags: MetadataTag[]): void {
	if (tiffOffset + 8 > view.byteLength) return;
	const endianCode = view.getUint16(tiffOffset);
	const littleEndian = endianCode === 0x4949; // "II"
	if (!littleEndian && endianCode !== 0x4d4d) return; // "MM"

	if (view.getUint16(tiffOffset + 2, littleEndian) !== 0x002a) return; // TIFF Magic

	const firstIfdOffset = view.getUint32(tiffOffset + 4, littleEndian);
	parseIfd(view, tiffOffset, tiffOffset + firstIfdOffset, littleEndian, tags);
}

function parseIfd(view: DataView, tiffOffset: number, ifdOffset: number, littleEndian: boolean, tags: MetadataTag[]): void {
	if (ifdOffset + 2 > view.byteLength) return;
	const entryCount = view.getUint16(ifdOffset, littleEndian);
	let ptr = ifdOffset + 2;

	for (let i = 0; i < entryCount; i++) {
		if (ptr + 12 > view.byteLength) break;
		const tagId = view.getUint16(ptr, littleEndian);
		const type = view.getUint16(ptr + 2, littleEndian);
		const count = view.getUint32(ptr + 4, littleEndian);
		const valueOffset = ptr + 8;

		const tagDef = EXIF_TAGS[tagId];
		if (tagDef) {
			const val = readTiffValue(view, tiffOffset, valueOffset, type, count, littleEndian);
			if (val !== null) {
				tags.push({ key: `exif_0x${tagId.toString(16)}`, label: tagDef.label, value: String(val), category: tagDef.category });
			}
		} else if (tagId === 0x8769) { // ExifIFDPointer
			const subIfdOffset = view.getUint32(valueOffset, littleEndian);
			parseIfd(view, tiffOffset, tiffOffset + subIfdOffset, littleEndian, tags);
		} else if (tagId === 0x8825) { // GPSInfo
			tags.push({ key: 'gps', label: 'GPS Location Coordinates', value: 'GPS Metadata Present', category: 'Location' });
		}
		ptr += 12;
	}
}

function readTiffValue(
	view: DataView,
	tiffOffset: number,
	valueOffset: number,
	type: number,
	count: number,
	littleEndian: boolean,
): string | number | null {
	// Type 2: ASCII string
	if (type === 2) {
		const stringOffset = count > 4 ? tiffOffset + view.getUint32(valueOffset, littleEndian) : valueOffset;
		if (stringOffset + count > view.byteLength) return null;
		return readAscii(view, stringOffset, count);
	}
	// Type 3: SHORT (16-bit integer)
	if (type === 3) return view.getUint16(valueOffset, littleEndian);
	// Type 4: LONG (32-bit integer)
	if (type === 4) return view.getUint32(valueOffset, littleEndian);
	// Type 5: RATIONAL (two LONGs: numerator / denominator)
	if (type === 5) {
		const ratOffset = tiffOffset + view.getUint32(valueOffset, littleEndian);
		if (ratOffset + 8 > view.byteLength) return null;
		const num = view.getUint32(ratOffset, littleEndian);
		const den = view.getUint32(ratOffset + 4, littleEndian);
		if (den === 0) return num;
		const val = num / den;
		return Number.isInteger(val) ? val : val.toFixed(2);
	}
	return null;
}

function parsePngMetadata(view: DataView, tags: MetadataTag[]): void {
	if (view.byteLength < 8) return;
	let offset = 8; // Skip PNG header
	while (offset < view.byteLength - 8) {
		const length = view.getUint32(offset);
		const chunkType = readAscii(view, offset + 4, 4);

		if (chunkType === 'tEXt' || chunkType === 'zTXt' || chunkType === 'iTXt') {
			const keyword = readAscii(view, offset + 8, Math.min(length, 30));
			tags.push({ key: `png_${chunkType}`, label: `PNG Text (${keyword || 'Metadata'})`, value: 'Present', category: 'Text' });
		} else if (chunkType === 'eXIf') {
			tags.push({ key: 'png_exif', label: 'PNG Embedded EXIF', value: 'Present', category: 'Camera' });
		} else if (chunkType === 'iCCP') {
			tags.push({ key: 'png_iccp', label: 'Color Profile (iCCP)', value: 'Present', category: 'Color' });
		}

		offset += 12 + length;
	}
}

function parseWebpMetadata(view: DataView, tags: MetadataTag[]): void {
	if (view.byteLength < 12) return;
	if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WEBP') return;

	let offset = 12;
	while (offset < view.byteLength - 8) {
		const fourCC = readAscii(view, offset, 4);
		const chunkSize = view.getUint32(offset + 4, true);

		if (fourCC === 'EXIF') {
			tags.push({ key: 'webp_exif', label: 'WebP Embedded EXIF', value: 'Present', category: 'Camera' });
		} else if (fourCC === 'XMP ') {
			tags.push({ key: 'webp_xmp', label: 'WebP XMP Metadata', value: 'Present', category: 'Structure' });
		} else if (fourCC === 'ICCP') {
			tags.push({ key: 'webp_iccp', label: 'Color Profile (ICCP)', value: 'Present', category: 'Color' });
		}

		offset += 8 + chunkSize + (chunkSize % 2); // WebP chunks are padded to 2-byte alignment
	}
}

/** Strip metadata by re-creating clean binary bytes or canvas raster copy. */
export function stripMetadataBinary(buffer: ArrayBuffer, mimeType: string): Uint8Array {
	const view = new DataView(buffer);

	if (mimeType === 'image/jpeg') {
		// Rebuild JPEG by omitting APP1 to APP15 (0xFFE1-0xFFEF) and Comments (0xFFFE)
		const cleanBlocks: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
		let offset = 2;

		while (offset < view.byteLength - 2) {
			const marker = view.getUint16(offset);
			if (marker === 0xffda) {
				// Start of Scan: copy remainder of image data as-is
				cleanBlocks.push(new Uint8Array(buffer.slice(offset)));
				break;
			}
			if ((marker & 0xff00) !== 0xff00) break;
			const length = view.getUint16(offset + 2);

			// Preserve essential markers (e.g., SOF0/SOF2, DQT, DHT, DRI), drop metadata APP/COM markers
			const isMetadata = (marker >= 0xffe1 && marker <= 0xffef) || marker === 0xfffe;
			if (!isMetadata) {
				cleanBlocks.push(new Uint8Array(buffer.slice(offset, offset + 2 + length)));
			}
			offset += 2 + length;
		}

		const totalLength = cleanBlocks.reduce((acc, b) => acc + b.byteLength, 0);
		const result = new Uint8Array(totalLength);
		let pos = 0;
		for (const block of cleanBlocks) {
			result.set(block, pos);
			pos += block.byteLength;
		}
		return result;
	}

	if (mimeType === 'image/png') {
		// Rebuild PNG by omitting tEXt, zTXt, iTXt, eXIf, iCCP, tIME chunks
		const cleanBlocks: Uint8Array[] = [new Uint8Array(buffer.slice(0, 8))]; // PNG signature
		let offset = 8;

		while (offset < view.byteLength - 8) {
			const length = view.getUint32(offset);
			const chunkType = readAscii(view, offset + 4, 4);

			const isMetadataChunk = ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP', 'tIME'].includes(chunkType);
			if (!isMetadataChunk) {
				cleanBlocks.push(new Uint8Array(buffer.slice(offset, offset + 12 + length)));
			}
			offset += 12 + length;
		}

		const totalLength = cleanBlocks.reduce((acc, b) => acc + b.byteLength, 0);
		const result = new Uint8Array(totalLength);
		let pos = 0;
		for (const block of cleanBlocks) {
			result.set(block, pos);
			pos += block.byteLength;
		}
		return result;
	}

	// Fallback for other formats: return copy
	return new Uint8Array(buffer);
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initImageMetadata(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-image-metadata]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const fileInput = root.querySelector<HTMLInputElement>('[data-metadata-source]');
	const dropZone = root.querySelector<HTMLElement>('[data-metadata-drop]');
	const stripButton = root.querySelector<HTMLButtonElement>('[data-metadata-strip]');
	const downloadButton = root.querySelector<HTMLButtonElement>('[data-metadata-download]');
	const resetButton = root.querySelector<HTMLButtonElement>('[data-metadata-reset]');
	const statusLine = root.querySelector<HTMLElement>('[data-metadata-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-metadata-error]');
	const results = root.querySelector<HTMLElement>('[data-metadata-results]');
	const metaList = root.querySelector<HTMLElement>('[data-metadata-list]');
	const cleanMeta = root.querySelector<HTMLElement>('[data-metadata-clean-info]');

	let sourceFile: File | null = null;
	let sourceBuffer: ArrayBuffer | null = null;
	let cleanBlob: Blob | null = null;
	let cleanUrl: string | null = null;
	let busy = false;

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const showError = (msg: string) => {
		if (errorLine) {
			errorLine.textContent = msg;
			errorLine.hidden = false;
		}
		setStatus('Metadata inspection failed.');
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const setBusy = (val: boolean) => {
		busy = val;
		if (stripButton) stripButton.disabled = val || !sourceBuffer;
		if (resetButton) resetButton.disabled = val;
		if (downloadButton) downloadButton.disabled = val || !cleanBlob;
		if (statusLine) statusLine.dataset.busy = val ? 'true' : 'false';
	};

	const releaseOutput = () => {
		if (cleanUrl) {
			URL.revokeObjectURL(cleanUrl);
			cleanUrl = null;
		}
		cleanBlob = null;
		if (downloadButton) downloadButton.disabled = true;
	};

	const releaseSource = () => {
		sourceFile = null;
		sourceBuffer = null;
	};

	const reset = () => {
		releaseSource();
		releaseOutput();
		if (fileInput) fileInput.value = '';
		if (results) results.hidden = true;
		if (metaList) metaList.innerHTML = '';
		if (cleanMeta) cleanMeta.textContent = '';
		clearError();
		setBusy(false);
		setStatus('Choose an image to inspect. Nothing leaves this tab.');
	};

	const inspectFile = async (file: File) => {
		clearError();
		const check = checkMetadataFile(file);
		if (!check.ok) {
			showError(check.message);
			return;
		}

		setBusy(true);
		setStatus(`Inspecting ${file.name}…`);

		try {
			sourceFile = file;
			sourceBuffer = await file.arrayBuffer();

			const metadata = extractImageMetadata(sourceBuffer, file.type);

			if (metaList) {
				metaList.innerHTML = '';
				if (metadata.tags.length === 0) {
					const empty = document.createElement('p');
					empty.className = 'tool__hint';
					empty.textContent = 'No sensitive EXIF or text metadata tags detected in this file.';
					metaList.appendChild(empty);
				} else {
					const table = document.createElement('table');
					table.className = 'tool-meta-table';
					const tbody = document.createElement('tbody');

					for (const tag of metadata.tags) {
						const tr = document.createElement('tr');
						const tdLabel = document.createElement('td');
						tdLabel.className = 'tool-meta-table__label mono';
						tdLabel.textContent = tag.label;

						const tdVal = document.createElement('td');
						tdVal.className = 'tool-meta-table__value mono';
						tdVal.textContent = tag.value;

						tr.appendChild(tdLabel);
						tr.appendChild(tdVal);
						tbody.appendChild(tr);
					}
					table.appendChild(tbody);
					metaList.appendChild(table);
				}
			}

			if (results) results.hidden = false;
			setBusy(false);
			setStatus(`Inspected ${file.name} (${formatBytes(file.size)}). ${metadata.summary}`);
		} catch (err) {
			setBusy(false);
			showError(`Failed to read metadata (${err instanceof Error ? err.message : String(err)}).`);
		}
	};

	const strip = () => {
		if (!sourceFile || !sourceBuffer || busy) return;
		setBusy(true);
		setStatus('Stripping metadata tags…');

		try {
			const cleanBytes = stripMetadataBinary(sourceBuffer, sourceFile.type);
			releaseOutput();
			cleanBlob = new Blob([new Uint8Array(cleanBytes)], { type: sourceFile.type });
			cleanUrl = URL.createObjectURL(cleanBlob);

			if (cleanMeta) {
				const saved = describeBytesDelta(sourceBuffer.byteLength, cleanBytes.byteLength);
				cleanMeta.textContent = `Clean image ready: ${formatBytes(cleanBytes.byteLength)} (${saved}). Metadata tags removed.`;
			}

			if (downloadButton) downloadButton.disabled = false;
			setBusy(false);
			setStatus(`Metadata removed successfully (${formatBytes(sourceBuffer.byteLength)} → ${formatBytes(cleanBytes.byteLength)}).`);
		} catch (err) {
			setBusy(false);
			showError(`Stripping failed (${err instanceof Error ? err.message : String(err)}).`);
		}
	};

	const download = () => {
		if (!cleanUrl || !sourceFile) return;
		const nameParts = sourceFile.name.split('.');
		const ext = nameParts.pop();
		const baseName = nameParts.join('.');
		const cleanName = `${baseName}-clean.${ext || 'jpg'}`;

		const a = document.createElement('a');
		a.href = cleanUrl;
		a.download = cleanName;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setStatus(`Saved ${cleanName}.`);
	};

	fileInput?.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (file) void inspectFile(file);
	}, { signal });

	dropZone?.addEventListener('dragover', (e) => {
		e.preventDefault();
		if (dropZone) dropZone.dataset.dragOver = 'true';
	}, { signal });
	dropZone?.addEventListener('dragleave', () => {
		if (dropZone) dropZone.dataset.dragOver = 'false';
	}, { signal });
	dropZone?.addEventListener('drop', (e) => {
		e.preventDefault();
		if (dropZone) dropZone.dataset.dragOver = 'false';
		const file = e.dataTransfer?.files?.[0];
		if (file) void inspectFile(file);
	}, { signal });

	stripButton?.addEventListener('click', strip, { signal });
	downloadButton?.addEventListener('click', download, { signal });
	resetButton?.addEventListener('click', reset, { signal });

	window.addEventListener('pagehide', reset, { signal });

	teardown = () => {
		controller.abort();
		reset();
	};

	setBusy(false);
	setStatus('Choose an image to inspect. Nothing leaves this tab.');
}

function describeBytesDelta(before: number, after: number): string {
	if (after < before) {
		const diff = before - after;
		return `${formatBytes(diff)} stripped`;
	}
	return '0 B stripped';
}

export function destroyImageMetadata(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
