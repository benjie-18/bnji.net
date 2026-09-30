import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: '**/*.spec.ts',
	globalTeardown: './tests/e2e/global-teardown.mjs',
	outputDir: '.astro/playwright-output',
	fullyParallel: true,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:4321',
		browserName: 'chromium',
		trace: 'retain-on-failure',
	},
	projects: [
		{ name: 'mobile', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
		{ name: 'tablet', use: { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1 } },
		{ name: 'desktop', use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
	],
	webServer: {
		command: 'node scripts/playwright-dev-server.mjs',
		url: 'http://127.0.0.1:4321/games/',
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: 'pipe',
		stderr: 'pipe',
	},
});
