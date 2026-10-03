/**
 * BNJI.NET — /tools/ Unit Converter script.
 *
 * Runs locally in browser memory. Supports Length, Mass, Temperature,
 * Data Storage, Area, and Speed.
 */

import {
	UNIT_CATEGORIES,
	UNIT_DEFINITIONS,
	type UnitCategory,
	type UnitDefinition,
} from '../config/tools.config';

/** Pure conversion function for all supported unit categories. */
export function convertUnits(
	value: number,
	category: UnitCategory,
	fromUnitId: string,
	toUnitId: string,
): number | null {
	if (!Number.isFinite(value)) return null;

	if (category === 'temperature') {
		return convertTemperature(value, fromUnitId, toUnitId);
	}

	const defs = UNIT_DEFINITIONS[category];
	if (!defs) return null;

	const fromDef = defs.find((u) => u.id === fromUnitId);
	const toDef = defs.find((u) => u.id === toUnitId);

	if (!fromDef?.factorToBase || !toDef?.factorToBase) return null;

	const baseValue = value * fromDef.factorToBase;
	const result = baseValue / toDef.factorToBase;

	return cleanNumber(result);
}

function convertTemperature(val: number, from: string, to: string): number | null {
	// Convert from -> Celsius
	let celsius = val;
	if (from === 'f') celsius = ((val - 32) * 5) / 9;
	else if (from === 'k') celsius = val - 273.15;
	else if (from !== 'c') return null;

	// Convert Celsius -> to
	let result = celsius;
	if (to === 'f') result = (celsius * 9) / 5 + 32;
	else if (to === 'k') result = celsius + 273.15;
	else if (to !== 'c') return null;

	return cleanNumber(result);
}

/** Round float results to avoid IEEE-754 precision artifacts like 0.0000000000000001. */
function cleanNumber(num: number): number {
	if (!Number.isFinite(num)) return 0;
	return Number(Math.round(Number(`${num}e8`)) + 'e-8');
}

/** Generate a human-readable formula explanation. */
export function formatConversionFormula(
	value: number,
	category: UnitCategory,
	fromUnitId: string,
	toUnitId: string,
	result: number,
): string {
	const defs = UNIT_DEFINITIONS[category];
	const fromDef = defs?.find((u) => u.id === fromUnitId);
	const toDef = defs?.find((u) => u.id === toUnitId);

	const fromSymbol = fromDef?.symbol || fromUnitId;
	const toSymbol = toDef?.symbol || toUnitId;

	if (category === 'temperature') {
		if (fromUnitId === 'c' && toUnitId === 'f') return `${value}°C × (9/5) + 32 = ${result}°F`;
		if (fromUnitId === 'f' && toUnitId === 'c') return `(${value}°F - 32) × (5/9) = ${result}°C`;
		if (fromUnitId === 'c' && toUnitId === 'k') return `${value}°C + 273.15 = ${result}K`;
		if (fromUnitId === 'k' && toUnitId === 'c') return `${value}K - 273.15 = ${result}°C`;
		if (fromUnitId === 'f' && toUnitId === 'k') return `(${value}°F - 32) × (5/9) + 273.15 = ${result}K`;
		if (fromUnitId === 'k' && toUnitId === 'f') return `(${value}K - 273.15) × (9/5) + 32 = ${result}°F`;
		return `${value} ${fromSymbol} = ${result} ${toSymbol}`;
	}

	if (fromDef?.factorToBase && toDef?.factorToBase) {
		const ratio = fromDef.factorToBase / toDef.factorToBase;
		return `${value} ${fromSymbol} × ${cleanNumber(ratio)} = ${result} ${toSymbol}`;
	}

	return `${value} ${fromSymbol} = ${result} ${toSymbol}`;
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initUnitConverter(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-unit-converter]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const categorySelect = root.querySelector('[data-unit-category]') as (HTMLElement & { value: string }) | null;
	const fromSelect = root.querySelector('[data-unit-from-type]') as (HTMLElement & { value: string; innerHTML: string }) | null;
	const toSelect = root.querySelector('[data-unit-to-type]') as (HTMLElement & { value: string; innerHTML: string }) | null;
	const fromInput = root.querySelector<HTMLInputElement>('[data-unit-from-value]');
	const toInput = root.querySelector<HTMLInputElement>('[data-unit-to-value]');
	const swapButton = root.querySelector<HTMLButtonElement>('[data-unit-swap]');
	const resetButton = root.querySelector<HTMLButtonElement>('[data-unit-reset]');
	const formulaLine = root.querySelector<HTMLElement>('[data-unit-formula]');
	const statusLine = root.querySelector<HTMLElement>('[data-unit-status]');

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const currentCategory = (): UnitCategory => {
		const val = (categorySelect?.value || 'length') as UnitCategory;
		return UNIT_DEFINITIONS[val] ? val : 'length';
	};

	const populateUnits = () => {
		const cat = currentCategory();
		const defs = UNIT_DEFINITIONS[cat] || [];

		if (fromSelect) {
			fromSelect.innerHTML = defs
				.map((d) => `<option value="${d.id}">${d.label} (${d.symbol})</option>`)
				.join('');
			if (defs.length > 0) fromSelect.value = defs[0].id;
		}

		if (toSelect) {
			toSelect.innerHTML = defs
				.map((d) => `<option value="${d.id}">${d.label} (${d.symbol})</option>`)
				.join('');
			if (defs.length > 1) toSelect.value = defs[1].id;
			else if (defs.length > 0) toSelect.value = defs[0].id;
		}
	};

	const recalculate = (source: 'from' | 'to' = 'from') => {
		const cat = currentCategory();
		const fromUnit = fromSelect?.value || '';
		const toUnit = toSelect?.value || '';

		if (!fromUnit || !toUnit) return;

		if (source === 'from') {
			const val = Number(fromInput?.value);
			if (!Number.isFinite(val) || fromInput?.value === '') {
				if (toInput) toInput.value = '';
				if (formulaLine) formulaLine.textContent = '';
				setStatus('Enter a value to convert.');
				return;
			}

			const res = convertUnits(val, cat, fromUnit, toUnit);
			if (res !== null && toInput) {
				toInput.value = String(res);
				if (formulaLine) {
					formulaLine.textContent = formatConversionFormula(val, cat, fromUnit, toUnit, res);
				}
				setStatus(`Converted ${val} ${fromUnit} to ${res} ${toUnit}.`);
			}
		} else {
			const val = Number(toInput?.value);
			if (!Number.isFinite(val) || toInput?.value === '') {
				if (fromInput) fromInput.value = '';
				if (formulaLine) formulaLine.textContent = '';
				setStatus('Enter a value to convert.');
				return;
			}

			const res = convertUnits(val, cat, toUnit, fromUnit);
			if (res !== null && fromInput) {
				fromInput.value = String(res);
				if (formulaLine) {
					formulaLine.textContent = formatConversionFormula(res, cat, fromUnit, toUnit, val);
				}
				setStatus(`Converted ${val} ${toUnit} to ${res} ${fromUnit}.`);
			}
		}
	};

	const swap = () => {
		if (!fromSelect || !toSelect) return;
		const temp = fromSelect.value;
		fromSelect.value = toSelect.value;
		toSelect.value = temp;
		recalculate('from');
	};

	const reset = () => {
		if (categorySelect) categorySelect.value = 'length';
		populateUnits();
		if (fromInput) fromInput.value = '1';
		recalculate('from');
	};

	categorySelect?.addEventListener('change', () => {
		populateUnits();
		recalculate('from');
	}, { signal });

	fromSelect?.addEventListener('change', () => recalculate('from'), { signal });
	toSelect?.addEventListener('change', () => recalculate('from'), { signal });

	fromInput?.addEventListener('input', () => recalculate('from'), { signal });
	toInput?.addEventListener('input', () => recalculate('to'), { signal });

	swapButton?.addEventListener('click', swap, { signal });
	resetButton?.addEventListener('click', reset, { signal });

	teardown = () => {
		controller.abort();
	};

	populateUnits();
	if (fromInput && !fromInput.value) fromInput.value = '1';
	recalculate('from');
}

export function destroyUnitConverter(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
