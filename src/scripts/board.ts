/**
 * BNJI.NET — public message board runtime.
 *
 * Owns everything between the API boundary (/api/board) and the DOM:
 *
 *   - loads the 10 most recent messages (capped initial page) and renders
 *     each as a theme-appropriate floating element (aero bubble in light,
 *     star orb in dark — pure CSS against html[data-theme]);
 *   - runs the physics loop (src/scripts/board-physics.ts): elements float
 *     upward, collide, and settle into a stack under the nav;
 *   - sizes every element to FIT its own content: a hidden probe (same CSS
 *     classes as the real thing) measures the wrapped text — plus the image
 *     block when present — and the bubble/star gets exactly that box. The old
 *     fixed-diameter heuristic (96 + length * 1.15, clamped) lives on only as
 *     the clamp range around the measurement;
 *   - drag: pointer capture makes any element kinematic while held — and it
 *     keeps pushing its neighbours, because collisions treat kinematic bodies
 *     as infinite mass; keyboard users get arrow-key nudging on focus;
 *   - submit: POSTs through the API and spawns the accepted message directly
 *     above the composer, where buoyancy takes it upward like the rest.
 *     Enter sends (Shift+Enter inserts a newline, IME composition is
 *     respected); a live n/250 counter flips to an over-limit state and
 *     disables Send past BOARD_CONFIG.maxTextLength — the client half of the
 *     server's 422;
 *   - list view: a toggle in the control strip opens a plain, non-physics
 *     <ol> of the SAME messages already in memory (newest first, inert
 *     textContent rendering). It never fetches — syncListView() renders from
 *     `bodies`, which the existing cursor/pagination loaders fill;
 *   - slider adjusts the visible count: raising it walks OLDER pages through
 *     the API's keyset cursor (bounded fetches, never full history in one
 *     request); lowering it trims; the archive button opens a dialog that
 *     walks the same cursor to exhaustion;
 *   - polls the newest page for new messages with conditional requests
 *     (If-None-Match / 304), and the poll timer itself is stopped while
 *     document.hidden and restarted on visibilitychange — no background
 *     requests at all;
 *   - mobile keyboard: the visual viewport is measured and published as
 *     --kb-inset so the composer rides above the keyboard and the floating
 *     field never extends behind it (mounting only — the physics engine in
 *     board-physics.ts is untouched);
 *   - reduced motion: no loop, no buoyancy — a calm static grid, drag still
 *     works; the site stays fully usable.
 *
 * Safety: server-validated content is rendered with textContent only; images
 * are data: URLs the server re-validated; nothing here trusts the payload.
 */
import { BOARD_CONFIG } from '../config/board.config';
import { clamp, isPageVisible, prefersReducedMotion } from './environment';
import { stepBodies, staticLayout, type PhysicsBody, type PhysicsBounds } from './board-physics';

type BoardMessage = {
	id: string;
	text: string;
	image?: string;
	hue: number;
	createdAt: number;
};

type Body = PhysicsBody & { el: HTMLElement; msg: BoardMessage; w: number; h: number };

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

	/* Visible viewport: when a virtual keyboard is open the layout viewport
	   can stay full-size (iOS) while the visual one shrinks. Sizing the field
	   to the visual viewport keeps bubbles out from behind the keyboard.
	   This is mounting/viewport adaptation only — the simulation itself
	   (stepBodies, collisions, buoyancy, drag) is untouched. */
	const visibleViewport = () => {
		const vv = typeof window !== 'undefined' ? window.visualViewport : null;
		return {
			width: vv ? Math.round(vv.width) : window.innerWidth,
			height: vv ? Math.round(vv.height) : window.innerHeight,
		};
	};

	const bounds = (): PhysicsBounds => {
		const vp = visibleViewport();
		return { width: vp.width, height: vp.height, ceiling: 76, floor: vp.height - 150 };
	};

	/* Publish the keyboard overlap for CSS (--kb-inset): how much of the
	   layout viewport the visual viewport no longer shows at the bottom.
	   Threshold at 80px ensures normal browser address bar collapsing or
	   desktop resize jitter does not falsely lift the composer. */
	const updateKeyboardInset = () => {
		const vv = window.visualViewport;
		if (!vv) return;
		const diff = window.innerHeight - vv.height - vv.offsetTop;
		const hidden = diff > 80 ? Math.round(diff) : 0;
		root.style.setProperty('--kb-inset', `${hidden}px`);
	};

	const announce = (text: string) => {
		statusEl.textContent = text;
	};

	/* --- rendering ---------------------------------------------------------- */

	/* Content-aware sizing. A hidden probe wearing the exact same classes as a
	   real message measures how big the content actually is: the grab at
	   max-content gives the text's natural single-line width (clamped to the
	   old heuristic's spirit: 96-260px), then re-measuring at that width gives
	   the wrapped height including padding and the fixed-size image block.
	   Because the probe lives in the field, theme CSS (bubble padding vs star
	   padding) is measured as rendered. */
	const MIN_W = 96;
	const MAX_W = 260;
	const MIN_H = 72;

	const probe = document.createElement('li');
	probe.className = 'board-msg';
	probe.setAttribute('aria-hidden', 'true');
	probe.style.visibility = 'hidden';
	probe.style.pointerEvents = 'none';
	const probeGrab = document.createElement('div');
	probeGrab.className = 'board-msg__grab';
	const probeImg = document.createElement('span'); // sized by CSS, not by load
	probeImg.className = 'board-msg__img';
	const probeSpan = document.createElement('span');
	probeSpan.className = 'board-msg__text';
	probeGrab.appendChild(probeImg);
probeGrab.appendChild(probeSpan);
	probe.appendChild(probeGrab);
	fieldEl.appendChild(probe);

	const sizeFor = (msg: BoardMessage): { w: number; h: number } => {
		probeSpan.textContent = msg.text;
		probeImg.style.display = msg.image ? '' : 'none';
		probeGrab.style.width = 'max-content';
		const natural = probeGrab.offsetWidth;
		const w = Math.round(clamp(natural, MIN_W, MAX_W));
		probeGrab.style.width = `${w}px`;
		const h = Math.max(MIN_H, probeGrab.offsetHeight);
		return { w, h };
	};

	function createElement(msg: BoardMessage, spawnAtComposer: boolean): Body {
		const li = document.createElement('li');
		li.className = 'board-msg';
		li.style.setProperty('--hue', String(msg.hue));
		const { w: width, h: height } = sizeFor(msg);
		li.style.width = `${width}px`;
		li.style.height = `${height}px`;

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
			w: width,
			h: height,
			// Collision radius stays one number (the physics engine is
			// untouched): the bounding circle of the content-sized box.
			r: Math.max(width, height) / 2,
			x: spawnAtComposer
				? b.width / 2 + (Math.random() - 0.5) * 90
				: b.width / 2 + (Math.random() - 0.5) * 160,
			y: spawnAtComposer ? b.floor - height / 2 - 8 : b.ceiling + height / 2 + 20 + Math.random() * 60,
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
		// Center the (no longer square) element on its physics position.
		body.el.style.transform = `translate3d(${(body.x - body.w / 2).toFixed(1)}px, ${(
			body.y - body.h / 2
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

	document.addEventListener('visibilitychange', () => {
		if (isPageVisible()) {
			startLoop();
			startPolling();
			// Catch up on anything posted while the tab was hidden.
			pollNow();
		} else {
			stopLoop();
			stopPolling();
		}
	});

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

	/* Fetch state:
	   - walkCursor: keyset cursor to the page OLDER than everything loaded so
	     far. Set by the initial load, advanced by slider/archive walks.
	   - etags: last ETag per URL, replayed as If-None-Match; a 304 means the
	     newest page is unchanged and polling costs one tiny round-trip. */
	const seen = new Set<string>();
	let walkCursor: string | null = null;
	const etags = new Map<string, string>();

	async function conditionalFetch(url: string): Promise<Response> {
		const headers: Record<string, string> = {};
		const etag = etags.get(url);
		if (etag) headers['if-none-match'] = etag;
		const response = await fetch(url, { headers });
		const fresh = response.headers.get('etag');
		if (fresh) etags.set(url, fresh);
		return response;
	}

	const latestUrl = `/api/board?limit=${BOARD_CONFIG.defaultVisible}`;

	/** Fetch the newest page (capped at defaultVisible). 304 = nothing new. */
	async function loadLatest(spawnNew: boolean, initial = false): Promise<void> {
		try {
			const response = await conditionalFetch(latestUrl);
			if (response.status === 304) return;
			if (!response.ok) throw new Error(`board ${response.status}`);
			const data = (await response.json()) as {
				messages: BoardMessage[];
				nextCursor: string | null;
			};
			if (initial) walkCursor = data.nextCursor;
			// Newest first from the API; oldest of the batch sits highest.
			const incoming = data.messages.slice().reverse().filter((m) => !seen.has(m.id));
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

	let loadingOlder = false;
	let pendingTarget = 0;

	/**
	 * Walk OLDER pages via the cursor until `target` messages are displayed
	 * or history is exhausted. Every request is a bounded page (never the
	 * full archive); the loop guard caps absurd walks.
	 */
	async function loadOlder(target: number): Promise<void> {
		if (loadingOlder) {
			pendingTarget = Math.max(pendingTarget, target);
			return;
		}
		loadingOlder = true;
		try {
			let guard = 0;
			while (bodies.length < target && walkCursor && guard < 20) {
				guard += 1;
				const need = target - bodies.length;
				const limit = Math.min(need, BOARD_CONFIG.pageSize);
				const url = `/api/board?limit=${limit}&cursor=${encodeURIComponent(walkCursor)}`;
				const response = await fetch(url);
				if (!response.ok) throw new Error(`board ${response.status}`);
				const data = (await response.json()) as {
					messages: BoardMessage[];
					nextCursor: string | null;
				};
				walkCursor = data.nextCursor;
				if (data.messages.length === 0) break;
				const incoming = data.messages.slice().reverse().filter((m) => !seen.has(m.id));
				for (const msg of incoming) {
					seen.add(msg.id);
					createElement(msg, false);
				}
				// Keep the bodies invariant "front = oldest": the just-created
				// older messages move from the tail to the head, in order.
				if (incoming.length > 0) {
					const created = bodies.splice(bodies.length - incoming.length, incoming.length);
					bodies.unshift(...created);
				}
			}
			trimTo(target);
			if (reduced) relayoutStatic();
		} catch {
			announce('Could not load older messages.');
		} finally {
			loadingOlder = false;
			const queued = pendingTarget;
			pendingTarget = 0;
			if (queued > bodies.length) void loadOlder(queued);
		}
	}

	function trimTo(count: number) {
		let trimmed = false;
		while (bodies.length > count) {
			const body = bodies.shift();
			if (body) {
				body.el.remove();
				seen.delete(body.msg.id);
				trimmed = true;
			}
		}
		if (trimmed && bodies.length > 0) {
			// Re-anchor the walk cursor to the oldest message STILL shown, so
			// raising the slider afterwards re-fetches exactly what was just
			// trimmed (the server's cursor seeks strictly older than its
			// anchor). Format mirrors encodeCursor in src/server/board-store.ts
			// — the documented contract: base64 JSON [createdAt, id].
			const oldest = bodies[0];
			walkCursor = btoa(JSON.stringify([oldest.msg.createdAt, oldest.msg.id]));
		}
		// Every batch load ends in trimTo, so this is the single sync point
		// that keeps the list view equal to the sky. No-op while closed.
		syncListView();
	}

	/* --- composer ---------------------------------------------------------------- */

	const textInput = composerEl.querySelector<HTMLTextAreaElement>('[data-board-text]');
	const fileInput = composerEl.querySelector<HTMLInputElement>('[data-board-file]');
	const preview = composerEl.querySelector<HTMLImageElement>('[data-board-preview]');
	const submit = composerEl.querySelector<HTMLButtonElement>('[data-board-submit]');
	const counter = composerEl.querySelector<HTMLElement>('[data-board-counter]');
	let pendingImage: string | undefined;

	/* Client half of the 250-char contract: the counter shows n/max, flips to
	   an over-limit state, and disables Send past the cap. The server still
	   answers 422 for anything that gets through — this is feedback, not the
	   enforcement. (The textarea deliberately has NO maxlength: the over-limit
	   state must be reachable so the visitor sees WHY send is disabled.) */
	const updateCounter = () => {
		if (!textInput) return;
		const len = textInput.value.length;
		if (counter) {
			counter.textContent = `${len}/${BOARD_CONFIG.maxTextLength}`;
			counter.classList.toggle('is-over', len > BOARD_CONFIG.maxTextLength);
		}
		if (submit) submit.disabled = len > BOARD_CONFIG.maxTextLength;
	};
	textInput?.addEventListener('input', updateCounter);

	/* Enter sends; Shift+Enter inserts a newline. isComposing guards IME
	   candidates, where Enter confirms text rather than the form. */
	textInput?.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		composerEl.requestSubmit();
	});
	updateCounter();

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
				updateCounter();
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
		// Raising the count walks older CURSOR pages — never an unbounded
		// full-history fetch.
		else if (bodies.length < target) void loadOlder(target);
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
			// First archive page, then walk the cursor until history is
			// exhausted (guard caps the loop; pages are bounded by the API).
			const messages: BoardMessage[] = [];
			let cursor: string | null = null;
			let guard = 0;
			do {
				const url = cursor
					? `/api/board?all=1&cursor=${encodeURIComponent(cursor)}`
					: '/api/board?all=1';
				const response = await fetch(url);
				if (!response.ok) throw new Error(`board ${response.status}`);
				const data = (await response.json()) as {
					messages: BoardMessage[];
					nextCursor: string | null;
				};
				messages.push(...data.messages);
				cursor = data.nextCursor;
			} while (cursor && ++guard < 50);
			archiveList.textContent = '';
			for (const msg of messages) {
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

	/* --- list view (plain, accessible, non-physics) --------------------------- */

	/* The sky is the spectacle; this is the readable fallback: the SAME
	   messages, newest first, as a static <ol> — no drag, no motion, fully
	   reachable by keyboard and screen reader. It performs no fetching of its
	   own: syncListView() renders from `bodies`, which the existing loaders
	   (initial capped load, cursor walks, polls, submits) already maintain,
	   and trimTo() — the single point every batch ends at — keeps it current. */
	const viewToggle = root.querySelector<HTMLButtonElement>('[data-board-view-toggle]');
	const listView = root.querySelector<HTMLElement>('[data-board-listview]');
	const listItems = root.querySelector<HTMLOListElement>('[data-board-list-items]');

	const listViewOpen = () => listView !== null && listView.hidden === false;

	function syncListView() {
		if (!listItems || !listViewOpen()) return;
		listItems.textContent = '';
		if (bodies.length === 0) {
			const empty = document.createElement('li');
			empty.className = 'board-listview__item';
			empty.textContent = 'No messages yet — the sky is empty.';
			listItems.appendChild(empty);
			return;
		}
		// bodies is oldest-first (the trim invariant); the list reads newest-first.
		for (let i = bodies.length - 1; i >= 0; i--) {
			const msg = bodies[i].msg;
			const li = document.createElement('li');
			li.className = 'board-listview__item';
			const time = document.createElement('time');
			time.dateTime = new Date(msg.createdAt).toISOString();
			time.textContent = new Date(msg.createdAt).toLocaleString();
			const p = document.createElement('p');
			p.textContent = msg.text; // same inert-rendering rule as the sky
			li.appendChild(time);
			li.appendChild(p);
			if (msg.image) {
				const img = document.createElement('img');
				img.src = msg.image; // server-validated data: URL only
				img.alt = 'Image attached to a visitor message';
				img.className = 'board-listview__img';
				img.loading = 'lazy';
				li.appendChild(img);
			}
			listItems.appendChild(li);
		}
	}

	viewToggle?.addEventListener('click', () => {
		if (!listView) return;
		const opening = listView.hidden;
		listView.hidden = !opening;
		viewToggle.setAttribute('aria-pressed', String(opening));
		viewToggle.textContent = opening ? 'Sky view' : 'List view';
		root.classList.toggle('board--listview', opening);
		if (opening) {
			syncListView();
			listView.focus();
			announce('List view opened — the same messages, newest first.');
		} else {
			announce('Sky view restored.');
			viewToggle.focus();
		}
	});

	/* --- polling --------------------------------------------------------------------- */

	/* The poll timer only EXISTS while the tab is visible: visibilitychange
	   (handler registered above with the physics loop) stops it entirely when
	   document.hidden and restarts it — with an immediate catch-up fetch —
	   when the tab returns. Each poll is a conditional request: the server
	   answers 304 when the newest page is unchanged, so a quiet board costs
	   one header-sized round-trip instead of a full JSON payload. */
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	const pollNow = () => {
		// Skip while the archive dialog is open: it renders its own snapshot
		// and spawns from polling would reshuffle the field behind it.
		if (!isPageVisible() || dialog?.hidden === false) return;
		void loadLatest(true);
	};
	const startPolling = () => {
		if (BOARD_CONFIG.pollIntervalMs <= 0 || pollTimer !== undefined) return;
		pollTimer = setInterval(pollNow, BOARD_CONFIG.pollIntervalMs);
	};
	const stopPolling = () => {
		if (pollTimer !== undefined) clearInterval(pollTimer);
		pollTimer = undefined;
	};

	window.addEventListener('resize', () => {
		updateKeyboardInset();
		if (reduced) relayoutStatic();
	});

	/* --- go ------------------------------------------------------------------------- */

	/* Visual-viewport tracking: publish the keyboard overlap as --kb-inset
	   (composer + field CSS consume it) and keep the physics floor honest.
	   'scroll' fires when iOS pans the visual viewport inside the layout one. */
	if (window.visualViewport) {
		window.visualViewport.addEventListener('resize', updateKeyboardInset);
		window.visualViewport.addEventListener('scroll', updateKeyboardInset);
	}
	updateKeyboardInset();

	sliderValueEl.textContent = sliderEl.value;
	// Initial load is capped at the newest defaultVisible (10) messages;
	// anything beyond that only arrives through cursor walks.
	void loadLatest(false, true);
	root.classList.add('board--ready');
	if (!reduced) startLoop();
	else root.classList.add('board--static');
	startPolling();
}
