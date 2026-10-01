/**
 * `bnji.isometric-stack` browser client — the Lab isometric stack game,
 * ported to the Games shell at ONE fixed speed (Normal, 155px/s) with a
 * server-verified leaderboard claim.
 *
 * Gameplay math is owned by `src/game/stack-rules.ts`: the renderer feeds
 * quantized drop positions into the same `stackDrop` the verifier replays, so
 * a claimed run is reconstructed server-side rather than trusted.
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

const STACK_GAME_ID = 'bnji.isometric-stack';
const STACK_MODE_ID = 'default';
const LAYER_HEIGHT = 18;
const SPEED_PX_PER_SEC = 155; // the ONE fixed speed — no difficulty or speed options
const BEST_STORAGE_KEY = 'bnji:stack:best';

type Debris = { x: number; y: number; z: number; w: number; d: number; vy: number; vx: number; vz: number; opacity: number; colorIndex: number };
type Spark = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number; color: string };

function randomIdempotencyKey(): string {
	const bytes = new Uint8Array(18);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
}

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
	const startButton = document.querySelector<HTMLButtonElement>('[data-stack-start]');
	const resetButton = document.querySelector<HTMLButtonElement>('[data-stack-reset]');
	const soundButton = document.querySelector<HTMLButtonElement>('[data-stack-sound]');
	const claimForm = document.querySelector<HTMLFormElement>('[data-stack-claim]');
	const claimOpen = document.querySelector<HTMLButtonElement>('[data-stack-claim-open]');
	const claimBack = document.querySelector<HTMLButtonElement>('[data-stack-results-back]');
	const claimNote = document.querySelector<HTMLElement>('[data-stack-claim-note]');
	const claimStatus = document.querySelector<HTMLElement>('[data-stack-claim-status]');
	const resultNote = document.querySelector<HTMLElement>('[data-stack-result-note]');
	const againButton = document.querySelector<HTMLButtonElement>('[data-stack-results-again]');

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

	try {
		const stored = Number(localStorage.getItem(BEST_STORAGE_KEY));
		if (Number.isFinite(stored) && stored > 0) bestScore = stored;
	} catch { /* storage unavailable */ }

	function say(message: string): void { if (statusEl) statusEl.textContent = message; }
	function showShell(state: 'ready' | 'results'): void {
		const shell = document.querySelector<HTMLElement>('[data-game-shell]');
		if (shell && shell.dataset.gameState !== state) setGameShellState(shell, state);
	}
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
		x: originX + (x - z) * 0.866025,
		y: originY + (x + z) * 0.4 - (y - cameraY),
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
		ctx.fillStyle = colors.left;
		ctx.beginPath();
		ctx.moveTo(p3.x, p3.y); ctx.lineTo(p0.x, p0.y); ctx.lineTo(p4.x, p4.y); ctx.lineTo(p7.x, p7.y);
		ctx.closePath(); ctx.fill();
		ctx.fillStyle = colors.right;
		ctx.beginPath();
		ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p6.x, p6.y); ctx.lineTo(p5.x, p5.y);
		ctx.closePath(); ctx.fill();
		ctx.fillStyle = colors.top;
		ctx.beginPath();
		ctx.moveTo(p4.x, p4.y); ctx.lineTo(p5.x, p5.y); ctx.lineTo(p6.x, p6.y); ctx.lineTo(p7.x, p7.y);
		ctx.closePath(); ctx.fill();
		ctx.strokeStyle = colors.edge;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(p4.x, p4.y); ctx.lineTo(p5.x, p5.y); ctx.lineTo(p6.x, p6.y); ctx.lineTo(p7.x, p7.y);
		ctx.closePath(); ctx.stroke();
		ctx.restore();
	}
	function spawnSparks(screenX: number, screenY: number, count: number): void {
		for (let i = 0; i < count; i += 1) {
			const angle = Math.random() * Math.PI * 2;
			const speed = 2 + Math.random() * 5;
			sparks.push({ x: screenX, y: screenY, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 1.5, life: 0, maxLife: 0.5 + Math.random() * 0.4, size: 2 + Math.random() * 3, color: '#38bdf8' });
		}
	}
	function paintHud(): void {
		if (scoreEl) scoreEl.textContent = String(run.score);
		if (bestEl) bestEl.textContent = String(bestScore);
		if (comboCountEl) comboCountEl.textContent = String(run.combo);
		if (comboEl) comboEl.hidden = run.combo < 2;
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
			piece.x += piece.vx;
			piece.z += piece.vz;
			piece.opacity -= 0.65 * dt;
			if (piece.opacity <= 0 || piece.y < -250) debris.splice(i, 1);
		}
		for (let i = sparks.length - 1; i >= 0; i -= 1) {
			const spark = sparks[i]!;
			spark.life += dt;
			if (spark.life >= spark.maxLife) { sparks.splice(i, 1); continue; }
			spark.x += spark.vx;
			spark.y += spark.vy;
			spark.vy += 2.5 * dt * 60;
		}
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const ox = canvas.width / 2;
		const oy = canvas.height * 0.74;
		const shadowCenter = projectIso(0, 0, 0, ox, oy);
		ctx.save();
		const shadow = ctx.createRadialGradient(shadowCenter.x, shadowCenter.y, 10, shadowCenter.x, shadowCenter.y, 150);
		shadow.addColorStop(0, isLight() ? 'rgba(30, 80, 140, 0.35)' : 'rgba(0, 0, 0, 0.55)');
		shadow.addColorStop(1, 'transparent');
		ctx.fillStyle = shadow;
		ctx.beginPath();
		ctx.ellipse(shadowCenter.x, shadowCenter.y, 150, 70, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
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
			ctx.save();
			ctx.globalAlpha = 1 - spark.life / spark.maxLife;
			ctx.fillStyle = spark.color;
			ctx.beginPath();
			ctx.arc(spark.x, spark.y, spark.size, 0, Math.PI * 2);
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
		if (claimForm) claimForm.hidden = true;
		if (claimStatus) claimStatus.textContent = '';
		if (resultNote) resultNote.textContent = '';
		playing = true;
		started = true;
		if (overlay) overlay.hidden = true;
		spawnActive();
		paintHud();
		say('Playing — Space or tap to drop the block.');
		showShell('ready');
	}
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
		const shellReady = document.querySelector<HTMLElement>('[data-game-shell]')?.dataset.gameState === 'ready';
		if (!claimDone && !resultsAcknowledged && shellReady) {
			if (resultNote) resultNote.textContent = `Score ${run.score} · ${run.layers.length - 1} layers · best combo ×${run.maxCombo}.`;
			showShell('results');
		}
		renderClaimable();
	}
	function renderClaimable(): void {
		const claimable = gameOver && run.score >= 1 && !claimDone;
		if (claimForm) claimForm.hidden = !claimable;
		if (claimOpen) claimOpen.hidden = !claimable;
		if (claimNote && claimable) {
			claimNote.textContent = `Score ${run.score} · ${run.layers.length - 1} layers · leaderboard tie-break ${stackTieBreak(run.layers.length)} (deeper runs win ties).`;
		}
	}
	function dropBlock(): void {
		if (!playing || gameOver) return;
		const posQ = quantizePosition(activePos);
		const step = stackDrop(run, posQ);
		if (!step.ok) { say(step.error === 'too_deep' ? 'Run is too deep to continue.' : 'That drop is out of range.'); return; }
		if (step.result.kind === 'miss') {
			fatalPos = posQ;
			endRun();
			return;
		}
		const placed = step.result;
		run = step.run;
		drops.push(posQ);
		const prev = run.layers[run.layers.length - 2]!;
		if (placed.perfect) {
			playTone(480 + run.combo * 55, 'triangle', 0.35);
			const screen = projectIso(placed.layer.x, run.layers.length * LAYER_HEIGHT, placed.layer.z, canvas!.width / 2, canvas!.height * 0.74);
			spawnSparks(screen.x, screen.y, 16);
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
		if (claimForm) claimForm.hidden = true;
		if (claimStatus) claimStatus.textContent = '';
		if (resultNote) resultNote.textContent = '';
		if (overlay) overlay.hidden = false;
		paintHud();
		say('Ready — start a new run when you are.');
		showShell('ready');
	}

	// ------------------------------------------------------------- claim flow
	async function submitClaim(): Promise<void> {
		if (!claimForm || !claimDone || fatalPos === null) return;
		const nameInput = claimForm.querySelector<HTMLInputElement>('[name="displayName"]');
		const submit = claimForm.querySelector<HTMLButtonElement>('button[type="submit"]');
		const displayName = nameInput?.value.trim() ?? '';
		if (!displayName) { if (claimStatus) claimStatus.textContent = 'Type a name first.'; return; }
		if (submit) submit.disabled = true;
		if (nameInput) nameInput.disabled = true;
		if (claimStatus) claimStatus.textContent = 'Checking the run…';
		try {
			const response = await fetch('/api/games/scores', {
				method: 'POST', credentials: 'same-origin', cache: 'no-store',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					gameId: STACK_GAME_ID, mode: STACK_MODE_ID, score: run.score, tieBreak: stackTieBreak(run.layers.length),
					displayName, idempotencyKey: randomIdempotencyKey(),
					proof: { drops, fatal: fatalPos },
				}),
			});
			const body = await response.json().catch(() => ({})) as { score?: number; tieBreak?: number | null; error?: string };
			if (response.status === 201 || response.status === 202) {
				claimDone = true;
				if (claimStatus) claimStatus.textContent = `Score recorded: ${Number(body.score ?? run.score).toLocaleString()} on the Isometric Stack leaderboard.`;
				if (claimForm) claimForm.hidden = true;
				if (claimOpen) claimOpen.hidden = true;
			} else if (response.status === 409) {
				if (claimStatus) claimStatus.textContent = 'This run was already submitted.';
				claimDone = true;
			} else if (response.status === 403) {
				if (claimStatus) claimStatus.textContent = 'Score submissions must come from this page.';
			} else if (response.status === 429) {
				if (claimStatus) claimStatus.textContent = 'Too many claims right now — try again shortly.';
			} else if (response.status === 422) {
				if (claimStatus) claimStatus.textContent = 'The run could not be verified — replay it and claim again.';
			} else {
				if (claimStatus) claimStatus.textContent = 'Could not submit right now. Try again in a moment.';
			}
		} catch {
			if (claimStatus) claimStatus.textContent = 'Could not reach the leaderboard. Try again in a moment.';
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
	claimBack?.addEventListener('click', () => { resultsAcknowledged = true; showShell('ready'); });
	againButton?.addEventListener('click', () => startRun());

	const module: GameModule = {
		init: () => {
			paintHud();
			say('Ready — start a new run when you are.');
			if (!paused) { lastTime = performance.now(); animId = requestAnimationFrame(render); }
			return {
				pause: () => {
					paused = true;
					cancelAnimationFrame(animId);
				},
				resume: () => {
					if (!paused) return;
					paused = false;
					lastTime = performance.now();
					animId = requestAnimationFrame(render);
				},
				destroy: () => {
					paused = true;
					cancelAnimationFrame(animId);
					window.removeEventListener('keydown', onKeydown);
					if (audioCtx) { void audioCtx.close().catch(() => undefined); audioCtx = null; }
				},
			};
		},
	};

	return { module };
}
