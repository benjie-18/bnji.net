/**
 * Vitest configuration for the Workers-pool suite (`tests/workerd/**`).
 *
 * These tests run inside workerd via `@cloudflare/vitest-pool-workers`, so
 * Durable Object hibernation, `getWebSockets()`, socket attachments and DO
 * SQLite behave exactly as in production — the reason this runner exists
 * beside `node:test` (docs/CHAT-SYSTEM-PLAN.md §13). The `node:test` suite
 * stays the runner for routes and pure logic; files here must not use it.
 *
 * `wrangler.test.json` mirrors the production compat date/flags and the DO
 * bindings but carries no assets binding, so no `dist/` build is required.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.test.json' },
		}),
	],
	test: {
		include: ['tests/workerd/**/*.spec.ts'],
		// Expiry-teardown tests wait out (a shortened) room TTL in real time.
		testTimeout: 20_000,
	},
});
