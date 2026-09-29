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
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['physics', 'simulation', 'interactive'],
		status: 'live',
		component: 'FluidSandbox',
		question: 'Lorem ipsum dolor sit amet consectetur adipiscing elit?',
	},
	{
		slug: 'piano-bars',
		title: '3D Piano Bars',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['3d', 'audio', 'interactive'],
		status: 'live',
		component: 'PianoBars',
	},
	{
		slug: 'stack-game',
		title: 'Isometric Stack',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['game', '3d', 'physics'],
		status: 'live',
		component: 'StackGame',
	},
	{
		slug: 'iso-progress',
		title: '3D Isometric Progress Bar',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['3d', 'tools', 'interactive'],
		status: 'live',
		component: 'IsoProgress',
	},
	{
		slug: 'cursor-trails',
		title: 'Trailing Cursor Laboratory',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['particles', 'physics', 'interactive'],
		status: 'live',
		component: 'CursorTrails',
	},
	{
		slug: 'voxel-map',
		title: '3D Voxel Map Creator',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['3d', 'tools', 'interactive'],
		status: 'live',
		component: 'VoxelMap',
	},
	{
		slug: 'glass-minesweeper',
		title: 'Minesweeper',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['game', 'interactive'],
		status: 'live',
		component: 'GlassMinesweeper',
	},
	{
		slug: 'cps-counter',
		title: 'CPS Counter',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['benchmark', 'tools', 'interactive'],
		status: 'live',
		component: 'CpsCounter',
	},
	{
		slug: 'starfield-tuner',
		title: 'Starfield Tuner',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['canvas', 'tools'],
		status: 'live',
		component: 'StarfieldTuner',
	},
	{
		slug: 'glass-bench',
		title: 'Liquid Glass Optical Laboratory',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['tools', 'interactive'],
		status: 'live',
		component: 'GlassBench',
	},
	{
		slug: 'orbit-field',
		title: 'Orbit Field',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['particles', 'physics', 'canvas'],
		status: 'live',
		component: 'OrbitField',
	},
	{
		slug: 'webgl-nebula',
		title: 'WebGL Nebula',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['3d', 'canvas'],
		status: 'wip',
	},
	{
		slug: 'audio-reactive-sky',
		title: 'Audio-Reactive Sky',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['audio', 'canvas'],
		status: 'idea',
	},
	{
		slug: 'minecraft-world-viewer',
		title: 'Minecraft World Viewer',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['3d', 'tools'],
		status: 'idea',
	},
	{
		slug: 'bubble-pop',
		title: 'Bubble Pop',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['game', 'canvas', 'interactive'],
		status: 'live',
		component: 'BubblePop',
	},
	{
		slug: 'memory-pairs',
		title: 'Memory Pairs',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['game', 'interactive'],
		status: 'live',
		component: 'MemoryPairs',
	},
	{
		slug: 'reaction-timer',
		title: 'Reaction Timer',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['benchmark', 'tools', 'interactive'],
		status: 'live',
		component: 'ReactionTimer',
	},
];

/** Experiments that can actually be run on the page. */
export function getRunnableExperiments(): Experiment[] {
	return EXPERIMENTS.filter((experiment) => experiment.status === 'live' && experiment.component);
}
