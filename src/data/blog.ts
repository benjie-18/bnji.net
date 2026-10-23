/**
 * BNJI.NET — blog collection access.
 *
 * Everything that reads the `blog` content collection goes through here, so the
 * homepage preview, /me/blog/ and the RSS feed cannot disagree about ordering,
 * URLs or draft handling.
 *
 * Content itself stays in src/content/blog/*.md(x) and the schema stays in
 * src/content.config.ts. Adding a post = adding a markdown file; nothing here
 * needs to change.
 */
import { getCollection, type CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;

/** Route for a post. Always trailing-slashed to match the prerendered directory. */
export function postUrl(post: BlogPost): string {
	return `/me/blog/${encodeURIComponent(post.id)}/`;
}

/** Newest first. */
export async function getBlogPosts(): Promise<BlogPost[]> {
	// `draft: true` in frontmatter keeps a post out of every list, the sitemap
	// and the feed without deleting the file.
	const posts = await getCollection('blog', ({ data }) => !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/** The n newest posts, for previews. */
export async function getRecentBlogPosts(limit: number): Promise<BlogPost[]> {
	const posts = await getBlogPosts();
	return posts.slice(0, limit);
}

/** Rough reading time in minutes, computed at build time from the raw body. */
export function getReadingTime(post: BlogPost): number {
	const words = post.body?.trim().split(/\s+/).filter(Boolean).length ?? 0;
	// 220 wpm is a comfortable silent-reading pace; never report "0 min".
	return Math.max(1, Math.round(words / 220));
}
