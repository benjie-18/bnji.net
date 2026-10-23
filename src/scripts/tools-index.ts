/**
 * BNJI.NET — /projects/tools/ repertory behaviour: one category at a time, plus keys.
 *
 * WHAT IT ADDS ON TOP OF THE MARKUP
 * ---------------------------------
 * The repertory in src/components/tools/ToolsRepertory.astro is a list of plain
 * anchors, so with JavaScript off the page is fourteen tools under four
 * headings and every link jumps to its tool. This module turns those same links
 * into a filter: choosing a category hides the other three sections, which is
 * what stops the page being a scroll. Nothing is removed from the document —
 * the tools keep their state and their controllers keep running while hidden.
 *
 * It is deliberately DOM-driven: the categories, the tool ids and even the
 * shortcut digits are read from the markup rather than imported from
 * src/data/tools.ts, so the script cannot disagree with the page it is bound to
 * the way a second copy of the list could.
 *
 * Two rules the code below holds to:
 *   - it never calls preventDefault on a link. The anchor still navigates, so
 *     the URL keeps working as a shareable deep link and the browser does the
 *     scrolling (with the page's own smooth-scroll and scroll-padding).
 *   - a digit typed into a tool is a digit. The shortcut is ignored whenever the
 *     keystroke lands in a field, which is most of this page.
 */

import { prefersReducedMotion } from './environment';

let started = false;
let teardown: (() => void) | null = null;

/** Scroll the same way the page does: smooth unless the visitor asked otherwise. */
function scrollTo(element: Element): void {
	element.scrollIntoView({
		block: 'start',
		behavior: prefersReducedMotion() ? 'auto' : 'smooth',
	});
}

export function initToolsIndex(): void {
	if (started) return;

	const root = document.querySelector<HTMLElement>('[data-tools-repertory]');
	if (!root) return;

	const groups = Array.from(document.querySelectorAll<HTMLElement>('[data-tool-group]'));
	if (groups.length === 0) return;

	started = true;

	const controller = new AbortController();
	const { signal } = controller;

	const chips = Array.from(root.querySelectorAll<HTMLElement>('[data-tools-cat]'));
	const live = root.querySelector<HTMLElement>('[data-tools-live]');

	const chipFor = (categoryId: string | null): HTMLElement | undefined =>
		chips.find((chip) => (chip.dataset.toolsCat ?? 'all') === (categoryId ?? 'all'));

	const labelOf = (chip: HTMLElement | undefined): string =>
		chip?.querySelector('.tools-repertory__cat-name')?.textContent?.trim() ?? '';

	const toolsIn = (group: HTMLElement): number =>
		group.querySelectorAll('.tool-group__tools > *').length;

	/**
	 * Show one category, or every category when `categoryId` is null.
	 * `hidden` (rather than a class) so a hidden tool is also hidden from the
	 * accessibility tree: a filter that leaves the other twelve tools reachable
	 * by Tab is a filter that lies about what is on the page.
	 */
	const show = (categoryId: string | null): void => {
		for (const group of groups) {
			group.hidden = categoryId !== null && group.dataset.toolGroup !== categoryId;
		}

		for (const chip of chips) {
			const active = (chip.dataset.toolsCat ?? 'all') === (categoryId ?? 'all');
			if (active) chip.setAttribute('aria-current', 'true');
			else chip.removeAttribute('aria-current');
		}

		if (!live) return;
		if (categoryId === null) {
			const total = groups.reduce((sum, group) => sum + toolsIn(group), 0);
			live.textContent = `All ${total} tools are listed.`;
			return;
		}
		const group = groups.find((entry) => entry.dataset.toolGroup === categoryId);
		const count = group ? toolsIn(group) : 0;
		live.textContent = `${labelOf(chipFor(categoryId))}: ${count} tool${count === 1 ? '' : 's'} shown, the other categories are hidden.`;
	};

	/**
	 * The section a `#…` in the address bar points at — a tool id or a `#cat-…`.
	 * getElementById rather than a selector built from the hash: a tool id is a
	 * plain slug, and this way an odd hash cannot become a broken selector.
	 */
	const groupForHash = (): HTMLElement | null => {
		const id = window.location.hash.replace(/^#/, '');
		if (!id) return null;
		const target = document.getElementById(id);
		if (!target) return null;
		return target.closest<HTMLElement>('[data-tool-group]');
	};

	/**
	 * Follow the address bar. The browser scrolls to a fragment during load, and
	 * it does that before this script runs — so when the target was hidden by a
	 * filter, the scroll is owed and is paid here.
	 */
	const followHash = (): void => {
		const group = groupForHash();
		const wasHidden = group?.hidden ?? false;
		show(group?.dataset.toolGroup ?? null);
		if (group && wasHidden) scrollTo(group);
	};

	root.addEventListener(
		'click',
		(event) => {
			const target = event.target as Element | null;

			const chip = target?.closest<HTMLElement>('[data-tools-cat]');
			if (chip) {
				const chosen = chip.dataset.toolsCat ?? 'all';
				show(chosen === 'all' ? null : chosen);
				return;
			}

			/*
			 * A tool link: open its category and let the anchor scroll to the
			 * tool. The category is read from the list the link sits in, so a
			 * link and its category cannot drift apart.
			 */
			const link = target?.closest<HTMLElement>('[data-tools-link]');
			if (!link) return;
			const holder = link.closest<HTMLElement>('[data-tools-group-links]');
			show(holder?.dataset.toolsGroupLinks ?? null);
		},
		{ signal },
	);

	window.addEventListener('hashchange', followHash, { signal });

	/*
	 * Digits, read off the <kbd> the repertory already prints: the shortcut on
	 * screen and the shortcut in code are the same element, so a category added
	 * to the data file is reachable by key without a second edit here.
	 */
	const shortcuts = new Map<string, string | null>();
	for (const chip of chips) {
		const key = chip.querySelector('kbd')?.textContent?.trim();
		if (!key) continue;
		const chosen = chip.dataset.toolsCat ?? 'all';
		shortcuts.set(key, chosen === 'all' ? null : chosen);
	}

	if (shortcuts.size > 0) {
		document.addEventListener(
			'keydown',
			(event) => {
				if (event.ctrlKey || event.metaKey || event.altKey) return;
				if (!shortcuts.has(event.key)) return;
				// Typing "1" into the word counter is not a category change.
				const target = event.target as Element | null;
				if (target?.closest('input, textarea, select, [contenteditable]')) return;

				event.preventDefault();
				const categoryId = shortcuts.get(event.key) ?? null;
				show(categoryId);
				const group =
					categoryId === null
						? null
						: groups.find((entry) => entry.dataset.toolGroup === categoryId);
				// "All" only reveals: wherever the visitor is stays wherever it is.
				if (group) scrollTo(group);
			},
			{ signal },
		);
	}

	followHash();

	teardown = () => {
		controller.abort();
		// A stopped controller must not leave tools hidden behind it.
		show(null);
	};
}

export function destroyToolsIndex(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
