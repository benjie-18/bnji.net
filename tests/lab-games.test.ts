/**
 * BNJI.NET — behaviour for two live Lab experiments: Isometric Stack and
 * Minesweeper.
 *
 * These components are self-contained: the whole controller lives in the
 * component's own <script> block, with no module imports and no engine to
 * import. To test them, the component's REAL source is transpiled with
 * esbuild (the same compiler Astro uses for the build) and executed against
 * the DOM shim with a virtual clock, a fake IntersectionObserver and a
 * throwaway 2D context. The fixtures mirror each component's data-*
 * selectors, so a rename in the component fails here instead of the game
 * silently testing nothing.
 *
 * What each test pins down:
 *
 *  Isometric Stack — a perfect drop (inside the snap threshold) raises the
 *  visible combo, an overhang drop resets it, and the BEST combo is recorded
 *  so it survives to the game-over screen: the fatal drop of a run is always
 *  an overhang, which resets the live combo to 0 first, so a final screen
 *  that reads the live combo can only ever print 0. The combo also has to
 *  multiply the score (the documented "combo multiplier") and an overhang
 *  as wide as the top layer ends the game.
 *
 *  Minesweeper — clearing the last safe tile wins: the face, the mine
 *  counter and the auto-flags update, AND a win screen appears (title,
 *  stats, Play Again); the timer is stopped by the win; a loss reveals the
 *  mines without a win screen; Play Again resets to a fresh board and a
 *  second win is still possible.
 *
 * Timing note for the Stack driver: the active block moves 155 px/s at the
 * default speed, from -170, bouncing at ±170. Every rendered frame moves it
 * `155 * (frameTime - previousFrameTime)`, so a drop is timed by advancing
 * the virtual clock to exact frame times — deterministic, no sleeps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { installTestDom } from './support/dom.mjs';

const COMPONENTS_URL = new URL('../src/components/lab/', import.meta.url);

/** Base block speed in px/s at the default speed multiplier (StackGame). */
const STACK_SPEED = 155;

/* --- test infrastructure ------------------------------------------------- */

type Shim = ReturnType<typeof installTestDom>;

/**
 * A controllable IntersectionObserver. The real one is the onscreen gate for
 * a lab rAF loop; firing it here is what starts the game's render loop.
 */
class FakeIntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	readonly callback: (
		entries: Array<{ isIntersecting: boolean; target: Element }>,
		observer: FakeIntersectionObserver,
	) => void;
	observed: unknown[] = [];

	constructor(
		callback: (
			entries: Array<{ isIntersecting: boolean; target: Element }>,
			observer: FakeIntersectionObserver,
		) => void,
	) {
		this.callback = callback;
		FakeIntersectionObserver.instances.push(this);
	}

	observe(target: unknown) {
		this.observed.push(target);
	}

	unobserve() {}

	disconnect() {}

	fire(isIntersecting: boolean) {
		this.callback(
			this.observed.map((target) => ({ isIntersecting, target: target as Element })),
			this,
		);
	}
}

/**
 * A 2D context that absorbs every draw call. The Stack game's rendering is
 * not under test — its state machine is — so the context only has to exist,
 * with the two methods whose return values the code reads.
 */
function makeFakeCanvas2D(): RenderingContext {
	const gradient = { addColorStop() {} };
	const store: Record<PropertyKey, unknown> = {};
	return new Proxy(store, {
		get(target, prop) {
			if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => gradient;
			if (prop in target) return target[prop];
			return () => {};
		},
		set(target, prop, value) {
			target[prop] = value;
			return true;
		},
	}) as unknown as RenderingContext;
}

/**
 * Transpile a component's <script> block the way the build does and run it
 * in the current global context, where the shim DOM is installed.
 */
async function runComponentScript(component: string): Promise<void> {
	const source = readFileSync(fileURLToPath(new URL(component, COMPONENTS_URL)), 'utf8');
	const startTag = '<script>';
	const start = source.indexOf(startTag);
	const end = source.indexOf('</script>', start);
	if (start === -1 || end === -1) throw new Error(`${component}: no <script> block found`);
	const ts = source.slice(start + startTag.length, end);
	const { code } = await transform(ts, { loader: 'ts' });
	// Wrapping in an IIFE keeps the script's top-level consts out of the
	// global lexical scope: runInThisContext bindings would otherwise
	// survive across runs and the second component's `const root` would
	// collide with the first one's.
	vm.runInThisContext(`(() => {\n${code}\n})();`, { filename: component });
}

/** Plain-object event: the shim's dispatchEvent takes objects, not Events. */
function dispatch(target: Element, type: string, eventTarget?: Element): void {
	const event = {
		type,
		target: eventTarget,
		preventDefault() {},
		stopPropagation() {},
	};
	(target as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(event);
}

function el(tag: string, attrs: Record<string, string> = {}, text = ''): HTMLElement {
	const node = document.createElement(tag);
	for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
	if (text) node.textContent = text;
	return node;
}

function append(parent: Element, ...children: Element[]): Element {
	for (const child of children) parent.appendChild(child);
	return parent;
}

function withGlobals<T>(fn: () => Promise<T> | T): Promise<T> {
	// Node has no IntersectionObserver; the games gate their rAF loop on it.
	const previous = (globalThis as Record<string, unknown>)['IntersectionObserver'];
	(globalThis as Record<string, unknown>)['IntersectionObserver'] = FakeIntersectionObserver;
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			if (previous === undefined) delete (globalThis as Record<string, unknown>)['IntersectionObserver'];
			else (globalThis as Record<string, unknown>)['IntersectionObserver'] = previous;
		});
}

/* --- Isometric Stack fixture & driver ------------------------------------ */

function buildStackFixture() {
	const root = el('div', { 'data-stack-game': '', class: 'stack-game' });

	const header = el('div', { class: 'stack-header' });
	const score = el('span', { 'data-sg-score': '' }, '0');
	const combo = el('div', { 'data-sg-combo': '', class: 'stack-combo' });
	combo.hidden = true;
	combo.setAttribute('hidden', '');
	append(combo, append(el('span', { class: 'stack-combo-badge' }), el('span', { 'data-sg-combo-count': '' }, '1')));
	append(header, score, combo, el('span', { 'data-sg-best': '' }, '0'));

	const viewport = el('div', { class: 'stack-viewport' });
	const canvas = el('canvas', { 'data-sg-canvas': '', width: '640', height: '520' }) as HTMLCanvasElement;
	canvas.width = 640;
	canvas.height = 520;
	// The shim's canvas element is not a real HTMLCanvasElement; the game
	// only needs getContext('2d') to hand back a drawable surface.
	(canvas as unknown as { getContext: () => unknown }).getContext = () => makeFakeCanvas2D();
	const overlay = el('div', { 'data-sg-overlay': '' });
	overlay.setAttribute('hidden', '');
	append(
		overlay,
		append(
			el('div', { class: 'stack-overlay-card' }),
			el('h3', { 'data-sg-title': '' }, 'ISO STACK'),
			el('p', { 'data-sg-desc': '' }, 'Tap or press Space to drop layers.'),
			el('button', { 'data-sg-start': '', type: 'button' }, 'Start Game'),
		),
	);
	const hud = el('div', { class: 'stack-hud' });
	append(hud, el('button', { 'data-sg-restart': '', type: 'button' }, 'Reset'));
	append(hud, append(el('button', { 'data-sg-audio': '', type: 'button', 'aria-pressed': 'true' }), el('span', { 'data-sg-audio-dot': '' })));
	append(viewport, canvas, overlay, hud);

	const controls = el('div', { class: 'lab-controls' });
	for (const key of ['theme', 'thickness', 'zoom', 'speed'] as const) {
		append(
			controls,
			append(
				el('label', { class: 'lab-control' }),
				el('input', { 'data-sg-in': key, type: 'range', value: key === 'theme' ? '0' : key === 'thickness' ? '18' : key === 'zoom' ? '1.0' : '2' }),
				el('output', { 'data-sg-out': key }),
			),
		);
	}

	append(root, header, viewport, controls);
	document.body.appendChild(root);
	return { root, score, combo, comboCount: combo.querySelector('[data-sg-combo-count]') as Element, overlay, canvas };
}

/**
 * Drives the Stack game by timing frames. The virtual clock keeps
 * MILLISECONDS, and the component clamps each frame's dt to 0.1s, so one
 * frame moves the block at most STACK_SPEED * 0.1 = 15.5px.
 *
 * After any spawn (the initial one, a drop, or a restart) the block sits at
 * -170. The driver renders one long frame first: whatever its gap, dt clamps
 * to exactly the 0.1 literal, so the block ends at -170 + 155*0.1 — the same
 * arithmetic the game performs, exactly. From there, 100ms frames each move
 * it another 15.5px, and one final exact-length frame lands it on
 * `targetPos` (within floating-point dust, far inside the 3.5px snap).
 */
function createStackDriver(canvas: HTMLCanvasElement, clock: { advance(ms: number): void }) {
	let lastFrameTime = 0;

	function advanceTo(timeMs: number) {
		clock.advance(timeMs - lastFrameTime);
		lastFrameTime = timeMs;
	}

	/** Render one frame 16.67ms later (~60fps). */
	function frame(): void {
		advanceTo(lastFrameTime + 16.67);
	}

	/** Drop the block when its position is exactly `targetPos`. */
	function drop(targetPos: number): void {
		advanceTo(lastFrameTime + 2000); // long frame: dt clamps to 0.1s
		let pos = -170 + STACK_SPEED * 0.1;
		const step = STACK_SPEED * 0.1; // 15.5px per 100ms frame
		const steps = Math.floor((targetPos - pos - 1e-9) / step);
		for (let i = 0; i < steps; i += 1) advanceTo(lastFrameTime + 100);
		pos += steps * step;
		advanceTo(lastFrameTime + ((targetPos - pos) / STACK_SPEED) * 1000);
		dispatch(canvas, 'pointerdown');
	}

	return { frame, drop };
}

/* --- Minesweeper fixture & helpers ---------------------------------------- */

const MS_ROWS = 9;
const MS_COLS = 9;
const MS_MINES = 10;

function buildMinesweeperFixture() {
	const root = el('div', { 'data-minesweeper': '', class: 'glass-minesweeper' });

	const hud = el('div', { class: 'ms-hud' });
	append(
		hud,
		append(el('div', { class: 'ms-counter' }), el('span', { 'data-ms-mines': '' }, '010')),
		append(el('button', { 'data-ms-face': '', type: 'button', 'aria-label': 'Reset Minesweeper game' }), el('span', { 'data-ms-face-icon': '' }, '(◕‿◕)')),
		append(el('div', { class: 'ms-counter' }), el('span', { 'data-ms-time': '' }, '000')),
	);

	const toolbar = el('div', { class: 'ms-toolbar' });
	const diffs = el('div', { class: 'ms-difficulties', role: 'radiogroup', 'aria-label': 'Game Difficulty' });
	append(diffs, el('button', { 'data-ms-diff': 'easy', type: 'button', class: 'is-active' }, 'Beginner (9×9)'));
	append(diffs, el('button', { 'data-ms-diff': 'medium', type: 'button' }, 'Intermediate (12×12)'));
	append(diffs, el('button', { 'data-ms-diff': 'hard', type: 'button' }, 'Expert (16×14)'));
	append(diffs, el('button', { 'data-ms-diff': 'custom', type: 'button' }, 'Custom'));
	const tools = el('div', { class: 'ms-tools' });
	append(tools, append(el('button', { 'data-ms-flag-toggle': '', type: 'button', 'aria-pressed': 'false' }), el('span', { 'data-ms-flag-label': '' }, 'Mode: ⛏ Dig')));
	append(tools, append(el('button', { 'data-ms-audio': '', type: 'button', 'aria-pressed': 'true' }), el('span', { 'data-ms-audio-dot': '' })));
	append(tools, el('button', { 'data-ms-settings-toggle': '', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Toggle game settings' }, '⚙ Settings'));
	append(toolbar, diffs, tools);

	const drawer = el('div', { 'data-ms-settings-drawer': '' });
	drawer.hidden = true;
	append(
		drawer,
		append(
			el('div', { class: 'ms-settings-panel' }),
			append(el('div', { class: 'ms-settings-header' }), el('span', { class: 'ms-settings-title' }, 'CUSTOM'), el('button', { 'data-ms-settings-close': '', type: 'button' }, 'Close ✕')),
			el('label', { class: 'lab-control' }),
		),
	);
	const colsIn = el('input', { 'data-ms-in': 'cols', type: 'range', value: '9' });
	const rowsIn = el('input', { 'data-ms-in': 'rows', type: 'range', value: '9' });
	const minesIn = el('input', { 'data-ms-in': 'mines', type: 'range', value: '10' });
	const themeIn = el('select', { 'data-ms-in': 'theme' });
	const glassIn = el('select', { 'data-ms-in': 'glass' });
	append(
		drawer,
		el('output', { 'data-ms-out': 'cols' }, '9 Cols'),
		el('output', { 'data-ms-out': 'rows' }, '9 Rows'),
		el('output', { 'data-ms-out': 'mines' }, '10 Mines (12%)'),
		el('output', { 'data-ms-out': 'theme' }, 'Liquid Aero'),
		el('output', { 'data-ms-out': 'glass' }, 'Crystal Clear'),
		el('button', { 'data-ms-apply-custom': '', type: 'button' }, 'Apply & Start Game'),
	);
	drawer.appendChild(colsIn);
	drawer.appendChild(rowsIn);
	drawer.appendChild(minesIn);
	drawer.appendChild(themeIn);
	drawer.appendChild(glassIn);

	const viewport = el('div', { 'data-ms-viewport': '' });
	const grid = el('div', { 'data-ms-grid': '', role: 'grid', 'aria-label': 'Minesweeper Board' });
	const overlay = el('div', { 'data-ms-overlay': '' });
	overlay.hidden = true;
	append(
		overlay,
		append(
			el('div', { class: 'ms-overlay-card' }),
			el('span', { 'data-ms-overlay-emoji': '' }, '(★‿★)'),
			el('h3', { 'data-ms-overlay-title': '' }, 'You win!'),
			el('p', { 'data-ms-overlay-desc': '' }, 'Cleared the board.'),
			el('button', { 'data-ms-play-again': '', type: 'button', class: 'glass-button' }, 'Play Again'),
		),
	);
	append(viewport, grid, overlay);

	append(root, hud, toolbar, drawer, viewport, el('div', { class: 'lab-hint' }, 'Left-click to reveal'));
	document.body.appendChild(root);

	const q = (selector: string) => root.querySelector(selector) as Element;
	return {
		root,
		grid,
		mines: q('[data-ms-mines]'),
		time: q('[data-ms-time]'),
		faceIcon: q('[data-ms-face-icon]'),
		overlay,
		overlayTitle: q('[data-ms-overlay-title]'),
		overlayDesc: q('[data-ms-overlay-desc]'),
		playAgain: q('[data-ms-play-again]'),
		cell: (r: number, c: number) => grid.querySelector(`[data-r="${r}"][data-c="${c}"]`) as Element,
		cells: () => Array.from(grid.querySelectorAll('.ms-cell')),
	};
}

/** Deterministic PRNG so the mine layout — and the test's copy of it — are known. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Mirror of GlassMinesweeper's seedMines placement loop: random cells until
 * `mines` are planted, skipping the 3×3 around the first click and cells
 * that already hold a mine. Kept in lockstep with the component so the test
 * knows exactly which tiles are mines without reaching into its closure.
 */
function simulateMines(rows: number, cols: number, mines: number, safeR: number, safeC: number, rng: () => number): boolean[][] {
	const layout: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
	let planted = 0;
	const target = Math.min(mines, rows * cols - 1);
	while (planted < target) {
		const r = Math.floor(rng() * rows);
		const c = Math.floor(rng() * cols);
		if (Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1) continue;
		if (!layout[r][c]) {
			layout[r][c] = true;
			planted += 1;
		}
	}
	return layout;
}

/* --- tests ----------------------------------------------------------------- */

test('iso stack: perfect drops build the combo, the best combo survives to game over, and the combo multiplies the score', async () => {
	await withGlobals(async () => {
		const dom = installTestDom() as Shim;
		FakeIntersectionObserver.instances = [];
		try {
			const { score, combo, comboCount, overlay, canvas } = buildStackFixture();
			await runComponentScript('StackGame.astro');

			// Start the onscreen-gated render loop.
			const observer = FakeIntersectionObserver.instances[0];
			assert.ok(observer, 'StackGame must gate its loop on IntersectionObserver');
			observer.fire(true);

			const driver = createStackDriver(canvas, dom.clock);
			driver.frame(); // idle frame: the game is not playing yet

			// Start the game with the overlay button, as a visitor would —
			// the first action starts the run, it does not drop a block.
			const startBtn = overlay.querySelector('[data-sg-start]') as Element;
			dispatch(startBtn, 'click');
			assert.equal(overlay.hasAttribute('hidden'), true, 'overlay hides when the game starts');

			// Three perfect drops (z, x, z) — the combo badge must climb.
			driver.drop(0);
			assert.equal(score.textContent, '1', 'first perfect drop scores 1');
			assert.equal(combo.hidden, false, 'combo badge shows after a perfect drop');
			assert.equal(comboCount.textContent, '1', 'combo counts 1');

			driver.drop(0);
			assert.equal(comboCount.textContent, '2', 'combo counts 2');
			assert.equal(score.textContent, '3', 'second perfect drop is worth 2 (combo multiplier)');

			driver.drop(0);
			assert.equal(comboCount.textContent, '3', 'combo counts 3');
			assert.equal(score.textContent, '6', 'third perfect drop is worth 3');

			// An overhang drop resets the combo but still places a layer.
			driver.drop(40);
			assert.equal(combo.hidden, true, 'overhang drop hides the combo badge');
			assert.equal(score.textContent, '7', 'imperfect drop is worth 1');

			// Perfect again — relative to the new (offset) top layer.
			driver.drop(0);
			assert.equal(combo.hidden, false, 'combo restarts after an overhang');
			assert.equal(comboCount.textContent, '1', 'combo restarts at 1');
			assert.equal(score.textContent, '8', 'fourth placed layer worth 1 more');

			// Fatal drop: overhang wider than the top layer ends the game.
			driver.drop(170);
			assert.equal(overlay.hasAttribute('hidden'), false, 'game-over overlay is shown');
			assert.equal(overlay.querySelector('[data-sg-title]')?.textContent, 'GAME OVER');
			// The fatal drop just reset the live combo to 0, so a screen that
			// reads the live combo would print "Best combo: 0" — the recorded
			// best (3) is what must be registered.
			assert.equal(
				overlay.querySelector('[data-sg-desc]')?.textContent,
				'Stacked 5 crystal layers! Best combo: 3.',
				'game over reports layers and the best combo reached',
			);
			assert.equal(score.textContent, '8', 'final score');
			assert.equal(overlay.querySelector('[data-sg-start]')?.textContent, 'Play Again');

			// Play Again resets the run.
			dispatch(overlay.querySelector('[data-sg-start]') as Element, 'click');
			assert.equal(overlay.hasAttribute('hidden'), true, 'overlay hides on restart');
			assert.equal(score.textContent, '0', 'score resets');
			assert.equal(combo.hidden, true, 'combo resets');
			driver.drop(0);
			assert.equal(score.textContent, '1', 'the restarted run plays normally');
		} finally {
			dom.uninstall();
		}
	});
});

test('minesweeper: clearing the last safe tile wins and shows the win screen', async () => {
	await withGlobals(async () => {
		const dom = installTestDom() as Shim;
		const realRandom = Math.random;
		try {
			const ms = buildMinesweeperFixture();
			await runComponentScript('GlassMinesweeper.astro');

			assert.equal(ms.cells().length, MS_ROWS * MS_COLS, 'board renders the full grid');

			// Deterministic mine layout for the first click at (0,0).
			Math.random = mulberry32(2026);
			const mines = simulateMines(MS_ROWS, MS_COLS, MS_MINES, 0, 0, mulberry32(2026));
			assert.equal(ms.mines.textContent, '010', 'mine counter starts at the mine count');

			// First click: safe by guarantee, seeds the board, starts the timer.
			dispatch(ms.grid, 'click', ms.cell(0, 0));
			assert.equal(ms.faceIcon.textContent, '(◕‿◕)', 'face is normal after the safe first click');

			// Let 5 seconds elapse, then reveal every remaining safe tile.
			dom.clock.advance(5000);
			assert.equal(ms.time.textContent, '005', 'timer runs while the game is alive');
			for (let r = 0; r < MS_ROWS; r += 1) {
				for (let c = 0; c < MS_COLS; c += 1) {
					if (!mines[r][c]) dispatch(ms.grid, 'click', ms.cell(r, c));
				}
			}

			// Win state: face, counter, auto-flags…
			assert.equal(ms.faceIcon.textContent, '(★‿★)', 'face shows the win theme');
			assert.equal(ms.mines.textContent, '000', 'mine counter zeroes on a win');
			for (let r = 0; r < MS_ROWS; r += 1) {
				for (let c = 0; c < MS_COLS; c += 1) {
					const cell = ms.cell(r, c);
					if (mines[r][c]) {
						assert.ok(cell.classList.contains('is-flagged'), `mine at ${r},${c} auto-flagged`);
						assert.equal(cell.textContent, '🚩', `mine at ${r},${c} shows the flag`);
					} else {
						assert.ok(cell.classList.contains('is-revealed'), `safe tile ${r},${c} revealed`);
					}
				}
			}

			// …and the win screen itself.
			assert.equal(ms.overlay.hidden, false, 'win overlay is shown');
			assert.equal(ms.overlayTitle.textContent, 'You win!');
			assert.match(ms.overlayDesc.textContent, /9×9 in 5s/, 'win screen reports the board and the time');

			// The win stops the timer.
			dom.clock.advance(3000);
			assert.equal(ms.time.textContent, '005', 'timer is frozen after the win');

			// Play Again starts a fresh game.
			dispatch(ms.playAgain, 'click');
			assert.equal(ms.overlay.hidden, true, 'win overlay hides on reset');
			assert.equal(ms.faceIcon.textContent, '(◕‿◕)', 'face resets');
			assert.equal(ms.mines.textContent, '010', 'mine counter resets');
			assert.equal(ms.time.textContent, '000', 'timer resets');
			assert.ok(ms.cells().every((cell) => cell.classList.contains('is-unrevealed')), 'fresh board is fully unrevealed');

			// A second game can still be won (fresh seed, first click at 4,4).
			Math.random = mulberry32(1337);
			const mines2 = simulateMines(MS_ROWS, MS_COLS, MS_MINES, 4, 4, mulberry32(1337));
			dispatch(ms.grid, 'click', ms.cell(4, 4));
			for (let r = 0; r < MS_ROWS; r += 1) {
				for (let c = 0; c < MS_COLS; c += 1) {
					if (!mines2[r][c]) dispatch(ms.grid, 'click', ms.cell(r, c));
				}
			}
			assert.equal(ms.faceIcon.textContent, '(★‿★)', 'second game wins too');
			assert.equal(ms.overlay.hidden, false, 'win screen appears again');
		} finally {
			Math.random = realRandom;
			dom.uninstall();
		}
	});
});

test('minesweeper: a loss reveals the mines but never shows the win screen', async () => {
	await withGlobals(async () => {
		const dom = installTestDom() as Shim;
		const realRandom = Math.random;
		try {
			const ms = buildMinesweeperFixture();
			await runComponentScript('GlassMinesweeper.astro');

			Math.random = mulberry32(2026);
			const mines = simulateMines(MS_ROWS, MS_COLS, MS_MINES, 0, 0, mulberry32(2026));

			// Safe first click, then walk straight into a mine.
			dispatch(ms.grid, 'click', ms.cell(0, 0));
			const mineAt = (r: number, c: number) => mines[r][c] && !ms.cell(r, c).classList.contains('is-revealed');
			let hitR = -1;
			let hitC = -1;
			outer: for (let r = 0; r < MS_ROWS; r += 1) {
				for (let c = 0; c < MS_COLS; c += 1) {
					if (mineAt(r, c)) {
						hitR = r;
						hitC = c;
						break outer;
					}
				}
			}
			assert.ok(hitR >= 0, 'a mine is reachable for the loss case');
			dispatch(ms.grid, 'click', ms.cell(hitR, hitC));

			// Loss state: dead face, detonated tile, mines revealed…
			assert.equal(ms.faceIcon.textContent, '(×_×)', 'face shows the dead theme');
			assert.ok(ms.cell(hitR, hitC).classList.contains('is-detonated'), 'the hit mine detonates');
			assert.equal(ms.cell(hitR, hitC).textContent, '💥');
			for (let r = 0; r < MS_ROWS; r += 1) {
				for (let c = 0; c < MS_COLS; c += 1) {
					if (mines[r][c] && !(r === hitR && c === hitC)) {
						assert.equal(ms.cell(r, c).textContent, '💣', `unhit mine ${r},${c} revealed`);
					}
				}
			}

			// …but no win screen, and the face still resets the game.
			assert.equal(ms.overlay.hidden, true, 'loss must not show the win overlay');
			dispatch(ms.root.querySelector('[data-ms-face]') as Element, 'click');
			assert.equal(ms.faceIcon.textContent, '(◕‿◕)', 'face click resets after a loss');
			assert.ok(ms.cells().every((cell) => cell.classList.contains('is-unrevealed')), 'board is fresh after reset');
		} finally {
			Math.random = realRandom;
			dom.uninstall();
		}
	});
});
