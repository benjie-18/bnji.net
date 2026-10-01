/** `bnji.stack` shared rules: scoring, snap, miss, and proof reconstruction. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	STACK_MAX_PROOF_LAYERS,
	STACK_POSITION_SCALE,
	STACK_TRAVEL,
	quantizePosition,
	stackDrop,
	stackStart,
	stackTieBreak,
	verifyStackRun,
} from '../src/game/stack-rules';

function perfectDrop(run: ReturnType<typeof stackStart>, pos = 0) {
	const step = stackDrop(run, quantizePosition(pos));
	assert.equal(step.ok, true);
	if (!step.ok) throw new Error('unreachable');
	assert.equal(step.result.kind, 'placed');
	return step;
}

describe('stack-rules', () => {
	test('a run starts on the lab base block and always moves the first drop on z', () => {
		const run = stackStart();
		assert.equal(run.axis, 'z');
		assert.deepEqual(run.layers[0], { x: 0, z: 0, w: 140, d: 140 });
		assert.equal(run.score, 0);
		assert.equal(run.combo, 0);
	});

	test('consecutive perfect drops score the triangular combo sequence', () => {
		let run = stackStart();
		const axes: string[] = [];
		const expected = [1, 3, 6, 10, 15];
		for (let i = 0; i < 5; i += 1) {
			const step = perfectDrop(run);
			run = step.run;
			if (step.result.kind !== 'placed') throw new Error('unreachable');
			axes.push(step.result.axis);
			assert.equal(step.result.perfect, true, `drop ${i} is perfect`);
			assert.equal(run.score, expected[i]);
		}
		assert.equal(run.maxCombo, 5);
		// Axes alternate starting on z: z, x, z, x, z.
		assert.deepEqual(axes, ['z', 'x', 'z', 'x', 'z']);
		// Every layer of a perfect streak stays centred on the base.
		assert.ok(run.layers.every((layer) => layer.x === 0 && layer.z === 0));
	});

	test('an offset drop trims the slab exactly like the lab renderer', () => {
		let run = stackStart();
		const step = stackDrop(run, quantizePosition(10));
		assert.equal(step.ok, true);
		if (!step.ok) throw new Error('unreachable');
		assert.equal(step.result.kind, 'placed');
		if (step.result.kind !== 'placed') throw new Error('unreachable');
		assert.equal(step.result.perfect, false);
		assert.equal(step.result.points, 1);
		// z-axis: width trimmed 140→130, centre shifted +5.
		assert.deepEqual(step.run.layers[1], { x: 0, z: 5, w: 140, d: 130 });
		assert.equal(step.run.combo, 0);
		assert.equal(step.run.score, 1);
	});

	test('missing the slab ends the run without mutating it', () => {
		const run = stackStart();
		const exact = stackDrop(run, quantizePosition(140)); // overhang >= width is a miss
		assert.equal(exact.ok, true);
		if (!exact.ok) throw new Error('unreachable');
		assert.equal(exact.result.kind, 'miss');
		assert.deepEqual(exact.run, run);
		const beyond = stackDrop(run, quantizePosition(-160));
		assert.equal(beyond.ok, true);
		if (!beyond.ok) throw new Error('unreachable');
		assert.equal(beyond.result.kind, 'miss');
	});

	test('snap boundary is inclusive at exactly 3.5px and exclusive above it', () => {
		const atBoundary = stackDrop(stackStart(), 3.5 * STACK_POSITION_SCALE);
		assert.equal(atBoundary.ok && atBoundary.result.kind === 'placed' && atBoundary.result.perfect, true);
		const above = stackDrop(stackStart(), 71); // 3.55px
		assert.equal(above.ok, true);
		if (!above.ok) throw new Error('unreachable');
		assert.equal(above.result.kind === 'placed' && above.result.perfect, false);
		if (above.result.kind !== 'placed') throw new Error('unreachable');
		assert.equal(above.result.layer.d, 140 - 3.55);
	});

	test('positions are quantized to 0.05px and travel bounds are enforced', () => {
		assert.equal(quantizePosition(10.024), 200);
		assert.equal(quantizePosition(10.026), 201);
		assert.equal(stackDrop(stackStart(), STACK_TRAVEL * STACK_POSITION_SCALE + 1).ok, false);
		assert.equal(stackDrop(stackStart(), Number.NaN).ok, false);
		assert.equal(stackDrop(stackStart(), 1.5).ok, false, 'proof positions must be integers');
	});

	test('runs deeper than the proof cap refuse new drops', () => {
		let run = stackStart();
		for (let i = 0; i < STACK_MAX_PROOF_LAYERS; i += 1) {
			const step = stackDrop(run, 0);
			assert.equal(step.ok, true);
			if (!step.ok) throw new Error('unreachable');
			run = step.run;
		}
		const overflow = stackDrop(run, 0);
		assert.equal(overflow.ok, false);
	});

	test('verifyStackRun reconstructs score, layers and combo from a scripted run', () => {
		// All-perfect run: 1+2+3+4 = 10, five layers, max combo 4.
		const perfect = verifyStackRun({ drops: [0, 0, 0, 0], fatal: quantizePosition(150) });
		assert.deepEqual(perfect, { score: 10, layers: 5, maxCombo: 4 });
		// Offset between perfects resets the streak: 1 + 1 + 1 = 3, four layers.
		const mixed = verifyStackRun({ drops: [0, quantizePosition(10), 0], fatal: quantizePosition(-150) });
		assert.deepEqual(mixed, { score: 3, layers: 4, maxCombo: 1 });
	});

	test('verifyStackRun rejects anything that is not a complete legal run', () => {
		assert.equal(verifyStackRun(null), null);
		assert.equal(verifyStackRun({ drops: [], fatal: 0 }), null, 'at least one placed layer');
		assert.equal(verifyStackRun({ drops: [0], fatal: 0 }), null, 'fatal drop must actually miss');
		assert.equal(verifyStackRun({ drops: [quantizePosition(200)], fatal: 0 }), null, 'drops may not miss');
		assert.equal(verifyStackRun({ drops: [0, 0], fatal: 1.5 }), null, 'fatal must be an integer');
		assert.equal(verifyStackRun({ drops: [STACK_TRAVEL * STACK_POSITION_SCALE + 1], fatal: 0 }), null, 'out-of-range drops');
		assert.equal(verifyStackRun({ drops: new Array(STACK_MAX_PROOF_LAYERS + 1).fill(0), fatal: 0 }), null, 'over the proof cap');
		assert.equal(verifyStackRun('drops'), null);
		assert.equal(verifyStackRun({ drops: [0], fatal: STACK_TRAVEL * STACK_POSITION_SCALE + 1 }), null, 'fatal out of range');
	});

	test('tie-breaks rank deeper runs first', () => {
		assert.ok(stackTieBreak(10) > stackTieBreak(11));
		assert.equal(stackTieBreak(0), 999);
	});
});
