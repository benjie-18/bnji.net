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
	// Astro sessions are OFF. Nothing here reads `Astro.session`: the admin
	// cookie (§5.3) and the `bnji_ps` profile key are hand-rolled in D1 and
	// cookies. Left enabled, @astrojs/cloudflare injects an id-less `SESSION`
	// KV binding into the generated dist/server/wrangler.json — at the top
	// level AND inside `previews` — and a Preview deploy then fails with
	// `binding SESSION of type kv_namespace must have a namespace_id
	// specified [code: 10021]`. Keep this at the TOP LEVEL of the config: the
	// adapter reads `config.session`, so the same key inside `cloudflare({...})`
	// is silently ignored. Verify with:
	//   npm run build && grep SESSION dist/server/wrangler.json  # no output
	session: false,
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
			// YouTube playlist metadata lookup. OPTIONAL: the importer falls
			// back to public oEmbed and then to manual entry, so the feature
			// works with no key configured. A server-context secret — never
			// inlined into a client bundle.
			YOUTUBE_API_KEY: envField.string({ context: "server", access: "secret", optional: true }),
			// Spotify Client Credentials pair. OPTIONAL for the same reason:
			// with no pair the Spotify path falls back to public oEmbed and
			// then to manual entry. This is a Client Credentials pair, which
			// is server-only — the token it buys never leaves the Worker.
			//
			// Declared even though the admin panel imports no Spotify link:
			// getSecret() reads the Worker env by name whether or not a key is
			// declared, so an undeclared secret still resolves and silently
			// skips this schema. Declaring it is what puts the value in the one
			// file an auditor reads, which is the same reason YOUTUBE_API_KEY
			// above is declared rather than left to the same silent path.
			SPOTIFY_CLIENT_ID: envField.string({ context: "server", access: "secret", optional: true }),
			SPOTIFY_CLIENT_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
		},
	},
	integrations: [
		sitemap({
			// /admin is gated by ACCESS_RULES, but a URL in a sitemap is a URL
			// published to every search engine and scraper on the internet.
			// Being unreachable is not the same as being unlisted, and the
			// dashboard has no business in a public index. The page also sets
			// noindex; this is the second, load-bearing half of that.
			//
			// The same holds for /projects/stella: it is gated behind the
			// admin credential, so it is unlisted here and noindexed on the
			// page, for the same reason.
			//
			// /about is hidden for now (redundant with /gizlyy/): it is out of
			// the nav and noindexed, and a sitemap entry would be a third,
			// load-bearing leak. Drop the '/about' clause to unhide it.
			filter: (page) => !page.includes('/admin') && !page.includes('/about') && !page.includes('/projects/stella'),
		}),
	],
	adapter: cloudflare({
		// @astrojs/cloudflare v14 replaced the `platformProxy` option with the
		// Cloudflare Vite plugin, so `platformProxy` is no longer a valid key (it
		// also failed type-checking). Prerenderable pages run through Astro's
		// Node environment; API routes with prerender=false still execute in the
		// Worker and use runtime bindings such as BOARD_DB and BOARD_KV. Local
		// route verification must therefore use Wrangler, not only `astro dev`.
		prerenderEnvironment: "node",
	}),
});
