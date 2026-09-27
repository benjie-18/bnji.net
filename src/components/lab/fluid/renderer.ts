/**
 * Fluid Sandbox — renderer.
 *
 * WebGL2 screen-space metaballs, the standard trick for making a particle
 * liquid read as one continuous body:
 *   pass 1  every particle is splatted as a soft (1-q²)³ kernel into an
 *           offscreen field (additive blending; rgb = colour·weight,
 *           a = weight). Half-float when available, 8-bit scaled otherwise.
 *   pass 2  a full-screen shader thresholds the field into a surface, derives
 *           a normal from the field gradient and shades it: depth tint,
 *           diffuse + specular highlight, a lit rim on the meniscus and
 *           velocity foam. Solids (a linearly-filtered cell mask, so walls
 *           come out rounded) and the brush ring are drawn in the same pass.
 *
 * The canvas is transparent: the stage's CSS background shows through, so
 * the liquid sits on the same backdrop as every other lab experiment.
 *
 * When WebGL2 is missing the Canvas 2D fallback draws plain discs — less
 * pretty, same simulation.
 */
import { FLUID_RENDER, FLUID_THEME, LIGHT_TONE, toLightTone, type FluidTool, type RGB } from './config';
import type { FlipSolver } from './solver';

export type Theme = 'dark' | 'light';

export type FrameInput = {
	solver: FlipSolver;
	speeds: Float32Array;
	theme: Theme;
	foam: number;
	/** Brush ring in cell units, or null to hide it. */
	cursor: { x: number; y: number; r: number; tool: FluidTool } | null;
};

export interface FluidRenderer {
	readonly kind: 'webgl' | 'canvas';
	resize(width: number, height: number, dpr: number): void;
	render(frame: FrameInput): void;
	destroy(): void;
}

/* --- WebGL2 --------------------------------------------------------------- */

const SPLAT_VS = `#version 300 es
in vec2 aPos;
in vec3 aColor;
in float aSpeed;
uniform vec2 uGrid;
uniform float uPointSize;
uniform float uFoam;
uniform vec2 uFoamRange;
out vec3 vColor;
void main() {
	vec2 f = (aPos - 1.0) / (uGrid - 2.0);
	gl_Position = vec4(f.x * 2.0 - 1.0, 1.0 - f.y * 2.0, 0.0, 1.0);
	gl_PointSize = uPointSize;
	float foam = smoothstep(uFoamRange.x, uFoamRange.y, aSpeed) * uFoam;
	vColor = mix(aColor, vec3(1.0), foam * 0.8);
}`;

const SPLAT_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
uniform float uWeight;
out vec4 outColor;
void main() {
	vec2 c = gl_PointCoord * 2.0 - 1.0;
	float q = dot(c, c);
	if (q >= 1.0) discard;
	float w = 1.0 - q;
	w = w * w * w * uWeight;
	outColor = vec4(vColor * w, w);
}`;

const QUAD_VS = `#version 300 es
in vec2 aQuad;
out vec2 vUv;
void main() {
	vUv = aQuad * 0.5 + 0.5;
	gl_Position = vec4(aQuad, 0.0, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uField;
uniform sampler2D uSolid;
uniform vec2 uFieldTexel;
uniform vec2 uGrid;
uniform vec2 uRes;
uniform float uThreshold;
uniform float uWeight;
uniform float uLight;
uniform vec3 uSolidColor;
uniform vec3 uSolidEdge;
uniform vec3 uCursor;
uniform vec3 uCursorColor;
uniform vec3 uTone;
out vec4 outColor;

// Clamped just above the surface: the interior reads flat, so only the
// meniscus bends the normal (otherwise every particle sparkles).
float field(vec2 uv) { return min(texture(uField, uv).a / uWeight, uThreshold + 0.4); }

// 9-tap tent blur of the cell mask: diagonal walls drawn on a coarse grid
// come out as smooth slopes instead of staircases.
float solidMask(vec2 suv, vec2 gt) {
	float m = texture(uSolid, suv).r * 4.0;
	m += (texture(uSolid, suv + vec2(gt.x, 0.0)).r + texture(uSolid, suv - vec2(gt.x, 0.0)).r
		+ texture(uSolid, suv + vec2(0.0, gt.y)).r + texture(uSolid, suv - vec2(0.0, gt.y)).r) * 2.0;
	m += texture(uSolid, suv + gt).r + texture(uSolid, suv - gt).r
		+ texture(uSolid, suv + vec2(gt.x, -gt.y)).r + texture(uSolid, suv + vec2(-gt.x, gt.y)).r;
	return m / 16.0;
}

void main() {
	vec4 s = texture(uField, vUv);
	float d = s.a / uWeight;
	vec3 col = s.a > 1e-6 ? s.rgb / s.a : vec3(0.0);
	// Particles store the night palette; the Aero theme deepens it so the
	// liquid reads as tinted glass on a pale sky instead of washing out.
	if (uLight > 0.5) col = clamp((col - uTone.x) * uTone.y + uTone.z, 0.0, 1.0);
	float T = uThreshold;
	vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
	vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));

	/* liquid */
	float aa = fwidth(d) + 0.015;
	float cover = smoothstep(T - aa, T + aa, d);
	vec4 liquid = vec4(0.0);
	if (cover > 0.0) {
		vec2 e = uFieldTexel * 2.5;
		float dx = field(vUv + vec2(e.x, 0.0)) - field(vUv - vec2(e.x, 0.0));
		float dy = field(vUv + vec2(0.0, e.y)) - field(vUv - vec2(0.0, e.y));
		vec3 n = normalize(vec3(-dx, -dy, 0.35));
		float diff = clamp(dot(n, L), 0.0, 1.0);
		float spec = pow(max(dot(n, H), 0.0), 70.0);
		float depth = smoothstep(T, T + 1.3, d);
		float rim = 1.0 - smoothstep(T, T + 0.3, d);
		vec3 body;
		float alpha;
		if (uLight < 0.5) {
			body = mix(col * 1.2, col * 0.38, depth * 0.8);
			body = body * (0.62 + 0.5 * diff) + rim * mix(col, vec3(1.0), 0.35) * 0.85 + spec * 0.95;
			alpha = mix(0.95, 0.84, depth);
		} else {
			body = mix(col * 0.9 + 0.16, col * 0.6, depth * 0.75);
			body = body * (0.78 + 0.28 * diff) + spec * 0.9;
			body = mix(body, col * 0.42, rim * 0.6);
			alpha = mix(0.7, 0.88, depth);
		}
		liquid = vec4(body * alpha, alpha) * cover;
	}

	/* solids */
	vec2 sim = vec2(1.0 + vUv.x * (uGrid.x - 2.0), 1.0 + (1.0 - vUv.y) * (uGrid.y - 2.0));
	vec2 suv = sim / uGrid;
	vec2 gt = 1.0 / uGrid;
	float m = solidMask(suv, gt * 0.75);
	float saa = fwidth(m) + 0.01;
	float sm = smoothstep(0.5 - saa, 0.5 + saa, m);
	vec4 solid = vec4(0.0);
	if (sm > 0.0) {
		float mx = solidMask(suv + vec2(gt.x, 0.0), gt * 0.75) - solidMask(suv - vec2(gt.x, 0.0), gt * 0.75);
		float my = solidMask(suv + vec2(0.0, gt.y), gt * 0.75) - solidMask(suv - vec2(0.0, gt.y), gt * 0.75);
		float edge = clamp(1.0 - smoothstep(0.5, 0.75, m), 0.0, 1.0);
		vec3 sn = normalize(vec3(-mx, my, 0.7));
		float sl = clamp(dot(sn, L), 0.0, 1.0);
		vec3 scol = uSolidColor * (0.78 + 0.35 * sl) + uSolidEdge * edge * 0.75;
		float sa = mix(0.9, 1.0, edge);
		solid = vec4(scol * sa, sa) * sm;
	}

	vec4 result = solid + liquid * (1.0 - solid.a);

	/* brush ring */
	if (uCursor.z > 0.0) {
		float px = (uGrid.y - 2.0) / uRes.y;
		float dist = abs(length(sim - uCursor.xy) - uCursor.z);
		float ring = 1.0 - smoothstep(px * 0.75, px * 2.0, dist);
		vec4 rc = vec4(uCursorColor, 1.0) * ring * 0.8;
		result = rc + result * (1.0 - rc.a);
	}

	outColor = result;
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error('shader alloc failed');
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`fluid shader: ${log}`);
	}
	return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
	const program = gl.createProgram();
	if (!program) throw new Error('program alloc failed');
	const v = compile(gl, gl.VERTEX_SHADER, vs);
	const f = compile(gl, gl.FRAGMENT_SHADER, fs);
	gl.attachShader(program, v);
	gl.attachShader(program, f);
	gl.linkProgram(program);
	gl.deleteShader(v);
	gl.deleteShader(f);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`fluid program: ${gl.getProgramInfoLog(program)}`);
	}
	return program;
}

class WebGLFluidRenderer implements FluidRenderer {
	readonly kind = 'webgl' as const;
	private gl: WebGL2RenderingContext;
	private canvas: HTMLCanvasElement;
	private fieldScale: number;
	private splat: WebGLProgram;
	private composite: WebGLProgram;
	private posBuffer: WebGLBuffer;
	private colorBuffer: WebGLBuffer;
	private speedBuffer: WebGLBuffer;
	private quadBuffer: WebGLBuffer;
	private splatVao: WebGLVertexArrayObject;
	private quadVao: WebGLVertexArrayObject;
	private fieldTex: WebGLTexture;
	private fbo: WebGLFramebuffer;
	private solidTex: WebGLTexture;
	private solidVersion = -1;
	private solidScratch: Uint8Array = new Uint8Array(0);
	private floatField: boolean;
	private weight: number;
	private maxPointSize: number;
	private fieldW = 1;
	private fieldH = 1;
	private capacity = 0;
	private splatU: Record<string, WebGLUniformLocation | null>;
	private compU: Record<string, WebGLUniformLocation | null>;

	constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, fieldScale: number) {
		this.canvas = canvas;
		this.gl = gl;
		this.fieldScale = fieldScale;

		this.floatField = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
		// 8-bit fields saturate at 1.0, so weights are scaled down to leave
		// headroom for the deep interior of the liquid.
		this.weight = this.floatField ? 1 : 0.18;
		const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
		this.maxPointSize = range ? range[1] : 64;

		this.splat = link(gl, SPLAT_VS, SPLAT_FS);
		this.composite = link(gl, QUAD_VS, COMPOSITE_FS);
		this.splatU = this.uniforms(this.splat, ['uGrid', 'uPointSize', 'uFoam', 'uFoamRange', 'uWeight']);
		this.compU = this.uniforms(this.composite, [
			'uField', 'uSolid', 'uFieldTexel', 'uGrid', 'uRes', 'uThreshold', 'uWeight', 'uLight',
			'uSolidColor', 'uSolidEdge', 'uCursor', 'uCursorColor', 'uTone',
		]);

		this.posBuffer = gl.createBuffer()!;
		this.colorBuffer = gl.createBuffer()!;
		this.speedBuffer = gl.createBuffer()!;
		this.quadBuffer = gl.createBuffer()!;

		this.splatVao = gl.createVertexArray()!;
		gl.bindVertexArray(this.splatVao);
		this.attrib(this.splat, 'aPos', this.posBuffer, 2);
		this.attrib(this.splat, 'aColor', this.colorBuffer, 3);
		this.attrib(this.splat, 'aSpeed', this.speedBuffer, 1);

		this.quadVao = gl.createVertexArray()!;
		gl.bindVertexArray(this.quadVao);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
		const quadLoc = gl.getAttribLocation(this.composite, 'aQuad');
		gl.enableVertexAttribArray(quadLoc);
		gl.vertexAttribPointer(quadLoc, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		this.fieldTex = gl.createTexture()!;
		this.fbo = gl.createFramebuffer()!;
		this.solidTex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, this.solidTex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	}

	private uniforms(program: WebGLProgram, names: string[]) {
		const out: Record<string, WebGLUniformLocation | null> = {};
		for (const name of names) out[name] = this.gl.getUniformLocation(program, name);
		return out;
	}

	private attrib(program: WebGLProgram, name: string, buffer: WebGLBuffer, size: number) {
		const gl = this.gl;
		const loc = gl.getAttribLocation(program, name);
		if (loc < 0) return;
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
	}

	private allocField() {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
		const make = (internal: number, type: number) => {
			gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.fieldW, this.fieldH, 0, gl.RGBA, type, null);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fieldTex, 0);
			return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
		};
		if (this.floatField && !make(gl.RGBA16F, gl.HALF_FLOAT)) {
			// Extension advertised but not renderable on this driver.
			this.floatField = false;
			this.weight = 0.18;
		}
		if (!this.floatField) make(gl.RGBA8, gl.UNSIGNED_BYTE);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	resize(width: number, height: number, dpr: number): void {
		this.canvas.width = Math.max(1, Math.round(width * dpr));
		this.canvas.height = Math.max(1, Math.round(height * dpr));
		this.fieldW = Math.max(1, Math.round(this.canvas.width * this.fieldScale));
		this.fieldH = Math.max(1, Math.round(this.canvas.height * this.fieldScale));
		this.allocField();
	}

	private uploadSolids(solver: FlipSolver) {
		if (solver.solidVersion === this.solidVersion) return;
		this.solidVersion = solver.solidVersion;
		const { numX, numY, solid } = solver;
		if (this.solidScratch.length !== numX * numY) this.solidScratch = new Uint8Array(numX * numY);
		const data = this.solidScratch;
		// Solver is column-major (i * numY + j); textures are row-major. The
		// outer wall ring is left out: the stage border already frames it.
		for (let j = 0; j < numY; j++) {
			for (let i = 0; i < numX; i++) {
				const border = i === 0 || j === 0 || i === numX - 1 || j === numY - 1;
				data[j * numX + i] = !border && solid[i * numY + j] ? 255 : 0;
			}
		}
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.solidTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, numX, numY, 0, gl.RED, gl.UNSIGNED_BYTE, data);
	}

	render({ solver, speeds, theme, foam, cursor }: FrameInput): void {
		const gl = this.gl;
		if (gl.isContextLost()) return;
		const count = solver.count;
		this.uploadSolids(solver);

		if (solver.maxParticles !== this.capacity) {
			this.capacity = solver.maxParticles;
			gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 8, gl.DYNAMIC_DRAW);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 12, gl.DYNAMIC_DRAW);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.speedBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, this.capacity * 4, gl.DYNAMIC_DRAW);
		}

		/* pass 1: field */
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		gl.viewport(0, 0, this.fieldW, this.fieldH);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		if (count > 0) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, solver.pos, 0, count * 2);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, solver.color, 0, count * 3);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.speedBuffer);
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, speeds, 0, count);

			const pxPerCell = this.fieldH / (solver.numY - 2);
			const size = Math.min(this.maxPointSize, 2 * FLUID_RENDER.kernelRadius * solver.radius * pxPerCell);

			gl.useProgram(this.splat);
			gl.uniform2f(this.splatU.uGrid, solver.numX, solver.numY);
			gl.uniform1f(this.splatU.uPointSize, size);
			gl.uniform1f(this.splatU.uFoam, foam);
			gl.uniform2f(this.splatU.uFoamRange, FLUID_RENDER.foamSpeedLow, FLUID_RENDER.foamSpeedHigh);
			gl.uniform1f(this.splatU.uWeight, this.weight);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE);
			gl.bindVertexArray(this.splatVao);
			gl.drawArrays(gl.POINTS, 0, count);
		}

		/* pass 2: composite */
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.disable(gl.BLEND);
		gl.useProgram(this.composite);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
		gl.uniform1i(this.compU.uField, 0);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, this.solidTex);
		gl.uniform1i(this.compU.uSolid, 1);
		gl.uniform2f(this.compU.uFieldTexel, 1 / this.fieldW, 1 / this.fieldH);
		gl.uniform2f(this.compU.uGrid, solver.numX, solver.numY);
		gl.uniform2f(this.compU.uRes, this.canvas.width, this.canvas.height);
		gl.uniform1f(this.compU.uThreshold, FLUID_RENDER.threshold);
		gl.uniform1f(this.compU.uWeight, this.weight);
		gl.uniform1f(this.compU.uLight, theme === 'light' ? 1 : 0);
		gl.uniform3f(this.compU.uTone, LIGHT_TONE.pivot, LIGHT_TONE.gain, LIGHT_TONE.lift);
		const palette = FLUID_THEME[theme];
		gl.uniform3fv(this.compU.uSolidColor, palette.solid);
		gl.uniform3fv(this.compU.uSolidEdge, palette.solidEdge);
		if (cursor) {
			gl.uniform3f(this.compU.uCursor, cursor.x, cursor.y, cursor.r);
			gl.uniform3fv(this.compU.uCursorColor, palette.cursor[cursor.tool]);
		} else {
			gl.uniform3f(this.compU.uCursor, 0, 0, 0);
		}
		gl.bindVertexArray(this.quadVao);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindVertexArray(null);
	}

	destroy(): void {
		const gl = this.gl;
		gl.deleteProgram(this.splat);
		gl.deleteProgram(this.composite);
		for (const b of [this.posBuffer, this.colorBuffer, this.speedBuffer, this.quadBuffer]) gl.deleteBuffer(b);
		gl.deleteVertexArray(this.splatVao);
		gl.deleteVertexArray(this.quadVao);
		gl.deleteTexture(this.fieldTex);
		gl.deleteTexture(this.solidTex);
		gl.deleteFramebuffer(this.fbo);
	}
}

/* --- Canvas 2D fallback ---------------------------------------------------- */

const css = (rgb: RGB | number[], a = 1) =>
	`rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;

class CanvasFluidRenderer implements FluidRenderer {
	readonly kind = 'canvas' as const;
	private ctx: CanvasRenderingContext2D;
	private canvas: HTMLCanvasElement;
	private w = 1;
	private h = 1;

	constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
		this.canvas = canvas;
		this.ctx = ctx;
	}

	resize(width: number, height: number, dpr: number): void {
		this.w = width;
		this.h = height;
		this.canvas.width = Math.max(1, Math.round(width * dpr));
		this.canvas.height = Math.max(1, Math.round(height * dpr));
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	render({ solver, theme, cursor }: FrameInput): void {
		const { ctx, w, h } = this;
		const sx = w / (solver.numX - 2);
		const sy = h / (solver.numY - 2);
		ctx.clearRect(0, 0, w, h);
		const palette = FLUID_THEME[theme];
		const rad = Math.max(1.2, solver.radius * 1.6 * sx);
		const light = theme === 'light';
		const tone = (c: number) => (light ? toLightTone(c) : c);
		for (let p = 0; p < solver.count; p++) {
			ctx.fillStyle = css(
				[tone(solver.color[3 * p]), tone(solver.color[3 * p + 1]), tone(solver.color[3 * p + 2])],
				0.85,
			);
			ctx.beginPath();
			ctx.arc((solver.pos[2 * p] - 1) * sx, (solver.pos[2 * p + 1] - 1) * sy, rad, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.fillStyle = css(palette.solid, 0.95);
		for (let i = 1; i < solver.numX - 1; i++) {
			for (let j = 1; j < solver.numY - 1; j++) {
				if (solver.solid[i * solver.numY + j]) ctx.fillRect((i - 1) * sx, (j - 1) * sy, sx + 0.5, sy + 0.5);
			}
		}
		if (cursor) {
			ctx.strokeStyle = css(palette.cursor[cursor.tool], 0.8);
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc((cursor.x - 1) * sx, (cursor.y - 1) * sy, cursor.r * sx, 0, Math.PI * 2);
			ctx.stroke();
		}
	}

	destroy(): void {}
}

/**
 * WebGL2 first, Canvas 2D second, null when the browser offers neither.
 * Returns the canvas actually in use: a canvas that already handed out a
 * WebGL context (e.g. shader compile failed) can never give a 2D one, so it
 * is swapped for a fresh clone in that case.
 */
export function createRenderer(
	canvas: HTMLCanvasElement,
	fieldScale: number,
): { renderer: FluidRenderer; canvas: HTMLCanvasElement } | null {
	let target = canvas;
	try {
		const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
		if (gl) return { renderer: new WebGLFluidRenderer(canvas, gl, fieldScale), canvas };
	} catch (error) {
		console.warn('[fluid] WebGL2 renderer unavailable, using Canvas 2D.', error);
		const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
		canvas.replaceWith(fresh);
		target = fresh;
	}
	const ctx = target.getContext('2d');
	return ctx ? { renderer: new CanvasFluidRenderer(target, ctx), canvas: target } : null;
}
