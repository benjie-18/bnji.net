/**
 * Stella handoff prompts — the data behind /projects/stella/.
 *
 * The prompt text is quoted verbatim from the two handoff docs, so these
 * tests pin the properties that must survive any regeneration: the mode and
 * phase inventory, the shape of every phase body, and the one allowed
 * change — the preamble's first line, set to the selected phase.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ACCESS_RULES } from '../src/config/access.config';
import {
	STELLA_FIRING_ORDER,
	STELLA_MODES,
	STELLA_PHASES,
	STELLA_PHASE_ID_PLACEHOLDER,
	composeStellaPrompt,
} from '../src/data/stella-prompts';

test('stella prompts: two modes and 29 phases in firing order', () => {
	assert.deepEqual(Object.keys(STELLA_MODES).sort(), ['fable', 'opus']);
	assert.equal(STELLA_PHASES.length, 29);
	assert.deepEqual(
		STELLA_PHASES.map((phase) => phase.id),
		STELLA_FIRING_ORDER,
	);
	assert.equal(new Set(STELLA_PHASES.map((phase) => phase.id)).size, 29);
	for (const phase of STELLA_PHASES) {
		assert.ok(phase.title.length > 0, phase.id);
	}
});

test('stella prompts: every phase body is a task plus acceptance', () => {
	for (const phase of STELLA_PHASES) {
		assert.ok(phase.body.startsWith('<task>'), phase.id);
		assert.ok(phase.body.endsWith('</acceptance>'), phase.id);
		assert.ok(phase.body.includes('</task>'), phase.id);
		assert.ok(phase.body.includes('<acceptance>'), phase.id);
	}
});

test('stella prompts: stored preambles keep the placeholder first line', () => {
	for (const mode of Object.values(STELLA_MODES)) {
		assert.equal(mode.preamble.split('\n')[0], STELLA_PHASE_ID_PLACEHOLDER);
	}
	assert.notEqual(STELLA_MODES.fable.preamble, STELLA_MODES.opus.preamble);
	assert.notEqual(STELLA_MODES.fable.fixPrompt, STELLA_MODES.opus.fixPrompt);
});

test('stella prompts: full prompt sets PHASE_ID and keeps the body verbatim', () => {
	const phase = STELLA_PHASES.find((p) => p.id === 'F2');
	assert.ok(phase);
	const mode = STELLA_MODES.fable;
	const preambleWithId = mode.preamble.replace(STELLA_PHASE_ID_PLACEHOLDER, 'PHASE_ID: F2');
	const full = composeStellaPrompt('fable', 'F2', 'full');
	assert.equal(full, `${preambleWithId}\n\n${phase.body}`);
	assert.ok(full.startsWith('PHASE_ID: F2\n\n<role>'));
	assert.ok(full.endsWith(phase.body));
});

test('stella prompts: fix prompt uses the mode fix text, phase-only is the body alone', () => {
	const phase = STELLA_PHASES.find((p) => p.id === 'F2');
	assert.ok(phase);
	const fixFable = composeStellaPrompt('fable', 'F2', 'fix');
	const fixOpus = composeStellaPrompt('opus', 'F2', 'fix');
	assert.ok(fixFable.startsWith('PHASE_ID: F2\n\n<role>'));
	assert.ok(fixFable.includes('<task>\nThis is a fix round for PHASE_ID.'));
	assert.ok(fixFable.endsWith(STELLA_MODES.fable.fixPrompt));
	assert.ok(fixOpus.endsWith(STELLA_MODES.opus.fixPrompt));
	assert.notEqual(fixFable, fixOpus);
	assert.equal(composeStellaPrompt('opus', 'F2', 'phase'), phase.body);
});

test('stella prompts: compose rejects unknown mode, phase and variant', () => {
	assert.throws(() => composeStellaPrompt('sonnet' as never, 'F2', 'full'));
	assert.throws(() => composeStellaPrompt('fable', 'F9', 'full'));
	assert.throws(() => composeStellaPrompt('fable', 'F2', 'all' as never));
});

test('stella prompts: no personal-info words in the prompt text', () => {
	const joined = [
		...Object.values(STELLA_MODES).flatMap((mode) => [mode.preamble, mode.fixPrompt]),
		...STELLA_PHASES.map((phase) => phase.body),
	]
		.join('\n')
		.toLowerCase();
	for (const word of ['benjamin', 'emond', 'cegep', 'rtx 4070']) {
		assert.ok(!joined.includes(word), word);
	}
});

test('stella prompts: page and API are gated behind the admin session', () => {
	const page = ACCESS_RULES.find((rule) => rule.pattern === '/projects/stella');
	assert.ok(page, 'missing /projects/stella rule');
	assert.equal(page.auth, 'token');
	assert.equal(page.sessionPattern, '/admin');
	assert.equal(page.redirectTo, '/admin/login');
	const api = ACCESS_RULES.find((rule) => rule.pattern === '/api/stella');
	assert.ok(api, 'missing /api/stella rule');
	assert.equal(api.auth, 'token');
	assert.equal(api.sessionPattern, '/admin');
	assert.equal(api.redirectTo, undefined);
});

test('stella prompts: page is server-rendered and unlisted', () => {
	const source = readFileSync(new URL('../src/pages/projects/stella.astro', import.meta.url), 'utf8');
	// verify-access.mjs enforces the same at build time; this pins it in
	// the suite so the regression is caught before the build runs.
	assert.match(source, /export\s+const\s+prerender\s*=\s*false/);
	assert.ok(source.includes('noindex'), 'gated page must be noindexed');
});

test('stella prompts: prompt text never ships in the client bundle', () => {
	const ui = readFileSync(new URL('../src/scripts/stella-prompts-ui.ts', import.meta.url), 'utf8');
	// The client bundle is served statically, without running the Worker —
	// importing the data here would publish every prompt to anyone who
	// fetched the chunk, page gate or not. The doc comment above names the
	// module it refuses to import, so this matches an import statement,
	// not a bare mention.
	assert.ok(!/from\s+['"]\.\.\/data\/stella-prompts['"]/.test(ui), 'client module must not import the prompt data');
	assert.ok(ui.includes('/api/stella/prompt'), 'client module fetches prompt text from the gated API');
});
