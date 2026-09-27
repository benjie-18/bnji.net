/**
 * FLIP/PIC liquid solver (2D, CPU, allocation-free per frame).
 *
 * Method — the one production tools and Müller's "Ten Minute Physics" FLIP
 * tutorial use for splashy liquids:
 *   1. Particles carry the liquid (position, velocity, colour).
 *   2. Each sub-step: integrate gravity → separate overlapping particles →
 *      resolve collisions (walls, drawn solids, the push obstacle) →
 *      splat particle velocities onto a staggered MAC grid → solve pressure
 *      with Gauss-Seidel + over-relaxation, with a drift term that pushes
 *      apart cells denser than rest density (keeps volume from "leaking") →
 *      read velocities back as a FLIP/PIC blend.
 *   3. Viscosity lowers the FLIP ratio (more PIC = smoother, damped flow)
 *      and diffuses grid velocity between neighbouring fluid faces.
 *
 * Units: one grid cell = 1. Coordinates are y-DOWN (screen space), so
 * positive gravity pulls towards +y. The outer ring of cells is a permanent
 * wall on all four sides (the box in the box); boundaries are handled
 * symmetrically on every side so the liquid can actually come to rest.
 */
import { FLUID_SOLVER } from './config';

const FLUID = 0;
const AIR = 1;
const SOLID = 2;

export type StepOptions = {
	dt: number;
	gravityX: number;
	gravityY: number;
	viscosity: number;
	cohesion: number;
	colorMixing: boolean;
};

export class FlipSolver {
	readonly numX: number;
	readonly numY: number;
	readonly maxParticles: number;
	readonly radius: number;
	count = 0;

	/* particles */
	readonly pos: Float32Array;
	readonly vel: Float32Array;
	readonly color: Float32Array;
	private readonly prevPos: Float32Array;

	/* MAC grid; index = i * numY + j */
	private readonly u: Float32Array;
	private readonly v: Float32Array;
	private readonly du: Float32Array;
	private readonly dv: Float32Array;
	private readonly prevU: Float32Array;
	private readonly prevV: Float32Array;
	/** 1 = open, 0 = blocked (walls, drawn solids, obstacle) for this step. */
	private readonly s: Float32Array;
	/** Static solids drawn by the user + the outer walls. 1 = solid. */
	readonly solid: Uint8Array;
	private readonly cellType: Int32Array;
	private readonly density: Float32Array;
	private readonly restDensity: number;
	private readonly driftK = FLUID_SOLVER.driftStiffness;

	/* spatial hash for particle separation */
	private readonly pInv: number;
	private readonly pNumX: number;
	private readonly pNumY: number;
	private readonly cellCount: Int32Array;
	private readonly firstCell: Int32Array;
	private readonly cellIds: Int32Array;
	/** Hash cell of each particle, from the last rebuild (stale-by-one-pass is fine). */
	private readonly particleCell: Int32Array;

	/* push obstacle */
	private obstacle = { active: false, x: 0, y: 0, r: 0, vx: 0, vy: 0 };

	/** Bumped whenever `solid` changes so the renderer can re-upload it. */
	solidVersion = 0;
	/** Largest particle speed seen last step (drives adaptive sub-stepping). */
	maxSpeed = 0;

	constructor(numX: number, numY: number, maxParticles: number) {
		this.numX = numX;
		this.numY = numY;
		this.maxParticles = maxParticles;
		this.radius = FLUID_SOLVER.particleRadius;

		const cells = numX * numY;
		this.u = new Float32Array(cells);
		this.v = new Float32Array(cells);
		this.du = new Float32Array(cells);
		this.dv = new Float32Array(cells);
		this.prevU = new Float32Array(cells);
		this.prevV = new Float32Array(cells);
		this.s = new Float32Array(cells);
		this.solid = new Uint8Array(cells);
		this.cellType = new Int32Array(cells);
		this.density = new Float32Array(cells);

		// Hexagonal packing at spacing 2r gives 1 / (2√3 r²) particles per
		// cell; bilinear splatting sums to 1 per particle, so that is also
		// the rest value of `density`. Derived, not measured, so pouring into
		// an empty box does not calibrate against a sparse first frame.
		this.restDensity = FLUID_SOLVER.restDensityScale / (2 * Math.sqrt(3) * this.radius * this.radius);

		this.pos = new Float32Array(maxParticles * 2);
		this.prevPos = new Float32Array(maxParticles * 2);
		this.vel = new Float32Array(maxParticles * 2);
		this.color = new Float32Array(maxParticles * 3);

		this.pInv = 1 / (2.2 * this.radius);
		this.pNumX = Math.floor(numX * this.pInv) + 1;
		this.pNumY = Math.floor(numY * this.pInv) + 1;
		const pCells = this.pNumX * this.pNumY;
		this.cellCount = new Int32Array(pCells);
		this.firstCell = new Int32Array(pCells + 1);
		this.cellIds = new Int32Array(maxParticles);
		this.particleCell = new Int32Array(maxParticles);

		this.clearSolids();
	}

	/* --- editing -------------------------------------------------------- */

	clearParticles(): void {
		this.count = 0;
	}

	/** Removes drawn solids; the outer wall ring always stays. */
	clearSolids(): void {
		const { numX, numY } = this;
		for (let i = 0; i < numX; i++) {
			for (let j = 0; j < numY; j++) {
				const border = i === 0 || j === 0 || i === numX - 1 || j === numY - 1;
				this.solid[i * numY + j] = border ? 1 : 0;
			}
		}
		this.solidVersion++;
	}

	isSolidAt(x: number, y: number): boolean {
		const i = Math.floor(x);
		const j = Math.floor(y);
		if (i < 0 || j < 0 || i >= this.numX || j >= this.numY) return true;
		return this.solid[i * this.numY + j] === 1;
	}

	/**
	 * Paint (value=1) or erase (value=0) a disc of solid cells. Liquid inside
	 * a new solid is pushed radially out of it rather than deleted.
	 */
	stampSolid(cx: number, cy: number, r: number, value: 0 | 1): void {
		const { numX, numY } = this;
		const i0 = Math.max(1, Math.floor(cx - r));
		const i1 = Math.min(numX - 2, Math.ceil(cx + r));
		const j0 = Math.max(1, Math.floor(cy - r));
		const j1 = Math.min(numY - 2, Math.ceil(cy + r));
		let changed = false;
		for (let i = i0; i <= i1; i++) {
			for (let j = j0; j <= j1; j++) {
				const dx = i + 0.5 - cx;
				const dy = j + 0.5 - cy;
				if (dx * dx + dy * dy > r * r) continue;
				const k = i * numY + j;
				if (this.solid[k] !== value) {
					this.solid[k] = value;
					changed = true;
				}
			}
		}
		if (!changed) return;
		this.solidVersion++;
		if (value === 1) {
			const reach = r + 0.75;
			for (let p = 0; p < this.count; p++) {
				const dx = this.pos[2 * p] - cx;
				const dy = this.pos[2 * p + 1] - cy;
				const d = Math.hypot(dx, dy);
				if (d >= reach) continue;
				const nx = d > 1e-4 ? dx / d : 0;
				const ny = d > 1e-4 ? dy / d : -1;
				this.pos[2 * p] = cx + nx * reach;
				this.pos[2 * p + 1] = cy + ny * reach;
			}
		}
	}

	/** Solid line of thickness r between two points (used by the draw tool). */
	stampSolidLine(x0: number, y0: number, x1: number, y1: number, r: number, value: 0 | 1): void {
		const length = Math.hypot(x1 - x0, y1 - y0);
		const steps = Math.max(1, Math.ceil(length / Math.max(0.35, r * 0.5)));
		for (let n = 0; n <= steps; n++) {
			const t = n / steps;
			this.stampSolid(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, value);
		}
	}

	/** Axis-aligned solid rectangle in cell units (scenes). */
	fillSolidRect(x0: number, y0: number, x1: number, y1: number): void {
		const { numX, numY } = this;
		for (let i = Math.max(1, Math.floor(x0)); i < Math.min(numX - 1, Math.ceil(x1)); i++) {
			for (let j = Math.max(1, Math.floor(y0)); j < Math.min(numY - 1, Math.ceil(y1)); j++) {
				this.solid[i * numY + j] = 1;
			}
		}
		this.solidVersion++;
	}

	addParticle(x: number, y: number, vx: number, vy: number, r: number, g: number, b: number): boolean {
		if (this.count >= this.maxParticles) return false;
		if (this.isSolidAt(x, y)) return false;
		const p = this.count++;
		this.pos[2 * p] = x;
		this.pos[2 * p + 1] = y;
		this.prevPos[2 * p] = x;
		this.prevPos[2 * p + 1] = y;
		this.vel[2 * p] = vx;
		this.vel[2 * p + 1] = vy;
		this.color[3 * p] = r;
		this.color[3 * p + 1] = g;
		this.color[3 * p + 2] = b;
		return true;
	}

	/** Hex-packed block of liquid at rest spacing (cell units). */
	fillBlock(x0: number, y0: number, x1: number, y1: number, rgb: readonly number[]): void {
		const dx = 2 * this.radius;
		const dy = dx * Math.sqrt(3) * 0.5;
		let row = 0;
		for (let y = y1 - this.radius; y > y0; y -= dy, row++) {
			for (let x = x0 + this.radius + (row % 2 ? this.radius : 0); x < x1; x += dx) {
				if (!this.addParticle(x, y, 0, 0, rgb[0], rgb[1], rgb[2])) {
					if (this.count >= this.maxParticles) return;
				}
			}
		}
	}

	/**
	 * Pour: emits jittered particles in a disc, skipping spots that are
	 * already at rest density so holding the brush still does not stack
	 * particles on top of each other (which would explode the pressure).
	 */
	pour(cx: number, cy: number, r: number, vx: number, vy: number, rgb: readonly number[], budget: number): void {
		const spacing = 2 * this.radius * 1.05;
		let emitted = 0;
		for (let attempt = 0; attempt < budget * 3 && emitted < budget; attempt++) {
			const a = Math.random() * Math.PI * 2;
			const d = Math.sqrt(Math.random()) * r;
			const x = cx + Math.cos(a) * d;
			const y = cy + Math.sin(a) * d;
			const i = Math.floor(x);
			const j = Math.floor(y);
			if (i < 1 || j < 1 || i >= this.numX - 1 || j >= this.numY - 1) continue;
			if (this.density[i * this.numY + j] > this.restDensity * 0.7) continue;
			if (this.hasNeighbourWithin(x, y, spacing)) continue;
			if (this.addParticle(x, y, vx, vy, rgb[0], rgb[1], rgb[2])) {
				// Keep the density estimate current so the rest of this batch
				// respects what was just emitted.
				this.density[i * this.numY + j] += 1;
				emitted++;
			} else if (this.count >= this.maxParticles) {
				return;
			}
		}
	}

	/** Removes particles inside a disc (swap-remove, order is irrelevant). */
	drain(cx: number, cy: number, r: number): void {
		const r2 = r * r;
		for (let p = this.count - 1; p >= 0; p--) {
			const dx = this.pos[2 * p] - cx;
			const dy = this.pos[2 * p + 1] - cy;
			if (dx * dx + dy * dy > r2) continue;
			const last = --this.count;
			this.pos[2 * p] = this.pos[2 * last];
			this.pos[2 * p + 1] = this.pos[2 * last + 1];
			this.prevPos[2 * p] = this.prevPos[2 * last];
			this.prevPos[2 * p + 1] = this.prevPos[2 * last + 1];
			this.vel[2 * p] = this.vel[2 * last];
			this.vel[2 * p + 1] = this.vel[2 * last + 1];
			this.color[3 * p] = this.color[3 * last];
			this.color[3 * p + 1] = this.color[3 * last + 1];
			this.color[3 * p + 2] = this.color[3 * last + 2];
		}
	}

	setObstacle(active: boolean, x = 0, y = 0, r = 0, vx = 0, vy = 0): void {
		const o = this.obstacle;
		o.active = active;
		o.x = x;
		o.y = y;
		o.r = r;
		o.vx = vx;
		o.vy = vy;
	}

	/* --- simulation ------------------------------------------------------ */

	step(options: StepOptions): void {
		const frameDt = Math.min(options.dt, FLUID_SOLVER.maxFrameDt);
		if (frameDt <= 0) return;
		const travel = (this.maxSpeed * frameDt) / FLUID_SOLVER.maxCellsPerSubstep;
		const substeps = Math.min(FLUID_SOLVER.maxSubsteps, Math.max(1, Math.ceil(travel)));
		const dt = frameDt / substeps;
		const flipRatio = FLUID_SOLVER.flipRatio * (1 - 0.85 * options.viscosity);

		for (let n = 0; n < substeps; n++) {
			this.integrate(dt, options.gravityX, options.gravityY);
			this.separate(options.cohesion, options.colorMixing);
			this.collide();
			this.buildBlockers();
			this.transfer(true, 0);
			this.updateDensity();
			this.solvePressure(dt);
			if (options.viscosity > 0) this.diffuse(options.viscosity);
			this.transfer(false, flipRatio);
		}
		this.measureSpeed(frameDt);
	}

	private integrate(dt: number, gx: number, gy: number): void {
		const { pos, vel, prevPos } = this;
		for (let p = 0; p < this.count; p++) {
			prevPos[2 * p] = pos[2 * p];
			prevPos[2 * p + 1] = pos[2 * p + 1];
			vel[2 * p] += gx * dt;
			vel[2 * p + 1] += gy * dt;
			pos[2 * p] += vel[2 * p] * dt;
			pos[2 * p + 1] += vel[2 * p + 1] * dt;
		}
	}

	private hasNeighbourWithin(x: number, y: number, dist: number): boolean {
		// Cheap check against the hash built in the last separate() pass.
		const { pInv, pNumX, pNumY, firstCell, cellIds, pos } = this;
		const xi = Math.min(pNumX - 1, Math.max(0, Math.floor(x * pInv)));
		const yi = Math.min(pNumY - 1, Math.max(0, Math.floor(y * pInv)));
		const d2 = dist * dist;
		for (let a = Math.max(0, xi - 1); a <= Math.min(pNumX - 1, xi + 1); a++) {
			for (let b = Math.max(0, yi - 1); b <= Math.min(pNumY - 1, yi + 1); b++) {
				const cell = a * pNumY + b;
				for (let k = firstCell[cell]; k < firstCell[cell + 1]; k++) {
					const q = cellIds[k];
					if (q >= this.count) continue;
					const dx = pos[2 * q] - x;
					const dy = pos[2 * q + 1] - y;
					if (dx * dx + dy * dy < d2) return true;
				}
			}
		}
		return false;
	}

	/**
	 * Pushes overlapping particles apart (and, with cohesion, pulls nearly
	 * touching ones together a little — a cheap surface-tension stand-in that
	 * makes thin streams bead into droplets). Also diffuses colour so two
	 * liquids blend where they meet.
	 */
	private separate(cohesion: number, colorMixing: boolean): void {
		const { pInv, pNumX, pNumY, cellCount, firstCell, cellIds, particleCell, pos, color } = this;
		const n = this.count;

		cellCount.fill(0);
		for (let p = 0; p < n; p++) {
			const xi = Math.min(pNumX - 1, Math.max(0, Math.floor(pos[2 * p] * pInv)));
			const yi = Math.min(pNumY - 1, Math.max(0, Math.floor(pos[2 * p + 1] * pInv)));
			const c = xi * pNumY + yi;
			particleCell[p] = c;
			cellCount[c]++;
		}
		let sum = 0;
		for (let c = 0; c < pNumX * pNumY; c++) {
			sum += cellCount[c];
			firstCell[c] = sum;
		}
		firstCell[pNumX * pNumY] = sum;
		for (let p = 0; p < n; p++) {
			const c = particleCell[p];
			firstCell[c]--;
			cellIds[firstCell[c]] = p;
		}

		const minDist = 2 * this.radius;
		const minDist2 = minDist * minDist;
		const reach = minDist * 1.45;
		const reach2 = reach * reach;
		const pull = cohesion * 0.045;
		const mix = colorMixing ? FLUID_SOLVER.colorDiffusion : 0;

		for (let iter = 0; iter < FLUID_SOLVER.separationIterations; iter++) {
			for (let p = 0; p < n; p++) {
				const pc = particleCell[p];
				const xi = (pc / pNumY) | 0;
				const yi = pc - xi * pNumY;
				const a0 = xi > 0 ? xi - 1 : 0;
				const a1 = xi < pNumX - 1 ? xi + 1 : pNumX - 1;
				const b0 = yi > 0 ? yi - 1 : 0;
				const b1 = yi < pNumY - 1 ? yi + 1 : pNumY - 1;
				for (let a = a0; a <= a1; a++) {
					for (let b = b0; b <= b1; b++) {
						const cell = a * pNumY + b;
						for (let k = firstCell[cell]; k < firstCell[cell + 1]; k++) {
							const q = cellIds[k];
							if (q <= p) continue; // each pair once
							let dx = pos[2 * q] - pos[2 * p];
							let dy = pos[2 * q + 1] - pos[2 * p + 1];
							const d2 = dx * dx + dy * dy;
							if (d2 > reach2 || d2 === 0) continue;
							const d = Math.sqrt(d2);
							let s: number;
							if (d2 < minDist2) {
								s = (0.5 * (minDist - d)) / d;
							} else if (pull > 0) {
								// Gentle attraction that fades to zero at `reach`.
								s = (-pull * (d - minDist) * (reach - d)) / (d * (reach - minDist));
							} else {
								continue;
							}
							dx *= s;
							dy *= s;
							pos[2 * p] -= dx;
							pos[2 * p + 1] -= dy;
							pos[2 * q] += dx;
							pos[2 * q + 1] += dy;

							if (mix > 0 && d2 < minDist2) {
								for (let c = 0; c < 3; c++) {
									const c0 = color[3 * p + c];
									const c1 = color[3 * q + c];
									const avg = (c0 + c1) * 0.5;
									color[3 * p + c] = c0 + (avg - c0) * mix;
									color[3 * q + c] = c1 + (avg - c1) * mix;
								}
							}
						}
					}
				}
			}
		}
	}

	/**
	 * Keeps particles out of solid cells and at least one radius from any
	 * solid face. Particles that ended up deep inside a solid (a fast one
	 * crossing a thin wall) are returned to where they started the step.
	 */
	private collide(): void {
		const { pos, vel, prevPos, solid, numY, radius: r } = this;
		const slip = FLUID_SOLVER.wallSlip;
		const o = this.obstacle;
		const numX = this.numX;

		for (let p = 0; p < this.count; p++) {
			let x = pos[2 * p];
			let y = pos[2 * p + 1];

			// Hard clamp inside the wall ring first (NaN-proof too).
			if (!(x > 1 + r)) x = 1 + r;
			if (!(x < numX - 1 - r)) x = numX - 1 - r;
			if (!(y > 1 + r)) y = 1 + r;
			if (!(y < numY - 1 - r)) y = numY - 1 - r;

			let i = Math.floor(x);
			let j = Math.floor(y);

			if (solid[i * numY + j]) {
				// Inside a drawn solid: exit through the nearest open face.
				const fx = x - i;
				const fy = y - j;
				let best = Infinity;
				let nx = x;
				let ny = y;
				if (!solid[(i - 1) * numY + j] && fx < best) { best = fx; nx = i - r; ny = y; }
				if (!solid[(i + 1) * numY + j] && 1 - fx < best) { best = 1 - fx; nx = i + 1 + r; ny = y; }
				if (!solid[i * numY + j - 1] && fy < best) { best = fy; nx = x; ny = j - r; }
				if (!solid[i * numY + j + 1] && 1 - fy < best) { best = 1 - fy; nx = x; ny = j + 1 + r; }
				if (best === Infinity) {
					nx = prevPos[2 * p];
					ny = prevPos[2 * p + 1];
					vel[2 * p] *= -0.2;
					vel[2 * p + 1] *= -0.2;
				} else if (nx !== x) {
					vel[2 * p] = 0;
					vel[2 * p + 1] *= slip;
				} else {
					vel[2 * p + 1] = 0;
					vel[2 * p] *= slip;
				}
				x = nx;
				y = ny;
				i = Math.floor(x);
				j = Math.floor(y);
			}

			// Contact with neighbouring solid faces (keeps a radius gap).
			const fx = x - i;
			const fy = y - j;
			if (fx < r && solid[(i - 1) * numY + j]) {
				x = i + r;
				if (vel[2 * p] < 0) vel[2 * p] = 0;
				vel[2 * p + 1] *= slip;
			} else if (fx > 1 - r && solid[(i + 1) * numY + j]) {
				x = i + 1 - r;
				if (vel[2 * p] > 0) vel[2 * p] = 0;
				vel[2 * p + 1] *= slip;
			}
			if (fy < r && solid[i * numY + j - 1]) {
				y = j + r;
				if (vel[2 * p + 1] < 0) vel[2 * p + 1] = 0;
				vel[2 * p] *= slip;
			} else if (fy > 1 - r && solid[i * numY + j + 1]) {
				y = j + 1 - r;
				if (vel[2 * p + 1] > 0) vel[2 * p + 1] = 0;
				vel[2 * p] *= slip;
			}

			// Push obstacle: particles inside are moved to its rim and carried.
			if (o.active) {
				const dx = x - o.x;
				const dy = y - o.y;
				const d2 = dx * dx + dy * dy;
				const minD = o.r + r;
				if (d2 < minD * minD) {
					const d = Math.sqrt(d2) || 1e-4;
					x = o.x + (dx / d) * minD;
					y = o.y + (dy / d) * minD;
					vel[2 * p] = o.vx;
					vel[2 * p + 1] = o.vy;
					if (this.isSolidAt(x, y)) {
						x = prevPos[2 * p];
						y = prevPos[2 * p + 1];
					}
				}
			}

			pos[2 * p] = x;
			pos[2 * p + 1] = y;
		}
	}

	/** Builds `s` from the static solids plus the moving obstacle. */
	private buildBlockers(): void {
		const { numX, numY, s, solid, u, v } = this;
		const o = this.obstacle;
		for (let i = 0; i < numX; i++) {
			for (let j = 0; j < numY; j++) {
				const k = i * numY + j;
				s[k] = solid[k] ? 0 : 1;
				if (o.active && !solid[k]) {
					const dx = i + 0.5 - o.x;
					const dy = j + 0.5 - o.y;
					if (dx * dx + dy * dy < o.r * o.r) {
						s[k] = 0;
						// Obstacle faces carry its velocity into the pressure solve.
						u[k] = o.vx;
						if (i + 1 < numX) u[k + numY] = o.vx;
						v[k] = o.vy;
						if (j + 1 < numY) v[k + 1] = o.vy;
					}
				}
			}
		}
	}

	/**
	 * Particle ↔ grid velocity transfer (bilinear on the staggered grid).
	 * toGrid: splat and normalise. Otherwise: FLIP/PIC blend back onto the
	 * particles, only from faces that touch fluid (air faces are undefined).
	 */
	private transfer(toGrid: boolean, flipRatio: number): void {
		const { numX, numY, u, v, du, dv, prevU, prevV, cellType, s, pos, vel } = this;
		const n = numY;

		if (toGrid) {
			prevU.set(u);
			prevV.set(v);
			du.fill(0);
			dv.fill(0);
			u.fill(0);
			v.fill(0);
			for (let k = 0; k < numX * numY; k++) cellType[k] = s[k] === 0 ? SOLID : AIR;
			for (let p = 0; p < this.count; p++) {
				const i = Math.min(numX - 1, Math.max(0, Math.floor(pos[2 * p])));
				const j = Math.min(numY - 1, Math.max(0, Math.floor(pos[2 * p + 1])));
				const k = i * n + j;
				if (cellType[k] === AIR) cellType[k] = FLUID;
			}
		}

		for (let component = 0; component < 2; component++) {
			const dx = component === 0 ? 0 : 0.5;
			const dy = component === 0 ? 0.5 : 0;
			const f = component === 0 ? u : v;
			const prevF = component === 0 ? prevU : prevV;
			const d = component === 0 ? du : dv;
			const offset = component === 0 ? n : 1;

			for (let p = 0; p < this.count; p++) {
				const x = Math.min(Math.max(pos[2 * p], 1), numX - 1);
				const y = Math.min(Math.max(pos[2 * p + 1], 1), numY - 1);

				const x0 = Math.min(Math.floor(x - dx), numX - 2);
				const tx = x - dx - x0;
				const x1 = Math.min(x0 + 1, numX - 2);
				const y0 = Math.min(Math.floor(y - dy), numY - 2);
				const ty = y - dy - y0;
				const y1 = Math.min(y0 + 1, numY - 2);

				const sx = 1 - tx;
				const sy = 1 - ty;
				const d0 = sx * sy;
				const d1 = tx * sy;
				const d2 = tx * ty;
				const d3 = sx * ty;
				const nr0 = x0 * n + y0;
				const nr1 = x1 * n + y0;
				const nr2 = x1 * n + y1;
				const nr3 = x0 * n + y1;

				if (toGrid) {
					const pv = vel[2 * p + component];
					f[nr0] += pv * d0; d[nr0] += d0;
					f[nr1] += pv * d1; d[nr1] += d1;
					f[nr2] += pv * d2; d[nr2] += d2;
					f[nr3] += pv * d3; d[nr3] += d3;
				} else {
					const valid0 = cellType[nr0] !== AIR || cellType[nr0 - offset] !== AIR ? 1 : 0;
					const valid1 = cellType[nr1] !== AIR || cellType[nr1 - offset] !== AIR ? 1 : 0;
					const valid2 = cellType[nr2] !== AIR || cellType[nr2 - offset] !== AIR ? 1 : 0;
					const valid3 = cellType[nr3] !== AIR || cellType[nr3 - offset] !== AIR ? 1 : 0;
					const w = valid0 * d0 + valid1 * d1 + valid2 * d2 + valid3 * d3;
					if (w > 0) {
						const pic =
							(valid0 * d0 * f[nr0] + valid1 * d1 * f[nr1] + valid2 * d2 * f[nr2] + valid3 * d3 * f[nr3]) / w;
						const corr =
							(valid0 * d0 * (f[nr0] - prevF[nr0]) +
								valid1 * d1 * (f[nr1] - prevF[nr1]) +
								valid2 * d2 * (f[nr2] - prevF[nr2]) +
								valid3 * d3 * (f[nr3] - prevF[nr3])) /
							w;
						const flip = vel[2 * p + component] + corr;
						vel[2 * p + component] = (1 - flipRatio) * pic + flipRatio * flip;
					}
				}
			}

			if (toGrid) {
				for (let k = 0; k < f.length; k++) if (d[k] > 0) f[k] /= d[k];
				// Faces touching a blocker keep the blocker's velocity (0 for
				// static solids, the obstacle's velocity for the push tool).
				for (let i = 0; i < numX; i++) {
					for (let j = 0; j < numY; j++) {
						const k = i * n + j;
						const blocked = cellType[k] === SOLID;
						if (component === 0 && (blocked || (i > 0 && cellType[k - n] === SOLID))) u[k] = prevU[k];
						if (component === 1 && (blocked || (j > 0 && cellType[k - 1] === SOLID))) v[k] = prevV[k];
					}
				}
			}
		}

		if (toGrid) {
			// Static solid faces are still: clear what an obstacle left behind.
			for (let i = 0; i < numX; i++) {
				for (let j = 0; j < numY; j++) {
					const k = i * n + j;
					if (this.solid[k] || (i > 0 && this.solid[k - n])) u[k] = 0;
					if (this.solid[k] || (j > 0 && this.solid[k - 1])) v[k] = 0;
				}
			}
		}
	}

	private updateDensity(): void {
		const { numX, numY, density, pos } = this;
		const n = numY;
		density.fill(0);
		for (let p = 0; p < this.count; p++) {
			const x = Math.min(Math.max(pos[2 * p], 1), numX - 1);
			const y = Math.min(Math.max(pos[2 * p + 1], 1), numY - 1);
			const x0 = Math.floor(x - 0.5);
			const tx = x - 0.5 - x0;
			const x1 = Math.min(x0 + 1, numX - 2);
			const y0 = Math.floor(y - 0.5);
			const ty = y - 0.5 - y0;
			const y1 = Math.min(y0 + 1, numY - 2);
			const sx = 1 - tx;
			const sy = 1 - ty;
			if (x0 < numX && y0 < numY) density[x0 * n + y0] += sx * sy;
			if (x1 < numX && y0 < numY) density[x1 * n + y0] += tx * sy;
			if (x1 < numX && y1 < numY) density[x1 * n + y1] += tx * ty;
			if (x0 < numX && y1 < numY) density[x0 * n + y1] += sx * ty;
		}
	}

	private solvePressure(_dt: number): void {
		const { numX, numY, u, v, s, cellType, density, restDensity } = this;
		void _dt;
		const n = numY;
		const omega = FLUID_SOLVER.overRelaxation;
		// Snapshot before projection: the FLIP delta is (projected − this).
		this.prevU.set(u);
		this.prevV.set(v);

		for (let iter = 0; iter < FLUID_SOLVER.pressureIterations; iter++) {
			for (let i = 1; i < numX - 1; i++) {
				for (let j = 1; j < numY - 1; j++) {
					const center = i * n + j;
					if (cellType[center] !== FLUID) continue;
					const left = center - n;
					const right = center + n;
					const top = center - 1;
					const bottom = center + 1;
					const sx0 = s[left];
					const sx1 = s[right];
					const sy0 = s[top];
					const sy1 = s[bottom];
					const sum = sx0 + sx1 + sy0 + sy1;
					if (sum === 0) continue;
					let div = u[right] - u[center] + v[bottom] - v[center];
					// Drift compensation: over-dense cells get extra outflow.
					const compression = density[center] - restDensity;
					if (compression > 0) div -= this.driftK * compression;
					const p = (-div / sum) * omega;
					u[center] -= sx0 * p;
					u[right] += sx1 * p;
					v[center] -= sy0 * p;
					v[bottom] += sy1 * p;
				}
			}
		}
	}

	/** Viscosity: relax each fluid face towards the mean of its neighbours. */
	private diffuse(viscosity: number): void {
		const { numX, numY, u, v, cellType } = this;
		const n = numY;
		const k = Math.min(0.9, viscosity * 0.9);
		const passes = viscosity > 0.5 ? 3 : 2;
		for (let pass = 0; pass < passes; pass++) {
			for (let i = 2; i < numX - 2; i++) {
				for (let j = 2; j < numY - 2; j++) {
					const c = i * n + j;
					if (cellType[c] !== FLUID) continue;
					if (cellType[c - n] === FLUID) {
						const avg = (u[c - n] + u[c + n] + u[c - 1] + u[c + 1]) * 0.25;
						u[c] += (avg - u[c]) * k;
					}
					if (cellType[c - 1] === FLUID) {
						const avg = (v[c - n] + v[c + n] + v[c - 1] + v[c + 1]) * 0.25;
						v[c] += (avg - v[c]) * k;
					}
				}
			}
		}
	}

	private measureSpeed(frameDt: number): void {
		const { vel } = this;
		// Hard speed ceiling so a violent stir cannot tunnel through walls.
		const ceiling = (FLUID_SOLVER.maxCellsPerSubstep * FLUID_SOLVER.maxSubsteps) / Math.max(frameDt, 1e-4);
		let max = 0;
		for (let p = 0; p < this.count; p++) {
			let vx = vel[2 * p];
			let vy = vel[2 * p + 1];
			if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
				vx = 0;
				vy = 0;
			}
			const sp = Math.hypot(vx, vy);
			if (sp > ceiling) {
				vx *= ceiling / sp;
				vy *= ceiling / sp;
			}
			vel[2 * p] = vx;
			vel[2 * p + 1] = vy;
			if (sp > max) max = sp;
		}
		this.maxSpeed = Math.min(max, ceiling);
	}
}
