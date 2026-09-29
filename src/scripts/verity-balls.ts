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

const VERITY_STORAGE_KEY = 'bnji_verity_active';

let verityArmed = false;
let activeStage: HTMLElement | null = null;
let rafId: number | null = null;
let visibilityListener: (() => void) | null = null;

export function armVerity(): void {
	verityArmed = true;
	try {
		sessionStorage.setItem(VERITY_STORAGE_KEY, 'true');
	} catch {
		// Ignore storage errors in restricted environments
	}
}

export function isVerityArmed(): boolean {
	if (verityArmed) return true;
	try {
		return sessionStorage.getItem(VERITY_STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

export function initVerityBalls(): void {
	try {
		if (sessionStorage.getItem(VERITY_STORAGE_KEY) === 'true') {
			spawnVerityBalls();
		}
	} catch {
		// Ignore storage errors in restricted environments
	}
}

export function checkAndTriggerVerity(): void {
	if (verityArmed) {
		verityArmed = false;
		spawnVerityBalls();
	} else {
		initVerityBalls();
	}
}

type Ball = {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	el: HTMLElement;
	isDragging?: boolean;
	pointerId?: number;
	lastPointerX?: number;
	lastPointerY?: number;
	lastPointerTime?: number;
};

type RectBound = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

export function clearVerityBalls(): void {
	try {
		sessionStorage.removeItem(VERITY_STORAGE_KEY);
	} catch {
		// Ignore storage errors in restricted environments
	}
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

	function queryUIElements(): HTMLElement[] {
		const selector = [
			'[data-glass]',
			'.glass-panel',
			'.glass-button',
			'a.glass-button',
			'header',
			'footer',
			'article',
			'section',
			'button',
			'.card',
			'input',
			'select',
			'textarea',
			'[role="button"]',
			'[role="region"]',
			'.bento',
			'.hero-actions',
		].join(', ');

		const raw = Array.from(document.querySelectorAll<HTMLElement>(selector));
		return raw.filter((el) => {
			let p: HTMLElement | null = el;
			while (p) {
				if (p.id === 'verity-balls-stage') return false;
				p = p.parentElement;
			}
			return true;
		});
	}

	let uiElements = queryUIElements();
	let frameCount = 0;

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
		el.style.pointerEvents = 'auto';
		el.style.cursor = 'grab';
		el.style.touchAction = 'none';
		stage.appendChild(el);

		// Drop from top of viewport in staggered waves
		const x = Math.random() * (viewW - diameter) + radius;
		const y = -Math.random() * (viewH * 0.8) - radius;
		const vx = (Math.random() - 0.5) * 220;
		const vy = Math.random() * 60 + 20;

		const ball: Ball = { x, y, vx, vy, r: radius, el };

		// Pointer dragging interaction logic
		el.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0 && e.pointerType === 'mouse') return;
			ball.isDragging = true;
			ball.pointerId = e.pointerId;
			ball.lastPointerX = e.clientX;
			ball.lastPointerY = e.clientY;
			ball.lastPointerTime = performance.now();
			ball.vx = 0;
			ball.vy = 0;
			el.style.cursor = 'grabbing';
			try {
				el.setPointerCapture(e.pointerId);
			} catch {
				// Ignore setPointerCapture errors if unsupported
			}
		});

		el.addEventListener('pointermove', (e: PointerEvent) => {
			if (!ball.isDragging || e.pointerId !== ball.pointerId) return;
			const now = performance.now();
			const dt = (now - (ball.lastPointerTime ?? now)) / 1000;

			ball.x = e.clientX;
			ball.y = e.clientY;

			if (dt > 0.005) {
				const dx = e.clientX - (ball.lastPointerX ?? e.clientX);
				const dy = e.clientY - (ball.lastPointerY ?? e.clientY);

				const instVx = dx / dt;
				const instVy = dy / dt;

				// Smooth velocity to prevent abrupt spikes
				ball.vx = ball.vx * 0.3 + instVx * 0.7;
				ball.vy = ball.vy * 0.3 + instVy * 0.7;

				ball.lastPointerX = e.clientX;
				ball.lastPointerY = e.clientY;
				ball.lastPointerTime = now;
			}
		});

		const releasePointer = (e: PointerEvent) => {
			if (!ball.isDragging || e.pointerId !== ball.pointerId) return;
			ball.isDragging = false;
			ball.pointerId = undefined;
			el.style.cursor = 'grab';

			// Clamp release velocity (max 2000 px/s)
			const maxSpeed = 2000;
			const speed = Math.hypot(ball.vx, ball.vy);
			if (speed > maxSpeed) {
				ball.vx = (ball.vx / speed) * maxSpeed;
				ball.vy = (ball.vy / speed) * maxSpeed;
			}

			try {
				if (el.hasPointerCapture(e.pointerId)) {
					el.releasePointerCapture(e.pointerId);
				}
			} catch {
				// Ignore release failures
			}
		};

		el.addEventListener('pointerup', releasePointer);
		el.addEventListener('pointercancel', releasePointer);

		balls.push(ball);
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

		frameCount++;
		if (frameCount % 60 === 0) {
			uiElements = queryUIElements();
		}

		// Get fresh UI collision bounds
		const uiBounds: RectBound[] = uiElements
			.map((el) => {
				const rect = el.getBoundingClientRect();
				if (
					rect.width <= 10 ||
					rect.height <= 10 ||
					(rect.width >= W * 0.95 && rect.height >= H * 0.95)
				) {
					return null;
				}
				return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
			})
			.filter((b): b is RectBound => b !== null);

		// 2 Sub-steps per frame for high precision and zero tunneling/shakiness
		const subSteps = 2;
		const subDt = dt / subSteps;
		const subFriction = Math.pow(friction, 1 / subSteps);

		// Zero-allocation spatial grid arrays
		const maxCols = Math.max(1, Math.ceil(W / cellSize) + 2);
		const maxRows = Math.max(1, Math.ceil(H / cellSize) + 2);
		const totalCells = maxCols * maxRows;
		const gridHead = new Int32Array(totalCells);
		const gridNext = new Int32Array(balls.length);

		for (let step = 0; step < subSteps; step++) {
			// Physics Integration & Wall/UI Collisions
			for (let i = 0; i < balls.length; i++) {
				const b = balls[i];

				if (b.isDragging) {
					continue;
				}

				b.vy += gravity * subDt;
				b.vx *= subFriction;
				b.vy *= subFriction;

				b.x += b.vx * subDt;
				b.y += b.vy * subDt;

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

				// Precise Circle-AABB UI Element Collision Resolution
				for (let j = 0; j < uiBounds.length; j++) {
					const box = uiBounds[j];

					// Quick bounding box check first
					if (
						b.x + b.r < box.left ||
						b.x - b.r > box.right ||
						b.y + b.r < box.top ||
						b.y - b.r > box.bottom
					) {
						continue;
					}

					// Find closest point on UI box to ball center
					const closestX = Math.max(box.left, Math.min(b.x, box.right));
					const closestY = Math.max(box.top, Math.min(b.y, box.bottom));

					const dX = b.x - closestX;
					const dY = b.y - closestY;
					const distSq = dX * dX + dY * dY;

					if (distSq < b.r * b.r) {
						if (distSq === 0) {
							// Ball center is inside the UI box: push out to nearest edge
							const dl = b.x - box.left;
							const dr = box.right - b.x;
							const dt = b.y - box.top;
							const db = box.bottom - b.y;
							const minD = Math.min(dl, dr, dt, db);

							if (minD === dt) {
								b.y = box.top - b.r;
								b.vy = -Math.abs(b.vy) * restitution;
							} else if (minD === db) {
								b.y = box.bottom + b.r;
								b.vy = Math.abs(b.vy) * restitution;
							} else if (minD === dl) {
								b.x = box.left - b.r;
								b.vx = -Math.abs(b.vx) * restitution;
							} else {
								b.x = box.right + b.r;
								b.vx = Math.abs(b.vx) * restitution;
							}
						} else {
							// Ball touches edge or corner of UI box from outside
							const dist = Math.sqrt(distSq);
							const overlap = b.r - dist;
							const nx = dX / dist;
							const ny = dY / dist;

							// Separate ball from box along collision normal
							b.x += nx * overlap;
							b.y += ny * overlap;

							// Reflect velocity along collision normal
							const vDotN = b.vx * nx + b.vy * ny;
							if (vDotN < 0) {
								b.vx -= (1 + restitution) * vDotN * nx;
								b.vy -= (1 + restitution) * vDotN * ny;
							}
						}
					}
				}
			}

			// Allocation-free Spatial Grid for O(N) Ball-Ball Collisions
			gridHead.fill(-1);
			for (let i = 0; i < balls.length; i++) {
				const b = balls[i];
				const cx = Math.min(maxCols - 1, Math.max(0, Math.floor(b.x / cellSize)));
				const cy = Math.min(maxRows - 1, Math.max(0, Math.floor(b.y / cellSize)));
				const cellIdx = cy * maxCols + cx;
				gridNext[i] = gridHead[cellIdx];
				gridHead[cellIdx] = i;
			}

			// Check cell and neighbor cell collisions
			for (let cy = 0; cy < maxRows; cy++) {
				for (let cx = 0; cx < maxCols; cx++) {
					const cellIdx = cy * maxCols + cx;
					let i = gridHead[cellIdx];

					while (i !== -1) {
						// Check remaining balls in current cell & neighboring cells
						for (let ndy = 0; ndy <= 1; ndy++) {
							for (let ndx = (ndy === 0 ? 0 : -1); ndx <= 1; ndx++) {
								const ncx = cx + ndx;
								const ncy = cy + ndy;

								if (ncx >= 0 && ncx < maxCols && ncy >= 0 && ncy < maxRows) {
									const nCellIdx = ncy * maxCols + ncx;
									let j = (ndx === 0 && ndy === 0) ? gridNext[i] : gridHead[nCellIdx];

									while (j !== -1) {
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

											// Separate balls evenly (or skip separation if one is dragged)
											const overlap = (minDist - dist) * 0.5;
											if (!b1.isDragging && !b2.isDragging) {
												b1.x -= nx * overlap;
												b1.y -= ny * overlap;
												b2.x += nx * overlap;
												b2.y += ny * overlap;
											} else if (!b1.isDragging) {
												b1.x -= nx * overlap * 2;
												b1.y -= ny * overlap * 2;
											} else if (!b2.isDragging) {
												b2.x += nx * overlap * 2;
												b2.y += ny * overlap * 2;
											}

											// Relative velocity along collision normal
											const kx = b1.vx - b2.vx;
											const ky = b1.vy - b2.vy;
											const p = (nx * kx + ny * ky) * restitution;

											if (!b1.isDragging) {
												b1.vx -= p * nx;
												b1.vy -= p * ny;
											}
											if (!b2.isDragging) {
												b2.vx += p * nx;
												b2.vy += p * ny;
											}
										}

										j = gridNext[j];
									}
								}
							}
						}

						i = gridNext[i];
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
