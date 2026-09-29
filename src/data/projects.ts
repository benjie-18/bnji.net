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
	/** One or two concise sentences for cards. */
	description: string;
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
	/** Rough year, shown in mono type. */
	year?: string;
};

export const PROJECTS: Project[] = [
	{
		slug: 'bnji-net',
		title: 'BNJI.NET',
		description:
			'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.',
		tags: ['Design system', 'Liquid Glass', 'TypeScript'],
		href: 'https://bnji.net/',
		status: 'public',
		featured: true,
		year: '2026',
	},
	{
		slug: 'lorem-ipsum-kit',
		title: 'Lorem Ipsum Kit',
		description:
			'Placeholder project: consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		tags: ['Lorem', 'Ipsum', 'Placeholder'],
		status: 'wip',
		featured: true,
		year: '2026',
	},
	{
		slug: 'dolor-sit-engine',
		title: 'Dolor Sit Engine',
		description:
			'Placeholder project: sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium.',
		tags: ['Dolor', 'Sit', 'Amet'],
		status: 'local',
		featured: true,
		year: '2025',
	},
	{
		slug: 'consectetur-board',
		title: 'Consectetur Board',
		description:
			'Placeholder project: nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit.',
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
