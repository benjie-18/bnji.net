/**
 * BNJI.NET — /tools/ Time Zone Converter.
 *
 * Runs locally in the tab using standard Intl.DateTimeFormat primitives.
 * No external API call is made.
 */
import { COMMON_TIMEZONES } from '../config/tools.config';

export type ZoneConversionResult =
	| {
			ok: true;
			formattedSource: string;
			formattedTarget: string;
			timeDiffLabel: string;
			sourceOffset: string;
			targetOffset: string;
	  }
	| {
			ok: false;
			error: string;
	  };

/**
 * Format a Date object for a specific time zone into a readable localized string.
 */
export function formatInZone(date: Date, zone: string): string {
	try {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			weekday: 'short',
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
			timeZoneName: 'short',
		});
		return formatter.format(date);
	} catch {
		return 'Invalid time zone';
	}
}

/**
 * Get UTC offset string like "UTC+02:00" or "UTC-05:00" for a date in a zone.
 */
export function formatTimeZoneOffset(date: Date, zone: string): string {
	try {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			timeZoneName: 'longOffset',
		});
		const parts = formatter.formatToParts(date);
		const offsetPart = parts.find((p) => p.type === 'timeZoneName');
		if (offsetPart && offsetPart.value) {
			return offsetPart.value.replace('GMT', 'UTC');
		}
		return 'UTC';
	} catch {
		return 'UTC';
	}
}

/**
 * Calculate time difference in hours between source and target zones for a given date.
 */
export function calculateZoneDifference(date: Date, sourceZone: string, targetZone: string): string {
	try {
		const getZoneOffsetMinutes = (d: Date, z: string) => {
			const str = d.toLocaleString('en-US', { timeZone: z });
			const targetDate = new Date(str);
			const utcDate = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
			return Math.round((targetDate.getTime() - utcDate.getTime()) / 60000);
		};

		const sourceMinutes = getZoneOffsetMinutes(date, sourceZone);
		const targetMinutes = getZoneOffsetMinutes(date, targetZone);
		const diffMinutes = targetMinutes - sourceMinutes;

		if (diffMinutes === 0) return 'Same time';
		const diffHours = diffMinutes / 60;
		const sign = diffHours > 0 ? '+' : '';
		return `${sign}${diffHours % 1 === 0 ? diffHours : diffHours.toFixed(1)} hrs relative to source`;
	} catch {
		return 'Difference unavailable';
	}
}

/**
 * Convert a datetime input string (e.g. "2026-03-31T14:30") interpreted in sourceZone to targetZone.
 */
export function convertTimeZone(
	datetimeLocalStr: string,
	sourceZone: string,
	targetZone: string,
): ZoneConversionResult {
	if (!datetimeLocalStr) {
		return { ok: false, error: 'Please enter or select a date and time.' };
	}

	const dateObj = new Date(datetimeLocalStr);
	if (isNaN(dateObj.getTime())) {
		return { ok: false, error: 'Invalid date or time entered.' };
	}

	const [datePart, timePart] = datetimeLocalStr.split('T');
	if (!datePart) return { ok: false, error: 'Invalid input format.' };
	const [year, month, day] = datePart.split('-').map(Number);
	const [hour, minute] = (timePart || '00:00').split(':').map(Number);

	if (
		!year ||
		!month ||
		!day ||
		isNaN(hour) ||
		isNaN(minute)
	) {
		return { ok: false, error: 'Invalid date format.' };
	}

	let utcMs: number;
	try {
		const dummyUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
		const formattedInSource = dummyUtc.toLocaleString('en-US', { timeZone: sourceZone });
		const sourceAsUtc = new Date(formattedInSource);
		const offsetMs = dummyUtc.getTime() - sourceAsUtc.getTime();
		utcMs = dummyUtc.getTime() + offsetMs;
	} catch {
		return { ok: false, error: 'Unsupported or invalid time zone specified.' };
	}

	const actualDate = new Date(utcMs);
	const formattedSource = formatInZone(actualDate, sourceZone);
	const formattedTarget = formatInZone(actualDate, targetZone);
	const sourceOffset = formatTimeZoneOffset(actualDate, sourceZone);
	const targetOffset = formatTimeZoneOffset(actualDate, targetZone);
	const timeDiffLabel = calculateZoneDifference(actualDate, sourceZone, targetZone);

	return {
		ok: true,
		formattedSource,
		formattedTarget,
		timeDiffLabel,
		sourceOffset,
		targetOffset,
	};
}

/* ------------------------------------------------------------------------- *
 * Controller
 * ------------------------------------------------------------------------- */

let started = false;
let teardown: (() => void) | null = null;

export function initTimeZoneConverter(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-timezone-converter]');
	if (!root) return;
	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const datetimeInput = root.querySelector<HTMLInputElement>('[data-timezone-input]');
	const sourceSelect = root.querySelector('[data-timezone-source]') as (HTMLElement & { value: string }) | null;
	const targetSelect = root.querySelector('[data-timezone-target]') as (HTMLElement & { value: string }) | null;
	const swapButton = root.querySelector<HTMLButtonElement>('[data-timezone-swap]');
	const nowButton = root.querySelector<HTMLButtonElement>('[data-timezone-now]');
	const copyButton = root.querySelector<HTMLButtonElement>('[data-timezone-copy]');
	const statusLine = root.querySelector<HTMLElement>('[data-timezone-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-timezone-error]');
	const results = root.querySelector<HTMLElement>('[data-timezone-results]');
	const targetOutput = root.querySelector<HTMLElement>('[data-timezone-target-output]');
	const diffOutput = root.querySelector<HTMLElement>('[data-timezone-diff-output]');

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

	const setNow = () => {
		if (!datetimeInput) return;
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const localStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
		datetimeInput.value = localStr;
	};

	const update = () => {
		clearError();
		const val = datetimeInput?.value || '';
		const src = sourceSelect?.value || 'UTC';
		const tgt = targetSelect?.value || 'America/New_York';

		const res = convertTimeZone(val, src, tgt);
		if (!res.ok) {
			showError(res.error);
			return;
		}

		if (targetOutput) {
			targetOutput.textContent = `${res.formattedTarget} (${res.targetOffset})`;
		}
		if (diffOutput) {
			diffOutput.textContent = `${res.timeDiffLabel} (Source: ${res.sourceOffset})`;
		}
		if (results) results.hidden = false;
		if (copyButton) copyButton.disabled = false;
		setStatus(`Converted from ${src} to ${tgt}.`);
	};

	const copyResult = () => {
		if (!targetOutput?.textContent) return;
		navigator.clipboard.writeText(targetOutput.textContent)
			.then(() => setStatus('Copied converted time to clipboard!'))
			.catch(() => setStatus('Failed to copy to clipboard.'));
	};

	const swap = () => {
		if (!sourceSelect || !targetSelect) return;
		const tmp = sourceSelect.value;
		sourceSelect.value = targetSelect.value;
		targetSelect.value = tmp;
		update();
	};

	datetimeInput?.addEventListener('input', update, { signal });
	sourceSelect?.addEventListener('change', update, { signal });
	targetSelect?.addEventListener('change', update, { signal });
	swapButton?.addEventListener('click', swap, { signal });
	nowButton?.addEventListener('click', () => {
		setNow();
		update();
	}, { signal });
	copyButton?.addEventListener('click', copyResult, { signal });

	teardown = () => {
		controller.abort();
	};

	setNow();
	update();
}

export function destroyTimeZoneConverter(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
