/**
 * BNJI.NET — opening scroll sequence (homepage).
 *
 * A scroll-SCRUBBED cinematic, not a timed animation: every visual property
 * is a pure function of scroll progress p ∈ [0, 1]:
 *
 *   p = scrollY / (spacerHeight - viewportHeight)
 *
 *   - white field with a single blue glowing star;
 *   - the star scales (ease-in curve) and rotates smoothly with p, growing
 *     until its energy field fills the viewport;
 *   - in the last 14% the white field and the star cross-fade into the real
 *     homepage (layer opacity → 0, then hidden so it costs nothing);
 *   - scrolling back up scrubs the sequence in reverse — it is a lens on the
 *     scroll position, never a trap.
 *
 * Enable/disable (no local toggles of its own):
 *   - the intro reads its enabled state from the CENTRAL SETTINGS STORE
 *     (scripts/settings.ts → introEnabled), which the Settings overlay
 *     controls and localStorage persists. The store hydrates synchronously at
 *     import, and the pre-paint script in BaseHead.astro applies the same
 *     flag to html[data-intro] before first paint — so a disabled intro
 *     never renders its spacer, never starts, and never flashes;
 *   - prefers-reduced-motion always wins: html[data-intro="off"] removes the
 *     spacer and layer via CSS, and initIntro bails;
 *   - without JavaScript the spacer is display:none (html:not(.js)), so no
 *     dead scroll region exists.
 *   Disabling mid-session removes the spacer (CSS) but the scrub loop, once
 *   started, simply goes inert — a reload gives the clean disabled state.
 *
 * Cost model: one scroll listener writing two transforms + one opacity inside
 * a rAF coalescer; the layer is hidden entirely outside 0 < p < 1.
 */
import { createFrameScheduler, prefersReducedMotion } from './environment';
import { getSettings } from './settings';

export function initIntro(): void {
	const root = document.documentElement;
	// The store is the only enable switch; the dataset/motion checks are the
	// pre-paint and reduced-motion guarantees.
	if (!getSettings().introEnabled || root.dataset.intro === 'off' || prefersReducedMotion()) return;

	const layer = document.querySelector<HTMLElement>('[data-intro-layer]');
	const spacer = document.querySelector<HTMLElement>('[data-intro-spacer]');
	const star = document.querySelector<HTMLElement>('[data-intro-star]');
	const energy = document.querySelector<HTMLElement>('[data-intro-energy]');
	if (!layer || !spacer || !star || !energy) return;

	const smoothstep = (edge0: number, edge1: number, x: number) => {
		const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
		return t * t * (3 - 2 * t);
	};

	const update = () => {
		const spacerHeight = spacer.offsetHeight;
		const denom = Math.max(1, spacerHeight - window.innerHeight);
		const p = Math.min(1, Math.max(0, window.scrollY / denom));

		if (p <= 0.001) {
			layer.hidden = false;
			layer.style.opacity = '1';
			layer.style.pointerEvents = 'auto';
			star.style.transform = 'translate3d(-50%, -50%, 0) scale(1) rotate(0deg)';
			energy.style.opacity = '0';
			root.dataset.introState = 'active';
			return;
		}
		if (p >= 1) {
			// Fully transitioned: stop compositing the layer at all.
			layer.hidden = true;
			layer.style.pointerEvents = 'none';
			root.dataset.introState = 'done';
			return;
		}
		layer.hidden = false;
		layer.style.pointerEvents = p >= 0.86 ? 'none' : 'auto';
		root.dataset.introState = p >= 0.86 ? 'done' : 'active';

		// Ease-in growth: slow at first, then dominant — the star "arrives".
		const growth = Math.pow(p, 1.7);
		const scale = 1 + growth * 46;
		const rotate = p * 420;
		star.style.transform = `translate3d(-50%, -50%, 0) scale(${scale.toFixed(2)}) rotate(${rotate.toFixed(1)}deg)`;

		// Blue energy floods the field as the star gets close.
		energy.style.opacity = smoothstep(0.55, 0.92, p).toFixed(3);

		// Cross-fade into the homepage over the final 14%.
		layer.style.opacity = (1 - smoothstep(0.86, 1, p)).toFixed(3);
	};

	const schedule = createFrameScheduler(update);
	window.addEventListener('scroll', schedule, { passive: true });
	window.addEventListener('resize', schedule, { passive: true });
	update();
}
