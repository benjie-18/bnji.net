/**
 * BNJI.NET — starfield engine.
 *
 * A sparse field of small stars on a single <canvas>, drawn with an animation
 * frame loop that is deliberately cheap:
 *
 *  - star count scales with viewport area and is clamped (~180 stars at 1440x900,
 *    ~55 on a phone), so the sky never becomes noise or a fill-rate problem;
 *  - alpha values are quantised into a lookup table, because building two
 *    `rgba()` strings per star per frame is a surprisingly large GC load for an
 *    effect this small;
 *  - the loop is capped at ~30fps. Twinkle periods are 7-30 seconds, so the cap
 *    is invisible while halving the work;
 *  - the loop stops entirely when the tab is hidden;
 *  - only opacity/position change per frame — no filters, no shadows, no DOM.
 *
 * Interaction model
 * -----------------
 *  - pointer: stars inside `pointerRadius` brighten and grow, then ease back
 *    out. Fast attack, slow release, so the effect trails the cursor slightly
 *    instead of flickering. Disabled unless the device has a fine pointer.
 *  - `data-star-reactive`: any element with this attribute acts as a soft light
 *    source, so large surfaces (the hero wordmark, the Lab teaser) lift the
 *    stars behind them. Rects are cached and refreshed on scroll/resize.
 *  - scroll: each star has a `depth`, giving slow parallax against a canvas that
 *    is itself fixed to the viewport. Positions wrap, so the field never thins
 *    out at the edges.
 *
 * The same module powers the Lab's Starfield Tuner experiment; the site
 * background is just one particular set of options.
 */

import {
	clamp,
	createFrameScheduler,
	hasFinePointer,
	isPageVisible,
	prefersReducedMotion,
} from './environment';
import { getSettings, subscribeSettings } from './settings';

const TAU = Math.PI * 2;
/** Alpha is quantised to this many steps for the fillStyle lookup tables. */
const ALPHA_STEPS = 28;

export type StarfieldOptions = {
	/** Stars per 1,000,000 CSS px² of canvas. Sparse by design. */
	starsPerMegapixel?: number;
	minCount?: number;
	maxCount?: number;
	minRadius?: number;
	maxRadius?: number;
	/** Twinkle rate multiplier. 1 ≈ periods of 7-30 seconds. */
	twinkle?: number;
	/** Ambient vertical drift in CSS px per second. */
	drift?: number;
	/** Vertical parallax per pixel of page scroll, scaled by star depth. */
	scrollParallax?: number;
	/** Pointer influence radius in CSS px. */
	pointerRadius?: number;
	/** Extra brightness at the pointer centre, 0..1. */
	pointerBoost?: number;
	/** Brightness added inside [data-star-reactive] rects, 0..1. */
	reactiveBoost?: number;
	/** Frame cap. Lower = cheaper; 0 draws on every display frame. */
	targetFps?: number;
	/** Occasional meteors streaking the dark sky. Off under reduced motion. */
	shootingStars?: boolean;
	/** Star colour as an "r, g, b" triplet string. */
	color?: string;
	/** Maximum devicePixelRatio to render at (2 is plenty for 1px stars). */
	maxDpr?: number;
};

type Star = {
	x: number;
	y: number;
	radius: number;
	depth: number;
	baseAlpha: number;
	phase: number;
	speed: number;
	excite: number;
};

type Rect = { left: number; top: number; right: number; bottom: number };

/** A shooting star: position, velocity (px/s), age and total life (seconds). */
type Meteor = { x: number; y: number; vx: number; vy: number; age: number; life: number };

const SITE_DEFAULTS: Required<StarfieldOptions> = {
	starsPerMegapixel: 145,
	minCount: 42,
	maxCount: 300,
	minRadius: 0.35,
	maxRadius: 1.35,
	twinkle: 1,
	drift: 1.1,
	scrollParallax: 0.045,
	pointerRadius: 150,
	pointerBoost: 0.55,
	reactiveBoost: 0.2,
	// Uncapped by default: a hard 30fps cap produced uneven frame pacing on
	// high-refresh displays, which read as flicker. The field is cheap enough
	// (a few hundred arcs) to draw on every display frame; the Lab tuner can
	// still impose a cap.
	targetFps: 0,
	color: '226, 238, 255',
	maxDpr: 2,
	shootingStars: true,
};

export type Starfield = {
	/** Stop the loop and remove every listener. */
	destroy: () => void;
	/** Stop drawing but keep listeners (Lab experiments pause when offscreen). */
	pause: () => void;
	/** Resume after pause(). No-op when reduced motion is active. */
	resume: () => void;
	/** Live options — the Lab tuner writes these and the engine adapts. */
	options: Required<StarfieldOptions>;
	/** Rebuild the star population (after a density change, for example). */
	regenerate: () => void;
	/** Draw one frame immediately. */
	render: () => void;
	/** Current star population (the Lab reports it, and it is clamped). */
	count: () => number;
};

export function createStarfield(
	canvas: HTMLCanvasElement,
	initialOptions: StarfieldOptions = {},
): Starfield {
	const options: Required<StarfieldOptions> = { ...SITE_DEFAULTS, ...initialOptions };
	const maybeContext = canvas.getContext('2d', { alpha: true });

	// No 2D context (very old browser, or a canvas already taken): fail closed.
	// The page keeps its gradient background and nothing else breaks.
	if (!maybeContext) {
		const noop = () => {};
		return {
			destroy: noop,
			pause: noop,
			resume: noop,
			options,
			regenerate: noop,
			render: noop,
			count: () => 0,
		};
	}

	// Re-bind through the guard so the non-null type is the *declared* type.
	// Nested helpers (measure, render, ...) capture this binding, and control
	// flow narrowing does not reach into function bodies.
	const context: CanvasRenderingContext2D = maybeContext;

	const reducedMotion = prefersReducedMotion();
	// Pointer and reactive-area effects are desktop affordances. On touch
	// devices there is no hovering cursor to react to, so they are skipped
	// rather than simulated.
	const pointerEffects = hasFinePointer() && !reducedMotion;

	let stars: Star[] = [];
	let width = 0;
	let height = 0;
	let dpr = 1;
	let pointerX = 0;
	let pointerY = 0;
	let pointerActive = false;
	let reactiveRects: Rect[] = [];
	let scrollY = typeof window === 'undefined' ? 0 : window.scrollY;
	let frame = 0;
	let lastFrameTime = 0;
	let lastDrawTime = 0;
	let elapsed = 0;
	/** Seconds since the previous frame; the easing in render() depends on it. */
	let delta = 0;

	// Fill-style lookup tables (see the module comment for why).
	let coreLut: string[] = [];
	let glowLut: string[] = [];
	function buildLut(color: string) {
		coreLut = Array.from(
			{ length: ALPHA_STEPS + 1 },
			(_, i) => `rgba(${color},${(i / ALPHA_STEPS).toFixed(3)})`,
		);
		glowLut = Array.from(
			{ length: ALPHA_STEPS + 1 },
			(_, i) => `rgba(${color},${((i / ALPHA_STEPS) * 0.12).toFixed(3)})`,
		);
	}
	buildLut(options.color);

	function populate() {
		const area = width * height;
		const target = clamp(
			Math.round((area / 1_000_000) * options.starsPerMegapixel),
			options.minCount,
			options.maxCount,
		);
		stars = Array.from({ length: target }, () => ({
			x: Math.random() * width,
			y: Math.random() * height,
			radius: options.minRadius + Math.random() * (options.maxRadius - options.minRadius),
			// Depth drives parallax and drift: distant stars move less.
			depth: 0.25 + Math.random() * 0.75,
			baseAlpha: 0.22 + Math.random() * 0.62,
			phase: Math.random() * TAU,
			speed: (0.22 + Math.random() * 0.68) * options.twinkle,
			excite: 0,
		}));
	}

	/** Shortest distance from a point to an axis-aligned rect (0 when inside). */
	function distanceToRect(x: number, y: number, rect: Rect): number {
		const dx = Math.max(rect.left - x, 0, x - rect.right);
		const dy = Math.max(rect.top - y, 0, y - rect.bottom);
		return Math.hypot(dx, dy);
	}

	function measure() {
		const rect = canvas.getBoundingClientRect();
		const nextWidth = Math.max(1, Math.round(rect.width));
		const nextHeight = Math.max(1, Math.round(rect.height));
		const nextDpr = Math.min(options.maxDpr, window.devicePixelRatio || 1);

		if (nextWidth === width && nextHeight === height && nextDpr === dpr) return false;

		// Rescale existing stars instead of re-randomising, so a resize (or a
		// phone rotating) does not visually reshuffle the sky.
		const scaleX = width ? nextWidth / width : 1;
		const scaleY = height ? nextHeight / height : 1;
		for (const star of stars) {
			star.x *= scaleX;
			star.y *= scaleY;
		}

		width = nextWidth;
		height = nextHeight;
		dpr = nextDpr;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		return true;
	}

	function cacheReactiveRects() {
		if (!pointerEffects && options.reactiveBoost === 0) {
			reactiveRects = [];
			return;
		}
		const nodes = document.querySelectorAll<HTMLElement>('[data-star-reactive]');
		reactiveRects = [];
		nodes.forEach((node) => {
			const box = node.getBoundingClientRect();
			// Skip zero-size or offscreen elements so the per-star loop stays short.
			if (box.width < 2 || box.height < 2) return;
			if (box.bottom < 0 || box.top > window.innerHeight) return;
			reactiveRects.push({
				left: box.left,
				top: box.top,
				right: box.right,
				bottom: box.bottom,
			});
		});
	}

	function excitationTarget(star: Star, x: number, y: number): number {
		let target = 0;

		if (pointerActive && options.pointerRadius > 0) {
			const distance = Math.hypot(x - pointerX, y - pointerY);
			if (distance < options.pointerRadius) {
				// Cosine falloff: bright at the centre, smooth to zero at the edge,
				// so the response never looks like a hard spotlight.
				const falloff = 0.5 + 0.5 * Math.cos((distance / options.pointerRadius) * Math.PI);
				target = Math.max(target, falloff * options.pointerBoost);
			}
		}

		for (const rect of reactiveRects) {
			const distance = distanceToRect(x, y, rect);
			if (distance < options.pointerRadius) {
				const falloff = 0.5 + 0.5 * Math.cos((distance / options.pointerRadius) * Math.PI);
				target = Math.max(target, falloff * options.reactiveBoost);
			}
		}

		return target;
	}

	function render() {
		context.clearRect(0, 0, width, height);

		for (const star of stars) {
			// Continuous, wrapping motion: ambient drift + scroll parallax.
			const travel = reducedMotion
				? 0
				: elapsed * star.depth * options.drift + scrollY * star.depth * options.scrollParallax;
			const y = travel === 0 ? star.y : (((star.y + travel) % height) + height) % height;

			if (pointerEffects || reactiveRects.length > 0) {
				const target = excitationTarget(star, star.x, y);
				// Fast attack, slower release: the star "catches" the cursor and
				// then settles back instead of snapping. Frame-rate independent.
				const rate = target > star.excite ? 7 : 2.4;
				star.excite += (target - star.excite) * clamp(rate * delta, 0, 1);
			}

			const twinkle = reducedMotion
				? 0.85
				: 0.5 + 0.5 * Math.sin(elapsed * star.speed + star.phase);
			const alpha = clamp(
				star.baseAlpha * (0.62 + 0.38 * twinkle) + star.excite * 0.6,
				0,
				1,
			);
			const radius = star.radius * (1 + star.excite * 0.9);

			const step = Math.round(alpha * ALPHA_STEPS);
			context.fillStyle = coreLut[step];
			context.beginPath();
			context.arc(star.x, y, radius, 0, TAU);
			context.fill();

			// Soft halo, weighted continuously instead of switching on past a
			// radius threshold. The old binary test made halos pop in and out
			// as a twinkling star crossed it — one of the visible "flicker"
			// sources. globalAlpha keeps the quantised LUT but fades smoothly.
			const haloWeight = clamp((radius - 0.55) / 0.5, 0, 1) * 0.85 + star.excite * 0.5;
			if (haloWeight > 0.02) {
				context.globalAlpha = clamp(haloWeight, 0, 1);
				context.fillStyle = glowLut[step];
				context.beginPath();
				context.arc(star.x, y, radius * 3.6, 0, TAU);
				context.fill();
				context.globalAlpha = 1;
			}
		}

		drawMeteors();
	}

	/** Spawn, advance and draw shooting stars. Dark-sky only by nature: the
	 *  engine is paused in the light theme, and reduced motion never spawns. */
	function stepMeteors() {
		if (!options.shootingStars || reducedMotion) return;
		if (elapsed >= nextMeteorAt && meteors.length < 2) {
			const fromLeft = Math.random() < 0.5;
			const speed = 620 + Math.random() * 420;
			const angle = (fromLeft ? 24 : 156) * (Math.PI / 180) * (fromLeft ? 1 : 1);
			meteors.push({
				x: fromLeft ? -40 : width + 40,
				y: height * (0.08 + Math.random() * 0.3),
				vx: Math.cos(angle) * speed * (fromLeft ? 1 : -1),
				vy: Math.sin(angle) * speed * 0.55,
				age: 0,
				life: 0.9 + Math.random() * 0.6,
			});
			nextMeteorAt = elapsed + 6 + Math.random() * 9;
		}
		meteors = meteors.filter((m) => (m.age += delta) < m.life);
		for (const m of meteors) {
			m.x += m.vx * delta;
			m.y += m.vy * delta;
		}
	}

	function drawMeteors() {
		for (const m of meteors) {
			// Sine envelope: fade in, peak, fade out — no popping at either end.
			const envelope = Math.sin(Math.PI * clamp(m.age / m.life, 0, 1));
			const tail = 0.12;
			const tx = m.x - m.vx * tail;
			const ty = m.y - m.vy * tail;
			const gradient = context.createLinearGradient(m.x, m.y, tx, ty);
			gradient.addColorStop(0, `rgba(${options.color}, ${0.85 * envelope})`);
			gradient.addColorStop(1, `rgba(${options.color}, 0)`);
			context.strokeStyle = gradient;
			context.lineWidth = 1.6;
			context.lineCap = 'round';
			context.beginPath();
			context.moveTo(m.x, m.y);
			context.lineTo(tx, ty);
			context.stroke();
			// Head sparkle.
			context.globalAlpha = envelope;
			context.fillStyle = coreLut[ALPHA_STEPS];
			context.beginPath();
			context.arc(m.x, m.y, 1.4, 0, TAU);
			context.fill();
			context.globalAlpha = 1;
		}
	}

	function loop(now: number) {
		frame = requestAnimationFrame(loop);

		// Background tabs cost nothing: the loop is cancelled on visibilitychange
		// and restarted when the tab returns.
		if (!isPageVisible()) return;

		// Clamped so a background-tab stall cannot teleport the twinkle phase.
		delta = lastFrameTime ? clamp((now - lastFrameTime) / 1000, 0, 0.05) : 0;
		lastFrameTime = now;
		elapsed += delta;

		// Frame cap (see module comment). `elapsed` keeps advancing on skipped
		// frames so the twinkle phase stays continuous when we do draw.
		const minInterval = options.targetFps > 0 ? 1000 / options.targetFps : 0;
		if (minInterval > 0 && now - lastDrawTime < minInterval - 1) return;
		lastDrawTime = now;

		stepMeteors();
		render();
	}

	/* --- Listeners -------------------------------------------------------- */

	const onPointerMove = (event: PointerEvent) => {
		pointerX = event.clientX;
		pointerY = event.clientY;
		pointerActive = true;
	};

	const onPointerLeave = () => {
		pointerActive = false;
	};

	const schedulePointerCache = createFrameScheduler(cacheReactiveRects);
	const onScroll = () => {
		scrollY = window.scrollY;
		schedulePointerCache();
	};

	const onResize = () => {
		if (measure()) {
			if (stars.length === 0) populate();
			cacheReactiveRects();
			if (reducedMotion) render();
		}
	};

	// The loop is started and stopped through these two helpers so that tab
	// visibility, pause() and destroy() cannot disagree about the frame handle.
	let paused = false;

	const stop = () => {
		cancelAnimationFrame(frame);
		frame = 0;
		lastFrameTime = 0;
	};

	const startLoop = () => {
		if (frame || reducedMotion || paused) return;
		frame = requestAnimationFrame(loop);
	};

	const onVisibilityChange = () => {
		if (document.hidden) stop();
		else startLoop();
	};

	let meteors: Meteor[] = [];
	let nextMeteorAt = 4 + Math.random() * 6;

	let resizeObserver: ResizeObserver | undefined;

	// Boot: measure, seed the sky, wire the observers, then start the loop.
	function init() {
		measure();
		populate();
		cacheReactiveRects();

		if (typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(onResize);
			resizeObserver.observe(canvas);
		} else {
			window.addEventListener('resize', onResize, { passive: true });
		}

		if (reducedMotion) {
			// Reduced motion: one static frame, no loop, no pointer response.
			render();
			return;
		}

		window.addEventListener('scroll', onScroll, { passive: true });

		if (pointerEffects) {
			window.addEventListener('pointermove', onPointerMove, { passive: true });
			document.addEventListener('pointerleave', onPointerLeave);
			window.addEventListener('blur', onPointerLeave);
		}

		document.addEventListener('visibilitychange', onVisibilityChange);
		startLoop();
	}

	init();

	return {
		options,
		render,
		count: () => stars.length,
		pause: () => {
			paused = true;
			stop();
		},
		resume: () => {
			paused = false;
			if (isPageVisible()) startLoop();
		},
		regenerate: () => {
			buildLut(options.color);
			populate();
			if (reducedMotion) render();
		},
		destroy: () => {
			paused = true;
			stop();
			resizeObserver?.disconnect();
			window.removeEventListener('resize', onResize);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('pointermove', onPointerMove);
			window.removeEventListener('blur', onPointerLeave);
			document.removeEventListener('pointerleave', onPointerLeave);
			document.removeEventListener('visibilitychange', onVisibilityChange);
		},
	};
}

/** Canvases already initialised, so boot() can never double-start the sky. */
const started = new WeakSet<HTMLCanvasElement>();

/**
 * Site background entry point: finds <canvas data-starfield> and starts the
 * engine with the tuned site defaults, shaped by the settings store:
 *
 *   starDensity     scales the population linearly (1 = site default, 0 =
 *                   empty sky — minCount scales with it so the clamp does
 *                   not floor the field back into existence);
 *   performanceMode uses the engine's existing cost knobs: 30fps cap, dpr 1,
 *                   no meteors (SITE_DEFAULTS documents each as the cheaper
 *                   alternative — this is the path the Lab tuner exercises);
 *   reducedEffects  freezes the sky to one static frame, exactly like the
 *                   prefers-reduced-motion path inside the engine;
 *   cursorEffects   toggles the pointer response (radius/boost to 0 — the
 *                   excitation system is shared, so the soft reactive-area
 *                   lift quiets with it).
 *
 * All four re-apply live through subscribeSettings(); the engine already
 * reads `options` per frame and exposes regenerate()/pause()/resume().
 *
 * Called once from scripts/boot.ts.
 */
export function initStarfield(): void {
	const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-starfield]');
	if (!canvas || started.has(canvas)) return;
	started.add(canvas);

	const color = getComputedStyle(document.documentElement)
		.getPropertyValue('--star-color')
		.trim();

	const settings = getSettings();

	const densityOptions = (density: number) => ({
		starsPerMegapixel: Math.max(0, Math.round(SITE_DEFAULTS.starsPerMegapixel * density)),
		minCount: Math.max(0, Math.round(SITE_DEFAULTS.minCount * density)),
	});
	const perfOptions = (perf: boolean) => ({
		targetFps: perf ? 30 : SITE_DEFAULTS.targetFps,
		maxDpr: perf ? 1 : SITE_DEFAULTS.maxDpr,
		shootingStars: perf ? false : SITE_DEFAULTS.shootingStars,
	});
	const pointerOptions = (on: boolean) => ({
		pointerRadius: on ? SITE_DEFAULTS.pointerRadius : 0,
		pointerBoost: on ? SITE_DEFAULTS.pointerBoost : 0,
		reactiveBoost: on ? SITE_DEFAULTS.reactiveBoost : 0,
	});

	const field = createStarfield(canvas, {
		...(color ? { color } : {}),
		...densityOptions(settings.starDensity),
		...perfOptions(settings.performanceMode),
		...pointerOptions(settings.cursorEffects),
	});

	// The light (Frutiger Aero) theme owns the sky: the starfield rests instead
	// of burning frames behind an invisible canvas. The reduced-effects static
	// sky rests the same way (pause + one rendered frame = frozen sky).
	const root = document.documentElement;
	let staticSky = settings.reducedEffects;
	const syncTheme = () => {
		if (root.dataset.theme === 'light' || staticSky) {
			field.pause();
			// A paused canvas keeps whatever was last drawn; make sure a sky
			// exists when we freeze before the loop ever ran.
			field.render();
		} else {
			field.resume();
		}
	};
	new MutationObserver(syncTheme).observe(root, {
		attributes: true,
		attributeFilter: ['data-theme'],
	});
	syncTheme();

	let prev = settings;
	subscribeSettings((next) => {
		if (next.starDensity !== prev.starDensity) {
			Object.assign(field.options, densityOptions(next.starDensity));
			field.regenerate();
		}
		if (next.performanceMode !== prev.performanceMode) {
			Object.assign(field.options, perfOptions(next.performanceMode));
		}
		if (next.cursorEffects !== prev.cursorEffects) {
			Object.assign(field.options, pointerOptions(next.cursorEffects));
		}
		if (next.reducedEffects !== prev.reducedEffects) {
			staticSky = next.reducedEffects;
			syncTheme();
		}
		prev = next;
	});
}
