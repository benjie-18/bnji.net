/**
 * BNJI.NET — /tools/ Percentage Calculator script.
 *
 * Runs locally in browser tab memory. Computes X% of Y, X as % of Y,
 * percentage change, and percentage increase/decrease.
 */

import type { PercentageMode } from '../config/tools.config';

export type PercentageResult = {
	ok: boolean;
	value?: number;
	secondaryValue?: number;
	formattedResult: string;
	formula: string;
	error?: string;
};

/** Pure function to calculate percentage math scenarios. */
export function calculatePercentage(
	mode: PercentageMode,
	x: number,
	y: number,
): PercentageResult {
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return {
			ok: false,
			formattedResult: '—',
			formula: 'Enter valid numbers for X and Y.',
			error: 'Invalid input numbers.',
		};
	}

	if (mode === 'of') {
		const res = (x / 100) * y;
		const cleanRes = cleanNum(res);
		return {
			ok: true,
			value: cleanRes,
			formattedResult: `${cleanRes}`,
			formula: `(${x}% × ${y}) / 100 = ${cleanRes}`,
		};
	}

	if (mode === 'is-what') {
		if (y === 0) {
			return {
				ok: false,
				formattedResult: '—',
				formula: 'Cannot calculate percentage of 0.',
				error: 'Division by zero.',
			};
		}
		const res = (x / y) * 100;
		const cleanRes = cleanNum(res);
		return {
			ok: true,
			value: cleanRes,
			formattedResult: `${cleanRes}%`,
			formula: `(${x} / ${y}) × 100 = ${cleanRes}%`,
		};
	}

	if (mode === 'change') {
		if (x === 0) {
			return {
				ok: false,
				formattedResult: '—',
				formula: 'Base value (X) cannot be zero for % change.',
				error: 'Division by zero.',
			};
		}
		const diff = y - x;
		const pct = (diff / Math.abs(x)) * 100;
		const cleanPct = cleanNum(pct);
		const direction = cleanPct >= 0 ? 'increase' : 'decrease';
		return {
			ok: true,
			value: cleanPct,
			formattedResult: `${cleanPct > 0 ? '+' : ''}${cleanPct}% (${direction})`,
			formula: `((${y} - ${x}) / ${Math.abs(x)}) × 100 = ${cleanPct}%`,
		};
	}

	if (mode === 'increase-decrease') {
		const delta = (x / 100) * y;
		const increased = cleanNum(y + delta);
		const decreased = cleanNum(y - delta);
		return {
			ok: true,
			value: increased,
			secondaryValue: decreased,
			formattedResult: `+${x}% = ${increased}  |  -${x}% = ${decreased}`,
			formula: `Base: ${y} → +${x}% = ${increased}, -${x}% = ${decreased}`,
		};
	}

	return {
		ok: false,
		formattedResult: '—',
		formula: 'Unknown mode.',
	};
}

function cleanNum(num: number): number {
	if (!Number.isFinite(num)) return 0;
	return Number(Math.round(Number(`${num}e6`)) + 'e-6');
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initPercentageCalculator(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-percentage-calculator]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const modeSelect = root.querySelector('[data-percentage-mode]') as (HTMLElement & { value: string }) | null;
	const xInput = root.querySelector<HTMLInputElement>('[data-percentage-x]');
	const yInput = root.querySelector<HTMLInputElement>('[data-percentage-y]');
	const xLabel = root.querySelector<HTMLElement>('[data-percentage-x-label]');
	const yLabel = root.querySelector<HTMLElement>('[data-percentage-y-label]');
	const resultText = root.querySelector<HTMLElement>('[data-percentage-result]');
	const formulaText = root.querySelector<HTMLElement>('[data-percentage-formula]');
	const copyButton = root.querySelector<HTMLButtonElement>('[data-percentage-copy]');
	const resetButton = root.querySelector<HTMLButtonElement>('[data-percentage-reset]');
	const statusLine = root.querySelector<HTMLElement>('[data-percentage-status]');

	let currentResult = '';

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const syncLabels = () => {
		const mode = (modeSelect?.value || 'of') as PercentageMode;
		if (mode === 'of') {
			if (xLabel) xLabel.textContent = 'Percentage (X %)';
			if (yLabel) yLabel.textContent = 'Target Number (Y)';
		} else if (mode === 'is-what') {
			if (xLabel) xLabel.textContent = 'Part Number (X)';
			if (yLabel) yLabel.textContent = 'Total Number (Y)';
		} else if (mode === 'change') {
			if (xLabel) xLabel.textContent = 'Initial Value (X)';
			if (yLabel) yLabel.textContent = 'New Value (Y)';
		} else if (mode === 'increase-decrease') {
			if (xLabel) xLabel.textContent = 'Percentage Delta (X %)';
			if (yLabel) yLabel.textContent = 'Base Amount (Y)';
		}
	};

	const recalculate = () => {
		const mode = (modeSelect?.value || 'of') as PercentageMode;
		const rawX = xInput?.value ?? '';
		const rawY = yInput?.value ?? '';

		if (rawX === '' || rawY === '') {
			if (resultText) resultText.textContent = '—';
			if (formulaText) formulaText.textContent = 'Enter values for X and Y above.';
			if (copyButton) copyButton.disabled = true;
			currentResult = '';
			setStatus('Enter values for X and Y.');
			return;
		}

		const x = Number(rawX);
		const y = Number(rawY);

		const res = calculatePercentage(mode, x, y);

		if (resultText) resultText.textContent = res.formattedResult;
		if (formulaText) formulaText.textContent = res.formula;

		if (res.ok) {
			currentResult = res.formattedResult;
			if (copyButton) copyButton.disabled = false;
			setStatus(`Calculated: ${res.formattedResult}`);
		} else {
			currentResult = '';
			if (copyButton) copyButton.disabled = true;
			setStatus(res.error || 'Calculation error.');
		}
	};

	const reset = () => {
		if (modeSelect) modeSelect.value = 'of';
		syncLabels();
		if (xInput) xInput.value = '15';
		if (yInput) yInput.value = '100';
		recalculate();
	};

	const copyToClipboard = async () => {
		if (!currentResult) return;
		try {
			await navigator.clipboard.writeText(currentResult);
			setStatus(`Copied “${currentResult}” to clipboard.`);
		} catch {
			setStatus(`Result: ${currentResult}`);
		}
	};

	modeSelect?.addEventListener('change', () => {
		syncLabels();
		recalculate();
	}, { signal });

	xInput?.addEventListener('input', recalculate, { signal });
	yInput?.addEventListener('input', recalculate, { signal });

	copyButton?.addEventListener('click', () => void copyToClipboard(), { signal });
	resetButton?.addEventListener('click', reset, { signal });

	teardown = () => {
		controller.abort();
	};

	syncLabels();
	if (xInput && !xInput.value) xInput.value = '15';
	if (yInput && !yInput.value) yInput.value = '100';
	recalculate();
}

export function destroyPercentageCalculator(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
