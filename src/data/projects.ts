/**
 * BNJI.NET — project data.
 *
 * The homepage, /projects/ and any future project view all render from this
 * array. Markup never hard-codes a project, so adding one cannot require a
 * change to a component.
 *
 * Adding a project: append an object below. That is the whole workflow.
 *
 * Content policy: descriptions stay technical and neutral. No personal
 * biography, ownership claims or life details — placeholder copy otherwise.
 */

/**
 * Where a project lives. Drives the badge on the card:
 *  - public: reachable on the internet, `href` required
 *  - local:  runs on private hardware, no public URL
 *  - wip:    actively being built
 *  - idea:   parked / not started
 */
export type ProjectStatus = 'public' | 'local' | 'wip' | 'idea';

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
	public: 'Live',
	local: 'Runs locally',
	wip: 'In progress',
	idea: 'Idea',
};

export type Project = {
	/** Stable id. Used for the card's DOM id and the /projects/ anchor. */
	slug: string;
	title: string;
	/** One or two sentences for cards. Keep under ~150 characters. */
	description: string;
	/** Longer copy for /projects/. Optional. */
	detail?: string;
	tags: string[];
	/**
	 * Optional screenshot path (public/). Cards are designed to read as complete
	 * without one, so leaving it out is a supported state rather than a gap.
	 */
	image?: string;
	/** Public URL or internal route. Omit for local/private work. */
	href?: string;
	status: ProjectStatus;
	/** Featured projects render large on the homepage (max ~3). */
	featured: boolean;
	/** Mono key/value rows for the technical summary. */
	meta?: { label: string; value: string }[];
	/** Rough year, shown in mono type. */
	year?: string;
};

export const PROJECTS: Project[] = [
	{
		slug: 'bnji-net',
		title: 'BNJI.NET',
		description:
			'This site: a digital hub built as a small design system — canvas starfield, liquid glass surfaces, dual themes and a prerendered Astro front end on Cloudflare Workers.',
		detail:
			'Everything public is prerendered at build time and served as static assets from a Cloudflare Worker, so there is no server to babysit. The visual system is token-driven (src/styles/tokens.css) with a dark space theme and a Frutiger Aero light theme; the interaction layer is a handful of small TypeScript modules: starfield, pointer interactions, scroll choreography, board physics and a boot entry. No UI framework is shipped to the client.',
		tags: ['Astro', 'TypeScript', 'Cloudflare Workers', 'Design system'],
		href: 'https://bnji.net/',
		status: 'public',
		featured: true,
		meta: [
			{ label: 'Stack', value: 'Astro 7 · TypeScript · CSS' },
			{ label: 'Output', value: 'Static, Cloudflare Workers assets' },
			{ label: 'Client JS', value: 'Vanilla modules, one deferred bundle' },
		],
		year: '2026',
	},
	{
		slug: 'lorem-ipsum-kit',
		title: 'Lorem Ipsum Kit',
		description:
			'Placeholder project: consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim.',
		detail:
			'Quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
		tags: ['Lorem', 'Ipsum', 'Placeholder'],
		status: 'wip',
		featured: true,
		meta: [
			{ label: 'Lorem', value: 'Ipsum dolor sit amet' },
			{ label: 'Consectetur', value: 'Adipiscing elit sed do' },
		],
		year: '2026',
	},
	{
		slug: 'dolor-sit-engine',
		title: 'Dolor Sit Engine',
		description:
			'Placeholder project: sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.',
		tags: ['Dolor', 'Sit', 'Amet'],
		status: 'local',
		featured: true,
		meta: [
			{ label: 'Sed ut', value: 'Persiciatis unde omnis' },
			{ label: 'Iste natus', value: 'Error sit voluptatem' },
		],
		year: '2025',
	},
	{
		slug: 'consectetur-board',
		title: 'Consectetur Board',
		description:
			'Placeholder project: nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores.',
		tags: ['Consectetur', 'Adipiscing'],
		status: 'idea',
		featured: false,
		year: '—',
	},
];

/** All projects, featured first, then by year descending (stable order). */
export function getAllProjects(): Project[] {
	return PROJECTS.slice().sort((a, b) => {
		if (a.featured !== b.featured) return a.featured ? -1 : 1;
		return (b.year ?? '').localeCompare(a.year ?? '');
	});
}

/** Featured projects only, capped — the homepage renders these large. */
export function getFeaturedProjects(limit = 3): Project[] {
	return PROJECTS.filter((project) => project.featured).slice(0, limit);
}
