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
 *   - THE FULL LIST: the board's single non-physics view. One toggle opens a
 *     scrim + sheet containing every message ever sent, newest first, walked
 *     through the API's keyset cursor to exhaustion. This is also the ONLY
 *     place message-level actions exist, and it renders them only when the
 *     server said this visitor is an admin;
 *   - slider adjusts the visible count: raising it walks OLDER pages through
 *     the API's keyset cursor (bounded fetches, never full history in one
 *     request); lowering it trims;
 *   - polls the newest page for new messages with conditional requests
 *     (If-None-Match / 304), and the poll timer itself is stopped while
 *     document.hidden and restarted on visibilitychange — no background
 *     requests at all;
 *   - abuse telemetry: the FIRST load carries ?track=1, which is the one
 *     request the server turns into a security event (and the one that
 *     establishes the session cookie). Polls never carry it — logging every
 *     read would write ~180 rows per visitor-hour and bury the posts that
 *     actually matter. A device-details beacon follows the initial load, and
 *     another follows every accepted post;
 *   - moderation: for an admin only, each row in the full list carries a
 *     Delete control that calls POST /api/admin/board. The endpoint is the
 *     real enforcement — it rejects any caller without the admin session —
 *     and this client simply does not build the control for anyone else, so
 *     a visitor's payload contains no trace of the capability;
 *   - mobile keyboard: the visual viewport is measured and published as
 *     --kb-inset so the composer rides above the keyboard and the floating
 *     field never extends behind it (mounting only — the physics engine in
 *     board-physics.ts is untouched);
 *   - reduced motion: no loop, no buoyancy — a calm static grid, drag still
 *     works; the site stays fully usable.
 *
 * Safety: server-validated content is rendered with textContent only; images
 * are data: URLs the server re-validated; nothing here trusts the payload.
 *
 * ---------------------------------------------------------------------------
 * LIFECYCLE
 * ---------------------------------------------------------------------------
 * This module holds the site's only two genuinely long-lived resources, and it
 * is worth being explicit about who owns them and when they run.
 *
 * Mount. initMessageBoard() is called once from boot.ts. A module-level
 * `started` flag makes a second call a no-op, and a missing [data-board]
 * element returns immediately, so the module is inert on every other page.
 * Nothing here is mounted lazily or re-mounted on navigation.
 *
 * Resource 1 — the physics loop. One requestAnimationFrame chain, owned by
 * `frame`. startLoop() refuses to start a second chain (`if (frame) return`),
 * so the loop cannot be doubled by a stray call. Inside the callback, the
 * first thing it does is re-arm itself, then bail on !isPageVisible(): the
 * chain stays alive but does no work, which keeps the function pointer stable
 * across a tab switch without leaving a busy loop burning frames in the
 * background.
 *
 * Resource 2 — the poll timer. One setInterval, owned by `pollTimer`, with
 * startPolling()/stopPolling() as the only mutators. pollNow() additionally
 * skips while the full list is open, so the sheet's snapshot is never
 * reshuffled out from under a reader.
 *
 * The gate. Both resources are governed by ONE document-level
 * 'visibilitychange' listener, registered once near the top of this module:
 * visible -> startLoop(), startPolling(), and an immediate catch-up pollNow()
 * so anything posted while the tab was hidden appears on return; hidden ->
 * stopLoop(), stopPolling(). This is the only place either resource is
 * stopped, which is why the board makes no requests and runs no physics while
 * backgrounded.
 *
 * The reduced-motion path is a different shape, not a slower one: `reduced` is
 * read once at mount, and when it is true the loop is never started at all.
 * Bodies are laid out once by staticLayout() and repainted on drag, pointer
 * release and resize instead of per frame. The .board--static class marks it.
 *
 * Teardown: there is none, and that is deliberate for now. The board lives for
 * the document, and every listener it registers is bound to an element that
 * the document already owns. Note the asymmetry with interactions.ts, which
 * does register disposers — that module was written with teardown in mind
 * because it is the one most likely to be re-initialised. If the site ever
 * gains client-side navigation, this module needs the same treatment: drop
 * `started`, and add teardown for the loop, the poll timer, the
 * visibilitychange listener, and the visualViewport resize/scroll pair.
 * ---------------------------------------------------------------------------
 */
import { BOARD_CONFIG } from '../config/board.config';
import { clamp, isPageVisible, prefersReducedMotion } from './environment';
import { reportDeviceData, sendSecurityEnrichment } from './device-fingerprint';
import { stepBodies, staticLayout, type PhysicsBody, type PhysicsBounds } from './board-physics';

type BoardMessage = {
	id: string;
	text: string;
	image?: string;
	hue: number;
	createdAt: number;
};

type Body = PhysicsBody & { el: HTMLElement; msg: BoardMessage; w: number; h: number; lastTransform?: string };

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
	const status = root.querySelector<HTMLElement>('[data-board-status]');
	if (!field || !composer || !slider || !sliderValue || !status) return;
	// Re-bind through the guard: hoisted/closure functions below capture these
	// names, and control-flow narrowing does not reach into function bodies.
	const rootEl: HTMLElement = root;
	const fieldEl: HTMLUListElement = field;
	const composerEl: HTMLFormElement = composer;
	const sliderEl: HTMLInputElement = slider;
	const sliderValueEl: HTMLElement = sliderValue;
	const statusEl: HTMLElement = status;

	const bodies: Body[] = [];
	const reduced = prefersReducedMotion();
	let frame = 0;
	let lastTime = 0;
	let isBoardVisible = true;
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

	let cachedBounds: PhysicsBounds | null = null;
	const invalidateBounds = () => {
		cachedBounds = null;
	};

	const bounds = (): PhysicsBounds => {
		if (!cachedBounds) {
			const vp = visibleViewport();
			const mobile = vp.width < 900;
			// On desktop the nav pill is a real obstacle in the visual layer: leave
			// the full top field available so bubbles can rise beside it and rebound
			// at the viewport edge. Mobile keeps the safe header clearance because
			// its expanded navigation occupies the whole top band.
			cachedBounds = { width: vp.width, height: vp.height, ceiling: mobile ? 76 : 8, floor: vp.height - 150 };
		}
		return cachedBounds;
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

	/* Publish how much of the viewport the board's own chrome occupies at the
	   bottom (--board-chrome), so the full list can stop above it.

	   The number is MEASURED, not assumed, because the composer is not a fixed
	   height: the textarea grows with what is typed, the control strip is
	   absolutely positioned ABOVE the composer rather than inside it, and on
	   narrow screens that strip wraps to two rows. A hardcoded clearance would
	   be correct for exactly one of those states and wrong for the rest.

	   Measuring the control strip — the topmost piece of the stack — gives the
	   true top edge of everything the reader must not lose behind a panel.
	   Re-measured on the same events that move it: resize, keyboard, and the
	   composer growing as text is entered. */
	const updateChromeInset = () => {
		const strip = composerEl.querySelector<HTMLElement>('.board__composer-row--meta');
		// The strip is the topmost element of the composer's stack; when it is
		// not laid out yet (first paint, or display:none), fall back to the
		// composer box itself.
		const top = (strip ?? composerEl).getBoundingClientRect().top;
		if (!Number.isFinite(top) || top <= 0) return;
		root.style.setProperty('--board-chrome', `${Math.ceil(window.innerHeight - top)}px`);
	};

	/** Human-readable byte count, so a size refusal states a real number. */
	const formatBytes = (bytes: number): string =>
		bytes >= 1024 * 1024
			? `${Math.round(bytes / (1024 * 1024))} MB`
			: `${Math.round(bytes / 1024)} KB`;

	const announce = (text: string) => {
		statusEl.textContent = text;
	};

	/* --- moderation (admin only) -------------------------------------------- */

	/* The server resolved this while rendering the page. It is the ONLY source
	   of truth for whether controls exist — not a cookie read here, not a
	   guess.

	   The delete code itself is NOT in this file: it is a dynamic import
	   (scripts/board-moderate.ts) that a non-admin never triggers, so it is
	   never downloaded into their cache and never appears in a network tab.
	   A plain `if (isAdmin)` would have left the code sitting in every
	   visitor's bundle — inert, but shipped, and readable. See the module's
	   own header for the full reasoning.

	   The endpoint behind the control enforces independently: it rejects any
	   caller without the admin session, so even a hand-built request from a
	   non-admin (or a page left open across a logout) is refused. The flag
	   decides who is SHOWN the control; that check decides who is ALLOWED it. */
	const isAdmin = rootEl.dataset.boardAdmin === 'true';
	type AttachDelete = typeof import('./board-moderate')['default'];
	let attachDelete: AttachDelete | null = null;

	const loadModeration = async (): Promise<AttachDelete | null> => {
		if (!isAdmin) return null;
		if (!attachDelete) attachDelete = (await import('./board-moderate')).default;
		return attachDelete;
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

	const sizeCache = new Map<string, { w: number; h: number }>();

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
		const cached = sizeCache.get(msg.id);
		if (cached) return cached;
		probeSpan.textContent = msg.text;
		probeImg.style.display = msg.image ? '' : 'none';
		probeGrab.style.width = 'max-content';
		const natural = probeGrab.offsetWidth;
		const w = Math.round(clamp(natural, MIN_W, MAX_W));
		probeGrab.style.width = `${w}px`;
		const h = Math.max(MIN_H, probeGrab.offsetHeight);
		const size = { w, h };
		sizeCache.set(msg.id, size);
		return size;
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

		// A bubble is VISUAL ONLY: the drag handle is the entire interactive
		// surface. There is deliberately no control inside one — message
		// actions live in the full list, where they are reachable, listed and
		// (for admins) gated. Adding a button here would also mean competing
		// with pointerdown for the same gesture the drag already owns.
		li.appendChild(grab);
		fieldEl.appendChild(li);

		const b = bounds();
		const body: Body = {
			id: msg.id,
			el: li,
			msg,
			w: width,
			h: height,
			// Per-axis extents: the physics engine models the body as the
			// pill the bubble actually is (see pillRadius in
			// board-physics.ts), so the hitbox is exactly w x h — the old
			// bounding circle made wide bubbles repel vertically at their
			// width, leaving visible gaps between stacked bubbles.
			rx: width / 2,
			ry: height / 2,
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
		const transform = `translate3d(${(body.x - body.w / 2).toFixed(1)}px, ${(
			body.y - body.h / 2
		).toFixed(1)}px, 0)`;
		if (body.lastTransform !== transform) {
			body.lastTransform = transform;
			body.el.style.transform = transform;
		}
	};

	/* --- loop ---------------------------------------------------------------- */

	function loop(now: number) {
		frame = requestAnimationFrame(loop);
		if (!isPageVisible() || !isBoardVisible) return;
		const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 0.016;
		lastTime = now;
		stepBodies(bodies, dt, bounds());
		for (const body of bodies) paint(body);
	}

	const startLoop = () => {
		if (reduced || frame || !isBoardVisible) return;
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
		if (isPageVisible() && isBoardVisible) {
			startLoop();
			startPolling();
			// Catch up on anything posted while the tab was hidden.
			pollNow();
		} else {
			stopLoop();
			stopPolling();
		}
	});

	if (typeof IntersectionObserver !== 'undefined') {
		const boardObserver = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				isBoardVisible = entry.isIntersecting;
				if (isBoardVisible && isPageVisible()) {
					startLoop();
					startPolling();
					pollNow();
				} else {
					stopLoop();
					stopPolling();
				}
			}
		});
		boardObserver.observe(rootEl);
	}

	/* --- drag & keyboard move ------------------------------------------------- */

	function bindDrag(body: Body, grab: HTMLElement) {
		grab.addEventListener('pointerdown', (event) => {
			if (event.button !== 0 && event.pointerType === 'mouse') return;
			dragging = body;
			body.kinematic = true;
			grab.setPointerCapture(event.pointerId);
			grab.classList.add('board-msg__grab--held');

			// Track pointer history over the last ~100ms so release velocity is preserved accurately
			type PointerSample = { x: number; y: number; time: number };
			const history: PointerSample[] = [{ x: event.clientX, y: event.clientY, time: performance.now() }];

			const move = (e: PointerEvent) => {
				if (dragging !== body) return;
				const now = performance.now();
				body.x = e.clientX;
				body.y = e.clientY;

				history.push({ x: e.clientX, y: e.clientY, time: now });
				while (history.length > 2 && now - history[0].time > 120) {
					history.shift();
				}

				if (reduced) paint(body);
			};

			const up = () => {
				grab.removeEventListener('pointermove', move);
				grab.removeEventListener('pointerup', up);
				grab.removeEventListener('pointercancel', up);
				grab.classList.remove('board-msg__grab--held');
				body.kinematic = reduced;
				dragging = null;

				// Calculate true release velocity from the sample window
				const now = performance.now();
				const recent = history.filter((s) => now - s.time <= 100);
				if (recent.length >= 2) {
					const first = recent[0];
					const last = recent[recent.length - 1];
					const dt = Math.max(0.015, (last.time - first.time) / 1000);
					const vx = (last.x - first.x) / dt;
					const vy = (last.y - first.y) / dt;
					// Clamp to prevent runaway speeds while preserving momentum
					const MAX_VEL = 1500;
					body.vx = Math.max(-MAX_VEL, Math.min(MAX_VEL, vx));
					body.vy = Math.max(-MAX_VEL, Math.min(MAX_VEL, vy));
				}
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

	// The tracked URL is used ONLY for the first load of a visit. Every
	// later fetch (polls, slider walks) uses the plain URL, so a long-lived
	// tab does not become a firehose of read events.
	const latestUrl = `/api/board?limit=${BOARD_CONFIG.defaultVisible}`;
	const trackedUrl = `${latestUrl}&track=1`;

	/** Fetch the newest page (capped at defaultVisible). 304 = nothing new. */
	async function loadLatest(spawnNew: boolean, initial = false): Promise<void> {
		try {
			const response = await conditionalFetch(initial ? trackedUrl : latestUrl);
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
			// The tracked load logged a board-view security event and set the
			// session cookie; report the device details a beat later. Delayed
			// because on a first visit the cookie is still being set by the
			// response that created it.
			if (initial) sendSecurityEnrichment({ surface: 'board', endpoint: 'board-view' });
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
		// The textarea grows with the message, taking the composer — and the
		// strip above it — upward. The full list's clearance is measured from
		// that top edge, so it has to be re-read as the composer grows.
		updateChromeInset();
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
			// Checked before the read, so an oversized file never becomes a
			// 1.4MB+ base64 string in memory. The number shown is the one
			// the server enforces — see BOARD_CONFIG.maxImageBytes for why
			// the ceiling is storage-bound rather than 25MB.
			announce(
				`Image too large — ${formatBytes(BOARD_CONFIG.maxImageBytes)} max. ` +
					`That one is ${formatBytes(file.size)}.`,
			);
			fileInput.value = '';
			if (preview) preview.hidden = true;
			pendingImage = undefined;
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
				maxBytes?: number;
				maxLength?: number;
			};
			if (response.status === 429) {
				announce(`Too soon — try again in ${data.retryAfter ?? 20}s.`);
			} else if (data.error === 'image_too_large') {
				// The client check is the same number, so reaching this means
				// the two disagree — say what the server allows, not what the
				// browser thought.
				announce(
					`That image is too large for the board — ${formatBytes(data.maxBytes ?? BOARD_CONFIG.maxImageBytes)} max.`,
				);
				pendingImage = undefined;
				if (fileInput) fileInput.value = '';
				if (preview) preview.hidden = true;
			} else if (data.error === 'image_unsupported') {
				announce('That image could not be read — PNG, JPEG, WebP or GIF only.');
				pendingImage = undefined;
				if (fileInput) fileInput.value = '';
				if (preview) preview.hidden = true;
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
				// Same pairing as the page load: the POST logged a board-post
				// event, this supplies the device half of it.
				reportDeviceData({ surface: 'board', endpoint: 'board-post' });
			}
		} catch {
			announce('Network error — message not sent.');
		} finally {
			if (submit) submit.disabled = false;
		}
	});

	/* --- slider & the full list ------------------------------------------------- */

	sliderEl.addEventListener('input', () => {
		sliderValueEl.textContent = sliderEl.value;
		const target = Number(sliderEl.value);
		if (bodies.length > target) trimTo(target);
		// Raising the count walks older CURSOR pages — never an unbounded
		// full-history fetch.
		else if (bodies.length < target) void loadOlder(target);
	});

	/* THE FULL LIST — the board's only non-physics view, and the only place a
	   message-level action can appear. (The former "List view" panel is gone;
	   it rendered just the loaded window, so the two views could disagree.)

	   Modelled as scrim + sheet so it genuinely contains itself: the scrim
	   takes the whole viewport, so the sky behind can never read as part of
	   the panel, and the sheet is a flex column whose only scrolling part is
	   the message column. Escape, the scrim, and the close button all dismiss
	   it; focus moves in on open and returns to the toggle on close. */
	const listToggleEl = root.querySelector<HTMLButtonElement>('[data-board-view-toggle]');
	const list = root.querySelector<HTMLElement>('[data-board-list]');
	const listScrim = root.querySelector<HTMLElement>('[data-board-list-scrim]');
	const listSheet = root.querySelector<HTMLElement>('.board__list-sheet');
	const listItems = root.querySelector<HTMLOListElement>('[data-board-list-items]');
	const listCount = root.querySelector<HTMLElement>('[data-board-list-count]');
	const listClose = root.querySelector<HTMLButtonElement>('[data-board-list-close]');

	const listOpen = () => list !== null && list.hidden === false;

	/* One handler for every row's delete outcome — see createDeleteButton,
	   which owns the request and calls back here. */
	function onDeleteOutcome(
		outcome: { kind: 'deleted' | 'gone' | 'unauthorised' | 'failed' },
		id: string,
	): void {
		switch (outcome.kind) {
			case 'deleted':
			case 'gone': {
				// Drop it from the list, and from the sky if it was on screen.
				listItems?.querySelector(`[data-board-row-id="${CSS.escape(id)}"]`)?.remove();
				rootEl.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)?.remove();
				showListStatus(outcome.kind === 'gone' ? 'That message was already gone.' : 'Message deleted.');
				break;
			}
			case 'unauthorised':
				// The session went away under us. Retrying cannot help, so say
				// so rather than letting the admin retry into a wall.
				showListStatus('Not authorised — reload and sign in again.');
				break;
			case 'failed':
				showListStatus('Could not delete that message.');
				break;
		}
	}

	/* `mod` is null for every non-admin, which is what makes the control
	   unbuildable rather than merely unpressed. */
	function renderListRow(msg: BoardMessage, attach: AttachDelete | null): HTMLLIElement {
		const li = document.createElement('li');
		li.className = 'board-list__row';
		li.dataset.boardRowId = msg.id;

		const body = document.createElement('div');
		body.className = 'board-list__body';

		if (msg.image) {
			const img = document.createElement('img');
			img.src = msg.image; // server-validated data: URL only
			img.alt = 'Image attached to a visitor message';
			img.className = 'board-list__img';
			img.loading = 'lazy';
			body.appendChild(img);
		}

		const text = document.createElement('p');
		text.className = 'board-list__text';
		text.textContent = msg.text; // same inert-rendering rule as the sky
		body.appendChild(text);

		const time = document.createElement('time');
		time.className = 'board-list__time mono';
		time.dateTime = new Date(msg.createdAt).toISOString();
		time.textContent = new Date(msg.createdAt).toLocaleString();
		body.appendChild(time);

		li.appendChild(body);

		// Admin only, and absent entirely otherwise — see the moderation note
		// above. Built here rather than in the markup because the list is
		// rendered from data that does not exist until the fetch returns.
		if (attach) attach(li, msg.id, onDeleteOutcome);

		return li;
	}

	function showListStatus(text: string): void {
		if (listCount) listCount.textContent = text;
		announce(text);
	}

	async function loadFullList(): Promise<void> {
		if (!listItems) return;
		// Load the moderation chunk ONLY for an admin, and only when the list
		// is actually opened — a non-admin never issues this request.
		const attach = await loadModeration();
		listItems.textContent = '';
		const loading = document.createElement('li');
		loading.className = 'board-list__empty mono';
		loading.textContent = 'Loading every message…';
		listItems.appendChild(loading);
		if (listCount) listCount.textContent = 'Loading…';

		try {
			// First page, then walk the cursor until history is exhausted
			// (the guard caps the loop; pages are bounded by the API).
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

			listItems.textContent = '';
			const fragment = document.createDocumentFragment();
			// The API returns newest-first, which is the order we want to read.
			for (const msg of messages) fragment.appendChild(renderListRow(msg, attach));
			listItems.appendChild(fragment);

			if (messages.length === 0) {
				const empty = document.createElement('li');
				empty.className = 'board-list__empty mono';
				empty.textContent = 'No messages yet — the sky is empty.';
				listItems.appendChild(empty);
			}
			if (listCount) {
				listCount.textContent =
					messages.length === 1 ? '1 message, newest first' : `${messages.length} messages, newest first`;
			}
		} catch {
			listItems.textContent = '';
			const li = document.createElement('li');
			li.className = 'board-list__empty mono';
			li.textContent = 'Could not load the messages.';
			listItems.appendChild(li);
			if (listCount) listCount.textContent = 'Unavailable';
		}
	}

	function openList(): void {
		if (!list) return;
		list.hidden = false;
		// Lift the board's stacking context above the nav for as long as the
		// modal is open — see .board--modal in styles/board.css. Without it
		// the nav dock (z-index 35) renders over a .board that sits at 25,
		// and the modal's scrim would not cover the navigation.
		rootEl.classList.add('board--modal');
		listToggleEl?.setAttribute('aria-expanded', 'true');
		// Re-load each open so a message posted while it was closed (or
		// deleted by another admin) is reflected.
		void loadFullList();
		listSheet?.focus();
	}

	function closeList(): void {
		if (!list) return;
		list.hidden = true;
		rootEl.classList.remove('board--modal');
		listToggleEl?.setAttribute('aria-expanded', 'false');
		listToggleEl?.focus();
		// Anything may have changed in the sky while it was open.
		void loadLatest(true);
	}

	listToggleEl?.addEventListener('click', () => {
		if (listOpen()) closeList();
		else openList();
	});
	listClose?.addEventListener('click', closeList);
	listScrim?.addEventListener('click', closeList);
	list?.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closeList();
			return;
		}
		// Keep Tab inside the sheet while it is modal.
		if (event.key !== 'Tab' || !listSheet) return;
		const focusable = listSheet.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
		);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (!event.shiftKey && listSheet.contains(document.activeElement) && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		} else if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		}
	});

	// The sky keeps its own loop while the list is open, but polling stops:
	// the list holds its own snapshot, and new spawns would reshuffle the
	// field behind a panel the reader is looking through.


	/* --- polling --------------------------------------------------------------------- */

	/* The poll timer only EXISTS while the tab is visible: visibilitychange
	   (handler registered above with the physics loop) stops it entirely when
	   document.hidden and restarts it — with an immediate catch-up fetch —
	   when the tab returns. Each poll is a conditional request: the server
	   answers 304 when the newest page is unchanged, so a quiet board costs
	   one header-sized round-trip instead of a full JSON payload. */
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	const pollNow = () => {
		// Skip while the full list is open: it holds its own snapshot, and
		// spawns from polling would reshuffle the field behind the panel the
		// reader is looking at. closeList() forces a catch-up fetch.
		if (!isPageVisible() || !isBoardVisible || listOpen()) return;
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
		invalidateBounds();
		sizeCache.clear();
		updateKeyboardInset();
		updateChromeInset();
		if (reduced) relayoutStatic();
	});

	/* --- go ------------------------------------------------------------------------- */

	/* Visual-viewport tracking: publish the keyboard overlap as --kb-inset
	   (composer + field CSS consume it) and keep the physics floor honest.
	   'scroll' fires when iOS pans the visual viewport inside the layout one. */
	if (window.visualViewport) {
		window.visualViewport.addEventListener('resize', () => {
			invalidateBounds();
			updateKeyboardInset();
			updateChromeInset();
		});
		window.visualViewport.addEventListener('scroll', () => {
			invalidateBounds();
			updateKeyboardInset();
			updateChromeInset();
		});
	}
	updateKeyboardInset();
	updateChromeInset();

	sliderValueEl.textContent = sliderEl.value;
	// Initial load is capped at the newest defaultVisible (10) messages;
	// anything beyond that only arrives through cursor walks.
	void loadLatest(false, true);
	root.classList.add('board--ready');
	if (!reduced) startLoop();
	else root.classList.add('board--static');
	startPolling();
}
