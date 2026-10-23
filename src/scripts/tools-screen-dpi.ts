/**
 * BNJI.NET — /projects/tools/ screen / DPI calculator.
 *
 * Calculates PPI/DPI, physical dimensions (inches & cm), aspect ratio, total megapixels
 * and dot pitch locally in browser.
 */

import { SCREEN_PRESETS, TOOL_SCREEN_CONFIG } from '../config/tools.config';

export interface ScreenSpecsResult {
	ppi: number;
	widthInches: number;
	heightInches: number;
	widthCm: number;
	heightCm: number;
	aspectRatioStr: string;
	totalPixels: number;
	megapixels: number;
	dotPitchMm: number;
}

/* ------------------------------------------------------------------------- *
 * Pure Logic Helpers
 * ------------------------------------------------------------------------- */

export function gcd(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x;
}

export function formatAspectRatio(width: number, height: number): string {
	if (width <= 0 || height <= 0) return '0:0';
	const divisor = gcd(width, height);
	const wRatio = width / divisor;
	const hRatio = height / divisor;

	// Check common standard aspect ratios to account for non-integer pixel scaling
	const decimal = width / height;
	if (Math.abs(decimal - 16 / 9) < 0.02) return '16:9';
	if (Math.abs(decimal - 16 / 10) < 0.02) return '16:10';
	if (Math.abs(decimal - 4 / 3) < 0.02) return '4:3';
	if (Math.abs(decimal - 21 / 9) < 0.02) return '21:9';
	if (Math.abs(decimal - 32 / 9) < 0.02) return '32:9';

	return `${wRatio}:${hRatio}`;
}

export function calculateScreenSpecs(
	widthPx: number,
	heightPx: number,
	diagonalInches: number,
): ScreenSpecsResult | null {
	if (
		!Number.isFinite(widthPx) ||
		!Number.isFinite(heightPx) ||
		!Number.isFinite(diagonalInches) ||
		widthPx <= 0 ||
		heightPx <= 0 ||
		diagonalInches <= 0
	) {
		return null;
	}

	if (
		widthPx > TOOL_SCREEN_CONFIG.maxPixelDimension ||
		heightPx > TOOL_SCREEN_CONFIG.maxPixelDimension ||
		diagonalInches > TOOL_SCREEN_CONFIG.maxDiagonalInches
	) {
		return null;
	}

	const diagonalPx = Math.sqrt(widthPx * widthPx + heightPx * heightPx);
	const ppi = diagonalPx / diagonalInches;

	const widthInches = widthPx / ppi;
	const heightInches = heightPx / ppi;

	const widthCm = widthInches * 2.54;
	const heightCm = heightInches * 2.54;

	const aspectRatioStr = formatAspectRatio(widthPx, heightPx);
	const totalPixels = widthPx * heightPx;
	const megapixels = totalPixels / 1_000_000;

	// Dot pitch in millimeters (1 inch = 25.4 mm)
	const dotPitchMm = 25.4 / ppi;

	return {
		ppi: Math.round(ppi * 10) / 10,
		widthInches: Math.round(widthInches * 100) / 100,
		heightInches: Math.round(heightInches * 100) / 100,
		widthCm: Math.round(widthCm * 100) / 100,
		heightCm: Math.round(heightCm * 100) / 100,
		aspectRatioStr,
		totalPixels,
		megapixels: Math.round(megapixels * 100) / 100,
		dotPitchMm: Math.round(dotPitchMm * 1000) / 1000,
	};
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initScreenDpiCalculator(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-screen-calculator]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const presetSelect = root.querySelector('[data-screen-preset]') as
		| (HTMLElement & { value: string })
		| null;
	const widthInput = root.querySelector<HTMLInputElement>('[data-screen-width]');
	const heightInput = root.querySelector<HTMLInputElement>('[data-screen-height]');
	const diagonalInput = root.querySelector<HTMLInputElement>('[data-screen-diagonal]');
	const resetBtn = root.querySelector<HTMLButtonElement>('[data-screen-reset]');

	const statusLine = root.querySelector<HTMLElement>('[data-screen-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-screen-error]');
	const resultsBlock = root.querySelector<HTMLElement>('[data-screen-results]');

	const ppiOutput = root.querySelector<HTMLElement>('[data-screen-output-ppi]');
	const dimsOutput = root.querySelector<HTMLElement>('[data-screen-output-dims]');
	const metaOutput = root.querySelector<HTMLElement>('[data-screen-output-meta]');

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const showError = (msg: string) => {
		if (errorLine) {
			errorLine.textContent = msg;
			errorLine.hidden = false;
		}
		setStatus('Calculation error.');
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const calculate = () => {
		clearError();
		const w = Number(widthInput?.value);
		const h = Number(heightInput?.value);
		const diag = Number(diagonalInput?.value);

		if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
			showError('Please enter valid positive pixel dimensions for resolution.');
			return;
		}
		if (!Number.isFinite(diag) || diag <= 0) {
			showError('Please enter a valid positive diagonal screen size in inches.');
			return;
		}

		const specs = calculateScreenSpecs(w, h, diag);
		if (!specs) {
			showError(
				`Inputs exceed maximum supported limits (${TOOL_SCREEN_CONFIG.maxPixelDimension}px or ${TOOL_SCREEN_CONFIG.maxDiagonalInches} inches).`,
			);
			return;
		}

		if (resultsBlock) resultsBlock.hidden = false;
		if (ppiOutput) {
			ppiOutput.textContent = `${specs.ppi} PPI / DPI`;
		}
		if (dimsOutput) {
			dimsOutput.textContent = `Physical Size: ${specs.widthInches}" × ${specs.heightInches}" (${specs.widthCm} cm × ${specs.heightCm} cm)`;
		}
		if (metaOutput) {
			metaOutput.textContent = `Aspect Ratio: ${specs.aspectRatioStr} · Total Pixels: ${specs.totalPixels.toLocaleString()} (${specs.megapixels} MP) · Dot Pitch: ${specs.dotPitchMm} mm`;
		}

		setStatus(`Calculated screen specs for ${w}×${h} on a ${diag}" display.`);
	};

	const applyPreset = () => {
		const presetIndex = Number(presetSelect?.value);
		if (Number.isInteger(presetIndex) && presetIndex >= 0 && presetIndex < SCREEN_PRESETS.length) {
			const p = SCREEN_PRESETS[presetIndex];
			if (widthInput) widthInput.value = String(p.width);
			if (heightInput) heightInput.value = String(p.height);
			if (diagonalInput) diagonalInput.value = String(p.diagonal);
			calculate();
		}
	};

	const reset = () => {
		if (presetSelect) presetSelect.value = '0';
		applyPreset();
	};

	presetSelect?.addEventListener('change', applyPreset, { signal });
	widthInput?.addEventListener('input', calculate, { signal });
	heightInput?.addEventListener('input', calculate, { signal });
	diagonalInput?.addEventListener('input', calculate, { signal });
	resetBtn?.addEventListener('click', reset, { signal });

	teardown = () => {
		controller.abort();
		if (resultsBlock) resultsBlock.hidden = true;
		clearError();
	};

	reset();
}

export function destroyScreenDpiCalculator(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
