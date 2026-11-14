/**
 * The Stella prompt API: authorization and exact text.
 *
 * GET /api/stella/prompt composes one prompt server-side and answers JSON.
 * It is the only way prompt text reaches a browser — the client module
 * never imports the data — so these tests pin both halves of that: the
 * credential gate (the same admin guard every admin route uses, checked
 * here as well as in the middleware) and the composed text itself, which
 * must equal composeStellaPrompt exactly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { composeStellaPrompt } from '../src/data/stella-prompts';
import { GET } from '../src/pages/api/stella/prompt';

const ADMIN_TOKEN = 'test-admin-token';

declare global {
	// Set by tests/support/register.mjs; the stubs read both live at call time
	// so a test can rebind between requests.
	var __BNJI_TEST_SECRETS__: Record<string, string>;
	var __BNJI_TEST_BINDINGS__: Record<string, unknown>;
}

const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url))
	.filter((name) => name.endsWith('.sql'))
	.sort();

const db = createTestD1();
for (const name of MIGRATIONS) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'test-access-secret' };
globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: db };

// Seed the admin credential row the same way migration 0005 does.
db.raw
	.prepare('UPDATE admin_credentials SET token_hash = ? WHERE id = 1')
	.run(createHash('sha256').update(ADMIN_TOKEN).digest('hex'));

async function call(path: string, options: { bearer?: string } = {}): Promise<Response> {
	const url = `http://localhost${path}`;
	const headers = new Headers();
	if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
	const request = new Request(url, { method: 'GET', headers });
	const context = { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
	return GET(context);
}

test('stella prompt api: no credential -> 401, nothing leaks', async () => {
	const response = await call('/api/stella/prompt?mode=fable&phase=F1&variant=full');
	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: 'unauthorized' });
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('stella prompt api: valid selection returns the exact composed text', async () => {
	const response = await call('/api/stella/prompt?mode=fable&phase=F1&variant=full', { bearer: ADMIN_TOKEN });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const body = (await response.json()) as { text: string };
	assert.equal(body.text, composeStellaPrompt('fable', 'F1', 'full'));
	assert.ok(body.text.startsWith('PHASE_ID: F1\n\n<role>'));
});

test('stella prompt api: opus fix prompt differs only where the docs differ', async () => {
	const response = await call('/api/stella/prompt?mode=opus&phase=F2&variant=fix', { bearer: ADMIN_TOKEN });
	assert.equal(response.status, 200);
	const body = (await response.json()) as { text: string };
	assert.equal(body.text, composeStellaPrompt('opus', 'F2', 'fix'));
	assert.ok(body.text.startsWith('PHASE_ID: F2\n\n<role>'));
});

test('stella prompt api: phase-only returns the body alone', async () => {
	const response = await call('/api/stella/prompt?mode=fable&phase=V3&variant=phase', { bearer: ADMIN_TOKEN });
	assert.equal(response.status, 200);
	const body = (await response.json()) as { text: string };
	assert.equal(body.text, composeStellaPrompt('fable', 'V3', 'phase'));
	assert.ok(body.text.startsWith('<task>'));
	assert.ok(!body.text.includes('PHASE_ID:'));
});

test('stella prompt api: invalid selection -> 400', async () => {
	for (const query of [
		'mode=sonnet&phase=F1&variant=full',
		'mode=fable&phase=F9&variant=full',
		'mode=fable&phase=F1&variant=all',
		'mode=fable&phase=F1',
		'',
	]) {
		const response = await call(`/api/stella/prompt?${query}`, { bearer: ADMIN_TOKEN });
		assert.equal(response.status, 400, query);
		assert.deepEqual(await response.json(), { error: 'invalid_selection' });
	}
});

test('stella prompt api: invalid selection without a credential is still 401', async () => {
	const response = await call('/api/stella/prompt?mode=sonnet&phase=F9&variant=all');
	assert.equal(response.status, 401);
});
