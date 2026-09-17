/**
 * BNJI.NET — public message board runtime.
 *
 * Owns everything between the API boundary (/api/board) and the DOM:
 *
 *   - loads the N most recent messages (N from the slider, default 10) and
 *     renders each as a theme-appropriate floating element (aero bubble in
 *     light, star orb in dark — pure CSS against html[data-theme]);
 *   - runs the physics loop (src/scripts/board-physics.ts): elements float
 *     upward, collide, and settle into a stack under the nav;
 *   - drag: pointer capture makes any element kinematic while held — and it
 *     keeps pushing its neighbours, because collisions treat kinematic bodies
 *     as infinite mass; keyboard users get arrow-key nudging on focus;
 *   - submit: POSTs through the API and spawns the accepted message directly
 *     above the composer, where buoyancy takes it upward like the rest;
 *   - slider adjusts the visible count; the archive button opens a dialog with
 *     the full history;
 *   - polls for new messages (interval from config, paused while hidden);
 *   - reduced motion: no loop, no buoyancy — a calm static grid, drag still
 *     works; the site stays fully usable.
 *
 * Safety: server-validated content is rendered with textContent only; images
 * are data: URLs the server re-validated; nothing here trusts the payload.
 */
import { BOARD_CONFIG } from '../config/board.config';
import { prefersReducedMotion, isPageVisible } from './environment';
import { stepBodies, staticLayout, type PhysicsBody, type PhysicsBounds } from './board-physics';

type BoardMessage = {
	id: string;
	text: string;
	image?: string;
	hue: number;
	createdAt: number;
};

type Body = PhysicsBody & { el: HTMLElement; msg: BoardMessage };

let started = false;

export function initMessageBoard(): void {
	if (started) return;
	started = true;

	const root = document.querySelector<HTMLElement>('[data-board]');
	if (!root) return;
	const field = root.querySelector<HTMLUListElement>('[data-board-field]');
	const composer = root.querySelector<HTMLFormElement>('[data-board-composer]');
	const slider = root.querySelector<HTMLInputElement>('[data-board-slider]');
	const sliderValue = root.querySelector<HTMLElement>('[data-board-slider-value]');
	const archiveButton = root.querySelector<HTMLButtonElement>('[data-board-archive-open]');
	const status = root.querySelector<HTMLElement>('[data-board-status]');
	if (!field || !composer || !slider || !sliderValue || !archiveButton || !status) return;
	// Re-bind through the guard: hoisted/closure functions below capture these
	// names, and control-flow narrowing does not reach into function bodies.
	const fieldEl: HTMLUListElement = field;
	const composerEl: HTMLFormElement = composer;
	const sliderEl: HTMLInputElement = slider;
	const sliderValueEl: HTMLElement = sliderValue;
	const archiveButtonEl: HTMLButtonElement = archiveButton;
	const statusEl: HTMLElement = status;

	const bodies: Body[] = [];
	const reduced = prefersReducedMotion();
	let frame = 0;
	let lastTime = 0;
	let dragging: Body | null = null;

	const bounds = (): PhysicsBounds => ({
		width: window.innerWidth,
		height: window.innerHeight,
		ceiling: 76,
		floor: window.innerHeight - 150,
	});

	const announce = (text: string) => {
		statusEl.textContent = text;
	};

	/* --- rendering ---------------------------------------------------------- */

	const widthFor = (text: string, image?: string) =>
		Math.round(Math.min(220, Math.max(110, 96 + text.length * 1.15 + (image ? 40 : 0))));

	function createElement(msg: BoardMessage, spawnAtComposer: boolean): Body {
		const li = document.createElement('li');
		li.className = 'board-msg';
		li.style.setProperty('--hue', String(msg.hue));
		const width = widthFor(msg.text, msg.image);
		li.style.width = `${width}px`;

		const grab = document.createElement('button');
		grab.type = 'button';
		grab.className = 'board-msg__grab';
		grab.setAttribute(
			'aria-label',
			`Visitor message: ${msg.text.slice(0, 80)} — focus, then use arrow keys to move`,
		);
		if (msg.image) {
			const img = document.createElement('img');
			img.src = msg.image; // server-validated data: URL only
			img.alt = 'Image attached to a visitor message';
			img.className = 'board-msg__img';
			img.loading = 'lazy';
			grab.appendChild(img);
		}
		const span = document.createElement('span');
		span.className = 'board-msg__text';
		span.textContent = msg.text; // never innerHTML: UGC stays inert
		grab.appendChild(span);
		li.appendChild(grab);
		fieldEl.appendChild(li);

		const b = bounds();
		const body: Body = {
			id: msg.id,
			el: li,
			msg,
			r: width / 2,
			x: spawnAtComposer
				? b.width / 2 + (Math.random() - 0.5) * 90
				: b.width / 2 + (Math.random() - 0.5) * 160,
			y: spawnAtComposer ? b.floor - width / 2 - 8 : b.ceiling + width / 2 + 20 + Math.random() * 60,
			vx: (Math.random() - 0.5) * 20,
			vy: spawnAtComposer ? -60 : 0,
			kinematic: false,
		};
		li.classList.add('board-msg--enter');
		setTimeout(() => li.classList.remove('board-msg--enter'), 900);
		bodies.push(body);
		paint(body);
		bindDrag(body, grab);
		return body;
	}

	const paint = (body: Body) => {
		body.el.style.transform = `translate3d(${(body.x - body.r).toFixed(1)}px, ${(
			body.y - body.r
		).toFixed(1)}px, 0)`;
	};

	/* --- loop ---------------------------------------------------------------- */

	function loop(now: number) {
		frame = requestAnimationFrame(loop);
		if (!isPageVisible()) return;
		const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
		lastTime = now;
		stepBodies(bodies, dt, bounds());
		for (const body of bodies) paint(body);
	}

	const startLoop = () => {
		if (reduced || frame) return;
		lastTime = 0;
		frame = requestAnimationFrame(loop);
	};
	const stopLoop = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	};

	const relayoutStatic = () => {
		staticLayout(bodies, bounds());
		for (const body of bodies) paint(body);
	};

	document.addEventListener('visibilitychange', () => (isPageVisible() ? startLoop() : stopLoop()));

	/* --- drag & keyboard move ------------------------------------------------- */

	function bindDrag(body: Body, grab: HTMLElement) {
		grab.addEventListener('pointerdown', (event) => {
			if (event.button !== 0 && event.pointerType === 'mouse') return;
			dragging = body;
			body.kinematic = true;
			grab.setPointerCapture(event.pointerId);
			grab.classList.add('board-msg__grab--held');
			const move = (e: PointerEvent) => {
				if (dragging !== body) return;
				const prevX = body.x;
				const prevY = body.y;
				body.x = e.clientX;
				body.y = e.clientY;
				// Impart some velocity so releases feel physical.
				body.vx = (body.x - prevX) * 12;
				body.vy = (body.y - prevY) * 12;
				if (reduced) paint(body);
			};
			const up = () => {
				grab.removeEventListener('pointermove', move);
				grab.removeEventListener('pointerup', up);
				grab.removeEventListener('pointercancel', up);
				grab.classList.remove('board-msg__grab--held');
				body.kinematic = reduced;
				dragging = null;
			};
			grab.addEventListener('pointermove', move);
			grab.addEventListener('pointerup', up);
			grab.addEventListener('pointercancel', up);
		});

		// Non-pointer alternative: arrows nudge the focused element.
		grab.addEventListener('keydown', (event) => {
			const stepPx = event.shiftKey ? 40 : 14;
			const deltas: Record<string, [number, number]> = {
				ArrowLeft: [-stepPx, 0],
				ArrowRight: [stepPx, 0],
				ArrowUp: [0, -stepPx],
				ArrowDown: [0, stepPx],
			};
			const delta = deltas[event.key];
			if (!delta) return;
			event.preventDefault();
			body.x += delta[0];
			body.y += delta[1];
			body.kinematic = true;
			setTimeout(() => (body.kinematic = reduced), 400);
			paint(body);
		});
	}

	/* --- data ------------------------------------------------------------------ */

	const seen = new Set<string>();

	async function load(limit: number, spawnNew: boolean) {
		try {
			const response = await fetch(`/api/board?limit=${limit}`);
			if (!response.ok) throw new Error(`board ${response.status}`);
			const data = (await response.json()) as { messages: BoardMessage[] };
			// Newest first from the API; oldest of the batch sits highest.
			const incoming = data.messages
				.slice()
				.reverse()
				.filter((m) => !seen.has(m.id));
			for (const msg of incoming) {
				seen.add(msg.id);
				createElement(msg, spawnNew);
			}
			trimTo(Number(sliderEl.value));
			if (reduced) relayoutStatic();
		} catch {
			announce('Could not reach the message board.');
		}
	}

	function trimTo(count: number) {
		while (bodies.length > count) {
			const body = bodies.shift();
			if (body) {
				body.el.remove();
				seen.delete(body.msg.id);
			}
		}
	}

	/* --- composer ---------------------------------------------------------------- */

	const textInput = composerEl.querySelector<HTMLTextAreaElement>('[data-board-text]');
	const fileInput = composerEl.querySelector<HTMLInputElement>('[data-board-file]');
	const preview = composerEl.querySelector<HTMLImageElement>('[data-board-preview]');
	const submit = composerEl.querySelector<HTMLButtonElement>('[data-board-submit]');
	let pendingImage: string | undefined;

	fileInput?.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		pendingImage = undefined;
		if (!file) {
			if (preview) preview.hidden = true;
			return;
		}
		if (!BOARD_CONFIG.allowedImageTypes.includes(file.type)) {
			announce('Images must be PNG, JPEG, WebP or GIF.');
			fileInput.value = '';
			return;
		}
		if (file.size > BOARD_CONFIG.maxImageBytes) {
			announce('Image too large — 400 KB max.');
			fileInput.value = '';
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			pendingImage = String(reader.result);
			if (preview) {
				preview.src = pendingImage;
				preview.hidden = false;
			}
		};
		reader.readAsDataURL(file);
	});

	composerEl.addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!textInput) return;
		const text = textInput.value.trim();
		if (text.length === 0 || text.length > BOARD_CONFIG.maxTextLength) {
			announce(`Message must be 1-${BOARD_CONFIG.maxTextLength} characters.`);
			return;
		}
		if (submit) submit.disabled = true;
		announce('Sending…');
		try {
			const response = await fetch('/api/board', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, ...(pendingImage ? { image: pendingImage } : {}) }),
			});
			const data = (await response.json()) as {
				message?: BoardMessage;
				error?: string;
				retryAfter?: number;
			};
			if (response.status === 429) {
				announce(`Too soon — try again in ${data.retryAfter ?? 20}s.`);
			} else if (!response.ok || !data.message) {
				announce('The board rejected that message.');
			} else {
				seen.add(data.message.id);
				createElement(data.message, true);
				trimTo(Number(sliderEl.value));
				textInput.value = '';
				if (fileInput) fileInput.value = '';
				pendingImage = undefined;
				if (preview) preview.hidden = true;
				announce('Message posted.');
				startLoop();
			}
		} catch {
			announce('Network error — message not sent.');
		} finally {
			if (submit) submit.disabled = false;
		}
	});

	/* --- slider & archive ---------------------------------------------------------- */

	sliderEl.addEventListener('input', () => {
		sliderValueEl.textContent = sliderEl.value;
		const target = Number(sliderEl.value);
		if (bodies.length > target) trimTo(target);
		else void load(target, false);
	});

	const dialog = root.querySelector<HTMLElement>('[data-board-archive]');
	const archiveList = root.querySelector<HTMLOListElement>('[data-board-archive-list]');
	const archiveClose = root.querySelector<HTMLButtonElement>('[data-board-archive-close]');

	archiveButtonEl.addEventListener('click', async () => {
		if (!dialog || !archiveList) return;
		dialog.hidden = false;
		archiveList.textContent = '';
		const row = document.createElement('li');
		row.className = 'board-archive__row';
		row.textContent = 'Loading every message…';
		archiveList.appendChild(row);
		try {
			const response = await fetch('/api/board?all=1');
			const data = (await response.json()) as { messages: BoardMessage[] };
			archiveList.textContent = '';
			for (const msg of data.messages) {
				const li = document.createElement('li');
				li.className = 'board-archive__row';
				const time = document.createElement('time');
				time.dateTime = new Date(msg.createdAt).toISOString();
				time.textContent = new Date(msg.createdAt).toLocaleString();
				const p = document.createElement('p');
				p.textContent = msg.text;
				li.appendChild(time);
				li.appendChild(p);
				if (msg.image) {
					const img = document.createElement('img');
					img.src = msg.image;
					img.alt = 'Image attached to a visitor message';
					img.className = 'board-archive__img';
					li.appendChild(img);
				}
				archiveList.appendChild(li);
			}
			archiveClose?.focus();
		} catch {
			archiveList.textContent = '';
			const li = document.createElement('li');
			li.textContent = 'Could not load the archive.';
			archiveList.appendChild(li);
		}
	});

	const closeArchive = () => {
		if (!dialog) return;
		dialog.hidden = true;
		archiveButtonEl.focus();
	};
	archiveClose?.addEventListener('click', closeArchive);
	dialog?.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') closeArchive();
	});

	/* --- polling --------------------------------------------------------------------- */

	if (BOARD_CONFIG.pollIntervalMs > 0) {
		setInterval(() => {
			if (isPageVisible() && dialog?.hidden !== false) void load(Number(sliderEl.value), true);
		}, BOARD_CONFIG.pollIntervalMs);
	}

	window.addEventListener('resize', () => {
		if (reduced) relayoutStatic();
	});

	/* --- go ------------------------------------------------------------------------- */

	sliderValueEl.textContent = sliderEl.value;
	void load(Number(sliderEl.value), false);
	root.classList.add('board--ready');
	if (!reduced) startLoop();
	else root.classList.add('board--static');
}
