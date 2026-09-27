/**
 * Fluid Sandbox — controller.
 *
 * Wires one <section data-lab-experiment="fluid-sandbox"> to the solver and
 * renderer. It follows the lab isolation contract (src/data/lab.ts): every
 * query is scoped to `root`, it never writes to :root, its rAF loop stops
 * when the experiment is offscreen OR the tab is hidden, and destroy()
 * removes every listener/observer it added.
 *
 * DOM hooks (all data attributes, see FluidSandbox.astro):
 *   data-fluid-canvas / -stage / -hint / -fallback
 *   data-fluid-tool="pour|solid|…"     tool buttons (aria-pressed)
 *   data-fluid-in="viscosity|…"        sliders, paired with data-fluid-out
 *   data-fluid-color="0..n|-1"         swatches (-1 = spectrum)
 *   data-fluid-scene / -quality         selects
 *   data-fluid-mixing                   checkbox
 *   data-fluid-action="play|reset|clear-liquid|clear-solids"
 *   data-fluid-stat="fps|particles|sim"
 */
import { clamp, prefersReducedMotion } from '../../../scripts/environment';
import {
	FLUID_DEFAULTS,
	FLUID_PALETTE,
	FLUID_QUALITY,
	FLUID_RENDER,
	FLUID_SLIDERS,
	FLUID_SOLVER,
	FLUID_TOOLS,
	type FluidQuality,
	type FluidSceneId,
	type FluidSettings,
	type FluidTool,
	toLightTone,
	type RGB,
	type SliderKey,
} from './config';
import { createRenderer, type FluidRenderer, type Theme } from './renderer';
import { loadScene } from './scenes';
import { FlipSolver } from './solver';

const G = 9.81;

/**
 * <select> seen through HTMLElement: the Workers type definitions in this
 * project overload Element.remove() and make HTMLSelectElement fail the
 * querySelector constraint, so only the one property used is declared.
 */
type SelectLike = HTMLElement & { value: string };

function hsv(h: number, s: number, v: number): RGB {
	const f = (n: number) => {
		const k = (n + h * 6) % 6;
		return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
	};
	return [f(5), f(3), f(1)];
}

export function startFluidSandbox(root: HTMLElement): () => void {
	const stage = root.querySelector<HTMLElement>('[data-fluid-stage]');
	const initialCanvas = root.querySelector<HTMLCanvasElement>('[data-fluid-canvas]');
	const fallback = root.querySelector<HTMLElement>('[data-fluid-fallback]');
	const hintEl = root.querySelector<HTMLElement>('[data-fluid-hint]');
	if (!stage || !initialCanvas) return () => {};

	const settings: FluidSettings = { ...FLUID_DEFAULTS };
	const reducedMotion = prefersReducedMotion();
	const cleanups: (() => void)[] = [];
	const on = <K extends keyof HTMLElementEventMap>(
		target: HTMLElement | Document | Window,
		type: K | string,
		handler: (event: never) => void,
		options?: AddEventListenerOptions,
	) => {
		target.addEventListener(type, handler as EventListener, options);
		cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
	};

	const created = createRenderer(initialCanvas, FLUID_QUALITY[settings.quality].fieldScale);
	if (!created) {
		initialCanvas.hidden = true;
		if (fallback) fallback.hidden = false;
		return () => {};
	}
	let renderer: FluidRenderer = created.renderer;
	const canvas = created.canvas;
	stage.dataset.renderer = renderer.kind;

	/* --- state -------------------------------------------------------------- */

	let solver!: FlipSolver;
	let speeds = new Float32Array(0);
	let theme: Theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
	let running = !reducedMotion;
	let visible = true;
	let frame = 0;
	let lastTime = 0;
	let fpsFrames = 0;
	let fpsClock = 0;
	let simMs = 0;
	let boxW = 1;
	let boxH = 1;
	let simAspect = 0;

	const pointer = {
		inside: false,
		down: false,
		id: -1,
		x: 0,
		y: 0,
		lastX: 0,
		lastY: 0,
		vx: 0,
		vy: 0,
		lastMove: 0,
	};

	const stats = {
		fps: root.querySelector<HTMLElement>('[data-fluid-stat="fps"]'),
		particles: root.querySelector<HTMLElement>('[data-fluid-stat="particles"]'),
		sim: root.querySelector<HTMLElement>('[data-fluid-stat="sim"]'),
	};

	/* --- colour ------------------------------------------------------------- */

	const currentColor = (now = performance.now()): RGB => {
		if (settings.color < 0) {
			const hue = (now % FLUID_RENDER.spectrumPeriodMs) / FLUID_RENDER.spectrumPeriodMs;
			return hsv(hue, 0.72, 1);
		}
		return FLUID_PALETTE[settings.color]?.dark ?? FLUID_PALETTE[0].dark;
	};

	const sceneColors = (): RGB[] => {
		// The selected colour leads; the rest of the palette follows in order.
		const first = settings.color >= 0 ? settings.color : 0;
		return FLUID_PALETTE.map((_, i) => FLUID_PALETTE[(first + i) % FLUID_PALETTE.length].dark);
	};

	/* --- build / resize ----------------------------------------------------- */

	function measure(): boolean {
		const box = stage!.getBoundingClientRect();
		const w = Math.max(1, Math.round(box.width));
		const h = Math.max(1, Math.round(box.height));
		if (w === boxW && h === boxH) return false;
		boxW = w;
		boxH = h;
		renderer.resize(w, h, Math.min(FLUID_RENDER.maxDpr, window.devicePixelRatio || 1));
		return true;
	}

	function build(scene: FluidSceneId = settings.scene): void {
		const tier = FLUID_QUALITY[settings.quality];
		simAspect = boxW / boxH;
		const cellsY = tier.cellsY;
		const cellsX = Math.max(8, Math.round(cellsY * simAspect));
		solver = new FlipSolver(cellsX + 2, cellsY + 2, tier.maxParticles);
		speeds = new Float32Array(tier.maxParticles);
		loadScene(solver, scene, sceneColors());
		updateParticleStat();
		draw();
	}

	function onResize(): void {
		if (!measure()) return;
		// Rotating a phone changes the box shape; rebuild the grid so cells
		// stay square instead of stretching the liquid.
		if (Math.abs(boxW / boxH - simAspect) / simAspect > 0.1) build();
		else draw();
	}

	/* --- simulation loop ---------------------------------------------------- */

	function gravity(): [number, number] {
		// 9.81 m/s² in a tank FLUID_SOLVER.tankHeightMetres tall, in cells/s².
		const g = settings.gravity * G * ((solver.numY - 2) / FLUID_SOLVER.tankHeightMetres);
		const a = (settings.tilt * Math.PI) / 180;
		return [Math.sin(a) * g, Math.cos(a) * g];
	}

	function applyTool(dt: number): void {
		if (!pointer.down) {
			solver.setObstacle(false);
			return;
		}
		const r = settings.brush;
		switch (settings.tool) {
			case 'pour': {
				const budget = Math.max(2, Math.round(r * r * 0.9 * (dt * 60)));
				solver.pour(pointer.x, pointer.y, r * 0.7, pointer.vx * 0.5, pointer.vy * 0.5 + 10, currentColor(), budget);
				updateParticleStat();
				break;
			}
			case 'push':
				solver.setObstacle(true, pointer.x, pointer.y, r * 0.8, pointer.vx, pointer.vy);
				break;
			case 'drain':
				solver.drain(pointer.x, pointer.y, r);
				updateParticleStat();
				break;
			default:
				// solid / erase are applied from pointer events (stroke based).
				break;
		}
	}

	function updateSpeeds(): void {
		const { vel, count } = solver;
		for (let p = 0; p < count; p++) speeds[p] = Math.hypot(vel[2 * p], vel[2 * p + 1]);
	}

	function draw(): void {
		if (!solver) return;
		updateSpeeds();
		const showCursor = pointer.inside || pointer.down;
		renderer.render({
			solver,
			speeds,
			theme,
			foam: settings.foam,
			cursor: showCursor ? { x: pointer.x, y: pointer.y, r: settings.brush, tool: settings.tool } : null,
		});
	}

	function tick(now: number): void {
		frame = requestAnimationFrame(tick);
		const realDt = lastTime ? clamp((now - lastTime) / 1000, 0, 0.1) : 1 / 60;
		lastTime = now;

		// Pointer velocity decays when the pointer rests, so a still brush
		// does not keep flinging liquid with its last flick.
		if (now - pointer.lastMove > 60) {
			pointer.vx *= 0.8;
			pointer.vy *= 0.8;
		}

		if (running) {
			const dt = realDt * settings.speed;
			applyTool(dt);
			const [gx, gy] = gravity();
			const t0 = performance.now();
			solver.step({
				dt,
				gravityX: gx,
				gravityY: gy,
				viscosity: settings.viscosity,
				cohesion: settings.cohesion,
				colorMixing: settings.colorMixing,
			});
			simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
		}
		draw();

		fpsFrames += 1;
		fpsClock += realDt;
		if (fpsClock >= 0.5) {
			if (stats.fps) stats.fps.textContent = String(Math.round(fpsFrames / fpsClock));
			if (stats.sim) stats.sim.textContent = running ? simMs.toFixed(1) : '—';
			fpsFrames = 0;
			fpsClock = 0;
		}
	}

	function startLoop(): void {
		if (frame || !visible || document.hidden) return;
		lastTime = 0;
		frame = requestAnimationFrame(tick);
	}

	function stopLoop(): void {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	}

	function updateParticleStat(): void {
		if (stats.particles) stats.particles.textContent = `${solver.count.toLocaleString()} / ${solver.maxParticles.toLocaleString()}`;
	}

	/* --- pointer ------------------------------------------------------------ */

	function toSim(event: PointerEvent): [number, number] {
		const box = canvas.getBoundingClientRect();
		const fx = (event.clientX - box.left) / Math.max(1, box.width);
		const fy = (event.clientY - box.top) / Math.max(1, box.height);
		return [1 + fx * (solver.numX - 2), 1 + fy * (solver.numY - 2)];
	}

	function stroke(x0: number, y0: number, x1: number, y1: number): void {
		if (settings.tool === 'solid') solver.stampSolidLine(x0, y0, x1, y1, settings.brush * 0.55, 1);
		else if (settings.tool === 'erase') solver.stampSolidLine(x0, y0, x1, y1, settings.brush, 0);
		else return;
		if (!running) draw();
	}

	on(canvas, 'pointerdown', (event: PointerEvent) => {
		if (event.button !== 0 && event.pointerType === 'mouse') return;
		event.preventDefault();
		canvas.setPointerCapture(event.pointerId);
		const [x, y] = toSim(event);
		Object.assign(pointer, { down: true, id: event.pointerId, x, y, lastX: x, lastY: y, vx: 0, vy: 0, inside: true });
		pointer.lastMove = performance.now();
		stroke(x, y, x, y);
		if (!running && settings.tool === 'drain') {
			solver.drain(x, y, settings.brush);
			updateParticleStat();
			draw();
		}
	});

	on(canvas, 'pointermove', (event: PointerEvent) => {
		const [x, y] = toSim(event);
		const now = performance.now();
		const dt = Math.max(1, now - pointer.lastMove) / 1000;
		if (pointer.down && event.pointerId === pointer.id) {
			// Smoothed velocity in cells/s; clamped so a jittery trackpad
			// cannot fire liquid through a wall.
			const limit = 120;
			pointer.vx = clamp(pointer.vx * 0.5 + ((x - pointer.x) / dt) * 0.5, -limit, limit);
			pointer.vy = clamp(pointer.vy * 0.5 + ((y - pointer.y) / dt) * 0.5, -limit, limit);
			stroke(pointer.x, pointer.y, x, y);
			if (!running && settings.tool === 'drain') {
				solver.drain(x, y, settings.brush);
				updateParticleStat();
			}
		}
		pointer.lastX = pointer.x;
		pointer.lastY = pointer.y;
		pointer.x = x;
		pointer.y = y;
		pointer.lastMove = now;
		pointer.inside = true;
		if (!frame) draw();
	});

	const release = (event: PointerEvent) => {
		if (event.pointerId !== pointer.id) return;
		pointer.down = false;
		pointer.id = -1;
		solver.setObstacle(false);
		if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	};
	on(canvas, 'pointerup', release);
	on(canvas, 'pointercancel', release);
	on(canvas, 'pointerleave', () => {
		if (!pointer.down) pointer.inside = false;
		if (!frame) draw();
	});
	on(canvas, 'contextmenu', (event: Event) => event.preventDefault());

	/* --- controls ----------------------------------------------------------- */

	const toolButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-fluid-tool]'));
	const colorButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-fluid-color]'));
	const playButton = root.querySelector<HTMLButtonElement>('[data-fluid-action="play"]');

	function setTool(tool: FluidTool): void {
		settings.tool = tool;
		for (const button of toolButtons) button.setAttribute('aria-pressed', String(button.dataset.fluidTool === tool));
		stage!.dataset.tool = tool;
		updateHint();
	}

	function updateHint(): void {
		if (!hintEl) return;
		const tool = FLUID_TOOLS.find((t) => t.id === settings.tool);
		hintEl.textContent = running
			? `${tool?.hint ?? ''} · 1–5 tools · space pauses`
			: reducedMotion && !lastTime
				? 'motion reduced · press play to run the simulation'
				: `paused · ${tool?.hint ?? ''}`;
	}

	function setRunning(next: boolean): void {
		running = next;
		if (playButton) {
			playButton.textContent = running ? 'Pause' : 'Play';
			playButton.setAttribute('aria-pressed', String(!running));
		}
		updateHint();
	}

	function setColor(index: number): void {
		settings.color = index;
		for (const button of colorButtons) {
			button.setAttribute('aria-pressed', String(Number(button.dataset.fluidColor) === index));
		}
	}

	for (const button of toolButtons) {
		on(button, 'click', () => setTool(button.dataset.fluidTool as FluidTool));
	}
	for (const button of colorButtons) {
		on(button, 'click', () => setColor(Number(button.dataset.fluidColor)));
	}

	for (const spec of FLUID_SLIDERS) {
		const input = root.querySelector<HTMLInputElement>(`[data-fluid-in="${spec.key}"]`);
		const output = root.querySelector<HTMLOutputElement>(`[data-fluid-out="${spec.key}"]`);
		if (!input) continue;
		const show = () => {
			if (output) output.textContent = `${settings[spec.key].toFixed(spec.digits)}${spec.unit ?? ''}`;
		};
		input.value = String(settings[spec.key]);
		show();
		on(input, 'input', () => {
			settings[spec.key as SliderKey] = Number(input.value);
			show();
			if (!frame) draw();
		});
	}

	const sceneSelect = root.querySelector<HTMLElement>('[data-fluid-scene]') as SelectLike | null;
	if (sceneSelect) {
		sceneSelect.value = settings.scene;
		on(sceneSelect, 'change', () => {
			settings.scene = sceneSelect.value as FluidSceneId;
			build();
		});
	}

	const qualitySelect = root.querySelector<HTMLElement>('[data-fluid-quality]') as SelectLike | null;
	if (qualitySelect) {
		qualitySelect.value = settings.quality;
		on(qualitySelect, 'change', () => {
			settings.quality = qualitySelect.value as FluidQuality;
			// The field resolution belongs to the renderer: rebuild it at the
			// new scale (same canvas, context is reused).
			const next = createRenderer(canvas, FLUID_QUALITY[settings.quality].fieldScale);
			if (next && next.canvas === canvas) {
				renderer.destroy();
				renderer = next.renderer;
			}
			boxW = boxH = 0;
			measure();
			build();
		});
	}

	const mixing = root.querySelector<HTMLInputElement>('[data-fluid-mixing]');
	if (mixing) {
		mixing.checked = settings.colorMixing;
		on(mixing, 'change', () => {
			settings.colorMixing = mixing.checked;
		});
	}

	root.querySelectorAll<HTMLButtonElement>('[data-fluid-action]').forEach((button) => {
		on(button, 'click', () => {
			switch (button.dataset.fluidAction) {
				case 'play':
					setRunning(!running);
					break;
				case 'reset':
					build();
					break;
				case 'clear-liquid':
					solver.clearParticles();
					updateParticleStat();
					break;
				case 'clear-solids':
					solver.clearSolids();
					break;
			}
			if (!frame) draw();
		});
	});

	// Keyboard shortcuts, only while the stage itself has focus so they never
	// hijack typing or page scrolling elsewhere.
	on(stage, 'keydown', (event: KeyboardEvent) => {
		const index = Number(event.key) - 1;
		if (index >= 0 && index < FLUID_TOOLS.length) {
			setTool(FLUID_TOOLS[index].id);
		} else if (event.key === ' ') {
			setRunning(!running);
		} else if (event.key.toLowerCase() === 'r') {
			build();
		} else {
			return;
		}
		event.preventDefault();
	});

	/* --- theme + lifecycle -------------------------------------------------- */

	const themeObserver = new MutationObserver(() => {
		theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
		if (!frame) draw();
	});
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	cleanups.push(() => themeObserver.disconnect());

	if (typeof ResizeObserver !== 'undefined') {
		const ro = new ResizeObserver(onResize);
		ro.observe(stage);
		cleanups.push(() => ro.disconnect());
	} else {
		on(window, 'resize', onResize, { passive: true });
	}

	if (typeof IntersectionObserver !== 'undefined') {
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					visible = entry.isIntersecting;
					if (visible) startLoop();
					else stopLoop();
				}
			},
			{ rootMargin: '10% 0px' },
		);
		io.observe(root);
		cleanups.push(() => io.disconnect());
	}

	on(document, 'visibilitychange', () => {
		if (document.hidden) stopLoop();
		else startLoop();
	});

	on(canvas, 'webglcontextlost', (event: Event) => {
		event.preventDefault();
		stopLoop();
	});
	on(canvas, 'webglcontextrestored', () => {
		const next = createRenderer(canvas, FLUID_QUALITY[settings.quality].fieldScale);
		if (next) renderer = next.renderer;
		boxW = boxH = 0;
		measure();
		startLoop();
	});

	/* --- boot ----------------------------------------------------------------- */

	for (const button of colorButtons) {
		const index = Number(button.dataset.fluidColor);
		if (index >= 0) {
			// Own element's inline custom properties only (isolation rule 3).
			const rgb = (c: RGB) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;
			const dark = FLUID_PALETTE[index].dark;
			button.style.setProperty('--swatch-dark', rgb(dark));
			button.style.setProperty('--swatch-light', rgb(dark.map(toLightTone) as RGB));
		}
	}
	setTool(settings.tool);
	setColor(settings.color);
	measure();
	build();
	setRunning(running);
	startLoop();

	return () => {
		stopLoop();
		for (const cleanup of cleanups.splice(0)) cleanup();
		renderer.destroy();
	};
}
