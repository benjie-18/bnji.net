/**
 * BNJI.NET — Lab experiment registry.
 *
 * /projects/lab/ is the playground: interactive prototypes that are allowed to be
 * strange, but are not allowed to destabilize the rest of the site.
 */

export type LabStatus = 'live' | 'wip' | 'idea';

export const LAB_STATUS_LABEL: Record<LabStatus, string> = {
	live: '',
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
		description: 'Real time customizable fluid physics simulation sandbox.',
		tags: ['physics', 'simulation', 'interactive'],
		status: 'live',
		component: 'FluidSandbox',
	},
	{
		slug: 'piano-bars',
		title: '3D Piano Bars',
		description: 'Interactive 3d piano tiles in CSS.',
		tags: ['3d', 'audio', 'interactive'],
		status: 'live',
		component: 'PianoBars',
	},
	{
		slug: 'stack-game',
		title: 'Isometric Stack',
		description: 'Classic Stack game.',
		tags: ['game', '3d', 'physics'],
		status: 'live',
		component: 'StackGame',
	},
	{
		slug: 'iso-progress',
		title: '3D Isometric Progress Bar',
		description: '3D progress bar in full CSS.',
		tags: ['3d', 'tools', 'interactive'],
		status: 'live',
		component: 'IsoProgress',
	},
	{
		slug: 'cursor-trails',
		title: 'Trailing Cursor Laboratory',
		description: 'Different interactive cursor effects.',
		tags: ['particles', 'physics', 'interactive'],
		status: 'live',
		component: 'CursorTrails',
	},
	{
		slug: 'voxel-map',
		title: '3D Voxel Map Creator',
		description: 'Super low budget minecraft (full CSS), voxel map sandbox.',
		tags: ['3d', 'tools', 'interactive'],
		status: 'live',
		component: 'VoxelMap',
	},
	{
		slug: 'glass-minesweeper',
		title: 'Minesweeper',
		description: 'Classic minesweeper with a couple settings.',
		tags: ['game', 'interactive'],
		status: 'live',
		component: 'GlassMinesweeper',
	},
	{
		slug: 'cps-counter',
		title: 'CPS Counter',
		description: 'Test for clicks per second.',
		tags: ['benchmark', 'tools', 'interactive'],
		status: 'live',
		component: 'CpsCounter',
	},
	{
		slug: 'starfield-tuner',
		title: 'Starfield Tuner',
		description: "Custom CSS starfield background, used early on to create and tweak dark mode's background.",
		tags: ['canvas', 'tools'],
		status: 'live',
		component: 'StarfieldTuner',
	},
	{
		slug: 'glass-bench',
		title: 'Liquid Glass Optical Laboratory',
		description: 'Interactive reflection of the "liquid glass" clone used in UI.',
		tags: ['tools', 'interactive'],
		status: 'live',
		component: 'GlassBench',
	},
	{
		slug: 'orbit-field',
		title: 'Orbit Field',
		description: 'Basic particles and gravity test with cursor tracking.',
		tags: ['particles', 'physics', 'canvas'],
		status: 'live',
		component: 'OrbitField',
	},
	{
		slug: 'bubble-pop',
		title: 'Bubble Pop',
		description: 'Pop bubbles. popopopopop',
		tags: ['game', 'canvas', 'interactive'],
		status: 'live',
		component: 'BubblePop',
	},
	{
		slug: 'memory-pairs',
		title: 'Memory Pairs',
		description: 'Classic memory pairs game.',
		tags: ['game', 'interactive'],
		status: 'live',
		component: 'MemoryPairs',
	},
	{
		slug: 'reaction-timer',
		title: 'Reaction Timer',
		description: 'Test for reaction time with random intervals.',
		tags: ['benchmark', 'tools', 'interactive'],
		status: 'live',
		component: 'ReactionTimer',
	},
];

/** Experiments that can actually be run on the page. */
export function getRunnableExperiments(): Experiment[] {
	return EXPERIMENTS.filter((experiment) => experiment.status === 'live' && experiment.component);
}
