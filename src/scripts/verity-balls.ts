/**
 * BNJI.NET — Verity secret code balls physics engine.
 *
 * Easter egg triggered upon closing the settings overlay after entering 'verity'.
 * Spawns gravity-affected bouncing balls using /verity.webp with 2D physics.
 *
 * Optimizations:
 * - Dynamic density: scales count to viewport area (45..180 balls) so it fills any screen size.
 * - Spatial grid partitioning: O(N) neighbor checks instead of O(N²).
 * - Auto-pauses on visibilitychange (tab hidden).
 * - Zero CPU / memory overhead when cleared or inactive.
 */

let verityArmed = false;
let activeStage: HTMLElement | null = null;
let rafId: number | null = null;
let visibilityListener: (() => void) | null = null;

export function armVerity(): void {
	verityArmed = true;
}

export function isVerityArmed(): boolean {
	return verityArmed;
}

export function checkAndTriggerVerity(): void {
	if (verityArmed) {
		verityArmed = false;
		spawnVerityBalls();
	}
}

type Ball = {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	el: HTMLElement;
};

type RectBound = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

export function clearVerityBalls(): void {
	if (rafId !== null) {
		cancelAnimationFrame(rafId);
		rafId = null;
	}
	if (visibilityListener) {
		document.removeEventListener('visibilitychange', visibilityListener);
		visibilityListener = null;
	}
	if (activeStage) {
		activeStage.remove();
		activeStage = null;
	}
}

export function spawnVerityBalls(): void {
	clearVerityBalls();

	const viewW = window.innerWidth;
	const viewH = window.innerHeight;

	const stage = document.createElement('div');
	stage.id = 'verity-balls-stage';
	stage.style.position = 'fixed';
	stage.style.inset = '0';
	stage.style.pointerEvents = 'none';
	stage.style.zIndex = '99999';
	stage.style.overflow = 'hidden';

	// Top-left Clear Button
	const clearBtn = document.createElement('button');
	clearBtn.type = 'button';
	clearBtn.className = 'glass-button glass-button--sm';
	clearBtn.textContent = 'Clear Verity Balls ✕';
	clearBtn.style.position = 'fixed';
	clearBtn.style.top = '16px';
	clearBtn.style.left = '16px';
	clearBtn.style.pointerEvents = 'auto';
	clearBtn.style.zIndex = '100000';
	clearBtn.addEventListener('click', clearVerityBalls);
	stage.appendChild(clearBtn);

	document.body.appendChild(stage);
	activeStage = stage;

	// Ball dimensions: radius = 20px (40px diameter, height of button)
	const radius = 20;
	const diameter = radius * 2;
	const ballArea = Math.PI * radius * radius;
	const totalArea = viewW * viewH;

	// Dynamically scale ball count to fill approx 12-15% of screen volume (45 on mobile, up to 180 on 4K)
	const count = Math.min(180, Math.max(45, Math.floor((totalArea * 0.12) / ballArea)));
	const balls: Ball[] = [];

	// Collect interactive UI element bounds for collisions
	const uiElements = Array.from(
		document.querySelectorAll<HTMLElement>('.glass-panel, .glass-button, .bento, header, footer, .hero-actions'),
	);

	for (let i = 0; i < count; i++) {
		const el = document.createElement('div');
		el.style.position = 'absolute';
		el.style.width = `${diameter}px`;
		el.style.height = `${diameter}px`;
		el.style.borderRadius = '50%';
		el.style.backgroundImage = 'url("/verity.webp")';
		el.style.backgroundSize = 'cover';
		el.style.backgroundPosition = 'center';
		el.style.boxShadow = '0 4px 10px rgba(0,0,0,0.3)';
		el.style.willChange = 'transform';
		stage.appendChild(el);

		// Drop from top of viewport in staggered waves
		const x = Math.random() * (viewW - diameter) + radius;
		const y = -Math.random() * (viewH * 0.8) - radius;
		const vx = (Math.random() - 0.5) * 220;
		const vy = Math.random() * 60 + 20;

		balls.push({ x, y, vx, vy, r: radius, el });
	}

	let lastTime = performance.now();
	const gravity = 880; // px/s^2
	const restitution = 0.75; // bounce elasticity
	const friction = 0.992;

	// Spatial Grid Partitioning constants
	const cellSize = diameter;

	function update(): void {
		if (!activeStage || document.hidden) return;

		const now = performance.now();
		const dt = Math.min((now - lastTime) / 1000, 0.032);
		lastTime = now;

		const W = window.innerWidth;
		const H = window.innerHeight;

		// Get fresh UI collision bounds
		const uiBounds: RectBound[] = uiElements
			.map((el) => {
				const rect = el.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0 || rect.width >= W * 0.95) return null;
				return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
			})
			.filter((b): b is RectBound => b !== null);

		// Physics Integration & Wall/UI Collisions
		for (let i = 0; i < balls.length; i++) {
			const b = balls[i];

			b.vy += gravity * dt;
			b.vx *= friction;
			b.vy *= friction;

			b.x += b.vx * dt;
			b.y += b.vy * dt;

			// Screen Walls
			if (b.x < b.r) {
				b.x = b.r;
				b.vx = Math.abs(b.vx) * restitution;
			} else if (b.x > W - b.r) {
				b.x = W - b.r;
				b.vx = -Math.abs(b.vx) * restitution;
			}

			// Screen Floor & Ceiling
			if (b.y > H - b.r) {
				b.y = H - b.r;
				b.vy = -Math.abs(b.vy) * restitution;
				b.vx *= 0.94; // floor friction
			} else if (b.y < b.r && b.vy < 0) {
				b.y = b.r;
				b.vy = Math.abs(b.vy) * restitution;
			}

			// UI Elements Collision
			for (const box of uiBounds) {
				if (
					b.x + b.r > box.left &&
					b.x - b.r < box.right &&
					b.y + b.r > box.top &&
					b.y - b.r < box.bottom
				) {
					if (b.y < box.top && b.vy > 0) {
						b.y = box.top - b.r;
						b.vy = -Math.abs(b.vy) * restitution;
					} else if (b.y > box.bottom && b.vy < 0) {
						b.y = box.bottom + b.r;
						b.vy = Math.abs(b.vy) * restitution;
					} else if (b.x < box.left && b.vx > 0) {
						b.x = box.left - b.r;
						b.vx = -Math.abs(b.vx) * restitution;
					} else if (b.x > box.right && b.vx < 0) {
						b.x = box.right + b.r;
						b.vx = Math.abs(b.vx) * restitution;
					}
				}
			}
		}

		// Spatial Grid for O(N) Pairwise Ball Collisions
		const grid = new Map<string, number[]>();
		for (let i = 0; i < balls.length; i++) {
			const b = balls[i];
			const cx = Math.floor(b.x / cellSize);
			const cy = Math.floor(b.y / cellSize);
			const key = `${cx},${cy}`;
			const cell = grid.get(key);
			if (cell) {
				cell.push(i);
			} else {
				grid.set(key, [i]);
			}
		}

		// Collision resolution across neighbor cells
		const offsets = [
			[0, 0], [1, 0], [0, 1], [1, 1], [-1, 1],
		];

		for (const [key, members] of grid.entries()) {
			const [cx, cy] = key.split(',').map(Number);

			for (const [dx, dy] of offsets) {
				const nKey = `${cx + dx},${cy + dy}`;
				const neighbors = grid.get(nKey);
				if (!neighbors) continue;

				for (const i of members) {
					for (const j of neighbors) {
						if (i >= j) continue; // avoid self and duplicate checks

						const b1 = balls[i];
						const b2 = balls[j];

						const delX = b2.x - b1.x;
						const delY = b2.y - b1.y;
						const distSq = delX * delX + delY * delY;
						const minDist = b1.r + b2.r;

						if (distSq > 0 && distSq < minDist * minDist) {
							const dist = Math.sqrt(distSq);
							const nx = delX / dist;
							const ny = delY / dist;

							// Separate
							const overlap = (minDist - dist) * 0.5;
							b1.x -= nx * overlap;
							b1.y -= ny * overlap;
							b2.x += nx * overlap;
							b2.y += ny * overlap;

							// Relative velocity along collision normal
							const kx = b1.vx - b2.vx;
							const ky = b1.vy - b2.vy;
							const p = (nx * kx + ny * ky) * restitution;

							b1.vx -= p * nx;
							b1.vy -= p * ny;
							b2.vx += p * nx;
							b2.vy += p * ny;
						}
					}
				}
			}
		}

		// Render DOM positions
		for (let i = 0; i < balls.length; i++) {
			const b = balls[i];
			b.el.style.transform = `translate3d(${(b.x - b.r).toFixed(1)}px, ${(b.y - b.r).toFixed(1)}px, 0)`;
		}

		rafId = requestAnimationFrame(update);
	}

	// Auto-pause physics loop when the tab is hidden
	visibilityListener = () => {
		if (document.hidden) {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
		} else if (activeStage) {
			lastTime = performance.now();
			rafId = requestAnimationFrame(update);
		}
	};
	document.addEventListener('visibilitychange', visibilityListener);

	rafId = requestAnimationFrame(update);
}
