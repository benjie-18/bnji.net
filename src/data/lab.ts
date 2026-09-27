/**
 * BNJI.NET — Lab experiment registry.
 *
 * /lab/ is the playground: interactive prototypes that are allowed to be
 * strange, but are not allowed to destabilize the rest of the site.
 *
 * ISOLATION CONTRACT (see AGENTS.md):
 *  1. An experiment owns its DOM subtree — it never queries outside its own
 *     <section data-lab-experiment>.
 *  2. It owns its rAF loops, and must stop them when out of view, when the tab
 *     is hidden, and when prefers-reduced-motion is set.
 *  3. It never writes to :root or global CSS custom properties. Tune your own
 *     element's inline styles instead (see GlassBench).
 *  4. It imports engines from src/scripts/ rather than copying them.
 *
 * Astro cannot import a component from a runtime string, so `component` is a
 * union of keys in the static import map at the top of src/pages/lab.astro.
 * Adding an experiment = new component + new entry here + one line in that map.
 */

export type LabStatus = 'live' | 'wip' | 'idea';

export const LAB_STATUS_LABEL: Record<LabStatus, string> = {
	live: 'Runnable',
	wip: 'In progress',
	idea: 'Idea',
};

/** Keys of the static component map in src/pages/lab.astro. */
export type LabComponentKey =
	| 'StarfieldTuner'
	| 'GlassBench'
	| 'OrbitField'
	| 'BubblePop'
	| 'MemoryPairs'
	| 'ReactionTimer'
	| 'CpsCounter'
	| 'PianoBars'
	| 'StackGame'
	| 'IsoProgress'
	| 'CursorTrails'
	| 'VoxelMap'
	| 'GlassMinesweeper'
	| 'FluidSandbox';

export type Experiment = {
	slug: string;
	title: string;
	description: string;
	tags: string[];
	status: LabStatus;
	/** Set only when status is "live" and a component implements it. */
	component?: LabComponentKey;
	/** What the experiment is trying to answer — rendered in mono type. */
	question?: string;
};

export const EXPERIMENTS: Experiment[] = [
	{
		slug: 'fluid-sandbox',
		title: 'Fluid Sandbox',
		description:
			'A FLIP/PIC liquid simulation in a glass box. Pour liquid, draw walls, stir and drain it, tilt gravity, and tune viscosity, cohesion, speed and colour — the liquid levels itself, splashes, foams at speed and blends where colours meet.',
		tags: ['physics', 'simulation', 'interactive'],
		status: 'live',
		component: 'FluidSandbox',
		question: 'How convincing can a real pressure-solved liquid feel inside a web page?',
	},
	{
		slug: 'piano-bars',
		title: '3D Piano Bars',
		description:
			'Extruded 3D glass cuboids in continuous sine-wave motion or interactive piano mode. Light up upon hover, press, and keyboard actuation with Web Audio harmonic chime feedback, adapting between dark obsidian and frosty aqua crystal.',
		tags: ['3d', 'audio', 'interactive'],
		status: 'live',
		component: 'PianoBars',
	},
	{
		slug: 'stack-game',
		title: 'Isometric Stack',
		description:
			'A 3D isometric block stacking game adapted to bnji.net’s glass palette. Drop alternating blocks, chop overhangs into falling debris, and sustain combo streaks with precise alignment.',
		tags: ['game', '3d', 'physics'],
		status: 'live',
		component: 'StackGame',
	},
	{
		slug: 'iso-progress',
		title: '3D Isometric Progress Bar',
		description:
			'An extruded 3D isometric progress bar with multi-facet lighting, liquid crystal fluid fill, interactive tilt/yaw perspective sliders, and selectable bnji.net aero colorways.',
		tags: ['3d', 'tools', 'interactive'],
		status: 'live',
		component: 'IsoProgress',
	},
	{
		slug: 'cursor-trails',
		title: 'Trailing Cursor Laboratory',
		description:
			'An interactive pointer trail laboratory with customizable particle shapes (starlight sparks, glass orbs, ribbon streamers, neon dust), physics dynamics (spring drift, gravitational pull, scatter burst), and adaptive themes.',
		tags: ['particles', 'physics', 'interactive'],
		status: 'live',
		component: 'CursorTrails',
	},
	{
		slug: 'voxel-map',
		title: '3D Voxel Map Creator',
		description:
			'An isometric 3D voxel terrain studio with 4-way turntable camera orbit, elevation sculpting tools (raise, lower, flatten), preset topographies, and 6 translucent aero glass materials.',
		tags: ['3d', 'tools', 'interactive'],
		status: 'live',
		component: 'VoxelMap',
	},
	{
		slug: 'glass-minesweeper',
		title: 'Minesweeper',
		description:
			'Classic Minesweeper reimagined in liquid aero glass styling. Features reactive status smiley, live mine counter, digital stopwatch, flag mode toggle, and safe first-click guarantee.',
		tags: ['game', 'interactive'],
		status: 'live',
		component: 'GlassMinesweeper',
	},
	{
		slug: 'cps-counter',
		title: 'CPS Counter',
		description:
			'A high-frequency neuromuscular click speed benchmark. Track burst click frequency across 5s sprint, 10s endurance, or free cadence with live rate, peak velocity, and dynamic ripple feedback.',
		tags: ['benchmark', 'tools', 'interactive'],
		status: 'live',
		component: 'CpsCounter',
	},
	{
		slug: 'starfield-tuner',
		title: 'Starfield Tuner',
		description:
			'The same engine that draws the site background, exposed through live controls. Dial in density, twinkle and cursor response, then copy the numbers back into the component.',
		tags: ['canvas', 'tools'],
		status: 'live',
		component: 'StarfieldTuner',
	},
	{
		slug: 'glass-bench',
		title: 'Liquid Glass Optical Laboratory',
		description:
			'An optical calibration laboratory recreating Apple 2027 Liquid Glass: Snell’s Law refraction, 4th-power squircle SDF bezels, adaptive luminance (glass_L = 0.58·L_bg + 34), Fresnel rims, and test backdrops.',
		tags: ['tools', 'interactive'],
		status: 'live',
		component: 'GlassBench',
	},
	{
		slug: 'orbit-field',
		title: 'Orbit Field',
		description:
			'A few hundred particles under pointer gravity, integrated with semi-implicit Euler and clamped so a fast cursor cannot explode the simulation.',
		tags: ['particles', 'physics', 'canvas'],
		status: 'live',
		component: 'OrbitField',
	},
	{
		slug: 'webgl-nebula',
		title: 'WebGL Nebula',
		description:
			'A raymarched volumetric background meant to sit behind the hero at a fraction of the cost of the current gradient layers.',
		tags: ['3d', 'canvas'],
		status: 'wip',
	},
	{
		slug: 'audio-reactive-sky',
		title: 'Audio-Reactive Sky',
		description:
			'Web Audio analyser driving star brightness — music makes the sky breathe. Needs a user gesture to start, so it lives in the Lab and not on the homepage.',
		tags: ['audio', 'canvas'],
		status: 'idea',
	},
	{
		slug: 'minecraft-world-viewer',
		title: 'Minecraft World Viewer',
		description:
			'Read a region file, draw chunks on a canvas, pan around a world without launching the game.',
		tags: ['3d', 'tools'],
		status: 'idea',
	},
	{
		slug: 'bubble-pop',
		title: 'Bubble Pop',
		description:
			'A small arcade loop: glossy bubbles rise through the panel and pop when clicked or tapped. Score, combo streak and a calm mode for reduced motion.',
		tags: ['game', 'canvas', 'interactive'],
		status: 'live',
		component: 'BubblePop',
	},
	{
		slug: 'memory-pairs',
		title: 'Memory Pairs',
		description:
			'The classic flip-and-match card game on a 4x4 glass grid. Move counter, best score in session storage, fully keyboard playable.',
		tags: ['game', 'interactive'],
		status: 'live',
		component: 'MemoryPairs',
	},
	{
		slug: 'reaction-timer',
		title: 'Reaction Timer',
		description:
			'Measure response time in milliseconds: wait for the glow, click or press Space as fast as possible. Five rounds, median and best tracked.',
		tags: ['benchmark', 'tools', 'interactive'],
		status: 'live',
		component: 'ReactionTimer',
	},
];

/** Experiments that can actually be run on the page. */
export function getRunnableExperiments(): Experiment[] {
	return EXPERIMENTS.filter((experiment) => experiment.status === 'live' && experiment.component);
}
