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
	| 'ReactionTimer';

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
		slug: 'starfield-tuner',
		title: 'Starfield Tuner',
		description:
			'The same engine that draws the site background, exposed through live controls. Dial in density, twinkle and cursor response, then copy the numbers back into the component.',
		tags: ['canvas', 'starfield', 'tuning'],
		status: 'live',
		component: 'StarfieldTuner',
		question: 'How sparse can a sky be before it feels dead?',
	},
	{
		slug: 'glass-bench',
		title: 'Liquid Glass Bench',
		description:
			'A test surface for the glass design system: opacity, blur, saturation and border strength as sliders, with the resulting token values printed live.',
		tags: ['css', 'design system', 'glass'],
		status: 'live',
		component: 'GlassBench',
		question: 'Where does glass stop being glass and become fog?',
	},
	{
		slug: 'orbit-field',
		title: 'Orbit Field',
		description:
			'A few hundred particles under pointer gravity, integrated with semi-implicit Euler and clamped so a fast cursor cannot explode the simulation.',
		tags: ['canvas', 'physics', 'pointer'],
		status: 'live',
		component: 'OrbitField',
		question: 'Can a physics toy stay under 1% CPU on a phone?',
	},
	{
		slug: 'webgl-nebula',
		title: 'WebGL Nebula',
		description:
			'A raymarched volumetric background meant to sit behind the hero at a fraction of the cost of the current gradient layers.',
		tags: ['webgl', 'shaders'],
		status: 'wip',
		question: 'Is a shader cheaper than four backdrop-filters?',
	},
	{
		slug: 'audio-reactive-sky',
		title: 'Audio-Reactive Sky',
		description:
			'Web Audio analyser driving star brightness — music makes the sky breathe. Needs a user gesture to start, so it lives in the Lab and not on the homepage.',
		tags: ['web audio', 'canvas'],
		status: 'idea',
		question: 'What does a mix look like as a starfield?',
	},
	{
		slug: 'minecraft-world-viewer',
		title: 'Minecraft World Viewer',
		description:
			'Read a region file, draw chunks on a canvas, pan around a world without launching the game.',
		tags: ['minecraft', 'canvas', 'parsing'],
		status: 'idea',
		question: 'How fast can region files be decoded in the browser?',
	},
	{
		slug: 'bubble-pop',
		title: 'Bubble Pop',
		description:
			'A small arcade loop: glossy bubbles rise through the panel and pop when clicked or tapped. Score, combo streak and a calm mode for reduced motion.',
		tags: ['game', 'canvas', 'arcade'],
		status: 'live',
		component: 'BubblePop',
		question: 'How few lines can a genuinely playable browser toy be?',
	},
	{
		slug: 'memory-pairs',
		title: 'Memory Pairs',
		description:
			'The classic flip-and-match card game on a 4x4 glass grid. Move counter, best score in session storage, fully keyboard playable.',
		tags: ['game', 'dom', 'keyboard'],
		status: 'live',
		component: 'MemoryPairs',
		question: 'Can a DOM game stay smooth without a canvas or a framework?',
	},
	{
		slug: 'reaction-timer',
		title: 'Reaction Timer',
		description:
			'Measure response time in milliseconds: wait for the glow, click or press Space as fast as possible. Five rounds, median and best tracked.',
		tags: ['tool', 'input', 'measurement'],
		status: 'live',
		component: 'ReactionTimer',
		question: 'How does input latency feel across devices and themes?',
	},

];

/** Experiments that can actually be run on the page. */
export function getRunnableExperiments(): Experiment[] {
	return EXPERIMENTS.filter((experiment) => experiment.status === 'live' && experiment.component);
}
