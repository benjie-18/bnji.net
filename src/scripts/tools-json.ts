/**
 * BNJI.NET — /tools/ JSON formatter & validator.
 *
 * Local, synchronous and non-destructive: the visitor's text is only ever
 * replaced by a *successful* parse of itself, so a malformed paste keeps every
 * character and gets an error that says where it broke instead.
 *
 * SAFE TEXT RENDERING. Every string this module writes goes through
 * `textContent`. The editor's contents are attacker-chosen input — a JSON
 * document is just as good a place to hide `</textarea><img onerror=…>` as a
 * URL is — and a single innerHTML would turn this tool into an XSS sink.
 *
 * LINE/COLUMN. `JSON.parse`'s error wording is browser-specific and modern V8
 * omits the offset for several common failures, so `findJsonErrorOffset`
 * derives it from the text itself. That walker is the only reason this tool can
 * promise line/column in every browser rather than in one.
 */
import { TOOL_JSON_CONFIG } from '../config/tools.config';

/* ------------------------------------------------------------------------- *
 * Pure helpers (exported: unit-tested without a browser)
 * ------------------------------------------------------------------------- */

export type JsonOutcome =
	| { ok: true; value: string; shape: string }
	| { ok: false; error: string };

/** Sticky on purpose: it is re-run at every offset and must not slice the text. */
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_LITERALS = ['true', 'false', 'null'] as const;
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/**
 * Offset of the first token a JSON parser cannot accept, or null when the text
 * is structurally valid (in which case JSON.parse itself would have succeeded).
 *
 * The grammar here is deliberately narrow — it is a *validator*, not a parser:
 * it only has to answer "where does this stop being JSON", which is what the
 * error line needs. Anything it cannot decide falls back to null and the
 * caller reports the parser's own message instead.
 */
export function findJsonErrorOffset(text: string): number | null {
	type Frame = 'array' | 'object';
	const stack: Frame[] = [];
	let index = 0;

	const skipWhitespace = (): void => {
		while (index < text.length && WHITESPACE.has(text[index])) index += 1;
	};

	const readString = (): boolean => {
		const start = index;
		index += 1;
		while (index < text.length) {
			const char = text[index];
			if (char === '\\') {
				index += 2;
				continue;
			}
			if (char === '"') {
				index += 1;
				return true;
			}
			index += 1;
		}
		// Unterminated: point at the opening quote, which is what a person has
		// to go and close.
		index = start;
		return false;
	};

	const readLiteralOrNumber = (): boolean => {
		JSON_NUMBER.lastIndex = index;
		const number = JSON_NUMBER.exec(text);
		if (number) {
			index += number[0].length;
			return true;
		}
		for (const literal of JSON_LITERALS) {
			if (text.startsWith(literal, index)) {
				index += literal.length;
				return true;
			}
		}
		return false;
	};

	const readObjectBody = (): boolean => {
		skipWhitespace();
		if (index >= text.length) return false;
		if (text[index] === '}') {
			index += 1;
			stack.pop();
			return true;
		}
		for (;;) {
			skipWhitespace();
			if (text[index] !== '"') return false;
			if (!readString()) return false;
			skipWhitespace();
			if (text[index] !== ':') return false;
			index += 1;
			if (!readValue()) return false;
			skipWhitespace();
			if (text[index] === ',') {
				index += 1;
				continue;
			}
			if (text[index] === '}') {
				index += 1;
				stack.pop();
				return true;
			}
			return false;
		}
	};

	const readArrayBody = (): boolean => {
		skipWhitespace();
		if (index >= text.length) return false;
		if (text[index] === ']') {
			index += 1;
			stack.pop();
			return true;
		}
		for (;;) {
			if (!readValue()) return false;
			skipWhitespace();
			if (text[index] === ',') {
				index += 1;
				continue;
			}
			if (text[index] === ']') {
				index += 1;
				stack.pop();
				return true;
			}
			return false;
		}
	};

	function readValue(): boolean {
		skipWhitespace();
		if (index >= text.length) return false;
		const char = text[index];
		if (char === '{') {
			stack.push('object');
			index += 1;
			return readObjectBody();
		}
		if (char === '[') {
			stack.push('array');
			index += 1;
			return readArrayBody();
		}
		if (char === '"') return readString();
		return readLiteralOrNumber();
	}

	if (!readValue()) return index;
	skipWhitespace();
	// A complete value followed by more text is a syntax error in its own right
	// ("{} {}"), and the offset of that trailing text is the useful one.
	if (index < text.length) return index;
	return stack.length === 0 ? null : index;
}

/** 1-based line/column for an offset, so it can be shown next to the error. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
	const clamped = Math.min(Math.max(0, Math.floor(offset)), text.length);
	let line = 1;
	let lineStart = 0;
	for (let index = 0; index < clamped; index += 1) {
		if (text[index] === '\n') {
			line += 1;
			lineStart = index + 1;
		}
	}
	return { line, column: clamped - lineStart + 1 };
}

/** The inverse of `lineAndColumn`: a 1-based line/column back into an offset. */
export function offsetOfLineColumn(text: string, line: number, column: number): number {
	let offset = 0;
	let seen = 1;
	while (seen < line && offset < text.length) {
		if (text[offset] === '\n') seen += 1;
		offset += 1;
	}
	return Math.min(offset + Math.max(1, column) - 1, text.length);
}

/**
 * Where the parser failed: V8's own offset when it gives one, a Firefox/Safari
 * "line L column C" when that is all there is, and the local walker otherwise.
 */
function errorOffset(text: string, error: unknown): number | null {
	const message = error instanceof Error ? error.message : String(error);
	const position = /position (\d+)/.exec(message);
	if (position) return Number(position[1]);
	const lineColumn = /line (\d+) column (\d+)/.exec(message);
	if (lineColumn) {
		return offsetOfLineColumn(text, Number(lineColumn[1]), Number(lineColumn[2]));
	}
	return findJsonErrorOffset(text);
}

/** The parser's own wording, minus the position suffix it duplicates. */
function cleanMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const cleaned = message
		.replace(/\s*at position \d+(\s*\(line \d+ column \d+\))?/, '')
		.replace(/\s*\(line \d+ column \d+\)/, '')
		.replace(/^JSON\.parse:\s*/, '')
		.trim();
	return cleaned.length > 0 ? cleaned : 'Not valid JSON.';
}

/**
 * A sentence a person can act on, e.g.
 * "Line 3, column 12 — Expected ',' or '}' after property value in JSON."
 */
export function describeJsonError(text: string, error: unknown): string {
	const offset = errorOffset(text, error);
	if (offset === null) return cleanMessage(error);
	const { line, column } = lineAndColumn(text, offset);
	return `Line ${line}, column ${column} — ${cleanMessage(error)}`;
}

/** What the parsed value is, in words, for the success state. */
export function jsonShapeSummary(value: unknown): string {
	if (Array.isArray(value)) return `an array of ${value.length} item${value.length === 1 ? '' : 's'}`;
	if (value !== null && typeof value === 'object') {
		const keys = Object.keys(value as Record<string, unknown>).length;
		return `an object with ${keys} key${keys === 1 ? '' : 's'}`;
	}
	if (typeof value === 'string') {
		const shown = value.length > 24 ? `${value.slice(0, 24)}…` : value;
		return `the string “${shown}”`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') return `the ${typeof value} ${value}`;
	if (value === null) return 'null';
	return String(value);
}

/** Parse and re-emit with the configured indent. Never mutates on failure. */
export function formatJsonText(text: string): JsonOutcome {
	return transform(text, (value) => JSON.stringify(value, null, TOOL_JSON_CONFIG.indent));
}

/** Parse and re-emit on one line. */
export function minifyJsonText(text: string): JsonOutcome {
	return transform(text, (value) => JSON.stringify(value));
}

function transform(text: string, emit: (value: unknown) => string): JsonOutcome {
	try {
		const value: unknown = JSON.parse(text);
		const formatted = emit(value);
		return { ok: true, value: formatted, shape: jsonShapeSummary(value) };
	} catch (error) {
		return { ok: false, error: describeJsonError(text, error) };
	}
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
/** Set by init, cleared by destroy — see destroyJsonFormatter(). */
let teardown: (() => void) | null = null;

export function initJsonFormatter(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-json-formatter]');
	if (!root) return;
	started = true;

	// One signal for every listener, the way music.ts does it: teardown is a
	// single abort() rather than a list of removeEventListener calls.
	const controller = new AbortController();
	const { signal } = controller;

	const editor = root.querySelector<HTMLTextAreaElement>('[data-json-editor]');
	const formatButton = root.querySelector<HTMLButtonElement>('[data-json-format]');
	const minifyButton = root.querySelector<HTMLButtonElement>('[data-json-minify]');
	const copyButton = root.querySelector<HTMLButtonElement>('[data-json-copy]');
	const clearButton = root.querySelector<HTMLButtonElement>('[data-json-clear]');
	const statusLine = root.querySelector<HTMLElement>('[data-json-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-json-error]');
	const noteLine = root.querySelector<HTMLElement>('[data-json-note]');

	const setStatus = (message: string) => {
		if (statusLine) statusLine.textContent = message;
	};

	const showError = (message: string) => {
		if (errorLine) {
			errorLine.textContent = message;
			errorLine.hidden = false;
		}
	};

	const clearFeedback = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
		if (noteLine) {
			noteLine.textContent = '';
			noteLine.hidden = true;
		}
	};

	const emptyState = () => {
		clearFeedback();
		setStatus('Empty — paste JSON, then format or minify it.');
	};

	/**
	 * The shared body of Format and Minify. The editor's text is only replaced
	 * when the parse succeeded, which is why a broken paste is never lost.
	 */
	const runTransform = (outcome: JsonOutcome, verb: string) => {
		clearFeedback();
		if (!outcome.ok) {
			showError(outcome.error);
			setStatus('Your text is unchanged.');
			return;
		}
		if (editor) editor.value = outcome.value;
		setStatus(
			`${verb} — valid JSON, ${outcome.shape}, ${outcome.value.length.toLocaleString()} characters.`,
		);
	};

	/**
	 * Named `run` rather than `transform` on purpose: the module-level
	 * `transform()` is what Format and Minify both funnel through, and shadowing
	 * it here would make the two hard to tell apart while reading.
	 */
	const run = (mode: 'format' | 'minify') => {
		const text = editor?.value ?? '';
		if (text.trim().length === 0) {
			emptyState();
			return;
		}
		if (text.length > TOOL_JSON_CONFIG.maxCharacters) {
			clearFeedback();
			showError(
				`That is ${text.length.toLocaleString()} characters, over this tool's ${TOOL_JSON_CONFIG.maxCharacters.toLocaleString()}-character limit. Paste a smaller document.`,
			);
			setStatus('Your text is unchanged.');
			return;
		}
		const outcome = mode === 'format' ? formatJsonText(text) : minifyJsonText(text);
		runTransform(outcome, mode === 'format' ? 'Formatted' : 'Minified');
	};
	/**
	 * Copy without assuming a clipboard. The async Clipboard API needs a secure
	 * context and a permission; `execCommand` needs a selection and is
	 * deprecated but universal; if neither works the text is selected and the
	 * visitor is told the keystroke, which always works.
	 */
	const copy = async () => {
		const text = editor?.value ?? '';
		clearFeedback();
		if (text.length === 0) {
			setStatus('Nothing to copy yet.');
			return;
		}

		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				setStatus(`Copied ${text.length.toLocaleString()} characters to the clipboard.`);
				return;
			}
		} catch {
			// Fall through to the manual path below rather than reporting a
			// dead end — the visitor still has the text selected.
		}

		selectEditorText();
		if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
			try {
				if (document.execCommand('copy')) {
					setStatus(`Copied ${text.length.toLocaleString()} characters to the clipboard.`);
					return;
				}
			} catch {
				// Same: fall through.
			}
		}
		if (noteLine) {
			noteLine.textContent =
				'The clipboard is unavailable here. The text is selected — press Ctrl or ⌘ + C.';
			noteLine.hidden = false;
		}
		setStatus('Copy needs a keystroke in this browser.');
	};

	const selectEditorText = () => {
		if (editor && typeof editor.select === 'function') editor.select();
	};

	formatButton?.addEventListener('click', () => run('format'), { signal });
	minifyButton?.addEventListener('click', () => run('minify'), { signal });
	copyButton?.addEventListener('click', () => void copy(), { signal });
	clearButton?.addEventListener('click', () => {
		if (editor) editor.value = '';
		emptyState();
		editor?.focus();
	}, { signal });

	teardown = () => controller.abort();

	emptyState();
}

/**
 * Drop the bindings and re-arm the init, so a second call binds a fresh
 * subtree. The editor's text is deliberately left alone: clearing it here would
 * be this module destroying a visitor's work on a lifecycle event it does not
 * own.
 */
export function destroyJsonFormatter(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
