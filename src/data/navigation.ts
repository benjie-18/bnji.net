/**
 * BNJI.NET — navigation data.
 *
 * Navigation is data, never markup: Header.astro, Footer.astro and the mobile
 * nav sheet all render from the arrays below. To add a destination, create the
 * page in src/pages/ and append an entry here — no component edits required.
 *
 * Convention: internal hrefs always carry a trailing slash. The site is
 * prerendered to directories (/about/index.html) and Cloudflare serves those
 * for /about/, so trailing slashes avoid a redirect on every click.
 */

export type NavItem = {
	label: string;
	href: string;
	/** One-line purpose. Shown in the mobile nav sheet and on cards. */
	description?: string;
	/**
	 * True when the route does not exist yet. Coming-soon items are rendered as
	 * inert text, never as <a> — a dead link is worse than a visible "soon".
	 */
	comingSoon?: boolean;
};

/**
 * A dropdown in the header pill: one trigger label, several destinations.
 * Groups exist so the top level stays short (Home · Projects · Community · Me)
 * while every route remains one click — or two — away. Rendered by
 * Header.astro; behaviour (keyboard, touch, edge-aware placement) lives in
 * scripts/interactions.ts → initNavDropdowns.
 */
export type NavGroup = {
	label: string;
	/** Stable slug: becomes the panel's DOM id (aria-controls). */
	slug: string;
	items: NavItem[];
};

/** Anything that can sit at the top level of the pill. */
export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
	return Array.isArray((entry as NavGroup).items);
}

/** Every destination in the nav, groups flattened — for sitemaps, 404s, tests. */
export function flatNavItems(entries: readonly NavEntry[]): NavItem[] {
	return entries.flatMap((entry) => (isNavGroup(entry) ? entry.items : [entry]));
}

/**
 * Floating pill nav: four top-level entries so it fits a phone in the sheet.
 * Projects, Community and Me are dropdowns (see NavGroup); their destinations
 * appear ONLY inside the dropdown, never as standalone top-level links.
 */
export const PRIMARY_NAV: NavEntry[] = [
	{ label: 'Home', href: '/', description: 'Back to the hub' },
	{
		label: 'Projects',
		slug: 'projects',
		items: [
			{ label: 'Projects', href: '/projects/', description: 'Selected work and placeholders' },
			{ label: 'Lab', href: '/lab/', description: 'Interactive experiments' },
			{ label: 'Games', href: '/games/', description: 'A growing catalog of games' },
			{ label: 'Tools', href: '/tools/', description: 'Image, word and diff tools that run locally' },
		],
	},
	{
		label: 'Community',
		slug: 'community',
		items: [
			{ label: 'Board', href: '/board/', description: 'The public message board' },
			{ label: 'Messages', href: '/messages/', description: 'Private messages between accounts' },
			{ label: 'Friends', href: '/friends/', description: 'Friend requests and presence' },
		],
	},
	{
		label: 'Me',
		slug: 'me',
		items: [
			// Hidden for now — /about/ is redundant with the /gizlyy/ profile.
			// The page itself still exists (noindexed, out of the sitemap);
			// re-add this entry to put the link back.
			// { label: 'About', href: '/about/', description: 'What this site is' },
			{ label: 'Profile', href: '/gizlyy/', description: 'Personal social profile' },
			{ label: 'Blog', href: '/blog/', description: 'Notes and placeholder writing' },
			{ label: 'Contact', href: '/contact/', description: 'Leave a message' },
		],
	},
];

/**
 * Reserved destinations. They are listed in the footer as muted "soon" chips so
 * the roadmap is visible without shipping empty pages. Promoting one is two
 * steps: add src/pages/<route>.astro, then move the entry into PRIMARY_NAV.
 */
export const FUTURE_NAV: NavItem[] = [
	{ label: 'AI', href: '/ai/', description: 'Local models, prompts, benchmarks', comingSoon: true },
	{
		label: 'Minecraft',
		href: '/minecraft/',
		description: 'Servers, worlds and plugins',
		comingSoon: true,
	},
	{ label: 'Music', href: '/music/', description: 'Tracks and audio experiments', comingSoon: true },
	{
		label: 'Status',
		href: '/status/',
		description: 'Uptime for services and tunnels',
		comingSoon: true,
	},
	{ label: 'Now', href: '/now/', description: 'What I am working on this month', comingSoon: true },
];

/** Secondary footer links (site routes only — socials live in data/site.ts). */
export const FOOTER_NAV: NavItem[] = [
	{ label: 'Blog', href: '/blog/' },
	{ label: 'Projects', href: '/projects/' },
	{ label: 'Lab', href: '/lab/' },
	{ label: 'Games', href: '/games/' },
	{ label: 'Board', href: '/board/' },
	{ label: 'Profile', href: '/gizlyy/' },
	{ label: 'Contact', href: '/contact/' },
];
