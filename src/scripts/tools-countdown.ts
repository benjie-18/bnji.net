/**
 * BNJI.NET — /projects/tools/ Countdown & Stopwatch.
 *
 * Runs locally using high-resolution performance.now() timestamps.
 */
import { TOOL_COUNTDOWN_CONFIG } from '../config/tools.config';

export type FormattedTime = {
	hours: string;
	minutes: string;
	seconds: string;
	milliseconds: string;
	full: string;
};

/**
 * Format milliseconds into structured HH:MM:SS.ms strings.
 */
export function formatTimeMs(ms: number): FormattedTime {
	const safeMs = Math.max(0, Math.floor(ms));
	const hoursNum = Math.floor(safeMs / (1000 * 60 * 60));
	const minutesNum = Math.floor((safeMs % (1000 * 60 * 60)) / (1000 * 60));
	const secondsNum = Math.floor((safeMs % (1000 * 60)) / 1000);
	const msNum = Math.floor((safeMs % 1000) / 10); // 2 digits ms

	const pad = (n: number) => String(n).padStart(2, '0');
	const hours = pad(hoursNum);
	const minutes = pad(minutesNum);
	const seconds = pad(secondsNum);
	const milliseconds = pad(msNum);

	const full = hoursNum > 0
		? `${hours}:${minutes}:${seconds}.${milliseconds}`
		: `${minutes}:${seconds}.${milliseconds}`;

	return {
		hours,
		minutes,
		seconds,
		milliseconds,
		full,
	};
}

/**
 * Convert user hours, minutes, seconds inputs into total milliseconds.
 */
export function parseTimeInput(hours: number, minutes: number, seconds: number): number {
	const h = Math.min(TOOL_COUNTDOWN_CONFIG.maxHours, Math.max(0, Math.floor(hours || 0)));
	const m = Math.min(TOOL_COUNTDOWN_CONFIG.maxMinutes, Math.max(0, Math.floor(minutes || 0)));
	const s = Math.min(TOOL_COUNTDOWN_CONFIG.maxSeconds, Math.max(0, Math.floor(seconds || 0)));

	return (h * 3600 + m * 60 + s) * 1000;
}

export type LapResult = {
	lapNumber: number;
	lapTimeMs: number;
	totalTimeMs: number;
	formattedLap: string;
	formattedTotal: string;
};

/**
 * Calculate lap time split.
 */
export function calculateStopwatchLap(
	currentMs: number,
	lastLapMs: number,
	lapIndex: number,
): LapResult {
	const lapTimeMs = Math.max(0, currentMs - lastLapMs);
	return {
		lapNumber: lapIndex + 1,
		lapTimeMs,
		totalTimeMs: currentMs,
		formattedLap: formatTimeMs(lapTimeMs).full,
		formattedTotal: formatTimeMs(currentMs).full,
	};
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initCountdownStopwatch(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-countdown-stopwatch]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const modeSelect = root.querySelector('[data-timer-mode]') as (HTMLElement & { value: string }) | null;
	const stopwatchSection = root.querySelector<HTMLElement>('[data-stopwatch-section]');
	const countdownSection = root.querySelector<HTMLElement>('[data-countdown-section]');

	// Stopwatch DOM
	const stopwatchDisplay = root.querySelector<HTMLElement>('[data-stopwatch-display]');
	const swStartBtn = root.querySelector<HTMLButtonElement>('[data-stopwatch-start]');
	const swPauseBtn = root.querySelector<HTMLButtonElement>('[data-stopwatch-pause]');
	const swLapBtn = root.querySelector<HTMLButtonElement>('[data-stopwatch-lap]');
	const swResetBtn = root.querySelector<HTMLButtonElement>('[data-stopwatch-reset]');
	const lapList = root.querySelector<HTMLElement>('[data-stopwatch-laps]');

	// Countdown DOM
	const hoursInput = root.querySelector<HTMLInputElement>('[data-countdown-hours]');
	const minsInput = root.querySelector<HTMLInputElement>('[data-countdown-mins]');
	const secsInput = root.querySelector<HTMLInputElement>('[data-countdown-secs]');
	const countdownDisplay = root.querySelector<HTMLElement>('[data-countdown-display]');
	const cdStartBtn = root.querySelector<HTMLButtonElement>('[data-countdown-start]');
	const cdPauseBtn = root.querySelector<HTMLButtonElement>('[data-countdown-pause]');
	const cdResetBtn = root.querySelector<HTMLButtonElement>('[data-countdown-reset]');
	const presetBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-countdown-preset]'));

	const statusLine = root.querySelector<HTMLElement>('[data-timer-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-timer-error]');

	/* State */
	let swRunning = false;
	let swStartTime = 0;
	let swElapsed = 0;
	let swLastLapTime = 0;
	let swLaps: LapResult[] = [];
	let swAnimFrame: number | null = null;

	let cdRunning = false;
	let cdTotalMs = 0;
	let cdRemainingMs = 0;
	let cdEndTime = 0;
	let cdAnimFrame: number | null = null;

	const setStatus = (msg: string) => {
		if (statusLine) statusLine.textContent = msg;
	};

	const showError = (msg: string) => {
		if (errorLine) {
			errorLine.textContent = msg;
			errorLine.hidden = false;
		}
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const updateStopwatchUI = () => {
		const formatted = formatTimeMs(swElapsed);
		if (stopwatchDisplay) {
			stopwatchDisplay.textContent = formatted.full;
		}
	};

	const renderLaps = () => {
		if (!lapList) return;
		if (swLaps.length === 0) {
			lapList.innerHTML = '';
			return;
		}
		lapList.innerHTML = swLaps
			.map(
				(l) =>
					`<div class="tool__lap-row mono"><span>Lap ${l.lapNumber}</span><span>${l.formattedLap}</span><span>(${l.formattedTotal})</span></div>`,
			)
			.join('');
	};

	const tickStopwatch = () => {
		if (!swRunning) return;
		swElapsed = performance.now() - swStartTime;
		updateStopwatchUI();
		swAnimFrame = requestAnimationFrame(tickStopwatch);
	};

	const startStopwatch = () => {
		if (swRunning) return;
		clearError();
		swRunning = true;
		swStartTime = performance.now() - swElapsed;
		if (swStartBtn) swStartBtn.disabled = true;
		if (swPauseBtn) swPauseBtn.disabled = false;
		if (swLapBtn) swLapBtn.disabled = false;
		setStatus('Stopwatch running…');
		tickStopwatch();
	};

	const pauseStopwatch = () => {
		if (!swRunning) return;
		swRunning = false;
		if (swAnimFrame !== null) cancelAnimationFrame(swAnimFrame);
		if (swStartBtn) swStartBtn.disabled = false;
		if (swPauseBtn) swPauseBtn.disabled = true;
		if (swLapBtn) swLapBtn.disabled = true;
		setStatus('Stopwatch paused.');
	};

	const lapStopwatch = () => {
		if (!swRunning) return;
		if (swLaps.length >= TOOL_COUNTDOWN_CONFIG.maxLaps) return;
		const lap = calculateStopwatchLap(swElapsed, swLastLapTime, swLaps.length);
		swLastLapTime = swElapsed;
		swLaps.unshift(lap);
		renderLaps();
		setStatus(`Recorded Lap ${lap.lapNumber}: ${lap.formattedLap}`);
	};

	const resetStopwatch = () => {
		pauseStopwatch();
		swElapsed = 0;
		swLastLapTime = 0;
		swLaps = [];
		updateStopwatchUI();
		renderLaps();
		if (swStartBtn) swStartBtn.disabled = false;
		if (swPauseBtn) swPauseBtn.disabled = true;
		if (swLapBtn) swLapBtn.disabled = true;
		setStatus('Stopwatch reset.');
	};

	/* Countdown logic */

	const updateCountdownUI = () => {
		const formatted = formatTimeMs(cdRemainingMs);
		if (countdownDisplay) {
			countdownDisplay.textContent = formatted.full;
		}
	};

	const tickCountdown = () => {
		if (!cdRunning) return;
		const now = performance.now();
		cdRemainingMs = Math.max(0, cdEndTime - now);
		updateCountdownUI();

		if (cdRemainingMs <= 0) {
			cdRunning = false;
			if (cdStartBtn) cdStartBtn.disabled = false;
			if (cdPauseBtn) cdPauseBtn.disabled = true;
			setStatus('Countdown finished!');
			if (countdownDisplay) countdownDisplay.classList.add('tool__timer--alert');
			return;
		}

		cdAnimFrame = requestAnimationFrame(tickCountdown);
	};

	const startCountdown = () => {
		if (cdRunning) return;
		clearError();

		if (cdRemainingMs <= 0) {
			const h = Number(hoursInput?.value || 0);
			const m = Number(minsInput?.value || 0);
			const s = Number(secsInput?.value || 0);
			cdTotalMs = parseTimeInput(h, m, s);
			cdRemainingMs = cdTotalMs;
		}

		if (cdRemainingMs <= 0) {
			showError('Please set a duration greater than 0 seconds.');
			return;
		}

		if (countdownDisplay) countdownDisplay.classList.remove('tool__timer--alert');
		cdRunning = true;
		cdEndTime = performance.now() + cdRemainingMs;
		if (cdStartBtn) cdStartBtn.disabled = true;
		if (cdPauseBtn) cdPauseBtn.disabled = false;
		setStatus('Countdown active…');
		tickCountdown();
	};

	const pauseCountdown = () => {
		if (!cdRunning) return;
		cdRunning = false;
		if (cdAnimFrame !== null) cancelAnimationFrame(cdAnimFrame);
		if (cdStartBtn) cdStartBtn.disabled = false;
		if (cdPauseBtn) cdPauseBtn.disabled = true;
		setStatus('Countdown paused.');
	};

	const resetCountdown = () => {
		pauseCountdown();
		cdRemainingMs = 0;
		cdTotalMs = 0;
		if (hoursInput) hoursInput.value = '0';
		if (minsInput) minsInput.value = '5';
		if (secsInput) secsInput.value = '0';
		if (countdownDisplay) countdownDisplay.classList.remove('tool__timer--alert');
		updateCountdownUI();
		setStatus('Countdown reset.');
	};

	const applyPreset = (seconds: number) => {
		pauseCountdown();
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		if (hoursInput) hoursInput.value = String(h);
		if (minsInput) minsInput.value = String(m);
		if (secsInput) secsInput.value = String(s);
		cdRemainingMs = seconds * 1000;
		cdTotalMs = cdRemainingMs;
		updateCountdownUI();
		setStatus(`Preset set to ${m}m ${s}s.`);
	};

	const syncMode = () => {
		const mode = modeSelect?.value || 'stopwatch';
		if (stopwatchSection) stopwatchSection.hidden = mode !== 'stopwatch';
		if (countdownSection) countdownSection.hidden = mode !== 'countdown';
		clearError();
	};

	modeSelect?.addEventListener('change', syncMode, { signal });

	swStartBtn?.addEventListener('click', startStopwatch, { signal });
	swPauseBtn?.addEventListener('click', pauseStopwatch, { signal });
	swLapBtn?.addEventListener('click', lapStopwatch, { signal });
	swResetBtn?.addEventListener('click', resetStopwatch, { signal });

	cdStartBtn?.addEventListener('click', startCountdown, { signal });
	cdPauseBtn?.addEventListener('click', pauseCountdown, { signal });
	cdResetBtn?.addEventListener('click', resetCountdown, { signal });

	presetBtns.forEach((btn) => {
		btn.addEventListener('click', () => {
			const sec = Number(btn.dataset.countdownPreset || 0);
			if (sec > 0) applyPreset(sec);
		}, { signal });
	});

	teardown = () => {
		if (swAnimFrame !== null) cancelAnimationFrame(swAnimFrame);
		if (cdAnimFrame !== null) cancelAnimationFrame(cdAnimFrame);
		controller.abort();
	};

	syncMode();
	updateStopwatchUI();
	updateCountdownUI();
	setStatus('Ready.');
}

export function destroyCountdownStopwatch(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
