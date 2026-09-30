import { existsSync, unlinkSync } from 'node:fs';

// Playwright tears down its webServer even when browser launch/tests fail. The
// marker ensures this only removes the fixture this test harness created.
export default async function globalTeardown() {
	const marker = new URL('../../.astro/playwright-fixture.created', import.meta.url);
	const route = new URL('../../src/pages/playwright-game-shell.astro', import.meta.url);
	if (existsSync(marker)) {
		if (existsSync(route)) unlinkSync(route);
		unlinkSync(marker);
	}
}
