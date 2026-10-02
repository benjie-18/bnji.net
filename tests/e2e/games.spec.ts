import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const expectNoAxeViolations = async (page: import('@playwright/test').Page) => {
	const results = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	expect(results.violations.map(({ id, impact, description, nodes }) => ({
			id,
			impact,
			description,
			nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
		})), 'axe detected accessibility violations').toEqual([]);
};

test('Games catalog renders at this project viewport without horizontal overflow and passes axe', async ({ page }) => {
	const response = await page.goto('/games/');
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading', { level: 1, name: 'Games' })).toBeVisible();
	// The catalog section is an h2 "Games" under an eyebrow label; the lab lives
	// on /lab/, not on this page.
	await expect(page.getByRole('heading', { level: 2, name: 'Games' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Leaderboards' })).toBeVisible();
	await expect(page.getByRole('heading', { level: 2, name: 'Private room' })).toBeVisible();
	await expect(page.locator('.games-card__id')).toHaveCount(0);
	await expect(page.locator('.games-card .chip')).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
	await expectNoAxeViolations(page);
});

test('shared shell exposes loading, error, results and polite/urgent live announcements', async ({ page }) => {
	await page.goto('/playwright-game-shell/');
	const shell = page.locator('[data-game-shell]');
	const status = shell.locator('[data-game-shell-status]');
	await expect(shell).toHaveAttribute('data-game-state', 'ready');
	await expect(status).toHaveAttribute('role', 'status');
	await expect(status).toHaveAttribute('aria-live', 'polite');
	await expectNoAxeViolations(page);

	await page.locator('[data-demo-loading]').click();
	await expect(shell).toHaveAttribute('data-game-state', 'loading');
	await expect(shell.locator('[data-game-shell-panel="loading"]')).toBeVisible();
	await expect(status).toContainText('Loading Shell test');
	await expectNoAxeViolations(page);

	await page.reload();
	await page.locator('[data-demo-error]').click();
	await expect(shell).toHaveAttribute('data-game-state', 'error');
	await expect(status).toHaveAttribute('role', 'alert');
	await expect(status).toHaveAttribute('aria-live', 'assertive');
	await expect(shell.locator('[data-game-shell-panel="error"] [data-game-shell-focus]')).toBeFocused();
	await expect(shell.getByRole('link', { name: 'Return to Games' })).toBeVisible();
	await expectNoAxeViolations(page);

	await page.reload();
	await page.locator('[data-demo-results]').click();
	await expect(shell).toHaveAttribute('data-game-state', 'results');
	await expect(shell.locator('[data-game-shell-panel="results"] [data-game-shell-focus]')).toBeFocused();
	await expect(shell.locator('[data-game-shell-panel="results"]')).toContainText('Demo result: complete.');
	await expect(status).toContainText('results are ready');
	await expectNoAxeViolations(page);
});

test('pause and resume controls work by keyboard and manage focus', async ({ page }) => {
	await page.goto('/playwright-game-shell/');
	const pause = page.locator('[data-game-pause]');
	let foundPause = false;
	for (let index = 0; index < 50; index += 1) {
		await page.keyboard.press('Tab');
		if (await pause.evaluate((button) => button === document.activeElement)) {
			foundPause = true;
			break;
		}
	}
	expect(foundPause, 'pause must be reachable using Tab alone').toBe(true);
	expect(await pause.evaluate((button) => button.matches(':focus-visible'))).toBe(true);
	await page.keyboard.press('Enter');
	const resume = page.locator('[data-game-resume]');
	await expect(page.locator('[data-game-shell]')).toHaveAttribute('data-game-state', 'paused');
	await expect(resume).toBeFocused();
	await page.keyboard.press('Space');
	await expect(page.locator('[data-game-shell]')).toHaveAttribute('data-game-state', 'ready');
	await expect(pause).toBeFocused();
	await expectNoAxeViolations(page);
});

test('reduced-motion preference removes the shell loading animation', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/playwright-game-shell/');
	await page.locator('[data-demo-loading]').click();
	await expect(page.locator('[data-game-shell-panel="loading"]')).toBeVisible();
	expect(await page.locator('.game-shell__pulse').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
});

test('Games and shell retain useful static content when JavaScript is disabled', async ({ browser }, testInfo) => {
	const viewport = testInfo.project.use.viewport as { width: number; height: number };
	const context = await browser.newContext({ javaScriptEnabled: false, viewport });
	try {
		const page = await context.newPage();
		await page.goto('/games/');
		await expect(page.getByRole('heading', { level: 1, name: 'Games' })).toBeVisible();
		await expect(page.getByRole('heading', { level: 2, name: 'Games' })).toBeVisible();
		await expect(page.getByRole('heading', { level: 2, name: 'Private room' })).toBeVisible();

		await page.goto('/playwright-game-shell/');
		await expect(page.getByRole('heading', { level: 1, name: 'Shell test' })).toBeVisible();
		await expect(page.getByText('The game content remains supplied by its owner.')).toBeVisible();
		await expect(page.locator('[data-game-shell-status]')).toContainText('Shell test is ready');
		await expect(page.locator('[data-game-pause]')).toBeHidden();
	} finally {
		await context.close();
	}
});

test('account creation sends the display name typed before the submit handler disables the form', async ({ page }) => {
	// Regression: setBusy() disables the controls, so FormData must be read first.
	// Mocking the endpoint keeps the assertion on the request body, not on D1 state.
	const requests: Array<{ method: string; body: unknown }> = [];
	await page.route('**/api/games/account', async (route) => {
		const request = route.request();
		requests.push({ method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
		if (request.method() === 'GET') {
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }) });
			return;
		}
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			body: JSON.stringify({ authenticated: true, displayName: 'Benji', recoveryCode: 'BNJI-TEST-CODE-ONCE', recoveryCodeDisplayedOnce: true }),
		});
	});

	await page.goto('/games/');
	// loadStatus() runs after the submit listeners attach, so this greeting proves the form is live.
	await expect(page.locator('[data-player-greeting]')).toContainText('No account or network save is required');
	const createForm = page.locator('[data-player-create]');
	await createForm.getByLabel('Display name').fill('Benji');
	await createForm.getByRole('button', { name: 'Create account & claim this guest session' }).click();

	await expect.poll(() => requests.find((request) => request.method === 'POST')).toEqual({ method: 'POST', body: { action: 'create', displayName: 'Benji' } });
	await expectNoAxeViolations(page);
});

test('Bubble Pop cancels its animation frame while the tab is hidden and resumes when visible', async ({ page, context }) => {
	// Three page loads, a capability probe and resume polls under a loaded
	// parallel run do not fit the default 30s budget.
	test.setTimeout(60_000);
	await page.addInitScript(() => {
		const canvasGetContext = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
			const context = canvasGetContext.call(this, type, ...args as []);
			if (type === '2d' && this.matches('[data-bp-canvas]') && context) {
				const drawing = context as CanvasRenderingContext2D;
				const clearRect = drawing.clearRect.bind(drawing);
				Object.defineProperty(drawing, 'clearRect', {
					configurable: true,
					value: (...rect: [number, number, number, number]) => {
						const counters = window as Window & { __bubblePopDraws?: number };
						counters.__bubblePopDraws = (counters.__bubblePopDraws ?? 0) + 1;
						clearRect(...rect);
					},
				});
			}
			return context;
		} as typeof HTMLCanvasElement.prototype.getContext;
	});
	await page.goto('/lab/');
	const bubblePop = page.locator('[data-bubble-pop]');
	await bubblePop.scrollIntoViewIfNeeded();
	await expect.poll(() => page.evaluate(() => (window as Window & { __bubblePopDraws?: number }).__bubblePopDraws ?? 0), { timeout: 10_000 }).toBeGreaterThan(1);

	const background = await context.newPage();
	await background.goto('/games/');
	await background.bringToFront();
	// Capability probe: some headless environments never demote a background
	// page's visibilityState (bringToFront is a no-op there). Where it isn't
	// supported, skip with a reason instead of failing the suite.
	const deadline = Date.now() + 3_000;
	let demoted = (await page.evaluate(() => document.visibilityState)) === 'hidden';
	while (!demoted && Date.now() < deadline) {
		await page.waitForTimeout(150);
		demoted = (await page.evaluate(() => document.visibilityState)) === 'hidden';
	}
	test.skip(!demoted, 'this environment never demotes background-page visibility');
	await page.waitForTimeout(120);
	const stoppedAt = await page.evaluate(() => (window as Window & { __bubblePopDraws?: number }).__bubblePopDraws ?? 0);
	await page.waitForTimeout(250);
	expect(await page.evaluate(() => (window as Window & { __bubblePopDraws?: number }).__bubblePopDraws ?? 0)).toBe(stoppedAt);

	await page.bringToFront();
	// Resume-side polls get an explicit budget: under a loaded parallel run the
	// default 5s expect timeout is not enough for visibility + rAF to settle.
	await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000 }).toBe('visible');
	await expect.poll(() => page.evaluate(() => (window as Window & { __bubblePopDraws?: number }).__bubblePopDraws ?? 0), { timeout: 10_000 }).toBeGreaterThan(stoppedAt);
	await background.close();
});
