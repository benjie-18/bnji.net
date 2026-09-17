/**
 * BNJI.NET — interest / topic bento grid.
 *
 * Rendered by ServicesPreview.astro as an asymmetric bento grid (deliberately
 * not a row of three identical cards). Data lives here so the homepage markup
 * stays declarative.
 *
 * Content policy: neutral placeholder copy only — this grid must not describe
 * a real person's life, background or identity.
 */

export type Interest = {
	/** Stable id, used as the DOM id and the mono index label. */
	id: string;
	/** Short mono label shown above the title. */
	label: string;
	title: string;
	description: string;
	tags: string[];
	/** Optional route to send people to. Omit when there is no page yet. */
	href?: string;
	/** Grid span on wide screens (of 12). Defaults to 6. */
	span?: 5 | 6 | 7 | 12;
};

export const INTERESTS: Interest[] = [
	{
		id: 'lorem-web',
		label: 'Lorem web',
		title: 'Lorem ipsum dolor sit',
		description:
			'Consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud.',
		tags: ['Lorem', 'Ipsum', 'Dolor'],
		href: '/projects/',
		span: 7,
	},
	{
		id: 'lorem-ai',
		label: 'Lorem intelligence',
		title: 'Sit amet consectetur',
		description:
			'Adipiscing elit duis tristique sollicitudin nibh sit amet commodo nulla facilisi. Nullam vehicula ipsum ut arcu dictum varius.',
		tags: ['Consectetur', 'Adipiscing', 'Elit'],
		span: 5,
	},
	{
		id: 'lorem-hardware',
		label: 'Lorem hardware',
		title: 'Sed do eiusmod tempor',
		description:
			'Incididunt ut labore et dolore magna aliqua. Quis ipsum suspendisse ultrices gravida dictum fusce ut placerat orci nulla.',
		tags: ['Eiusmod', 'Tempor', 'Incididunt'],
		span: 5,
	},
	{
		id: 'lorem-lab',
		label: 'Lorem experiments',
		title: 'Ut labore et dolore',
		description:
			'Magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
		tags: ['Labore', 'Dolore', 'Magna'],
		href: '/lab/',
		span: 7,
	},
];
