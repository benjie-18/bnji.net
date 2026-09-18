/**
 * BNJI.NET — message board physics.
 *
 * A deliberately small 2D solver for the floating message bubbles/stars:
 *
 *   - buoyancy: a constant upward acceleration, so new messages rise from the
 *     composer toward the accumulated stack at the top;
 *   - soft collisions: pairwise position correction + damped impulse, so
 *     elements jostle and settle instead of overlapping or exploding;
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
	/** Collision radius in px. */
	r: number;
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
			const minDist = a.r + b.r;
			const distSq = dx * dx + dy * dy;
			if (distSq >= minDist * minDist || distSq === 0) continue;

			const dist = Math.sqrt(distSq);
			const nx = dx / dist;
			const ny = dy / dist;
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
			body.x = Math.min(Math.max(body.x, body.r), bounds.width - body.r);
			body.y = Math.min(Math.max(body.y, bounds.ceiling + body.r), bounds.floor - body.r);
			continue;
		}
		if (body.x < body.r) {
			body.x = body.r;
			body.vx = Math.abs(body.vx) * 0.5;
		} else if (body.x > bounds.width - body.r) {
			body.x = bounds.width - body.r;
			body.vx = -Math.abs(body.vx) * 0.5;
		}
		if (body.y < bounds.ceiling + body.r) {
			// Settle into the stack: kill most vertical speed, let collisions
			// spread the pile sideways.
			body.y = bounds.ceiling + body.r;
			body.vy = Math.abs(body.vy) * 0.12;
			body.vx += (Math.random() - 0.5) * 6;
		} else if (body.y > bounds.floor - body.r) {
			body.y = bounds.floor - body.r;
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
	bodies.forEach((body, i) => {
		const col = i % columns;
		const row = Math.floor(i / columns);
		body.x = cell * col + cell / 2;
		body.y = bounds.ceiling + body.r + 12 + row * (body.r * 2 + 18);
		body.vx = 0;
		body.vy = 0;
	});
}
