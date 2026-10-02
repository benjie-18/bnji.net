/**
 * BNJI.NET — primitives shared by the browser tools on /tools/.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * There are three tools and one visitor. Two of them read text files and all
 * three print numbers, and the moment each grew its own `formatBytes()` or its
 * own idea of what a text file is, "1.5 KB" on one tool and "1.50 KB" on the
 * next — or a `.log` accepted here and refused there — became a matter of time.
 * So the shared vocabulary lives once, here: byte and number formatting, the
 * text-file whitelist with its byte limit, and the shape of a refusal.
 *
 * What is NOT here: anything a single tool owns. Word segmentation belongs to
 * the word counter, canvas encoding to the image converter, the diff table to
 * the text diff. A tool imports these primitives; these primitives import
 * nothing from a tool.
 *
 * Like every other module in src/scripts/, nothing here touches the network and
 * nothing here stores anything: the tools' privacy posture is that there is
 * nowhere for data to go.
 */
import {
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

/**
 * Whether a decoded file looks like it was not UTF-8 text. `File.text()` decodes
 * UTF-8 and replaces bytes it cannot parse with U+FFFD, so a PDF, a UTF-16 file
 * or a binary renamed .txt arrives as mojibake — and counting, comparing or
 * converting mojibake without saying so is the quietest way to be wrong.
 */
export function looksLikeMojibake(text: string): boolean {
	return text.includes('\uFFFD');
}
