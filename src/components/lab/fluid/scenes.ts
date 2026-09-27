/**
 * Fluid Sandbox — preset scenes.
 *
 * Every coordinate is a 0..1 fraction of the box interior so a scene looks the
 * same at every quality tier and aspect ratio. A scene receives a tiny
 * builder API instead of the solver, which keeps layouts declarative:
 * add a scene = add an id to FLUID_SCENES in config.ts + a function here.
 */
import type { FluidSceneId, RGB } from './config';
import type { FlipSolver } from './solver';

type SceneApi = {
	/** Liquid block. */
	liquid(x0: number, y0: number, x1: number, y1: number, color: RGB): void;
	/** Solid rectangle. */
	wall(x0: number, y0: number, x1: number, y1: number): void;
	/** Solid line of thickness t (fraction of box height). */
	line(x0: number, y0: number, x1: number, y1: number, t?: number): void;
};

type Scene = (api: SceneApi, colors: RGB[]) => void;

const SCENES: Record<FluidSceneId, Scene> = {
	dam(api, [a]) {
		api.liquid(0, 0.18, 0.38, 1, a);
		api.wall(0.62, 0.72, 0.7, 1);
	},
	basins(api, [a, , c]) {
		api.wall(0.47, 0.45, 0.53, 1);
		api.liquid(0, 0.35, 0.3, 1, a);
		api.liquid(0.7, 0.35, 1, 1, c);
	},
	funnel(api, [, b]) {
		api.line(0.18, 0.34, 0.46, 0.62, 0.035);
		api.line(0.82, 0.34, 0.54, 0.62, 0.035);
		api.wall(0.3, 0.86, 0.34, 1);
		api.wall(0.66, 0.86, 0.7, 1);
		api.liquid(0.25, 0.0, 0.75, 0.3, b);
	},
	cascade(api, [a, , , d]) {
		api.line(0.0, 0.3, 0.3, 0.36, 0.03);
		api.line(0.72, 0.5, 0.38, 0.56, 0.03);
		api.line(0.28, 0.72, 0.6, 0.78, 0.03);
		api.liquid(0.0, 0.0, 0.22, 0.28, a);
		api.liquid(0.78, 0.2, 1, 0.48, d);
	},
	empty() {},
};

export function loadScene(solver: FlipSolver, id: FluidSceneId, colors: RGB[]): void {
	solver.clearParticles();
	solver.clearSolids();

	// Interior spans cells [1, num-1]; map fractions onto it.
	const w = solver.numX - 2;
	const h = solver.numY - 2;
	const X = (f: number) => 1 + f * w;
	const Y = (f: number) => 1 + f * h;

	const api: SceneApi = {
		liquid: (x0, y0, x1, y1, color) => solver.fillBlock(X(x0), Y(y0), X(x1), Y(y1), color),
		wall: (x0, y0, x1, y1) => solver.fillSolidRect(X(x0), Y(y0), X(x1), Y(y1)),
		line: (x0, y0, x1, y1, t = 0.03) =>
			solver.stampSolidLine(X(x0), Y(y0), X(x1), Y(y1), Math.max(0.8, (t * h) / 2), 1),
	};

	// Solids first so liquid blocks skip cells that are already walls.
	const deferred: (() => void)[] = [];
	const ordered: SceneApi = {
		liquid: (...args) => deferred.push(() => api.liquid(...args)),
		wall: api.wall,
		line: api.line,
	};
	SCENES[id](ordered, colors);
	for (const run of deferred) run();
}
