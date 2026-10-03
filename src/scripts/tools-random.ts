/**
 * BNJI.NET — /tools/ Random Number & Item Picker.
 *
 * Uses crypto.getRandomValues when available for cryptographically sound random values.
 * Local only, no network calls.
 */
import { TOOL_RANDOM_CONFIG } from '../config/tools.config';

/**
 * Return a random integer in [min, max] inclusive using crypto.getRandomValues if available.
 */
export function getRandomInt(min: number, max: number): number {
	const range = max - min + 1;
	if (range <= 0) return min;

	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		const array = new Uint32Array(1);
		crypto.getRandomValues(array);
		return min + (array[0] % range);
	}
	return Math.floor(Math.random() * range) + min;
}

export type NumberResult =
	| { ok: true; numbers: number[] }
	| { ok: false; error: string };

/**
 * Generate a list of random numbers within [min, max].
 */
export function generateRandomNumbers(
	min: number,
	max: number,
	count: number,
	allowDuplicates: boolean,
	sort: boolean,
): NumberResult {
	if (!Number.isFinite(min) || !Number.isFinite(max)) {
		return { ok: false, error: 'Min and Max must be valid numbers.' };
	}
	if (min > max) {
		return { ok: false, error: 'Min cannot be greater than Max.' };
	}
	if (min < TOOL_RANDOM_CONFIG.minNumber || max > TOOL_RANDOM_CONFIG.maxNumber) {
		return {
			ok: false,
			error: `Numbers must be between ${TOOL_RANDOM_CONFIG.minNumber.toLocaleString()} and ${TOOL_RANDOM_CONFIG.maxNumber.toLocaleString()}.`,
		};
	}

	const safeCount = Math.min(TOOL_RANDOM_CONFIG.maxCount, Math.max(1, Math.round(count || 1)));
	const possibleCount = max - min + 1;

	if (!allowDuplicates && safeCount > possibleCount) {
		return {
			ok: false,
			error: `Cannot generate ${safeCount} unique numbers in a range of size ${possibleCount}. Enable duplicates or widen the range.`,
		};
	}

	const results: number[] = [];
	if (!allowDuplicates) {
		const set = new Set<number>();
		while (set.size < safeCount) {
			set.add(getRandomInt(min, max));
		}
		results.push(...set);
	} else {
		for (let i = 0; i < safeCount; i++) {
			results.push(getRandomInt(min, max));
		}
	}

	if (sort) {
		results.sort((a, b) => a - b);
	}

	return { ok: true, numbers: results };
}

export type ItemPickResult =
	| { ok: true; items: string[] }
	| { ok: false; error: string };

/**
 * Pick random items from a raw multiline/comma-separated text string.
 */
export function pickRandomItems(
	rawText: string,
	count: number,
	allowDuplicates: boolean,
): ItemPickResult {
	if (!rawText || !rawText.trim()) {
		return { ok: false, error: 'Please enter at least one item to pick from.' };
	}

	// Split by newlines or commas if single line
	let parsed = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
	if (parsed.length === 1 && parsed[0].includes(',')) {
		parsed = parsed[0].split(',').map((item) => item.trim()).filter(Boolean);
	}

	if (parsed.length === 0) {
		return { ok: false, error: 'No valid non-empty items found.' };
	}

	const safeCount = Math.min(TOOL_RANDOM_CONFIG.maxPickerItems, Math.max(1, Math.round(count || 1)));

	if (!allowDuplicates && safeCount > parsed.length) {
		return {
			ok: false,
			error: `Cannot pick ${safeCount} unique items from a list of ${parsed.length} items. Enable duplicates or add more items.`,
		};
	}

	const chosen: string[] = [];
	const available = [...parsed];

	for (let i = 0; i < safeCount; i++) {
		if (allowDuplicates) {
			const idx = getRandomInt(0, available.length - 1);
			chosen.push(available[idx]);
		} else {
			const idx = getRandomInt(0, available.length - 1);
			chosen.push(available[idx]);
			available.splice(idx, 1);
		}
	}

	return { ok: true, items: chosen };
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initRandomPicker(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-random-picker]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const modeSelect = root.querySelector('[data-random-mode]') as (HTMLElement & { value: string }) | null;
	const numberSection = root.querySelector<HTMLElement>('[data-random-number-section]');
	const itemSection = root.querySelector<HTMLElement>('[data-random-item-section]');

	// Number mode controls
	const minInput = root.querySelector<HTMLInputElement>('[data-random-min]');
	const maxInput = root.querySelector<HTMLInputElement>('[data-random-max]');
	const numCountInput = root.querySelector<HTMLInputElement>('[data-random-num-count]');
	const numDupesCheck = root.querySelector<HTMLInputElement>('[data-random-num-dupes]');
	const numSortCheck = root.querySelector<HTMLInputElement>('[data-random-num-sort]');

	// Item mode controls
	const itemsTextarea = root.querySelector<HTMLTextAreaElement>('[data-random-items]');
	const itemCountInput = root.querySelector<HTMLInputElement>('[data-random-item-count]');
	const itemDupesCheck = root.querySelector<HTMLInputElement>('[data-random-item-dupes]');

	const generateBtn = root.querySelector<HTMLButtonElement>('[data-random-generate]');
	const resetBtn = root.querySelector<HTMLButtonElement>('[data-random-reset]');
	const statusLine = root.querySelector<HTMLElement>('[data-random-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-random-error]');
	const resultsContainer = root.querySelector<HTMLElement>('[data-random-results]');
	const outputList = root.querySelector<HTMLElement>('[data-random-output-list]');

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const showError = (msg: string) => {
		if (errorLine) {
			errorLine.textContent = msg;
			errorLine.hidden = false;
		}
		if (resultsContainer) resultsContainer.hidden = true;
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const syncMode = () => {
		const mode = modeSelect?.value || 'number';
		if (numberSection) numberSection.hidden = mode !== 'number';
		if (itemSection) itemSection.hidden = mode !== 'item';
		clearError();
		if (resultsContainer) resultsContainer.hidden = true;
	};

	const generate = () => {
		clearError();
		const mode = modeSelect?.value || 'number';

		if (mode === 'number') {
			const min = Number(minInput?.value ?? TOOL_RANDOM_CONFIG.defaultMin);
			const max = Number(maxInput?.value ?? TOOL_RANDOM_CONFIG.defaultMax);
			const count = Number(numCountInput?.value ?? TOOL_RANDOM_CONFIG.defaultCount);
			const allowDupes = numDupesCheck?.checked ?? true;
			const sort = numSortCheck?.checked ?? false;

			const res = generateRandomNumbers(min, max, count, allowDupes, sort);
			if (!res.ok) {
				showError(res.error);
				return;
			}

			if (outputList) {
				outputList.innerHTML = res.numbers
					.map((n) => `<span class="tool__chip-item mono">${n}</span>`)
					.join('');
			}
			if (resultsContainer) resultsContainer.hidden = false;
			setStatus(`Generated ${res.numbers.length} random number(s).`);
		} else {
			const text = itemsTextarea?.value || '';
			const count = Number(itemCountInput?.value ?? 1);
			const allowDupes = itemDupesCheck?.checked ?? false;

			const res = pickRandomItems(text, count, allowDupes);
			if (!res.ok) {
				showError(res.error);
				return;
			}

			if (outputList) {
				outputList.innerHTML = res.items
					.map((item) => `<span class="tool__chip-item mono">${escapeHtml(item)}</span>`)
					.join('');
			}
			if (resultsContainer) resultsContainer.hidden = false;
			setStatus(`Picked ${res.items.length} random item(s).`);
		}
	};

	const reset = () => {
		if (minInput) minInput.value = String(TOOL_RANDOM_CONFIG.defaultMin);
		if (maxInput) maxInput.value = String(TOOL_RANDOM_CONFIG.defaultMax);
		if (numCountInput) numCountInput.value = String(TOOL_RANDOM_CONFIG.defaultCount);
		if (numDupesCheck) numDupesCheck.checked = true;
		if (numSortCheck) numSortCheck.checked = false;

		if (itemsTextarea) itemsTextarea.value = '';
		if (itemCountInput) itemCountInput.value = '1';
		if (itemDupesCheck) itemDupesCheck.checked = false;

		clearError();
		if (resultsContainer) resultsContainer.hidden = true;
		setStatus('Ready to generate.');
	};

	modeSelect?.addEventListener('change', syncMode, { signal });
	generateBtn?.addEventListener('click', generate, { signal });
	resetBtn?.addEventListener('click', reset, { signal });

	teardown = () => {
		controller.abort();
	};

	syncMode();
	setStatus('Ready to generate.');
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function destroyRandomPicker(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
