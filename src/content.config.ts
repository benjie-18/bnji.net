import { glob } from 'astro/loaders';
import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';

/**
 * Blog collection.
 *
 * Adding a post = creating a file in src/content/blog/ with the frontmatter
 * below. `tags` and `draft` are optional additions to the original starter
 * schema, so every existing post still validates untouched:
 *  - tags: rendered as chips on the post and on cards
 *  - draft: true keeps a post out of the index, previews, sitemap and feed
 *    without deleting the file (see src/data/blog.ts)
 */
const blog = defineCollection({
	// Load Markdown files in the `src/content/blog/` directory. MDX support was
	// removed with the MDX workflow; keep the pattern markdown-only.
	loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
	// Type-check frontmatter using a schema
	schema: z.object({
		title: z.string(),
		description: z.string(),
		// Transform string to Date object
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		heroImage: z.string().optional(),
		tags: z.array(z.string()).optional(),
		draft: z.boolean().optional(),
	}),
});

export const collections = { blog };
