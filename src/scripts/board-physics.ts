/**
 * BNJI.NET — message board physics.
 *
 * A deliberately small 2D solver for the floating message bubbles/stars:
 *
 *   - buoyancy: a constant upward acceleration, so new messages rise from the
 *     composer toward the accumulated stack at the top;
 *   - soft collisions: pairwise position correction + damped impulse, so
 *     elements jostle and settle instead of overlapping or exploding;
 *   - collision shape: each body is a PILL (capsule) matching the bubble's
 *     actual CSS shape (border-radius: 999px around the content-sized box).
 *     The test is exact along both axes — a bubble keeps neighbours out by
 *     its own width and its own height, nothing more — and an honest
 *     approximation on diagonals. The old single-radius model used the
 *     bounding circle of the box (max(w, h) / 2), which made wide bubbles
 *     collide vertically at their WIDTH: stacked bubbles left a gap as big
 *     as w - h between their visible edges;
 *   - dragged bodies are kinematic: infinite mass during a drag, but still
 *     push everything else around them (the brief's requirement);
 *   - walls and a ceiling band: the stack accumulates under the nav instead of
 *     escaping the viewport;
 *   - semi-implicit Euler with a clamped dt: stable at any frame rate, and a
 *     background-tab stall cannot teleport elements.
 *
 * Cost model: O(n²) pairs with n ≤ ~30 visible elements — a few hundred
 * distance checks per frame, which is noise. The loop lives in board.ts and
 * pauses when the tab is hidden.
 */
export type PhysicsBody = {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Half the content box width — horizontal collision extent (px). */
	rx: number;
	/** Half the content box height — vertical collision extent (px). */
	ry: number;
	/** True while a pointer or the keyboard is moving this body directly. */
	kinematic: boolean;
};

export type PhysicsBounds = {
	width: number;
	height: number;
	/** Elements settle below this line (clears the floating nav). */
	ceiling: number;
	/** Elements stay above this line (clears the composer). */
	floor: number;
};

export type PhysicsOptions = {
	/** Upward acceleration, px/s². */
	buoyancy: number;
	/** Velocity damping per second (0..1). */
	damping: number;
	/** Collision restitution (0 = mushy, 1 = bouncy). */
	restitution: number;
};

export const PHYSICS_DEFAULTS: PhysicsOptions = {
	buoyancy: 26,
	damping: 0.55,
	restitution: 0.35,
};

/**
 * How far a pill extends along the unit direction (nx, ny).
 *
 * The bubble is a pill: the Minkowski sum of its long axis (a segment of
 * half-length |rx - ry|) and an end-cap disc of radius min(rx, ry). The
 * support of that shape in any direction is the axis projection plus the cap
 * radius, which is EXACT — and it collapses to the plain radius when
 * rx === ry (the dark theme's round star orbs). Because the extent is taken
 * along the line joining two bodies' centres, vertical neighbours separate
 * by exactly h/2 + h/2 and side-by-side neighbours by w/2 + w/2.
 */
function pillRadius(rx: number, ry: number, nx: number, ny: number): number {
	if (rx >= ry) return (rx - ry) * Math.abs(nx) + ry;
	return (ry - rx) * Math.abs(ny) + rx;
}

export function stepBodies(
	bodies: PhysicsBody[],
	dt: number,
	bounds: PhysicsBounds,
	options: PhysicsOptions = PHYSICS_DEFAULTS,
): void {
	const step = Math.min(dt, 0.05);

	/* Integrate: buoyancy lifts, damping calms, kinematic bodies ignore both. */
	for (const body of bodies) {
		if (body.kinematic) continue;
		body.vy -= options.buoyancy * step;
		const damp = Math.max(0, 1 - options.damping * step);
		body.vx *= damp;
		body.vy *= damp;
		body.x += body.vx * step;
		body.y += body.vy * step;
	}

	/* Pairwise soft collisions. */
	for (let i = 0; i < bodies.length; i++) {
		for (let j = i + 1; j < bodies.length; j++) {
			const a = bodies[i];
			const b = bodies[j];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const distSq = dx * dx + dy * dy;

			// Coincident centres: any push-out direction is as good as
			// another, but the normal still has to be a unit vector.
			let nx = 0;
			let ny = 1;
			let dist = 0;
			if (distSq > 0) {
				dist = Math.sqrt(distSq);
				nx = dx / dist;
				ny = dy / dist;
			}

			// Collision extent along the line of centres (exact for circles
			// and parallel pills; a fair soft-body estimate at angles).
			const minDist = pillRadius(a.rx, a.ry, nx, ny) + pillRadius(b.rx, b.ry, nx, ny);
			if (distSq >= minDist * minDist) continue;

			const overlap = minDist - dist;

			// Position correction: kinematic bodies move nothing themselves.
			const aShare = a.kinematic ? 0 : b.kinematic ? 1 : 0.5;
			const bShare = b.kinematic ? 0 : a.kinematic ? 1 : 0.5;
			a.x -= nx * overlap * aShare;
			a.y -= ny * overlap * aShare;
			b.x += nx * overlap * bShare;
			b.y += ny * overlap * bShare;

			// Damped impulse along the normal, only when approaching.
			const rvx = b.vx - a.vx;
			const rvy = b.vy - a.vy;
			const closing = rvx * nx + rvy * ny;
			if (closing < 0) {
				const impulse = (-(1 + options.restitution) * closing) / 2;
				if (!a.kinematic) {
					a.vx -= nx * impulse;
					a.vy -= ny * impulse;
				}
				if (!b.kinematic) {
					b.vx += nx * impulse;
					b.vy += ny * impulse;
				}
			}
		}
	}

	/* Walls, ceiling stack band, composer floor. */
	for (const body of bodies) {
		if (body.kinematic) {
			body.x = Math.min(Math.max(body.x, body.rx), bounds.width - body.rx);
			body.y = Math.min(Math.max(body.y, bounds.ceiling + body.ry), bounds.floor - body.ry);
			continue;
		}
		if (body.x < body.rx) {
			body.x = body.rx;
			body.vx = Math.abs(body.vx) * 0.5;
		} else if (body.x > bounds.width - body.rx) {
			body.x = bounds.width - body.rx;
			body.vx = -Math.abs(body.vx) * 0.5;
		}
		if (body.y < bounds.ceiling + body.ry) {
			// Settle into the stack: kill most vertical speed, let collisions
			// spread the pile sideways.
			body.y = bounds.ceiling + body.ry;
			body.vy = Math.abs(body.vy) * 0.12;
			body.vx += (Math.random() - 0.5) * 6;
		} else if (body.y > bounds.floor - body.ry) {
			body.y = bounds.floor - body.ry;
			body.vy = -Math.abs(body.vy) * 0.4;
		}
	}
}

/** Static (reduced-motion) layout: a calm grid from the top of the field. */
export function staticLayout(
	bodies: PhysicsBody[],
	bounds: PhysicsBounds,
): void {
	const columns = Math.max(2, Math.floor(bounds.width / 190));
	const cell = bounds.width / columns;
	let top = bounds.ceiling + 12;
	for (let i = 0; i < bodies.length; i += columns) {
		const row = bodies.slice(i, i + columns);
		// A row occupies the tallest member's height, so a short bubble in
		// one row cannot sink into the next one.
		const halfH = Math.max(...row.map((body) => body.ry));
		for (let c = 0; c < row.length; c++) {
			const body = row[c];
			body.x = cell * (i % columns + c) + cell / 2;
			body.y = top + halfH;
			body.vx = 0;
			body.vy = 0;
		}
		top += halfH * 2 + 18;
	}
}
