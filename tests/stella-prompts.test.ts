/**
 * Stella handoff prompts — the data behind /projects/stella/.
 *
 * The prompt text is quoted verbatim from the two handoff docs, so these
 * tests pin the properties that must survive any regeneration: the mode and
 * phase inventory, the shape of every phase body, and the one allowed
 * change — the preamble's first line, set to the selected phase.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	STELLA_FIRING_ORDER,
	STELLA_MODES,
	STELLA_PHASES,
	STELLA_PHASE_ID_PLACEHOLDER,
	composeStellaPrompt,
} from '../src/data/stella-prompts';

test('stella prompts: two modes and 27 phases in firing order', () => {
	assert.deepEqual(Object.keys(STELLA_MODES).sort(), ['fable', 'opus']);
	assert.equal(STELLA_PHASES.length, 27);
	assert.deepEqual(
		STELLA_PHASES.map((phase) => phase.id),
		STELLA_FIRING_ORDER,
	);
	assert.equal(new Set(STELLA_PHASES.map((phase) => phase.id)).size, 27);
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
