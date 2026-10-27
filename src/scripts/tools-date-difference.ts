/**
 * BNJI.NET — /projects/tools/ date difference & date addition/subtraction calculator.
 *
 * Runs completely locally in the tab with no external API calls or network requests.
 */

import { DATE_CALC_CONFIG, type DateAddUnit } from '../config/tools.config';

export interface DateDiffResult {
	years: number;
	months: number;
	days: number;
	totalDays: number;
	totalHours: number;
	totalMinutes: number;
	businessDays: number;
	isNegative: boolean;
}

export interface DateAddResult {
	resultDate: Date;
	dateString: string;
	formatted: string;
}

/* ------------------------------------------------------------------------- *
 * Pure Logic Helpers
 * ------------------------------------------------------------------------- */

/**
 * Parses YYYY-MM-DD or YYYY-MM-DDTHH:mm into a local Date object.
 */
export function parseDateInput(value: string): Date | null {
	if (!value || typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;

	// Handle YYYY-MM-DD format explicitly to construct local midnight Date
	const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
	if (isoMatch) {
		const year = parseInt(isoMatch[1], 10);
		const month = parseInt(isoMatch[2], 10) - 1;
		const day = parseInt(isoMatch[3], 10);
		const d = new Date(year, month, day);
		if (Number.isNaN(d.getTime())) return null;
		return d;
	}

	const d = new Date(trimmed);
	if (Number.isNaN(d.getTime())) return null;
	return d;
}

/**
 * Formats a Date object as YYYY-MM-DD.
 */
export function formatDateIso(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Formats a Date object into a readable string (e.g. "Monday, October 14, 2024").
 */
export function formatDateHuman(date: Date): string {
	return date.toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
}

/**
 * Calculates the calendar difference (Years, Months, Days) and total units
 * between two dates.
 */
export function calculateDateDifference(
	startDateStr: string,
	endDateStr: string,
	includeEndDay = false,
): DateDiffResult | null {
	const start = parseDateInput(startDateStr);
	const end = parseDateInput(endDateStr);

	if (!start || !end) return null;

	let d1 = new Date(start);
	let d2 = new Date(end);

	const isNegative = d2.getTime() < d1.getTime();
	if (isNegative) {
		const temp = d1;
		d1 = d2;
		d2 = temp;
	}

	// Calendar-day totals, not elapsed milliseconds: a midnight-to-midnight
	// interval crossing a DST change is 23 or 25 hours in local time, so
	// flooring the millisecond diff undercounts it by a day in spring
	// (2024-01-01 to 2025-03-15 gave 438 instead of 439 in America/Toronto,
	// while passing in UTC). Compare calendar dates via UTC midnights.
	const utcDay = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
	let totalDays = Math.round((utcDay(d2) - utcDay(d1)) / (1000 * 60 * 60 * 24));
	if (includeEndDay) {
		totalDays += 1;
	}
	const totalHours = totalDays * 24;
	const totalMinutes = totalHours * 60;

	// Business days count (Monday=1 .. Friday=5)
	let businessDays = 0;
	const cur = new Date(d1);
	const endLimit = new Date(d2);
	if (includeEndDay) {
		endLimit.setDate(endLimit.getDate() + 1);
	}

	// Protect against massive loops
	const maxDays = DATE_CALC_CONFIG.maxYearSpan * 366;
	let dayCount = 0;
	while (cur < endLimit && dayCount < maxDays) {
		const dayOfWeek = cur.getDay();
		if (dayOfWeek !== 0 && dayOfWeek !== 6) {
			businessDays++;
		}
		cur.setDate(cur.getDate() + 1);
		dayCount++;
	}

	// Calendar Y/M/D breakdown
	let years = d2.getFullYear() - d1.getFullYear();
	let months = d2.getMonth() - d1.getMonth();
	let days = d2.getDate() - d1.getDate();

	if (includeEndDay) {
		days += 1;
	}

	if (days < 0) {
		months -= 1;
		// Days in previous month of d2
		const prevMonth = new Date(d2.getFullYear(), d2.getMonth(), 0);
		days += prevMonth.getDate();
	}

	if (months < 0) {
		years -= 1;
		months += 12;
	}

	return {
		years,
		months,
		days,
		totalDays,
		totalHours,
		totalMinutes,
		businessDays,
		isNegative,
	};
}

/**
 * Adds or subtracts an amount of days/weeks/months/years from a date.
 */
export function addOrSubtractDate(
	startDateStr: string,
	amount: number,
	unit: DateAddUnit,
	operation: 'add' | 'subtract' = 'add',
): DateAddResult | null {
	const start = parseDateInput(startDateStr);
	if (!start || !Number.isFinite(amount)) return null;

	const mult = operation === 'subtract' ? -1 : 1;
	const delta = Math.round(amount) * mult;

	const res = new Date(start);

	if (unit === 'days') {
		res.setDate(res.getDate() + delta);
	} else if (unit === 'weeks') {
		res.setDate(res.getDate() + delta * 7);
	} else if (unit === 'months') {
		const targetMonth = res.getMonth() + delta;
		res.setMonth(targetMonth);
	} else if (unit === 'years') {
		res.setFullYear(res.getFullYear() + delta);
	}

	return {
		resultDate: res,
		dateString: formatDateIso(res),
		formatted: formatDateHuman(res),
	};
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initDateDifferenceCalculator(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-date-calculator]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	// Mode selector / tabs
	const modeSelect = root.querySelector('[data-date-mode]') as
		| (HTMLElement & { value: string })
		| null;

	// Diff inputs
	const diffSection = root.querySelector<HTMLElement>('[data-date-diff-section]');
	const startInput = root.querySelector<HTMLInputElement>('[data-date-start]');
	const endInput = root.querySelector<HTMLInputElement>('[data-date-end]');
	const includeEndCheck = root.querySelector<HTMLInputElement>('[data-date-include-end]');

	// Add/Subtract inputs
	const addSection = root.querySelector<HTMLElement>('[data-date-add-section]');
	const baseInput = root.querySelector<HTMLInputElement>('[data-date-base]');
	const opSelect = root.querySelector('[data-date-op]') as
		| (HTMLElement & { value: string })
		| null;
	const amountInput = root.querySelector<HTMLInputElement>('[data-date-amount]');
	const unitSelect = root.querySelector('[data-date-unit]') as
		| (HTMLElement & { value: string })
		| null;

	// Buttons
	const todayStartBtn = root.querySelector<HTMLButtonElement>('[data-date-today-start]');
	const todayEndBtn = root.querySelector<HTMLButtonElement>('[data-date-today-end]');
	const todayBaseBtn = root.querySelector<HTMLButtonElement>('[data-date-today-base]');
	const calculateBtn = root.querySelector<HTMLButtonElement>('[data-date-calculate]');
	const resetBtn = root.querySelector<HTMLButtonElement>('[data-date-reset]');

	// Feedback & Results
	const statusLine = root.querySelector<HTMLElement>('[data-date-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-date-error]');
	const resultsBlock = root.querySelector<HTMLElement>('[data-date-results]');

	// Output elements
	const ymdOutput = root.querySelector<HTMLElement>('[data-date-output-ymd]');
	const totalsOutput = root.querySelector<HTMLElement>('[data-date-output-totals]');
	const addOutput = root.querySelector<HTMLElement>('[data-date-output-add]');

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const showError = (msg: string) => {
		if (errorLine) {
			errorLine.textContent = msg;
			errorLine.hidden = false;
		}
		setStatus('Calculation failed.');
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const updateModeUI = () => {
		const mode = modeSelect?.value ?? 'diff';
		if (diffSection) diffSection.hidden = mode !== 'diff';
		if (addSection) addSection.hidden = mode !== 'add_subtract';
		clearError();
		if (resultsBlock) resultsBlock.hidden = true;
		setStatus('Enter dates to compute duration or target date.');
	};

	const calculate = () => {
		clearError();
		const mode = modeSelect?.value ?? 'diff';

		if (mode === 'diff') {
			const startVal = startInput?.value || '';
			const endVal = endInput?.value || '';
			const includeEnd = lockCheckState(includeEndCheck);

			if (!startVal || !endVal) {
				showError('Please select both a start date and an end date.');
				return;
			}

			const diff = calculateDateDifference(startVal, endVal, includeEnd);
			if (!diff) {
				showError('Invalid date inputs provided.');
				return;
			}

			if (resultsBlock) resultsBlock.hidden = false;
			if (addOutput) addOutput.hidden = true;
			if (ymdOutput) ymdOutput.hidden = false;
			if (totalsOutput) totalsOutput.hidden = false;

			const prefix = diff.isNegative ? 'End date is before start date: ' : '';
			if (ymdOutput) {
				ymdOutput.textContent = `${prefix}${diff.years} year(s), ${diff.months} month(s), ${diff.days} day(s)`;
			}
			if (totalsOutput) {
				totalsOutput.textContent = `Total Days: ${diff.totalDays.toLocaleString()} (${diff.businessDays.toLocaleString()} business days) · ${diff.totalHours.toLocaleString()} hours · ${diff.totalMinutes.toLocaleString()} minutes`;
			}

			setStatus('Difference computed successfully.');
		} else {
			const baseVal = baseInput?.value || '';
			const amountVal = Number(amountInput?.value);
			const op = (opSelect?.value as 'add' | 'subtract') || 'add';
			const unit = (unitSelect?.value as DateAddUnit) || 'days';

			if (!baseVal) {
				showError('Please select a base date.');
				return;
			}
			if (!Number.isFinite(amountVal)) {
				showError('Please enter a valid amount.');
				return;
			}

			const addRes = addOrSubtractDate(baseVal, amountVal, unit, op);
			if (!addRes) {
				showError('Invalid calculation parameters.');
				return;
			}

			if (resultsBlock) resultsBlock.hidden = false;
			if (ymdOutput) ymdOutput.hidden = true;
			if (totalsOutput) totalsOutput.hidden = true;
			if (addOutput) {
				addOutput.hidden = false;
				addOutput.textContent = `Resulting Date: ${addRes.dateString} (${addRes.formatted})`;
			}

			setStatus('Date calculation complete.');
		}
	};

	const reset = () => {
		const todayIso = formatDateIso(new Date());
		if (startInput) startInput.value = todayIso;
		if (endInput) endInput.value = todayIso;
		if (baseInput) baseInput.value = todayIso;
		if (amountInput) amountInput.value = '7';
		if (includeEndCheck) includeEndCheck.checked = false;
		if (modeSelect) modeSelect.value = 'diff';
		if (opSelect) opSelect.value = 'add';
		if (unitSelect) unitSelect.value = 'days';

		if (resultsBlock) resultsBlock.hidden = true;
		clearError();
		updateModeUI();
	};

	const setToday = (input: HTMLInputElement | null) => {
		if (input) {
			input.value = formatDateIso(new Date());
			calculate();
		}
	};

	// Event listeners
	modeSelect?.addEventListener('change', updateModeUI, { signal });
	startInput?.addEventListener('input', calculate, { signal });
	endInput?.addEventListener('input', calculate, { signal });
	includeEndCheck?.addEventListener('change', calculate, { signal });

	baseInput?.addEventListener('input', calculate, { signal });
	opSelect?.addEventListener('change', calculate, { signal });
	amountInput?.addEventListener('input', calculate, { signal });
	unitSelect?.addEventListener('change', calculate, { signal });

	calculateBtn?.addEventListener('click', calculate, { signal });
	resetBtn?.addEventListener('click', reset, { signal });

	todayStartBtn?.addEventListener('click', () => setToday(startInput), { signal });
	todayEndBtn?.addEventListener('click', () => setToday(endInput), { signal });
	todayBaseBtn?.addEventListener('click', () => setToday(baseInput), { signal });

	teardown = () => {
		controller.abort();
		reset();
	};

	// Set defaults
	reset();
}

function lockCheckState(el: HTMLInputElement | null): boolean {
	return el ? el.checked : false;
}

export function destroyDateDifferenceCalculator(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
