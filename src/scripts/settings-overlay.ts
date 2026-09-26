/**
 * BNJI.NET — settings overlay controller.
 *
 * Binds the SettingsOverlay.astro markup to the settings store
 * (scripts/settings.ts). Two halves:
 *
 *   DIALOG — opened by every [data-settings-open] trigger (the header gear);
 *   closed by its close button, the backdrop, or Escape. While open: Tab
 *   cycles inside the panel only (focus trap), <html> gets a scroll-lock
 *   class, aria-expanded on the triggers tracks state, and focus is restored
 *   to the trigger that opened it on close.
 *
 *   BINDING — every [data-setting] control is two-way bound to its store
 *   field: input/change writes through setSetting() (which validates,
 *   persists and notifies), and a store subscription writes every field back
 *   into the controls + <output> readouts. The overlay is therefore always a
 *   faithful view of the ONE store — if anything else ever changes a setting,
 *   the open overlay reflects it, and no control here owns private state.
 *
 * Value mapping: booleans bind checkbox.checked; 'theme' binds the radio
 * pair by value; ranges bind percent-domain values (volume and starDensity
 * are 0..1 in the store, 0..100 on the input; uiScale is 80..130 in both).
 */
import { getSettings, setSetting, subscribeSettings, type Settings } from './settings';

let overlayStarted = false;

type RangeSpec = { scale: number; format: (v: number) => string };

const RANGES: Partial<Record<keyof Settings, RangeSpec>> = {
	volume: { scale: 1 / 100, format: (v) => `${Math.round(v * 100)}%` },
	starDensity: { scale: 1 / 100, format: (v) => `${Math.round(v * 100)}%` },
	uiScale: { scale: 1, format: (v) => `${Math.round(v)}%` },
};

export function initSettingsOverlay(): void {
	if (overlayStarted) return;
	overlayStarted = true;

	const overlay = document.querySelector<HTMLElement>('[data-settings-overlay]');
	const backdrop = document.querySelector<HTMLElement>('[data-settings-backdrop]');
	const close = document.querySelector<HTMLButtonElement>('[data-settings-close]');
	const openers = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-open]'));
	if (!overlay || !backdrop || openers.length === 0) return;

	const controls = Array.from(
		overlay.querySelectorAll<HTMLInputElement>('[data-setting]'),
	);
	const outputs = Array.from(
		overlay.querySelectorAll<HTMLElement>('[data-setting-output]'),
	);

	/* --- dialog ------------------------------------------------------------- */

	let lastFocused: HTMLElement | null = null;

	const isOpen = () => overlay.hidden === false;

	const setOpen = (open: boolean) => {
		if (open === isOpen()) return;
		if (open) lastFocused = document.activeElement as HTMLElement | null;
		overlay.hidden = !open;
		backdrop.hidden = !open;
		document.documentElement.classList.toggle('settings-is-open', open);
		for (const trigger of openers) trigger.setAttribute('aria-expanded', String(open));
		if (open) {
			// Focus the dialog itself: a screen reader announces it, and the
			// first Tab lands on the close button (first focusable inside).
			overlay.focus();
		} else if (lastFocused && document.contains(lastFocused)) {
			lastFocused.focus();
		}
		lastFocused = null;
	};

	for (const trigger of openers) {
		trigger.addEventListener('click', () => setOpen(!isOpen()));
	}
	close?.addEventListener('click', () => setOpen(false));
	backdrop.addEventListener('click', () => setOpen(false));

	overlay.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			setOpen(false);
			return;
		}
		if (event.key !== 'Tab') return;
		// Focus trap: cycle among the panel's focusable controls.
		const focusables = Array.from(
			overlay.querySelectorAll<HTMLElement>(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			),
		).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const active = document.activeElement;
		if (!overlay.contains(active) || active === overlay) {
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first.focus();
		} else if (event.shiftKey && active === first) {
			event.preventDefault();
			last.focus();
		}
	});

	/* --- two-way store binding ---------------------------------------------- */

	const writeToControl = (control: HTMLInputElement, settings: Settings) => {
		const key = control.dataset.setting as keyof Settings | undefined;
		if (!key) return;
		if (control.type === 'checkbox') {
			control.checked = settings[key] === true;
			return;
		}
		if (control.type === 'radio') {
			control.checked = String(settings[key]) === control.value;
			return;
		}
		if (control.type === 'range') {
			const spec = RANGES[key];
			const value = Number(settings[key]);
			control.value = String(spec ? Math.round(value / spec.scale) : value);
		}
	};

	const writeToOutput = (output: HTMLElement, settings: Settings) => {
		const key = output.dataset.settingOutput as keyof Settings | undefined;
		if (!key) return;
		const spec = RANGES[key];
		const value = Number(settings[key]);
		output.textContent = spec ? spec.format(value) : String(value);
	};

	const syncAll = (settings: Settings) => {
		for (const control of controls) writeToControl(control, settings);
		for (const output of outputs) writeToOutput(output, settings);
	};

	for (const control of controls) {
		const key = control.dataset.setting as keyof Settings | undefined;
		if (!key) continue;
		if (control.type === 'checkbox') {
			control.addEventListener('change', () => {
				setSetting(key as 'muted', control.checked as never);
			});
		} else if (control.type === 'radio') {
			control.addEventListener('change', () => {
				if (control.checked) setSetting(key as 'theme', control.value as never);
			});
		} else if (control.type === 'range') {
			control.addEventListener('input', () => {
				const spec = RANGES[key];
				const raw = Number(control.value);
				const value = spec ? raw * spec.scale : raw;
				setSetting(key as 'volume', value as never);
			});
		}
	}

	subscribeSettings(syncAll);
	syncAll(getSettings());
}
