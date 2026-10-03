/**
 * BNJI.NET — /tools/ List Randomizer & Shuffler.
 *
 * Local list parsing, deduplication, Fisher-Yates shuffling, and line numbering.
 */
import { TOOL_LIST_CONFIG } from '../config/tools.config';

export type ParseListOptions = {
	trimWhitespace?: boolean;
	removeBlankLines?: boolean;
	removeDuplicates?: boolean;
};

/**
 * Parse input string into a array of lines with options.
 */
export function parseList(text: string, options: ParseListOptions = {}): string[] {
	if (!text) return [];

	let lines = text.split('\n');

	if (options.trimWhitespace !== false) {
		lines = lines.map((l) => l.trim());
	}

	if (options.removeBlankLines !== false) {
		lines = lines.filter((l) => l.length > 0);
	}

	if (options.removeDuplicates) {
		lines = Array.from(new Set(lines));
	}

	if (lines.length > TOOL_LIST_CONFIG.maxLines) {
		lines = lines.slice(0, TOOL_LIST_CONFIG.maxLines);
	}

	return lines;
}

/**
 * Fisher-Yates shuffle using crypto.getRandomValues if available.
 */
export function shuffleList<T>(array: T[]): T[] {
	const result = [...array];
	for (let i = result.length - 1; i > 0; i--) {
		let j = 0;
		if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
			const arr = new Uint32Array(1);
			crypto.getRandomValues(arr);
			j = arr[0] % (i + 1);
		} else {
			j = Math.floor(Math.random() * (i + 1));
		}
		const temp = result[i];
		result[i] = result[j];
		result[j] = temp;
	}
	return result;
}

export type FormatListOptions = {
	addLineNumbers?: boolean;
};

/**
 * Format string array back into a multiline output.
 */
export function formatList(items: string[], options: FormatListOptions = {}): string {
	if (!items || items.length === 0) return '';
	if (options.addLineNumbers) {
		const padLen = String(items.length).length;
		return items.map((item, idx) => `${String(idx + 1).padStart(padLen, ' ')}. ${item}`).join('\n');
	}
	return items.join('\n');
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initListRandomizer(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-list-randomizer]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const textarea = root.querySelector<HTMLTextAreaElement>('[data-list-input]');
	const trimCheck = root.querySelector<HTMLInputElement>('[data-list-trim]');
	const blankCheck = root.querySelector<HTMLInputElement>('[data-list-blank]');
	const dupeCheck = root.querySelector<HTMLInputElement>('[data-list-dupe]');
	const numberCheck = root.querySelector<HTMLInputElement>('[data-list-numbers]');

	const shuffleBtn = root.querySelector<HTMLButtonElement>('[data-list-shuffle]');
	const reverseBtn = root.querySelector<HTMLButtonElement>('[data-list-reverse]');
	const sortAzBtn = root.querySelector<HTMLButtonElement>('[data-list-sort-az]');
	const sortZaBtn = root.querySelector<HTMLButtonElement>('[data-list-sort-za]');
	const copyBtn = root.querySelector<HTMLButtonElement>('[data-list-copy]');
	const clearBtn = root.querySelector<HTMLButtonElement>('[data-list-clear]');

	const statusLine = root.querySelector<HTMLElement>('[data-list-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-list-error]');
	const outputTextarea = root.querySelector<HTMLTextAreaElement>('[data-list-output]');
	const results = root.querySelector<HTMLElement>('[data-list-results]');

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const showError = (msg: string) => {
		if (errorLine) {
			errorLine.textContent = msg;
			errorLine.hidden = false;
		}
		if (results) results.hidden = true;
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const getParsed = (): string[] => {
		const raw = textarea?.value || '';
		return parseList(raw, {
			trimWhitespace: trimCheck?.checked ?? true,
			removeBlankLines: blankCheck?.checked ?? true,
			removeDuplicates: dupeCheck?.checked ?? false,
		});
	};

	const renderOutput = (items: string[], actionName: string) => {
		clearError();
		if (items.length === 0) {
			showError('Please enter at least one non-empty line.');
			return;
		}

		const formatted = formatList(items, {
			addLineNumbers: numberCheck?.checked ?? false,
		});

		if (outputTextarea) {
			outputTextarea.value = formatted;
		}
		if (results) results.hidden = false;
		if (copyBtn) copyBtn.disabled = false;
		setStatus(`${actionName} ${items.length} item(s).`);
	};

	const handleShuffle = () => {
		const parsed = getParsed();
		const shuffled = shuffleList(parsed);
		renderOutput(shuffled, 'Shuffled');
	};

	const handleReverse = () => {
		const parsed = getParsed();
		const reversed = [...parsed].reverse();
		renderOutput(reversed, 'Reversed');
	};

	const handleSortAz = () => {
		const parsed = getParsed();
		const sorted = [...parsed].sort((a, b) => a.localeCompare(b));
		renderOutput(sorted, 'Sorted A-Z');
	};

	const handleSortZa = () => {
		const parsed = getParsed();
		const sorted = [...parsed].sort((a, b) => b.localeCompare(a));
		renderOutput(sorted, 'Sorted Z-A');
	};

	const handleCopy = () => {
		if (!outputTextarea?.value) return;
		navigator.clipboard.writeText(outputTextarea.value)
			.then(() => setStatus('Copied list to clipboard!'))
			.catch(() => setStatus('Failed to copy to clipboard.'));
	};

	const handleClear = () => {
		if (textarea) textarea.value = '';
		if (outputTextarea) outputTextarea.value = '';
		clearError();
		if (results) results.hidden = true;
		if (copyBtn) copyBtn.disabled = true;
		setStatus('List cleared.');
	};

	shuffleBtn?.addEventListener('click', handleShuffle, { signal });
	reverseBtn?.addEventListener('click', handleReverse, { signal });
	sortAzBtn?.addEventListener('click', handleSortAz, { signal });
	sortZaBtn?.addEventListener('click', handleSortZa, { signal });
	copyBtn?.addEventListener('click', handleCopy, { signal });
	clearBtn?.addEventListener('click', handleClear, { signal });

	teardown = () => {
		controller.abort();
	};

	setStatus('Enter list items above and select an action.');
}

export function destroyListRandomizer(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
