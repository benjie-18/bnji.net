/**
 * Chat plan Phase A — display names and handles (browser surface).
 *
 * API responses are mocked the same way the account test mocks them: the
 * assertions here are about wiring, disclosure copy, client-side limits and
 * the exact request bodies — D1 behaviour is covered by the node harness in
 * tests/display-names.test.ts. These specs need a local Playwright run
 * (`npm run test:e2e`) before deploy; they do not run in this sandbox.
 */
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

function mockProfileName(page: import('@playwright/test').Page, options: {
	current?: { displayName: string | null; scope: string };
	postStatus?: number;
	postBody?: Record<string, unknown>;
}): Array<{ method: string; body: unknown }> {
	const requests: Array<{ method: string; body: unknown }> = [];
	void page.route('**/api/profile/name', async (route) => {
		const request = route.request();
		const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : null;
		requests.push({ method: request.method(), body });
		if (request.method() === 'GET') {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(options.current ?? { displayName: null, scope: 'guest' }),
			});
			return;
		}
		const status = options.postStatus ?? 200;
		await route.fulfill({
			status,
			contentType: 'application/json',
			body: JSON.stringify(status === 200
				? { displayName: String(body?.displayName ?? ''), scope: options.current?.scope ?? 'guest' }
				: { error: options.postBody?.error ?? 'invalid_display_name' }),
		});
	});
	return requests;
}

test('guest name control loads the current label, discloses what is stored, and posts the typed name', async ({ page }) => {
	const requests = mockProfileName(page, { current: { displayName: 'Ghost Rider', scope: 'guest' } });
	await page.goto('/projects/games/');
	const form = page.locator('[data-profile-name]');
	await expect(form.getByLabel('Your display name')).toHaveValue('Ghost Rider');
	await expect(page.locator('[data-profile-name-status]')).toContainText('Current name: Ghost Rider · guest name');
	await expect(form).toContainText("keyed by a digest of this browser's session cookie");
	await expect(form).toContainText('not linked to an account');
	await expect(form.getByLabel('Your display name')).toHaveAttribute('maxlength', '24');

	await form.getByLabel('Your display name').fill('New Rider');
	await form.getByRole('button', { name: 'Save name' }).click();
	await expect.poll(() => requests.find((request) => request.method === 'POST')).toEqual({ method: 'POST', body: { displayName: 'New Rider' } });
	await expect(page.locator('[data-profile-name-status]')).toContainText('Name saved: New Rider · guest name, kept 30 days');
	await expectNoAxeViolations(page);
});

test('a refused name shows the plain-language error, never raw markup', async ({ page }) => {
	mockProfileName(page, { postStatus: 422, postBody: { error: 'display_name_reserved' } });
	await page.goto('/projects/games/');
	const form = page.locator('[data-profile-name]');
	await form.getByLabel('Your display name').fill('admin');
	await form.getByRole('button', { name: 'Save name' }).click();
	const status = page.locator('[data-profile-name-status]');
	await expect(status).toHaveText('That name is reserved — pick another.');
	await expectNoAxeViolations(page);
});

test('the handle control is account-only, enforces the format client-side, and posts the claim', async ({ page }) => {
	const accountRequests: Array<{ method: string; body: unknown }> = [];
	await page.route('**/api/games/account', async (route) => {
		const request = route.request();
		accountRequests.push({ method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
		if (request.method() === 'GET') {
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, displayName: 'Player One', saveCount: 0, handle: null }) });
			return;
		}
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ handle: 'sky_patel' }) });
	});
	mockProfileName(page, { current: { displayName: null, scope: 'account' } });
	await page.goto('/projects/games/');
	await expect(page.locator('[data-player-greeting]')).toContainText('Signed in as Player One');
	const handleForm = page.locator('[data-player-handle]');
	await expect(handleForm).toBeVisible();
	await expect(page.locator('[data-handle-status]')).toContainText('No handle yet');
	await expect(handleForm).toContainText('Your handle is public');
	await expect(handleForm).toContainText('once every 30 days');
	const handleInput = handleForm.getByLabel('Handle');
	await expect(handleInput).toHaveAttribute('minlength', '3');
	await expect(handleInput).toHaveAttribute('maxlength', '20');
	await expect(handleInput).toHaveAttribute('pattern', '[a-z0-9_]{3,20}');

	await handleInput.fill('sky_patel');
	await handleForm.getByRole('button', { name: 'Save handle' }).click();
	await expect.poll(() => accountRequests.find((request) => request.method === 'POST')).toEqual({ method: 'POST', body: { action: 'set-handle', handle: 'sky_patel' } });
	await expect(page.locator('[data-handle-status]')).toHaveText('Handle saved: @sky_patel.');
	await expectNoAxeViolations(page);
});

test('guests never see the handle control', async ({ page }) => {
	await page.route('**/api/games/account', async (route) => {
		if (route.request().method() === 'GET') {
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }) });
			return;
		}
		await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'authentication_required' }) });
	});
	await page.route('**/api/profile/name', async (route) => {
		if (route.request().method() === 'GET') {
			await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ displayName: null, scope: 'guest' }) });
			return;
		}
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ displayName: 'Rider', scope: 'guest' }) });
	});
	await page.goto('/projects/games/');
	await expect(page.locator('[data-player-greeting]')).toContainText('No account or network save is required');
	await expect(page.locator('[data-player-handle]')).toBeHidden();
	await expectNoAxeViolations(page);
});
