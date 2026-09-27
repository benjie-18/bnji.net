/**
 * Fluid Sandbox — every tunable lives here.
 *
 * The lab experiment is split into four modules so each concern can be edited
 * without reading the others:
 *
 *   config.ts      THIS FILE: defaults, slider ranges, palettes, quality tiers.
 *   solver.ts      FLIP/PIC liquid solver (pure math, no DOM).
 *   scenes.ts      Preset layouts (liquid blocks + solids), in 0..1 fractions.
 *   renderer.ts    WebGL metaball renderer with a Canvas 2D fallback.
 *   controller.ts  DOM wiring: controls, pointer tools, lifecycle, destroy().
 *
 * Nothing outside src/components/lab/fluid/ and FluidSandbox.astro imports
 * these files, and they import nothing from the rest of the site except the
 * shared environment helpers.
 */

export type FluidTool = 'pour' | 'solid' | 'erase' | 'push' | 'drain';
export type FluidQuality = 'low' | 'medium' | 'high';
export type FluidSceneId = 'dam' | 'basins' | 'funnel' | 'cascade' | 'empty';

/** A user-facing slider: key into FluidSettings + its range and formatting. */
export type SliderSpec = {
	key: SliderKey;
	label: string;
	min: number;
	max: number;
	step: number;
	/** Decimal places shown in the <output>. */
	digits: number;
	unit?: string;
};

export type SliderKey =
	| 'viscosity'
	| 'gravity'
	| 'tilt'
	| 'speed'
	| 'cohesion'
	| 'brush'
	| 'foam';

export type FluidSettings = Record<SliderKey, number> & {
	tool: FluidTool;
	quality: FluidQuality;
	scene: FluidSceneId;
	/** Index into FLUID_PALETTE, or -1 for the cycling "spectrum" swatch. */
	color: number;
	colorMixing: boolean;
};

export const FLUID_DEFAULTS: FluidSettings = {
	viscosity: 0.08,
	gravity: 1,
	tilt: 0,
	speed: 1,
	cohesion: 0.2,
	brush: 3.2,
	foam: 0.6,
	tool: 'pour',
	quality: 'medium',
	scene: 'dam',
	color: 0,
	colorMixing: true,
};

export const FLUID_SLIDERS: SliderSpec[] = [
	{ key: 'viscosity', label: 'Viscosity', min: 0, max: 1, step: 0.01, digits: 2 },
	{ key: 'gravity', label: 'Gravity', min: 0, max: 2.5, step: 0.05, digits: 2, unit: 'g' },
	{ key: 'tilt', label: 'Gravity angle', min: -90, max: 90, step: 1, digits: 0, unit: '°' },
	{ key: 'speed', label: 'Speed', min: 0.25, max: 2, step: 0.05, digits: 2, unit: '×' },
	{ key: 'cohesion', label: 'Cohesion', min: 0, max: 1, step: 0.01, digits: 2 },
	{ key: 'foam', label: 'Foam', min: 0, max: 1, step: 0.01, digits: 2 },
	{ key: 'brush', label: 'Brush size', min: 1, max: 8, step: 0.1, digits: 1 },
];

export const FLUID_TOOLS: { id: FluidTool; label: string; hint: string }[] = [
	{ id: 'pour', label: 'Pour', hint: 'drag to pour liquid' },
	{ id: 'solid', label: 'Solid', hint: 'drag to draw walls' },
	{ id: 'erase', label: 'Erase', hint: 'drag to erase walls' },
	{ id: 'push', label: 'Push', hint: 'drag to stir the liquid' },
	{ id: 'drain', label: 'Drain', hint: 'drag to remove liquid' },
];

export const FLUID_SCENES: { id: FluidSceneId; label: string }[] = [
	{ id: 'dam', label: 'Dam break' },
	{ id: 'basins', label: 'Twin basins' },
	{ id: 'funnel', label: 'Funnel' },
	{ id: 'cascade', label: 'Cascade' },
	{ id: 'empty', label: 'Empty box' },
];

/**
 * Liquid colours as RGB in 0..1 (shader inputs, not CSS; the palette mirrors
 * the site accents). Particles always carry the `dark` value — the renderer
 * deepens it for the light theme, so switching theme never has to recolour
 * (or un-mix) liquid already in the box. `toLightTone` is that mapping; the
 * swatch buttons use it too so they always match the liquid.
 */
export const FLUID_PALETTE: { id: string; label: string; dark: RGB }[] = [
	{ id: 'aqua', label: 'Aqua', dark: [0.3, 0.72, 1.0] },
	{ id: 'aurora', label: 'Aurora', dark: [0.25, 0.95, 0.78] },
	{ id: 'ember', label: 'Ember', dark: [1.0, 0.55, 0.22] },
	{ id: 'rose', label: 'Rose', dark: [1.0, 0.42, 0.66] },
	{ id: 'lime', label: 'Lime', dark: [0.66, 1.0, 0.32] },
	{ id: 'violet', label: 'Violet', dark: [0.66, 0.52, 1.0] },
];

export type RGB = [number, number, number];

/** Night palette → Aero palette. Mirrored in the composite shader (renderer.ts). */
export const LIGHT_TONE = { pivot: 0.22, gain: 1.18, lift: 0.04 };

export function toLightTone(c: number): number {
	return Math.min(1, Math.max(0, (c - LIGHT_TONE.pivot) * LIGHT_TONE.gain + LIGHT_TONE.lift));
}

/** Grid height in cells and particle budget per quality tier. */
export const FLUID_QUALITY: Record<FluidQuality, { cellsY: number; maxParticles: number; fieldScale: number }> = {
	low: { cellsY: 44, maxParticles: 5000, fieldScale: 0.45 },
	medium: { cellsY: 60, maxParticles: 10000, fieldScale: 0.55 },
	high: { cellsY: 80, maxParticles: 17000, fieldScale: 0.7 },
};

/** Solver constants. Change with care; comments say what breaks. */
export const FLUID_SOLVER = {
	/** Particle radius as a fraction of a cell. Rest density is derived from it. */
	particleRadius: 0.3,
	/** Box height in metres used to scale 9.81 m/s² into cells/s². */
	tankHeightMetres: 3,
	/** Rest density multiplier (vs. ideal hex packing). Lower = liquid pushes apart harder. */
	restDensityScale: 1,
	/** Drift-compensation strength: how hard over-dense cells push out. Too high = boiling surface. */
	driftStiffness: 1,
	/** Gauss-Seidel pressure iterations. Fewer = springy, compressible liquid. */
	pressureIterations: 40,
	/** SOR factor for the pressure solve. >1.95 starts to ring. */
	overRelaxation: 1.9,
	/** Particle separation passes. 0 lets particles clump into lattices. */
	separationIterations: 2,
	/** FLIP ratio at zero viscosity. 1 = pure FLIP (noisy), 0 = PIC (syrup). */
	flipRatio: 0.95,
	/** Largest step per frame (s) before sub-stepping; avoids spiral of death. */
	maxFrameDt: 1 / 30,
	/** A particle may travel at most this many cells per sub-step. */
	maxCellsPerSubstep: 0.8,
	maxSubsteps: 4,
	/** Tangential velocity kept when sliding along a solid (1 = frictionless). */
	wallSlip: 0.96,
	/** Colour diffusion between touching particles when mixing is on. */
	colorDiffusion: 0.012,
};

/** Rendering constants for the metaball field. */
export const FLUID_RENDER = {
	/** Splat radius in particle radii. Bigger = smoother, blobbier surface. */
	kernelRadius: 3,
	/** Field value where the surface sits (1 = one isolated particle's peak). */
	threshold: 0.45,
	/** Speed (cells/s) where foam starts / saturates. */
	foamSpeedLow: 18,
	foamSpeedHigh: 60,
	/** Device-pixel-ratio cap for the canvas. */
	maxDpr: 2,
	/** How long (ms) the spectrum swatch takes to cycle the hue wheel. */
	spectrumPeriodMs: 9000,
};

/** Theme-dependent colours for everything that is not the liquid itself. */
export const FLUID_THEME: Record<'dark' | 'light', {
	solid: RGB;
	solidEdge: RGB;
	cursor: Record<FluidTool, RGB>;
}> = {
	dark: {
		solid: [0.2, 0.27, 0.4],
		solidEdge: [0.62, 0.84, 1.0],
		cursor: {
			pour: [0.76, 0.93, 1.0],
			solid: [0.8, 0.86, 1.0],
			erase: [1.0, 0.62, 0.55],
			push: [0.9, 0.9, 1.0],
			drain: [1.0, 0.75, 0.45],
		},
	},
	light: {
		solid: [0.93, 0.97, 1.0],
		solidEdge: [0.2, 0.52, 0.78],
		cursor: {
			pour: [0.0, 0.42, 0.68],
			solid: [0.1, 0.3, 0.55],
			erase: [0.8, 0.22, 0.18],
			push: [0.15, 0.3, 0.5],
			drain: [0.8, 0.42, 0.05],
		},
	},
};
