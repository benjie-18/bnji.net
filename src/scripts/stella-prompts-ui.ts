/**
 * BNJI.NET — /projects/stella/ client.
 *
 * One mount per page: wires the mode, phase and variant controls, renders
 * the composed prompt from src/data/stella-prompts.ts, keeps the choice in
 * the URL hash so a selection is shareable, and copies the exact text.
 *
 * This module never edits prompt text. The only substitution is the one the
 * data module performs: the preamble's first line is set to the selected
 * phase. Copying uses the rendered text itself, so what is copied is what
 * is shown.
 */

import { STELLA_PHASES, composeStellaPrompt } from '../data/stella-prompts';

type VariantId = 'full' | 'fix' | 'phase';

type Selection = {
	modeId: 'fable' | 'opus';
	phaseId: string;
	variantId: VariantId;
};

const DEFAULT_SELECTION: Selection = { modeId: 'fable', phaseId: 'F1', variantId: 'full' };

function isModeId(value: string): value is Selection['modeId'] {
	return value === 'fable' || value === 'opus';
}

function isVariantId(value: string): value is VariantId {
	return value === 'full' || value === 'fix' || value === 'phase';
}

function isPhaseId(value: string): boolean {
	return STELLA_PHASES.some((phase) => phase.id === value);
}

/** Read a selection from `#<mode>/<phase>/<variant>`; null when absent or invalid. */
function selectionFromHash(): Selection | null {
	const parts = window.location.hash.slice(1).split('/');
	if (parts.length !== 3) return null;
	const [modeId, phaseId, variantId] = parts;
	if (!isModeId(modeId) || !isPhaseId(phaseId) || !isVariantId(variantId)) return null;
	return { modeId, phaseId, variantId };
}

export function mountStellaPrompts(root: HTMLElement): void {
	const modeInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-stella-mode]'));
	// No querySelector<HTMLSelectElement> generic: it fails the Element
	// constraint under this repo's DOM libs, where no other file uses it
	// either. A plain lookup plus instanceof narrows just as well.
	const phaseSelect = root.querySelector('[data-stella-phase]');
	const prevButton = root.querySelector<HTMLButtonElement>('[data-stella-prev]');
	const nextButton = root.querySelector<HTMLButtonElement>('[data-stella-next]');
	const variantInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-stella-variant]'));
	const output = root.querySelector('[data-stella-output]');
	const count = root.querySelector<HTMLElement>('[data-stella-count]');
	const copyButton = root.querySelector('[data-stella-copy]');
	const status = root.querySelector('[data-stella-status]');
	const phaseOnlyLabel = root.querySelector<HTMLElement>('[data-stella-phase-only-label]');
	const opusNote = root.querySelector<HTMLElement>('[data-stella-opus-note]');

	if (
		!(phaseSelect instanceof HTMLSelectElement) ||
		!(output instanceof HTMLElement) ||
		!(copyButton instanceof HTMLButtonElement) ||
		!(status instanceof HTMLElement)
	) {
		return;
	}

	// Narrowed once here, so the closures below see non-nullable types.
	const phaseSelectEl: HTMLSelectElement = phaseSelect;
	const outputEl: HTMLElement = output;
	const copyButtonEl: HTMLButtonElement = copyButton;
	const statusEl: HTMLElement = status;

	let selection: Selection = selectionFromHash() ?? { ...DEFAULT_SELECTION };

	function phaseIndex(): number {
		return STELLA_PHASES.findIndex((phase) => phase.id === selection.phaseId);
	}

	function render(): void {
		const text = composeStellaPrompt(selection.modeId, selection.phaseId, selection.variantId);
		outputEl.textContent = text;
		if (count) {
			const lines = text.split('\n').length;
			count.textContent = `${text.length.toLocaleString()} characters, ${lines.toLocaleString()} lines`;
		}
		if (phaseOnlyLabel) phaseOnlyLabel.textContent = `Only ${selection.phaseId} prompt`;
		if (opusNote) opusNote.hidden = !(selection.modeId === 'opus' && selection.phaseId === 'F1');
		if (prevButton) prevButton.disabled = phaseIndex() <= 0;
		if (nextButton) nextButton.disabled = phaseIndex() >= STELLA_PHASES.length - 1;

		modeInputs.forEach((input) => {
			input.checked = input.value === selection.modeId;
		});
		phaseSelectEl.value = selection.phaseId;
		variantInputs.forEach((input) => {
			input.checked = input.value === selection.variantId;
		});

		const hash = `#${selection.modeId}/${selection.phaseId}/${selection.variantId}`;
		if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
	}

	function readControls(): Selection {
		const modeValue = modeInputs.find((input) => input.checked)?.value ?? selection.modeId;
		const variantValue = variantInputs.find((input) => input.checked)?.value ?? selection.variantId;
		return {
			modeId: isModeId(modeValue) ? modeValue : selection.modeId,
			phaseId: isPhaseId(phaseSelectEl.value) ? phaseSelectEl.value : selection.phaseId,
			variantId: isVariantId(variantValue) ? variantValue : selection.variantId,
		};
	}

	function stepPhase(delta: number): void {
		const next = phaseIndex() + delta;
		if (next < 0 || next >= STELLA_PHASES.length) return;
		selection = { ...selection, phaseId: STELLA_PHASES[next].id };
		render();
	}

	async function copyPrompt(): Promise<void> {
		const text = outputEl.textContent ?? '';
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(text);
			} else {
				const area = document.createElement('textarea');
				area.value = text;
				area.setAttribute('readonly', '');
				area.style.position = 'fixed';
				area.style.opacity = '0';
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand('copy');
				document.body.removeChild(area);
				if (!ok) throw new Error('execCommand copy returned false');
			}
			statusEl.textContent = 'Copied to clipboard.';
		} catch {
			statusEl.textContent = 'Copy did not work here. Select the text and copy it manually.';
		}
	}

	modeInputs.forEach((input) => {
		input.addEventListener('change', () => {
			selection = readControls();
			statusEl.textContent = '';
			render();
		});
	});

	variantInputs.forEach((input) => {
		input.addEventListener('change', () => {
			selection = readControls();
			statusEl.textContent = '';
			render();
		});
	});

	phaseSelectEl.addEventListener('change', () => {
		selection = readControls();
		statusEl.textContent = '';
		render();
	});

	prevButton?.addEventListener('click', () => {
		stepPhase(-1);
		statusEl.textContent = '';
	});
	nextButton?.addEventListener('click', () => {
		stepPhase(1);
		statusEl.textContent = '';
	});

	copyButtonEl.addEventListener('click', () => {
		void copyPrompt();
	});

	// Back and forward move through the hash history.
	window.addEventListener('hashchange', () => {
		const fromHash = selectionFromHash();
		if (fromHash) {
			selection = fromHash;
			statusEl.textContent = '';
			render();
		}
	});

	render();
}
