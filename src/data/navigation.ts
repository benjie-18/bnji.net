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

/** Floating pill nav. Kept to six items so it still fits a phone in the sheet. */
export const PRIMARY_NAV: NavItem[] = [
	{ label: 'Home', href: '/', description: 'Back to the hub' },
	{ label: 'About', href: '/about/', description: 'What this site is' },
	{ label: 'Projects', href: '/projects/', description: 'Selected work and placeholders' },
	{ label: 'Blog', href: '/blog/', description: 'Notes and placeholder writing' },
	{ label: 'Lab', href: '/lab/', description: 'Interactive experiments' },
	{ label: 'Contact', href: '/contact/', description: 'Leave a message' },
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
	{ label: 'Contact', href: '/contact/' },
];
