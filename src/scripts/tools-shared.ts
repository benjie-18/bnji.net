/**
 * BNJI.NET — primitives shared by the browser tools on /tools/.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * There are four tools and one visitor. Two of them read text files, two read
 * images, and all four print numbers — and the moment each grew its own
 * `formatBytes()` or its own idea of what a text file is, "1.5 KB" on one tool
 * and "1.50 KB" on the next, or a `.log` accepted here and refused there, became
 * a matter of time. So the shared vocabulary lives once, here: byte and number
 * formatting, the two file whitelists with their limits, and the shape of a
 * refusal.
 *
 * What is NOT here: anything a single tool owns. Word segmentation belongs to
 * the word counter, canvas encoding to the image converter, the diff table to
 * the text diff, colour arithmetic to the colour picker. A tool imports these
 * primitives; these primitives import nothing from a tool — which is why the
 * colour picker does not have to import the image converter to agree with it
 * about what a PNG weighs.
 *
 * Like every other module in src/scripts/, nothing here touches the network and
 * nothing here stores anything: the tools' privacy posture is that there is
 * nowhere for data to go.
 */
import {
	IMAGE_FILE_CONFIG,
	IMAGE_INPUT_LABELS,
	IMAGE_INPUT_TYPES,
	TEXT_FILE_CONFIG,
	TEXT_INPUT_EXTENSIONS,
	TEXT_INPUT_LABELS,
	TEXT_INPUT_TYPES,
} from '../config/tools.config';

/* ------------------------------------------------------------------------- *
 * Formatting
 * ------------------------------------------------------------------------- */

/**
 * Characters as a person counts them: one per code point, so an emoji is ONE
 * character and not the two UTF-16 units `String#length` would report. A lone
 * surrogate still counts as one — dropping it would make the total disagree with
 * what is on screen. Written as a loop rather than `[...text].length` because
 * spreading allocates one array entry per character, and the tools' limits
 * allow half a million of them.
 */
export function codePointLength(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		// 0xDC00–0xDFFF is the second half of a surrogate pair; the pair was
		// already counted at its lead unit.
		if (code >= 0xdc00 && code <= 0xdfff) continue;
		count += 1;
	}
	return count;
}

/** 1536 -> "1.5 KB". Used for every byte count the tools show. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * 1234 -> "1,234". Grouped with en-US commas so the digits a test asserts are
 * the digits a visitor reads; every word on these tools is English anyway.
 */
export function formatCount(value: number): string {
	if (!Number.isFinite(value)) return '0';
	return Math.round(value).toLocaleString('en-US');
}

/* ------------------------------------------------------------------------- *
 * Refusals
 * ------------------------------------------------------------------------- */

/**
 * The one shape every tool's guards return. A refusal carries its own sentence,
 * so the copy that explains a limit lives beside the limit that was checked.
 */
export type ToolCheck = { ok: true } | { ok: false; message: string };

/* ------------------------------------------------------------------------- *
 * The clipboard
 * ------------------------------------------------------------------------- */

/**
 * The three ways a copy can end. "Unavailable" is not a failure and is reported
 * differently: a browser with no clipboard API (anything not a secure context)
 * never had a chance, and saying "the copy failed" would blame the visitor's
 * action for the environment.
 */
export type CopyOutcome = 'copied' | 'unavailable' | 'refused';

/** Sentence stems, so three tools refuse a copy in the same words. */
export const COPY_UNAVAILABLE =
	'This browser has no clipboard API (it needs a secure context), so nothing was copied.';
export const COPY_REFUSED = 'The clipboard refused the copy, so nothing was copied.';

/**
 * Put text on the clipboard. Every tool that copies needs the same three
 * outcomes and the same two guards (no `navigator` at all, no `clipboard` on
 * it), so the mechanism lives here and the sentences — which describe three
 * different payloads — stay with the tools.
 */
export async function copyText(text: string): Promise<CopyOutcome> {
	const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
	if (!clipboard?.writeText) return 'unavailable';
	try {
		await clipboard.writeText(text);
		return 'copied';
	} catch {
		return 'refused';
	}
}

/* ------------------------------------------------------------------------- *
 * Text files
 * ------------------------------------------------------------------------- */

function extensionOf(name: string): string {
	const index = name.lastIndexOf('.');
	return index > 0 ? name.slice(index).toLowerCase() : '';
}

/**
 * Whether a file is text the tools read. A whitelist, like the image tool's:
 * the alternative is implying a tool reads anything.
 *
 * The type OR the extension is enough, because browsers disagree about both —
 * many report an empty type for .md/.csv/.log, and some answer
 * `application/octet-stream`. A PDF is refused on both counts (its MIME is not
 * `text/*` and `.pdf` is not in the list), which is the case that matters.
 */
export function isTextFile(file: { name: string; type: string }): boolean {
	if (TEXT_INPUT_TYPES.includes(file.type)) return true;
	if (file.type.startsWith('text/')) return true;
	return TEXT_INPUT_EXTENSIONS.includes(extensionOf(file.name));
}

/**
 * The slice of `File` the tools use, written structurally so a test can hand
 * over a fake without a browser.
 */
export type TextFile = { name: string; type: string; size: number; text(): Promise<string> };

/** Refuse a file before a single byte of it is read, and say why. */
export function checkTextFile(file: { name: string; type: string; size: number }): ToolCheck {
	if (!isTextFile(file)) {
		return {
			ok: false,
			message: `“${file.name}” is not a text file this tool reads. It reads ${TEXT_INPUT_LABELS} — not PDFs, documents, spreadsheets, images, archives or video.`,
		};
	}
	if (file.size === 0) {
		return { ok: false, message: `“${file.name}” is empty, so there is nothing to read.` };
	}
	if (file.size > TEXT_FILE_CONFIG.maxBytes) {
		return {
			ok: false,
			message: `“${file.name}” is ${formatBytes(file.size)}. This tool reads text files up to ${formatBytes(TEXT_FILE_CONFIG.maxBytes)} so one file cannot exhaust a phone's memory.`,
		};
	}
	return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Image files
 * ------------------------------------------------------------------------- */

/**
 * What a tool does with an image it accepts, in the words its refusals use.
 *
 * Both image-reading tools refuse the same files for the same reasons, but they
 * do different things with an accepted one, so the verb is a parameter instead
 * of a paraphrase each tool invents: the copy stays parallel, and neither tool
 * has to import the other to get it.
 */
export type ImagePurpose = {
	/** Third person, for "is not a format this tool …": 'converts'. */
	verb: string;
	/** Infinitive, for "there is nothing to …": 'convert'. */
	nothing: string;
};

/**
 * Refuse an image file before a single byte of it is decoded, and say why.
 *
 * The type check is a whitelist on purpose: the alternative — accepting anything
 * the browser might decode — is how a tool ends up implying it reads PDFs or
 * video. Anything outside IMAGE_INPUT_TYPES is rejected by name, before the
 * decode that could exhaust a phone's memory.
 */
export function checkImageFile(
	file: { name: string; type: string; size: number },
	purpose: ImagePurpose,
): ToolCheck {
	if (!IMAGE_INPUT_TYPES.includes(file.type)) {
		return {
			ok: false,
			message: `“${file.name}” is not a format this tool ${purpose.verb}. It reads ${IMAGE_INPUT_LABELS} — not PDFs, documents, archives or video.`,
		};
	}
	if (file.size === 0) {
		return { ok: false, message: `“${file.name}” is empty, so there is nothing to ${purpose.nothing}.` };
	}
	if (file.size > IMAGE_FILE_CONFIG.maxBytes) {
		return {
			ok: false,
			message: `“${file.name}” is ${formatBytes(file.size)}. This tool reads files up to ${formatBytes(IMAGE_FILE_CONFIG.maxBytes)} so decoding cannot exhaust a phone's memory.`,
		};
	}
	return { ok: true };
}

/**
 * Refuse an image that decoded into more pixels than the shared budget. The
 * bytes were already spent by the time this runs — a browser decodes before it
 * reports dimensions — so the check exists to stop the NEXT step (a canvas, a
 * scan) from allocating a second copy of a 40-megapixel image.
 */
export function checkDecodedImage(image: {
	name: string;
	width: number;
	height: number;
}): ToolCheck {
	const pixels = image.width * image.height;
	if (pixels > IMAGE_FILE_CONFIG.maxSourcePixels) {
		return {
			ok: false,
			message: `“${image.name}” decodes to ${image.width}×${image.height} (${formatCount(pixels)} pixels), over this tool's ${formatCount(IMAGE_FILE_CONFIG.maxSourcePixels)}-pixel source budget.`,
		};
	}
	return { ok: true };
}

/**
 * Whether a decoded file looks like it was not UTF-8 text. `File.text()` decodes
 * UTF-8 and replaces bytes it cannot parse with U+FFFD, so a PDF, a UTF-16 file
 * or a binary renamed .txt arrives as mojibake — and counting, comparing or
 * converting mojibake without saying so is the quietest way to be wrong.
 */
export function looksLikeMojibake(text: string): boolean {
	return text.includes('\uFFFD');
}
