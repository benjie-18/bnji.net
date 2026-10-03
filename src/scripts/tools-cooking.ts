/**
 * BNJI.NET — /tools/ cooking unit converter with optional ingredient density adjustment.
 *
 * Converts between volume and weight kitchen units locally in browser.
 */

import {
	COOKING_UNITS,
	INGREDIENT_DENSITIES,
	type CookingUnit,
	type CookingUnitInfo,
} from '../config/tools.config';

export interface ConversionResult {
	value: number;
	formattedValue: string;
	fromUnit: CookingUnitInfo;
	toUnit: CookingUnitInfo;
	ingredientName: string;
	requiresDensity: boolean;
	densityUsed?: number;
}

/* ------------------------------------------------------------------------- *
 * Pure Logic Helpers
 * ------------------------------------------------------------------------- */

export function getCookingUnit(id: string): CookingUnitInfo | undefined {
	return COOKING_UNITS.find((u) => u.id === id);
}

export function getIngredientDensity(id: string): number {
	const item = INGREDIENT_DENSITIES.find((i) => i.id === id);
	return item ? item.densityGml : 1.0;
}

export function getIngredientName(id: string): string {
	const item = INGREDIENT_DENSITIES.find((i) => i.id === id);
	return item ? item.name : 'Water / Default';
}

/**
 * Converts a cooking value from one unit to another.
 * Handles volume <-> volume, weight <-> weight, and volume <-> weight using ingredient density (g/ml).
 */
export function convertCookingValue(
	amount: number,
	fromUnitId: CookingUnit,
	toUnitId: CookingUnit,
	ingredientId = 'water',
): ConversionResult | null {
	if (!Number.isFinite(amount) || amount < 0) return null;

	const fromUnit = getCookingUnit(fromUnitId);
	const toUnit = getCookingUnit(toUnitId);
	if (!fromUnit || !toUnit) return null;

	const densityGml = getIngredientDensity(ingredientId);
	const ingredientName = getIngredientName(ingredientId);

	let resultInBaseToUnit = 0;
	const requiresDensity = fromUnit.category !== toUnit.category;

	if (fromUnit.category === 'volume' && toUnit.category === 'volume') {
		// Volume to Volume
		const baseMl = amount * fromUnit.baseRatio;
		resultInBaseToUnit = baseMl / toUnit.baseRatio;
	} else if (fromUnit.category === 'weight' && toUnit.category === 'weight') {
		// Weight to Weight
		const baseG = amount * fromUnit.baseRatio;
		resultInBaseToUnit = baseG / toUnit.baseRatio;
	} else if (fromUnit.category === 'volume' && toUnit.category === 'weight') {
		// Volume to Weight (ml -> g using density)
		const baseMl = amount * fromUnit.baseRatio;
		const baseG = baseMl * densityGml;
		resultInBaseToUnit = baseG / toUnit.baseRatio;
	} else {
		// Weight to Volume (g -> ml using density)
		const baseG = amount * fromUnit.baseRatio;
		const baseMl = baseG / densityGml;
		resultInBaseToUnit = baseMl / toUnit.baseRatio;
	}

	const formattedValue = formatCookingNumber(resultInBaseToUnit);

	return {
		value: resultInBaseToUnit,
		formattedValue,
		fromUnit,
		toUnit,
		ingredientName,
		requiresDensity,
		densityUsed: requiresDensity ? densityGml : undefined,
	};
}

export function formatCookingNumber(val: number): string {
	if (val === 0) return '0';
	if (val < 0.01) return val.toExponential(2);
	if (val >= 1000) return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
	return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initCookingConverter(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-cooking-converter]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const amountInput = root.querySelector<HTMLInputElement>('[data-cooking-amount]');
	const fromSelect = root.querySelector('[data-cooking-from]') as
		| (HTMLElement & { value: string })
		| null;
	const toSelect = root.querySelector('[data-cooking-to]') as
		| (HTMLElement & { value: string })
		| null;
	const ingredientSelect = root.querySelector('[data-cooking-ingredient]') as
		| (HTMLElement & { value: string })
		| null;
	const swapBtn = root.querySelector<HTMLButtonElement>('[data-cooking-swap]');
	const resetBtn = root.querySelector<HTMLButtonElement>('[data-cooking-reset]');

	const statusLine = root.querySelector<HTMLElement>('[data-cooking-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-cooking-error]');
	const resultsBlock = root.querySelector<HTMLElement>('[data-cooking-results]');
	const outputVal = root.querySelector<HTMLElement>('[data-cooking-output-value]');
	const outputMeta = root.querySelector<HTMLElement>('[data-cooking-output-meta]');

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const showError = (msg: string) => {
		if (errorLine) {
			errorLine.textContent = msg;
			errorLine.hidden = false;
		}
		setStatus('Conversion error.');
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const convert = () => {
		clearError();
		const amount = Number(amountInput?.value);
		const fromUnitId = (fromSelect?.value as CookingUnit) || 'cup';
		const toUnitId = (toSelect?.value as CookingUnit) || 'g';
		const ingredientId = ingredientSelect?.value || 'flour_ap';

		if (!Number.isFinite(amount) || amount < 0) {
			showError('Please enter a valid non-negative number.');
			return;
		}

		const res = convertCookingValue(amount, fromUnitId, toUnitId, ingredientId);
		if (!res) {
			showError('Could not process conversion.');
			return;
		}

		if (resultsBlock) resultsBlock.hidden = false;
		if (outputVal) {
			outputVal.textContent = `${res.formattedValue} ${res.toUnit.name}`;
		}
		if (outputMeta) {
			if (res.requiresDensity) {
				outputMeta.textContent = `Cross-category conversion (volume ↔ weight) using density for ${res.ingredientName} (${res.densityUsed} g/ml).`;
			} else {
				outputMeta.textContent = `Direct ${res.fromUnit.category} conversion.`;
			}
		}

		setStatus(`Converted ${amount} ${res.fromUnit.name} to ${res.formattedValue} ${res.toUnit.name}.`);
	};

	const swap = () => {
		if (fromSelect && toSelect) {
			const temp = fromSelect.value;
			fromSelect.value = toSelect.value;
			toSelect.value = temp;
			convert();
		}
	};

	const reset = () => {
		if (amountInput) amountInput.value = '1';
		if (fromSelect) fromSelect.value = 'cup';
		if (toSelect) toSelect.value = 'g';
		if (ingredientSelect) ingredientSelect.value = 'flour_ap';
		if (resultsBlock) resultsBlock.hidden = true;
		clearError();
		convert();
	};

	amountInput?.addEventListener('input', convert, { signal });
	fromSelect?.addEventListener('change', convert, { signal });
	toSelect?.addEventListener('change', convert, { signal });
	ingredientSelect?.addEventListener('change', convert, { signal });
	swapBtn?.addEventListener('click', swap, { signal });
	resetBtn?.addEventListener('click', reset, { signal });

	teardown = () => {
		controller.abort();
		reset();
	};

	reset();
}

export function destroyCookingConverter(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
