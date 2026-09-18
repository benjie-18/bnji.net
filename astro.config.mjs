// @ts-check
import { defineConfig, envField } from "astro/config";
import sitemap from "@astrojs/sitemap";

import cloudflare from "@astrojs/cloudflare";

// The canonical origin lives in src/data/site.ts, which every component uses
// for canonical/OG URLs. Importing it here means the sitemap, the RSS feed and
// the pages physically cannot disagree about the production domain.
import { SITE } from "./src/data/site.ts";

// https://astro.build/config
export default defineConfig({
	site: SITE.url,
	// Secret schema for astro:env/server. Every entry is OPTIONAL so builds,
	// previews and the Node prerender environment work with zero configuration;
	// owners set real values with `wrangler secret put <NAME>`. Values are
	// server-context secrets: they are never inlined into client bundles.
	env: {
		schema: {
			DISCORD_WEBHOOK_URL: envField.string({ context: "server", access: "secret", optional: true }),
			NTFY_URL: envField.string({ context: "server", access: "secret", optional: true }),
			BOARD_REST_URL: envField.string({ context: "server", access: "secret", optional: true }),
			BOARD_REST_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
			ACCESS_TOKEN: envField.string({ context: "server", access: "secret", optional: true }),
			ACCESS_PASSWORD_SHA: envField.string({ context: "server", access: "secret", optional: true }),
			ACCESS_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
		},
	},
	integrations: [sitemap()],
	adapter: cloudflare({
		// @astrojs/cloudflare v14 replaced the `platformProxy` option with the
		// Cloudflare Vite plugin, so `platformProxy` is no longer a valid key (it
		// also failed type-checking). Prerendering runs through Astro's Node
		// environment, which is the configuration verified to build cleanly.
		// Nothing on the site reads runtime bindings: every page is prerendered
		// and served as a static asset by the Worker.
		prerenderEnvironment: "node",
	}),
});
