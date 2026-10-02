/**
 * `bnji.isometric-stack` browser client — the Lab isometric stack game,
 * ported to the Games shell at ONE fixed speed (Normal, 155px/s) with a
 * server-verified leaderboard claim.
 *
 * Gameplay math is owned by `src/game/stack-rules.ts`: the renderer feeds
 * quantized drop positions into the same `stackDrop` the verifier replays, so
 * a claimed run is reconstructed server-side rather than trusted.
 *
 * Rendering notes that are easy to regress:
 *  - The canvas backing store is the CSS box times devicePixelRatio (the page
 *    gives the canvas an aspect-ratio so that box exists before the first
 *    frame); every projection reads the backing store, so one path serves 1x
 *    and retina.
 *  - Only the two faces a viewer can actually see are painted: the +z face
 *    (p3 → p2 → p6 → p7) and the +x face. Painting far faces too is invisible
 *    on an opaque block and shows as a wrong-coloured slab on a fading one.
 *  - Sparks live in WORLD coordinates and are projected at draw time, so they
 *    rise and fall with the tower instead of staying glued to a screen pixel.
 */
import type { GameModule } from '../game-runtime';
import {
	STACK_TRAVEL,
	quantizePosition,
	stackDrop,
	stackStart,
	stackTieBreak,
	type StackRun,
} from '../../game/stack-rules';
import { setGameShellState } from '../game-shell';
import { autoSubmitRun, createRunToken, idempotencyKey, readStanding, submitRun, type Standing } from '../game-scores';

const STACK_GAME_ID = 'bnji.isometric-stack';
const STACK_MODE_ID = 'default';
const LAYER_HEIGHT = 18;
const SPEED_PX_PER_SEC = 155; // the ONE fixed speed — no difficulty or speed options
const BEST_STORAGE_KEY = 'bnji:stack:best';

type Debris = { x: number; y: number; z: number; w: number; d: number; vy: number; vx: number; vz: number; opacity: number; colorIndex: number };
type Spark = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; maxLife: number; size: number; color: string };

export type StackGame = ReturnType<typeof createStackGame>;

export function createStackGame() {
	// ------------------------------------------------------------- page refs
	const canvas = document.querySelector<HTMLCanvasElement>('[data-stack-canvas]');
	const ctx = canvas?.getContext('2d') ?? null;
	const scoreEl = document.querySelector<HTMLElement>('[data-stack-score]');
	const bestEl = document.querySelector<HTMLElement>('[data-stack-best]');
	const comboEl = document.querySelector<HTMLElement>('[data-stack-combo]');
	const comboCountEl = document.querySelector<HTMLElement>('[data-stack-combo-count]');
	const statusEl = document.querySelector<HTMLElement>('[data-stack-status]');
	const overlay = document.querySelector<HTMLElement>('[data-stack-overlay]');
	const overlayTitle = document.querySelector<HTMLElement>('[data-stack-overlay-title]');
	const overlayDesc = document.querySelector<HTMLElement>('[data-stack-overlay-desc]');
	const startButton = document.querySelector<HTMLButtonElement>('[data-stack-start]');
	const againButton = document.querySelector<HTMLButtonElement>('[data-stack-again]');
	const overlayClaim = document.querySelector<HTMLButtonElement>('[data-stack-overlay-claim]');
	const resetButton = document.querySelector<HTMLButtonElement>('[data-stack-reset]');
	const soundButton = document.querySelector<HTMLButtonElement>('[data-stack-sound]');
	const claimForm = document.querySelector<HTMLFormElement>('[data-stack-claim]');
	const claimOpen = document.querySelector<HTMLButtonElement>('[data-stack-claim-open]');
	const claimBack = document.querySelector<HTMLButtonElement>('[data-stack-results-back]');
	const claimNote = document.querySelector<HTMLElement>('[data-stack-claim-note]');
	const claimStatus = document.querySelector<HTMLElement>('[data-stack-claim-status]');
	const resultNote = document.querySelector<HTMLElement>('[data-stack-result-note]');
	const resultsAgain = document.querySelector<HTMLButtonElement>('[data-stack-results-again]');
	const nameInput = claimForm?.querySelector<HTMLInputElement>('[name="displayName"]') ?? null;

	// -------------------------------------------------------------- game state
	let run: StackRun = stackStart();
	let drops: number[] = [];
	let fatalPos: number | null = null;
	let playing = false;
	let started = false;
	let gameOver = false;
	let claimDone = false;
	let resultsAcknowledged = false;
	let paused = false;
	let audioEnabled = false;
	let audioCtx: AudioContext | null = null;
	let bestScore = 0;
	let activePos = -STACK_TRAVEL;
	let activeDir = 1;
	let cameraY = 0;
	let targetCameraY = 0;
	let debris: Debris[] = [];
	let sparks: Spark[] = [];
	let animId = 0;
	let lastTime = performance.now();
	/** Device pixels per CSS pixel; 1 until the first fit. */
	let dpr = 1;
	/** One stable key per RUN: the automatic submit and a later manual claim are one submission. */
	let runToken = createRunToken();
	/** Server-measured standing once read, so the HUD shows the account's real best. */
	let standing: Standing | null = null;
	/** Why the run was not auto-submitted, for the overlay copy. */
	let skipReason: 'not_best' | 'guest' | 'unreadable' | null = null;

	try {
		const stored = Number(localStorage.getItem(BEST_STORAGE_KEY));
		if (Number.isFinite(stored) && stored > 0) bestScore = stored;
	} catch { /* storage unavailable */ }

	function say(message: string): void { if (statusEl) statusEl.textContent = message; }
	function showShell(state: 'ready' | 'results'): void {
		const shell = document.querySelector<HTMLElement>('[data-game-shell]');
		if (shell && shell.dataset.gameState !== state) setGameShellState(shell, state);
	}
	/** Park the camera and the card on the intro/over message — INSIDE the viewport. */
	function showOverlay(kind: 'intro' | 'over'): void {
		if (!overlay) return;
		overlay.dataset.stackOverlay = kind;
		overlay.hidden = false;
		if (startButton) startButton.hidden = kind !== 'intro';
		if (againButton) againButton.hidden = kind === 'intro';
		if (overlayClaim) overlayClaim.hidden = kind === 'intro' || claimDone;
	}
	function hideOverlay(): void { if (overlay) overlay.hidden = true; }
	function playTone(freq: number, type: OscillatorType = 'sine', dur = 0.22): void {
		if (!audioEnabled) return;
		try {
			if (!audioCtx) {
				const AudioClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
				audioCtx = new AudioClass();
			}
			if (audioCtx.state === 'suspended') void audioCtx.resume();
			const now = audioCtx.currentTime;
			const osc = audioCtx.createOscillator();
			const gain = audioCtx.createGain();
			osc.type = type;
			osc.frequency.setValueAtTime(freq, now);
			gain.gain.setValueAtTime(0.14, now);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
			osc.connect(gain);
			gain.connect(audioCtx.destination);
			osc.start(now);
			osc.stop(now + dur);
		} catch { /* audio unavailable */ }
	}

	// ------------------------------------------------------------- rendering
	/**
	 * Size the backing store to the CSS box at device-pixel resolution. The page
	 * gives the canvas `aspect-ratio`, so `getBoundingClientRect()` answers with a
	 * real height even before the first frame. Without this the canvas renders at
	 * its attribute size on every display, which is blurry on retina and wrong on
	 * any layout narrower than 640px.
	 */
	function fitCanvas(): void {
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const cssWidth = Math.max(1, rect.width || canvas.clientWidth || 640);
		const cssHeight = Math.max(1, rect.height || cssWidth * (520 / 640));
		dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
		const width = Math.round(cssWidth * dpr);
		const height = Math.round(cssHeight * dpr);
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
	}
	const isLight = (): boolean => document.documentElement.dataset.theme === 'light';
	function getColors(index: number): { top: string; left: string; right: string; edge: string } {
		const hue = (195 + index * 10) % 360;
		const sat = 85;
		const light = (isLight() ? 55 + 10 : 55);
		return {
			top: `hsl(${hue}, ${sat}%, ${light + 14}%)`,
			left: `hsl(${hue}, ${Math.max(0, sat - 12)}%, ${light - 12}%)`,
			right: `hsl(${hue}, ${Math.max(0, sat - 8)}%, ${light - 4}%)`,
			edge: `hsla(${hue}, 100%, 94%, 0.85)`,
		};
	}
	const projectIso = (x: number, y: number, z: number, originX: number, originY: number) => ({
		x: originX + (x - z) * 0.866025 * dpr,
		y: originY + ((x + z) * 0.4 - (y - cameraY)) * dpr,
		depth: x + z,
	});
	function drawIsoBox(x: number, y: number, z: number, w: number, d: number, h: number, colorIdx: number, opacity = 1): void {
		if (!ctx || !canvas || w <= 0 || d <= 0) return;
		const ox = canvas.width / 2;
		const oy = canvas.height * 0.74;
		const colors = getColors(colorIdx);
		const p0 = projectIso(x - w / 2, y, z - d / 2, ox, oy);
		const p1 = projectIso(x + w / 2, y, z - d / 2, ox, oy);
		const p2 = projectIso(x + w / 2, y, z + d / 2, ox, oy);
		const p3 = projectIso(x - w / 2, y, z + d / 2, ox, oy);
		const p4 = projectIso(x - w / 2, y + h, z - d / 2, ox, oy);
		const p5 = projectIso(x + w / 2, y + h, z - d / 2, ox, oy);
		const p6 = projectIso(x + w / 2, y + h, z + d / 2, ox, oy);
		const p7 = projectIso(x - w / 2, y + h, z + d / 2, ox, oy);
		ctx.save();
		ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
		// Left face: the +z side the viewer sees (NOT the hidden −x face).
		ctx.fillStyle = colors.left;
		ctx.beginPath();
		ctx.moveTo(p3.x, p3.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p6.x, p6.y); ctx.lineTo(p7.x, p7.y);
		ctx.closePath(); ctx.fill();
		// Right face: the +x side.
		ctx.fillStyle = colors.right;
		ctx.beginPath();
		ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p6.x, p6.y); ctx.lineTo(p5.x, p5.y);
		ctx.closePath(); ctx.fill();
		// Top face.
		ctx.fillStyle = colors.top;
		ctx.beginPath();
		ctx.moveTo(p4.x, p4.y); ctx.lineTo(p5.x, p5.y); ctx.lineTo(p6.x, p6.y); ctx.lineTo(p7.x, p7.y);
		ctx.closePath(); ctx.fill();
		ctx.strokeStyle = colors.edge;
		ctx.lineWidth = Math.max(1, dpr);
		ctx.beginPath();
		ctx.moveTo(p4.x, p4.y); ctx.lineTo(p5.x, p5.y); ctx.lineTo(p6.x, p6.y); ctx.lineTo(p7.x, p7.y);
		ctx.closePath(); ctx.stroke();
		ctx.restore();
	}
	/** Perfect-drop burst, in WORLD space, so it rises with the tower. */
	function spawnSparks(x: number, y: number, z: number, count: number): void {
		for (let i = 0; i < count; i += 1) {
			const angle = Math.random() * Math.PI * 2;
			const speed = 70 + Math.random() * 150;
			sparks.push({
				x, y, z,
				vx: Math.cos(angle) * speed, vz: Math.sin(angle) * speed,
				vy: 60 + Math.random() * 120,
				life: 0, maxLife: 0.5 + Math.random() * 0.4,
				size: 2 + Math.random() * 3,
				color: isLight() ? '#0284c7' : '#38bdf8',
			});
		}
	}
	function paintHud(): void {
		if (scoreEl) scoreEl.textContent = String(run.score);
		const serverBest = standing?.best ? Math.max(bestScore, standing.best.score) : bestScore;
		if (bestEl) bestEl.textContent = String(serverBest);
		if (comboCountEl) comboCountEl.textContent = String(run.combo);
		// Reserved slot: the combo chip is never removed, only hidden, so the
		// controls under it do not jump between combo and no-combo drops.
		if (comboEl) {
			comboEl.classList.toggle('stack-combo--idle', run.combo < 2);
			comboEl.setAttribute('aria-hidden', run.combo < 2 ? 'true' : 'false');
		}
	}

	const render = (now: number): void => {
		if (!ctx || !canvas) return;
		const dt = Math.min((now - lastTime) / 1000, 0.1);
		lastTime = now;
		cameraY += (targetCameraY - cameraY) * 0.08;
		if (playing && !gameOver) {
			activePos += activeDir * SPEED_PX_PER_SEC * dt;
			if (activePos > STACK_TRAVEL) { activePos = STACK_TRAVEL; activeDir = -1; }
			else if (activePos < -STACK_TRAVEL) { activePos = -STACK_TRAVEL; activeDir = 1; }
		}
		for (let i = debris.length - 1; i >= 0; i -= 1) {
			const piece = debris[i]!;
			piece.vy -= 900 * dt;
			piece.y += piece.vy * dt;
			piece.x += piece.vx * dt * 60;
			piece.z += piece.vz * dt * 60;
			piece.opacity -= 0.65 * dt;
			if (piece.opacity <= 0 || piece.y < -260) debris.splice(i, 1);
		}
		for (let i = sparks.length - 1; i >= 0; i -= 1) {
			const spark = sparks[i]!;
			spark.life += dt;
			if (spark.life >= spark.maxLife) { sparks.splice(i, 1); continue; }
			spark.vy -= 260 * dt;
			spark.x += spark.vx * dt;
			spark.y += spark.vy * dt;
			spark.z += spark.vz * dt;
		}
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const ox = canvas.width / 2;
		const oy = canvas.height * 0.74;
		// Ground contact shadow: clamped to the canvas and faded as the tower
		// grows, so a tall run is not sitting on a heavy plate whose real subject
		// is a base far below the viewport. Skipped entirely when off-screen.
		const shadowCenter = projectIso(0, 0, 0, ox, oy);
		const fade = Math.max(0.18, 1 - run.layers.length / 18);
		const radiusX = Math.min(canvas.width * 0.42, 150 * dpr);
		const radiusY = Math.min(canvas.height * 0.3, 70 * dpr);
		if (radiusX > 2 && radiusY > 2 && shadowCenter.y > -radiusY && shadowCenter.y < canvas.height + radiusY) {
			ctx.save();
			ctx.globalAlpha = fade;
			const shadow = ctx.createRadialGradient(shadowCenter.x, shadowCenter.y, 10, shadowCenter.x, shadowCenter.y, radiusX);
			shadow.addColorStop(0, isLight() ? 'rgba(30, 80, 140, 0.35)' : 'rgba(0, 0, 0, 0.55)');
			shadow.addColorStop(1, 'transparent');
			ctx.fillStyle = shadow;
			ctx.beginPath();
			ctx.ellipse(shadowCenter.x, shadowCenter.y, radiusX, radiusY, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		run.layers.forEach((layer, index) => {
			drawIsoBox(layer.x, index * LAYER_HEIGHT, layer.z, layer.w, layer.d, LAYER_HEIGHT, index);
		});
		for (const piece of debris) drawIsoBox(piece.x, piece.y, piece.z, piece.w, piece.d, LAYER_HEIGHT, piece.colorIndex, piece.opacity);
		if (playing && !gameOver) {
			const prev = run.layers[run.layers.length - 1]!;
			const axis = run.axis;
			const curX = axis === 'x' ? activePos : prev.x;
			const curZ = axis === 'z' ? activePos : prev.z;
			drawIsoBox(curX, run.layers.length * LAYER_HEIGHT, curZ, prev.w, prev.d, LAYER_HEIGHT, run.layers.length);
		}
		for (const spark of sparks) {
			const point = projectIso(spark.x, spark.y, spark.z, ox, oy);
			ctx.save();
			ctx.globalAlpha = Math.max(0, 1 - spark.life / spark.maxLife);
			ctx.fillStyle = spark.color;
			ctx.beginPath();
			ctx.arc(point.x, point.y, spark.size * dpr, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		if (!paused) animId = requestAnimationFrame(render);
	};

	// ------------------------------------------------------------------ rules
	function spawnActive(): void {
		activePos = -STACK_TRAVEL;
		activeDir = 1;
		targetCameraY = run.layers.length * LAYER_HEIGHT;
	}
	function startRun(): void {
		run = stackStart();
		drops = [];
		fatalPos = null;
		debris = [];
		sparks = [];
		cameraY = 0;
		targetCameraY = 0;
		gameOver = false;
		claimDone = false;
		resultsAcknowledged = false;
		skipReason = null;
		runToken = createRunToken();
		if (claimForm) claimForm.hidden = true;
		if (claimStatus) claimStatus.textContent = '';
		if (resultNote) resultNote.textContent = '';
		playing = true;
		started = true;
		hideOverlay();
		spawnActive();
		paintHud();
		say('Playing — Space or tap to drop the block.');
		showShell('ready');
	}
	/**
	 * End the run. The game-over card is the overlay INSIDE the viewport, and the
	 * shell stays in `ready`: swapping the whole panel on every miss reflows the
	 * page and hides the tower the player is still looking at. The claim form
	 * remains reachable — the overlay's \"Claim score\" button (or the side panel)
	 * opens the results panel, which is where the form lives.
	 */
	function endRun(): void {
		playing = false;
		gameOver = true;
		playTone(160, 'sawtooth', 0.5);
		if (run.score > bestScore) {
			bestScore = run.score;
			try { localStorage.setItem(BEST_STORAGE_KEY, String(bestScore)); } catch { /* storage unavailable */ }
		}
		paintHud();
		say(`Game over — score ${run.score} across ${run.layers.length - 1} layers.`);
		if (resultNote) resultNote.textContent = `Score ${run.score} · ${run.layers.length - 1} layers · best combo ×${run.maxCombo}.`;
		if (overlayTitle) overlayTitle.textContent = 'Run over';
		if (overlayDesc) overlayDesc.textContent = `Score ${run.score} · ${run.layers.length - 1} layers · best combo ×${run.maxCombo}.`;
		showOverlay('over');
		renderClaimable();
		void autoSubmitRunForRun();
	}
	/**
	 * Submit only a run that beats the server-read standing. `unreadable` and
	 * `guest` submit nothing and leave the manual form; either way the stable run
	 * key means a later manual claim is the SAME submission.
	 */
	async function autoSubmitRunForRun(): Promise<void> {
		const result = await autoSubmitRun({
			gameId: STACK_GAME_ID, mode: STACK_MODE_ID,
			score: run.score, tieBreak: stackTieBreak(run.layers.length),
			proof: { drops, fatal: fatalPos }, idempotencyKey: idempotencyKey('stk', runToken),
		});
		if (result.submitted) {
			claimDone = true;
			skipReason = null;
			if (claimForm) claimForm.hidden = true;
			if (claimOpen) claimOpen.hidden = true;
			if (overlayClaim) overlayClaim.hidden = true;
			if (overlayDesc && result.outcome.kind === 'stored') {
				overlayDesc.textContent = `Score ${run.score} · ${run.layers.length - 1} layers · submitted to the Isometric Stack leaderboard.`;
			}
			if (claimStatus && result.outcome.kind === 'stored') claimStatus.textContent = result.outcome.message;
		} else if (result.reason === 'not_best') {
			skipReason = 'not_best';
		} else if (result.reason === 'guest') {
			skipReason = 'guest';
		} else {
			skipReason = 'unreadable';
		}
		renderClaimable();
	}
	function renderClaimable(): void {
		const claimable = gameOver && run.score >= 1 && !claimDone;
		// Reserved slots: these controls are hidden, not re-created, so the panel
		// does not jump between a claimable run and one that was auto-submitted.
		if (claimForm) claimForm.hidden = !claimable;
		if (claimOpen) claimOpen.hidden = !claimable;
		if (overlayClaim) overlayClaim.hidden = !claimable;
		if (againButton) againButton.hidden = !gameOver;
		if (claimNote) {
			claimNote.textContent = claimable
				? `Score ${run.score} · ${run.layers.length - 1} layers · leaderboard tie-break ${stackTieBreak(run.layers.length)} (deeper runs win ties). Sign in to submit automatically; otherwise type a name.`
				: '';
		}
		if (claimStatus && claimable) {
			claimStatus.textContent = skipReason === 'not_best' ? 'This run did not beat your standing, so nothing was submitted.'
				: skipReason === 'unreadable' ? 'Your standing could not be checked, so nothing was submitted automatically.'
				: skipReason === 'guest' ? 'Guest runs are claimed with a display name below.' : '';
		}
	}
	function dropBlock(): void {
		if (!playing || gameOver) return;
		const posQ = quantizePosition(activePos);
		const step = stackDrop(run, posQ);
		if (!step.ok) { say(step.error === 'too_deep' ? 'Run is too deep to continue.' : 'That drop is out of range.'); return; }
		if (step.result.kind === 'miss') {
			fatalPos = posQ;
			// The miss must be SEEN: the block that fell wide is pushed off the
			// tower as debris, so the run ends where the player watched it end
			// instead of the tower silently freezing.
			const prev = run.layers[run.layers.length - 1]!;
			const axis = run.axis;
			debris.push({
				x: axis === 'x' ? posQ : prev.x,
				y: run.layers.length * LAYER_HEIGHT,
				z: axis === 'z' ? posQ : prev.z,
				w: prev.w, d: prev.d, vy: -20,
				vx: axis === 'x' ? Math.sign(posQ - prev.x) * 1.6 : 0,
				vz: axis === 'z' ? Math.sign(posQ - prev.z) * 1.6 : 0,
				opacity: 1, colorIndex: run.layers.length,
			});
			endRun();
			return;
		}
		const placed = step.result;
		run = step.run;
		drops.push(posQ);
		const prev = run.layers[run.layers.length - 2]!;
		if (placed.perfect) {
			playTone(480 + run.combo * 55, 'triangle', 0.35);
			spawnSparks(placed.layer.x, run.layers.length * LAYER_HEIGHT, placed.layer.z, 16);
		} else {
			playTone(300 + (run.layers.length % 8) * 28, 'sine', 0.18);
			const overhang = Math.abs(placed.diff);
			if (overhang > 0) {
				const axisWidth = placed.axis === 'x' ? prev.w : prev.d;
				const sign = Math.sign(placed.diff);
				if (placed.axis === 'x') {
					debris.push({ x: prev.x + placed.diff / 2 - sign * axisWidth / 2, y: (run.layers.length - 1) * LAYER_HEIGHT, z: prev.z, w: overhang, d: prev.d, vy: 0, vx: sign * 1.4, vz: 0, opacity: 1, colorIndex: run.layers.length - 1 });
				} else {
					debris.push({ x: prev.x, y: (run.layers.length - 1) * LAYER_HEIGHT, z: prev.z + placed.diff / 2 - sign * axisWidth / 2, w: prev.w, d: overhang, vy: 0, vx: 0, vz: sign * 1.4, opacity: 1, colorIndex: run.layers.length - 1 });
				}
			}
		}
		paintHud();
		spawnActive();
	}
	function handleAction(): void {
		if (paused) return;
		if (!started || !playing) { startRun(); return; }
		dropBlock();
	}
	function resetToStart(): void {
		playing = false;
		started = false;
		gameOver = false;
		run = stackStart();
		drops = [];
		fatalPos = null;
		debris = [];
		sparks = [];
		claimDone = false;
		resultsAcknowledged = false;
		skipReason = null;
		if (claimForm) claimForm.hidden = true;
		if (claimStatus) claimStatus.textContent = '';
		if (resultNote) resultNote.textContent = '';
		showOverlay('intro');
		if (overlayTitle) overlayTitle.textContent = 'ISO STACK';
		if (overlayDesc) overlayDesc.textContent = 'Tap or press Space to drop layers. Align blocks cleanly to maintain the tower surface.';
		paintHud();
		say('Ready — start a new run when you are.');
		showShell('ready');
	}

	// ------------------------------------------------------------- claim flow
	async function submitClaim(): Promise<void> {
		if (!claimForm || claimDone) return;
		const displayName = nameInput?.value.trim() ?? '';
		if (!displayName) { if (claimStatus) claimStatus.textContent = 'Type a name first.'; return; }
		const submit = claimForm.querySelector<HTMLButtonElement>('button[type="submit"]');
		if (submit) submit.disabled = true;
		if (nameInput) nameInput.disabled = true;
		if (claimStatus) claimStatus.textContent = 'Checking the run…';
		try {
			// Same stable key as the automatic attempt: this is one submission.
			const outcome = await submitRun({
				gameId: STACK_GAME_ID, mode: STACK_MODE_ID, score: run.score, tieBreak: stackTieBreak(run.layers.length),
				displayName, idempotencyKey: idempotencyKey('stk', runToken), proof: { drops, fatal: fatalPos },
			});
			if (outcome.kind === 'stored') {
				claimDone = true;
				if (claimStatus) claimStatus.textContent = `Score recorded: ${outcome.score.toLocaleString()} on the Isometric Stack leaderboard.`;
				if (claimForm) claimForm.hidden = true;
				if (claimOpen) claimOpen.hidden = true;
				if (overlayClaim) overlayClaim.hidden = true;
			} else if (outcome.kind === 'duplicate') {
				claimDone = true;
				if (claimStatus) claimStatus.textContent = 'This run was already submitted.';
			} else if (outcome.kind === 'unreachable') {
				if (claimStatus) claimStatus.textContent = 'Could not reach the server. Try again when online.';
			} else if (outcome.kind === 'not-best') {
				if (claimStatus) claimStatus.textContent = 'The board already holds a stronger run for you.';
			} else {
				if (claimStatus) claimStatus.textContent = outcome.message;
			}
		} catch {
			if (claimStatus) claimStatus.textContent = 'Could not reach the server. Try again when online.';
		} finally {
			if (nameInput) nameInput.disabled = false;
			if (submit) submit.disabled = false;
		}
	}

	// ---------------------------------------------------------------- listeners
	canvas?.addEventListener('pointerdown', (event) => { event.preventDefault(); handleAction(); });
	const onKeydown = (event: KeyboardEvent): void => {
		if (event.code !== 'Space') return;
		const target = event.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
		if (!document.querySelector<HTMLElement>('[data-game-shell]')?.contains(document.activeElement) && event.target !== document.body && event.target !== canvas) return;
		event.preventDefault();
		handleAction();
	};
	window.addEventListener('keydown', onKeydown);
	startButton?.addEventListener('click', () => startRun());
	againButton?.addEventListener('click', () => startRun());
	resultsAgain?.addEventListener('click', () => startRun());
	resetButton?.addEventListener('click', () => resetToStart());
	soundButton?.addEventListener('click', () => {
		audioEnabled = !audioEnabled;
		if (soundButton) {
			soundButton.setAttribute('aria-pressed', String(audioEnabled));
			soundButton.textContent = audioEnabled ? 'Sound on' : 'Sound off';
		}
		if (audioEnabled) playTone(520, 'sine', 0.15);
	});
	claimForm?.addEventListener('submit', (event) => { event.preventDefault(); void submitClaim(); });
	claimOpen?.addEventListener('click', () => { resultsAcknowledged = false; renderClaimable(); showShell('results'); });
	overlayClaim?.addEventListener('click', () => { resultsAcknowledged = false; renderClaimable(); showShell('results'); });
	claimBack?.addEventListener('click', () => { resultsAcknowledged = true; showShell('ready'); });
	const onResize = (): void => fitCanvas();
	window.addEventListener('resize', onResize);
	let resizeObserver: ResizeObserver | undefined;
	if (canvas && typeof ResizeObserver !== 'undefined') {
		resizeObserver = new ResizeObserver(() => fitCanvas());
		resizeObserver.observe(canvas);
	}

	const module: GameModule = {
		init: () => {
			fitCanvas();
			paintHud();
			say('Ready — start a new run when you are.');
			// The standing read also teaches the HUD the account's real best (and
			// whether a run is even auto-submittable). Deliberately not awaited by
			// the render loop: the tower must not wait on the network.
			void readStanding(STACK_GAME_ID, STACK_MODE_ID).then((result) => {
				if (!result.ok) return;
				standing = result.standing;
				paintHud();
			});
			if (!paused) { lastTime = performance.now(); animId = requestAnimationFrame(render); }
			return {
				pause: () => {
					paused = true;
					cancelAnimationFrame(animId);
				},
				resume: () => {
					if (!paused) return;
					paused = false;
					fitCanvas();
					lastTime = performance.now();
					animId = requestAnimationFrame(render);
				},
				destroy: () => {
					paused = true;
					cancelAnimationFrame(animId);
					window.removeEventListener('keydown', onKeydown);
					window.removeEventListener('resize', onResize);
					resizeObserver?.disconnect();
					if (audioCtx) { void audioCtx.close().catch(() => undefined); audioCtx = null; }
				},
			};
		},
	};

	return { module };
}
