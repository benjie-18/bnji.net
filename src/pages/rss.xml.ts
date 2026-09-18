/**
 * RSS feed for the blog.
 *
 * Reads through src/data/blog.ts so the feed, the blog index and the homepage
 * preview can never disagree about ordering or about which posts are drafts.
 *
 * Renamed from rss.xml.js to .ts: this is the only endpoint on the site, and
 * typing it costs nothing (Astro resolves rss.xml.ts to the /rss.xml route).
 */
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getBlogPosts, postUrl } from '../data/blog';
import { SITE } from '../data/site';

export async function GET(context: APIContext) {
	const posts = await getBlogPosts();

	return rss({
		title: SITE.fullName,
		description: SITE.description,
		// context.site comes from astro.config.mjs, which is set to SITE.url.
		// The fallback keeps the feed valid if that config is ever missing.
		site: context.site ?? SITE.url,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			link: postUrl(post),
			categories: post.data.tags,
		})),
		customData: `<language>${SITE.locale}</language>`,
	});
}
