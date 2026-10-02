/**
 * BNJI.NET — the travelling slab behind every segmented control.
 *
 * One module, one job: keep a `.glass-tabs__indicator` element sitting under the
 * currently selected label, and make the travel read as physical instead of as a
 * jump. It writes four edge offsets (`--tab-l/r/t/b`) and a direction; the CSS in
 * styles/glass.css owns the motion (which leg is fast, how far the tail
 * overshoots) from motion tokens. That split is why no duration appears here:
 * `prefers-reduced-motion`, the Settings store's performance mode and its reduced
 * effects switch all change the feel without this file knowing.
 *
 * The Admin section nav and the Games / Friends / leaderboard tab groups share
 * this — a control that moves in one place on the site should not have three
 * implementations of "where is the selected label".
 */
export type GlassTabsController = {
	/** Re-place the slab. `instant` skips the travel for the first paint and for relayouts. */
	place(instant?: boolean): void;
	destroy(): void;
};

export function mountGlassTabs(options: {
	list: HTMLElement;
	indicator: HTMLElement;
	/** The selected item right now, or null when nothing is selected (hidden). */
	current: () => HTMLElement | null;
}): GlassTabsController {
	const { list, indicator, current } = options;
	let lastLeft = Number.NaN;
	let observer: ResizeObserver | undefined;
	let frames: number[] = [];

	const place = (instant = false): void => {
		const target = current();
		if (!target) return;
		const listBox = list.getBoundingClientRect();
		const box = target.getBoundingClientRect();
		const left = box.left - listBox.left;
		const top = box.top - listBox.top;
		const right = listBox.width - (left + box.width);
		const bottom = listBox.height - (top + box.height);

		// Which way is it travelling? The leading edge gets the short leg, so a
		// pointer-following reader sees the capsule stretch toward the label.
		const forward = Number.isNaN(lastLeft) || left >= lastLeft;
		indicator.dataset.direction = forward ? 'forward' : 'back';
		if (instant || Number.isNaN(lastLeft)) indicator.dataset.instant = '';
		else delete indicator.dataset.instant;

		indicator.style.setProperty('--tab-l', `${left}px`);
		indicator.style.setProperty('--tab-r', `${right}px`);
		indicator.style.setProperty('--tab-t', `${top}px`);
		indicator.style.setProperty('--tab-b', `${bottom}px`);
		indicator.dataset.ready = '';
		lastLeft = left;
		if (indicator.dataset.instant !== undefined) {
			// Re-enable transitions only once the instant placement has painted, or
			// the first measured position would animate from the container's edge.
			frames.push(requestAnimationFrame(() => {
				frames.push(requestAnimationFrame(() => { delete indicator.dataset.instant; }));
			}));
		}
	};

	if (typeof ResizeObserver !== 'undefined') {
		// Wrapping on narrow screens, a late web-font swap and UI zoom all move the
		// labels; re-placing without travel keeps the slab glued instead of gliding.
		observer = new ResizeObserver(() => place(true));
		observer.observe(list);
	}
	const onSettings = (): void => place(true);
	window.addEventListener('bnji:settingschange', onSettings);

	return {
		place,
		destroy() {
			observer?.disconnect();
			for (const frame of frames) cancelAnimationFrame(frame);
			frames = [];
			window.removeEventListener('bnji:settingschange', onSettings);
		},
	};
}
