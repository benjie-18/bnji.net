/**
 * BNJI.NET — scroll behaviour.
 *
 * Scrolling should read as one continuous environment rather than a stack of
 * separate pages, so sections fade/rise into place and a few elements drift at
 * a different rate than the page. Everything here is transform/opacity only:
 * no scroll handler in this file touches a layout property.
 *
 * Markup contract:
 *   [data-reveal]                  gains .is-visible when it scrolls into view
 *   --reveal-delay: 120ms          optional stagger (inline custom property)
 *   [data-parallax="0.06"]         drift strength; the module writes --parallax-y.
 *                                  Negative = lags behind the scroll (depth),
 *                                  positive = leads it.
 *   [data-nav]                     gains .is-stuck once the page has scrolled
 *
 * Reduced motion: reveals resolve instantly and parallax is never started.
 * Without IntersectionObserver (ancient browsers) everything is revealed
 * immediately, so content can never stay invisible.
 */

import { clamp, createFrameScheduler, prefersReducedMotion } from './environment';
import { getSettings, subscribeSettings } from './settings';

let revealStarted = false;
let parallaxStarted = false;
let navStateStarted = false;

/**
 * Maximum parallax travel in px, before the per-element strength multiplier.
 * One constant here keeps every drifting element on the same scale.
 */
const PARALLAX_RANGE = 240;

/* -------------------------------------------------------------------------- */
/* Reveal on scroll                                                           */
/* -------------------------------------------------------------------------- */

export function initReveal(): void {
	if (revealStarted) return;
	revealStarted = true;

	const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
	if (targets.length === 0) return;

	const showAll = () => targets.forEach((element) => element.classList.add('is-visible'));

	// Reduced motion, the reduced-effects setting, or no IntersectionObserver:
	// skip the animation entirely and make sure nothing is left hidden.
	// (animations.css also force-shows [data-reveal] under
	// html[data-reduced-effects='on'], pre-paint, so this is the JS half of
	// the same gate — no observer work for a calm session.)
	if (
		prefersReducedMotion() ||
		getSettings().reducedEffects ||
		typeof IntersectionObserver === 'undefined'
	) {
		showAll();
		subscribeSettings((settings) => {
			if (settings.reducedEffects) showAll();
		});
		return;
	}

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add('is-visible');
				// One-shot: a section that has been seen should not blink again on
				// the way back up.
				observer.unobserve(entry.target);
			}
		},
		{
			// Trigger slightly before the element is fully on screen so it has
			// settled by the time the visitor is reading it.
			rootMargin: '0px 0px -8% 0px',
			threshold: 0.08,
		},
	);

	targets.forEach((element) => observer.observe(element));

	// Toggling reduced-effects on mid-session: reveal everything now; the CSS
	// gate (animations.css) cancels the transitions so nothing animates in.
	subscribeSettings((settings) => {
		if (settings.reducedEffects) showAll();
	});
}

/* -------------------------------------------------------------------------- */
/* Parallax                                                                   */
/* -------------------------------------------------------------------------- */

export function initParallax(): void {
	if (parallaxStarted) return;
	parallaxStarted = true;
	// Reduced effects at boot = treated exactly like reduced motion: the
	// listeners are never attached (enabling parallax live then applies on
	// the next load; DISABLING it live works immediately, below).
	if (prefersReducedMotion() || getSettings().reducedEffects) return;

	const strengths = new Map<HTMLElement, number>();
	document.querySelectorAll<HTMLElement>('[data-parallax]').forEach((element) => {
		const strength = Number(element.dataset.parallax);
		if (!Number.isFinite(strength) || strength === 0) return;
		strengths.set(element, strength);
	});
	if (strengths.size === 0) return;

	// Only elements near the viewport are updated, so a long page with a few
	// drifting headings costs the same as a short one.
	const active = new Set<HTMLElement>();

	// Live gate for the reduced-effects setting: updates stop and every
	// element settles back to its true position the moment it flips on.
	let parallaxOn = true;

	const update = createFrameScheduler(() => {
		if (!parallaxOn) return;
		const viewportHeight = window.innerHeight || 1;
		active.forEach((element) => {
			const strength = strengths.get(element) ?? 0;
			const box = element.getBoundingClientRect();
			// -1 when the element centre is a full viewport below the middle,
			// +1 when it is a full viewport above it.
			const progress = clamp(
				(box.top + box.height / 2 - viewportHeight / 2) / viewportHeight,
				-1,
				1,
			);
			element.style.setProperty(
				'--parallax-y',
				`${(progress * strength * PARALLAX_RANGE).toFixed(2)}px`,
			);
		});
	});

	if (typeof IntersectionObserver !== 'undefined') {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const element = entry.target as HTMLElement;
					if (entry.isIntersecting) active.add(element);
					else active.delete(element);
				}
			},
			{ rootMargin: '25% 0px' },
		);
		strengths.forEach((_strength, element) => observer.observe(element));
	} else {
		strengths.forEach((_strength, element) => active.add(element));
	}

	window.addEventListener('scroll', update, { passive: true });
	window.addEventListener('resize', update, { passive: true });
	update();

	subscribeSettings((settings) => {
		const next = !settings.reducedEffects;
		if (next === parallaxOn) return;
		parallaxOn = next;
		if (parallaxOn) update();
		else strengths.forEach((_strength, element) => element.style.setProperty('--parallax-y', '0px'));
	});
}

/* -------------------------------------------------------------------------- */
/* Navigation scroll state                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The floating nav starts almost invisible and gains fill, border and shadow
 * once the page has actually scrolled. Purely a class toggle — the visual
 * transition is CSS.
 */
export function initNavScrollState(): void {
	if (navStateStarted) return;
	navStateStarted = true;

	const nav = document.querySelector<HTMLElement>('[data-nav]');
	if (!nav) return;

	const THRESHOLD = 12;
	let stuck = false;

	const apply = createFrameScheduler(() => {
		const next = window.scrollY > THRESHOLD;
		if (next === stuck) return;
		stuck = next;
		nav.classList.toggle('is-stuck', stuck);
	});

	window.addEventListener('scroll', apply, { passive: true });
	apply();
}
