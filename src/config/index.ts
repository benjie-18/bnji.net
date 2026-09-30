/**
 * BNJI.NET — central configuration index.
 *
 * Every knob a site owner or future developer needs to touch lives in this
 * directory, and nowhere else. Each file states, per value:
 *   - what it does,
 *   - whether it is PUBLIC (safe to ship in the client bundle) or SECRET
 *     (must only ever be read server-side from environment variables),
 *   - how to replace it safely.
 *
 * Rules:
 *   1. NEVER write a real secret into any file in src/. Secrets belong in the
 *      deployment environment (Cloudflare Workers secrets / vars, or `.dev.vars`
 *      locally, which is git-ignored). See docs/CONFIGURATION.md.
 *   2. Public config may be imported by components and scripts. Secret config
 *      is read only inside `src/pages/api/*` and `src/server/*` through the
 *      runtime `env` object — those modules are never prerendered into HTML.
 *   3. Adding a new external service = add a new config file here + a section
 *      in docs/CONFIGURATION.md. Do not scatter service URLs through
 *      components.
 */
export {
	MUSIC_SOURCE,
	MUSIC_PROVIDER_URLS,
	type MusicProvider,
	type MusicTrack,
	type MusicSourceConfig,
} from './music.config';
export { DM_INTEGRATION, type DmIntegrationConfig } from './integrations.config';
export { BOARD_CONFIG, type BoardConfig } from './board.config';
export { NAMES_CONFIG, type NamesConfig } from './names.config';
export { ACCESS_RULES, THEME_CONFIG, INTRO_CONFIG, type RouteAccessRule } from './access.config';
