/**
 * BNJI.NET — site-wide identity, SEO defaults and contact details.
 *
 * Single source of truth for anything that ends up in <head>, the footer or a
 * contact link. `astro.config.mjs` imports SITE.url so the sitemap and RSS feed
 * can never drift from the canonical origin used by BaseHead.astro.
 *
 * Rules for agents:
 *  - Never put secrets, tokens or API keys in this file (or any file).
 *  - Never point SITE.url at a dev host (localhost, *.workers.dev, example.com).
 *  - This project intentionally carries NO personal biography: identity fields
 *    below are neutral placeholders. Do not replace them with real personal
 *    information; swap placeholders only for other placeholders.
 */

export type SocialLink = {
	/** Human-readable name. Also used as the accessible label. */
	label: string;
	href: string;
	/** Short handle rendered in mono type next to the label. */
	handle?: string;
	/** rel value for external links ("me" for own profiles). */
	rel?: string;
};

export const SITE = {
	/** Wordmark shown in the nav, hero, footer and 404. */
	name: 'BNJI',
	/** Full name used in metadata. */
	fullName: 'BNJI.NET',
	/** Default <title> when a page does not supply one. */
	title: 'BNJI — Lorem Ipsum Dolor',
	/** Suffix appended to per-page titles, e.g. "Lab · BNJI". */
	titleSuffix: 'BNJI',
	description:
		'BNJI.NET is a digital hub — lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.',
	/** Canonical production origin. bnji.net is served by a Cloudflare Worker. */
	url: 'https://bnji.net',
	locale: 'en',
	/**
	 * <meta name="theme-color"> per theme. Must track --bg in
	 * src/styles/tokens.css. The pre-paint script in BaseHead.astro picks the
	 * active one.
	 */
	themeColor: '#020204',
	themeColorLight: '#bfe6f7',
	/** Default Open Graph / Twitter image, 1200x630. Source: public/og-cover.svg. */
	defaultImage: '/og-cover.png',
	/**
	 * PLACEHOLDER identity — neutral lorem ipsum, not a real person. Kept in
	 * this one place so metadata, JSON-LD and the footer stay consistent.
	 */
	author: {
		name: 'Lorem Ipsum',
		role: 'Dolor sit amet',
		tagline: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
		location: 'Lorem Ipsum',
	},
	/**
	 * PLACEHOLDER — swap for a real mailbox. It lives here (and only here) so
	 * every mailto: link on the site updates at once.
	 */
	email: 'hello@bnji.net',
	/** PLACEHOLDER profile URL — replace with a real public profile if desired. */
	github: 'https://github.com/lorem-ipsum',
	githubHandle: 'lorem-ipsum',
	/** Year rendered in the footer copyright line. */
	foundedYear: 2026,
} as const;

/** Social / feed links. Rendered by Footer.astro and ContactSection.astro. */
export const SOCIAL_LINKS: SocialLink[] = [
	{ label: 'GitHub', href: SITE.github, handle: SITE.githubHandle, rel: 'me' },
	{ label: 'Email', href: `mailto:${SITE.email}`, handle: SITE.email },
];

/** Resolve any path against the canonical origin (used for OG/canonical tags). */
export function absoluteUrl(path: string): string {
	return new URL(path, SITE.url).toString();
}

/** "<page> · BNJI", or the site default title when no page title is given. */
export function pageTitle(title?: string): string {
	if (!title || title === SITE.title) return SITE.title;
	return `${title} · ${SITE.titleSuffix}`;
}
