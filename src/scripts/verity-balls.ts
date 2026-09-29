/**
 * BNJI.NET — Verity secret code balls physics effect.
 *
 * One-time easter egg triggered upon closing the settings overlay after entering 'verity'.
 * Spawns gravity-affected bouncing balls using /verity.webp with 2D physics.
 * Optimized with requestAnimationFrame, O(N) spatial bounds checks, and zero cost when inactive.
 */

let verityArmed = false;
let activeStage: HTMLElement | null = null;
let rafId: number | null = null;

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
	if (activeStage) {
		activeStage.remove();
		activeStage = null;
	}
}

export function spawnVerityBalls(): void {
	clearVerityBalls();

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

	const count = 36;
	const radius = 22; // Height of "Read the blog" button is ~44px, radius = 22px
	const diameter = radius * 2;
	const balls: Ball[] = [];

	const viewW = window.innerWidth;
	const viewH = window.innerHeight;

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

		// Drop from top of viewport across random columns
		const x = Math.random() * (viewW - diameter) + radius;
		const y = -Math.random() * 300 - radius;
		const vx = (Math.random() - 0.5) * 200;
		const vy = Math.random() * 50 + 20;

		balls.push({ x, y, vx, vy, r: radius, el });
	}

	let lastTime = performance.now();
	const gravity = 850; // px/s^2
	const restitution = 0.72; // bounce elasticity
	const friction = 0.992;

	function update(): void {
		if (!activeStage) return;

		const now = performance.now();
		const dt = Math.min((now - lastTime) / 1000, 0.032);
		lastTime = now;

		const W = window.innerWidth;
		const H = window.innerHeight;

		// Get fresh UI collision bounds
		const uiBounds: RectBound[] = uiElements
			.map((el) => {
				const rect = el.getBoundingClientRect();
				// Ignore hidden or full-screen elements
				if (rect.width <= 0 || rect.height <= 0 || rect.width >= W * 0.95) return null;
				return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
			})
			.filter((b): b is RectBound => b !== null);

		// Physics Integration & Collisions
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
				b.vx *= 0.95; // floor friction
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
					// Top edge bounce
					if (b.y < box.top && b.vy > 0) {
						b.y = box.top - b.r;
						b.vy = -Math.abs(b.vy) * restitution;
					}
					// Bottom edge
					else if (b.y > box.bottom && b.vy < 0) {
						b.y = box.bottom + b.r;
						b.vy = Math.abs(b.vy) * restitution;
					}
					// Left edge
					else if (b.x < box.left && b.vx > 0) {
						b.x = box.left - b.r;
						b.vx = -Math.abs(b.vx) * restitution;
					}
					// Right edge
					else if (b.x > box.right && b.vx < 0) {
						b.x = box.right + b.r;
						b.vx = Math.abs(b.vx) * restitution;
					}
				}
			}
		}

		// Ball-to-Ball Pairwise Collisions
		for (let i = 0; i < balls.length; i++) {
			for (let j = i + 1; j < balls.length; j++) {
				const b1 = balls[i];
				const b2 = balls[j];

				const dx = b2.x - b1.x;
				const dy = b2.y - b1.y;
				const distSq = dx * dx + dy * dy;
				const minDist = b1.r + b2.r;

				if (distSq > 0 && distSq < minDist * minDist) {
					const dist = Math.sqrt(distSq);
					const nx = dx / dist;
					const ny = dy / dist;

					// Separate
					const overlap = (minDist - dist) * 0.5;
					b1.x -= nx * overlap;
					b1.y -= ny * overlap;
					b2.x += nx * overlap;
					b2.y += ny * overlap;

					// Impulse
					const kx = b1.vx - b2.vx;
					const ky = b1.vy - b2.vy;
					const p = 2 * (nx * kx + ny * ky) / 2;

					b1.vx -= p * nx * restitution;
					b1.vy -= p * ny * restitution;
					b2.vx += p * nx * restitution;
					b2.vy += p * ny * restitution;
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

	rafId = requestAnimationFrame(update);
}
