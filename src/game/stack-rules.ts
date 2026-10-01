/**
 * Shared Isometric Stack rules for `bnji.stack`.
 *
 * The lab renderer and the server verifier replay this exact module, so a
 * leaderboard proof — the sequence of block positions at each drop — is
 * reconstructed server-side instead of trusted. Physics constants match the
 * lab game (140px base, ±170px travel, ≤3.5px snap) at the one fixed speed;
 * movement speed itself is cosmetic and never part of the proof.
 *
 * Proof encoding: each drop position is quantized to 1/20 px and sent as an
 * integer (`pos * 20`). All derived layer maths runs on those inputs in
 * deterministic IEEE-754 order, so client and server always agree.
 */

export const STACK_BASE_SIZE = 140;
export const STACK_TRAVEL = 170;
export const STACK_SNAP_PX = 3.5;
/** Quantization: proof integers are positions × STACK_POSITION_SCALE (0.05 px). */
export const STACK_POSITION_SCALE = 20;
/** Proof/replay cap — runs deeper than this cannot be claimed (payload bound). */
export const STACK_MAX_PROOF_LAYERS = 250;

export type StackAxis = 'x' | 'z';
export type StackLayer = { x: number; z: number; w: number; d: number };
export type StackRun = {
	/** `layers[0]` is the fixed base block; each entry after it was placed by a drop. */
	layers: StackLayer[];
	/** Axis of the NEXT drop. The first drop of a run always moves on `z` (lab parity). */
	axis: StackAxis;
	score: number;
	combo: number;
	maxCombo: number;
};

export type StackDropResult =
	| { kind: 'placed'; points: number; perfect: boolean; layer: StackLayer; diff: number; axis: StackAxis }
	| { kind: 'miss' };

export function stackStart(): StackRun {
	return {
		layers: [{ x: 0, z: 0, w: STACK_BASE_SIZE, d: STACK_BASE_SIZE }],
		axis: 'z',
		score: 0,
		combo: 0,
		maxCombo: 0,
	};
}

/** Quantize a live float position to the proof integer space (rounds to 0.05 px). */
export function quantizePosition(pos: number): number {
	return Math.round(pos * STACK_POSITION_SCALE);
}

/**
 * Apply one drop at a quantized position. Mutates nothing: returns the next
 * run on success so both the renderer and the verifier thread the same values.
 */
export function stackDrop(run: StackRun, posQ: number): { ok: true; run: StackRun; result: StackDropResult } | { ok: false; error: 'bad_position' | 'too_deep' } {
	if (!Number.isSafeInteger(posQ) || Math.abs(posQ) > STACK_TRAVEL * STACK_POSITION_SCALE) return { ok: false, error: 'bad_position' };
	if (run.layers.length - 1 >= STACK_MAX_PROOF_LAYERS) return { ok: false, error: 'too_deep' };
	const prev = run.layers[run.layers.length - 1]!;
	const axis = run.axis;
	const pos = posQ / STACK_POSITION_SCALE;
	const center = axis === 'x' ? prev.x : prev.z;
	const diff = pos - center;

	let snapDiff = diff;
	let perfect = false;
	let combo = run.combo;
	let points = 1;
	if (Math.abs(diff) <= STACK_SNAP_PX) {
		snapDiff = 0;
		combo += 1;
		points = combo;
		perfect = true;
	} else {
		combo = 0;
	}

	const prevWidth = axis === 'x' ? prev.w : prev.d;
	const overhang = Math.abs(snapDiff);
	if (overhang >= prevWidth) return { ok: true, run, result: { kind: 'miss' } };

	let layer: StackLayer;
	if (axis === 'x') {
		const newW = prevWidth - overhang;
		// The kept slab is centred where the two slabs overlap: shift by half the signed offset.
		layer = { x: prev.x + snapDiff / 2, z: prev.z, w: newW, d: prev.d };
	} else {
		const newD = prevWidth - overhang;
		layer = { x: prev.x, z: prev.z + snapDiff / 2, w: prev.w, d: newD };
	}

	const next: StackRun = {
		layers: [...run.layers, layer],
		axis: axis === 'x' ? 'z' : 'x',
		score: run.score + points,
		combo,
		maxCombo: Math.max(run.maxCombo, combo),
	};
	return { ok: true, run: next, result: { kind: 'placed', points, perfect, layer, diff: snapDiff, axis } };
}

/**
 * Replay a full run: `drops` are the quantized positions of every placed
 * layer, `fatal` is the position of the drop that ended the game (it must
 * actually miss). Returns null for anything that does not reconstruct into a
 * complete, legal run.
 */
export function verifyStackRun(proof: unknown): { score: number; layers: number; maxCombo: number } | null {
	if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
	const value = proof as Record<string, unknown>;
	const drops = value.drops;
	const fatal = value.fatal;
	if (!Array.isArray(drops) || drops.length < 1 || drops.length > STACK_MAX_PROOF_LAYERS) return null;
	if (!drops.every((entry) => Number.isSafeInteger(entry))) return null;
	if (!Number.isSafeInteger(fatal)) return null;
	let run = stackStart();
	for (const drop of drops as number[]) {
		const step = stackDrop(run, drop);
		if (!step.ok || step.result.kind === 'miss') return null;
		run = step.run;
	}
	// The fatal drop is judged against the last placed layer, exactly like
	// `stackDrop` would have judged it — and it must be a miss.
	if (Math.abs(fatal as number) > STACK_TRAVEL * STACK_POSITION_SCALE) return null;
	const last = run.layers[run.layers.length - 1]!;
	const axis = run.axis;
	const center = axis === 'x' ? last.x : last.z;
	const diff = (fatal as number) / STACK_POSITION_SCALE - center;
	const snapDiff = Math.abs(diff) <= STACK_SNAP_PX ? 0 : diff;
	const width = axis === 'x' ? last.w : last.d;
	if (Math.abs(snapDiff) < width) return null; // the run must end on the fatal miss
	return { score: run.score, layers: run.layers.length, maxCombo: run.maxCombo };
}

/** Leaderboard tie-break: deeper runs rank first when scores tie (ascending storage). */
export function stackTieBreak(layers: number): number {
	return Math.max(1, 999 - layers);
}
