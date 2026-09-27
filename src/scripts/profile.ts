/**
 * BNJI.NET — profile page client runtime.
 *
 * Handles five concerns:
 *   1. View tracking: sends a POST beacon to /api/profile/view on page load.
 *   2. Reactions: handles reaction button clicks with optimistic UI and
 *      graceful degradation.
 *   3. Link click tracking: sends a beacon for external link clicks.
 *   4. Copy-to-clipboard: handles Discord-style copy blocks.
 *   5. Security enrichment: reports screen/hardware/timing details the
 *      server cannot observe, for abuse detection on the server only.
 *
 * All operations are fire-and-forget and non-blocking. A failure in any
 * of these never affects page display or link functionality.
 *
 * Called from the profile page route via a <script> block.
 */

function sendBeacon(url: string, data: unknown): void {
	try {
		if (navigator.sendBeacon) {
			const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
			navigator.sendBeacon(url, blob);
		} else {
			fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(data),
				keepalive: true,
			}).catch(() => {});
		}
	} catch {
		// Silently ignore beacon failures.
	}
}

/**
 * Track a profile view. Called once on page load.
 */
export function initProfileViewTracking(slug: string): void {
	sendBeacon('/api/profile/view', { slug });
}

/**
 * Collect the device details only a browser can see. Everything here is
 * read defensively: an older browser that lacks a given API simply omits
 * that field rather than throwing.
 */
function collectDeviceData(): Record<string, unknown> {
	const data: Record<string, unknown> = {};

	try {
		if (typeof screen !== 'undefined') {
			data.screenWidth = screen.width;
			data.screenHeight = screen.height;
		}
	} catch {
		// Screen unavailable.
	}

	try {
		if (typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number') {
			data.screenPixelRatio = window.devicePixelRatio;
		}
	} catch {
		// Pixel ratio unavailable.
	}

	try {
		const nav = typeof navigator !== 'undefined' ? navigator : undefined;
		if (!nav) return data;

		if (typeof nav.hardwareConcurrency === 'number') {
			data.hardwareConcurrency = nav.hardwareConcurrency;
		}
		// deviceMemory is Chromium-only and deliberately coarse (buckets of
		// 0.25/0.5/1/2/4/8 GB) to blunt fingerprinting.
		const memory = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
		if (typeof memory === 'number') data.deviceMemory = memory;

		if (typeof nav.platform === 'string') data.platform = nav.platform;
		if (typeof nav.language === 'string') data.language = nav.language;
		if (typeof nav.maxTouchPoints === 'number') data.touchSupport = nav.maxTouchPoints > 0;
	} catch {
		// Navigator partially unavailable.
	}

	try {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (typeof timezone === 'string' && timezone) data.timezone = timezone;
	} catch {
		// Timezone unavailable.
	}

	const renderer = detectWebglRenderer();
	if (renderer) data.webglRenderer = renderer;

	return data;
}

/**
 * Read the GPU renderer string from a throwaway WebGL context. The debug
 * renderer info extension is what exposes the unmasked (real) renderer;
 * without it we fall back to the generic vendor string, or nothing.
 * The context is explicitly lost so the probe does not hold GPU memory.
 */
function detectWebglRenderer(): string | null {
	let canvas: HTMLCanvasElement | null = null;
	let gl: WebGLRenderingContext | null = null;
	try {
		canvas = document.createElement('canvas');
		gl = (canvas.getContext('webgl') ??
			canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
		if (!gl) return null;

		const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
		const value = debugInfo
			? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
			: gl.getParameter(gl.RENDERER);

		return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null;
	} catch {
		return null;
	} finally {
		try {
			gl?.getExtension('WEBGL_lose_context')?.loseContext();
		} catch {
			// Losing the context is best-effort.
		}
	}
}

/**
 * Report device details to the server for abuse detection, once per page
 * load, attached to the 'view' event logged moments ago.
 *
 * The delay is deliberate: on a first visit the session cookie is still
 * being set by the /api/profile/view response. Sending the enrichment
 * beacon immediately would race that Set-Cookie and the enrichment would
 * find no session to match. A short delay is imperceptible and makes the
 * first-visit case work; later visits already have the cookie, so the
 * delay costs nothing there.
 */
function initSecurityEnrichment(slug: string): void {
	setTimeout(() => {
		try {
			sendBeacon('/api/profile/security/enrich', {
				slug,
				endpoint: 'view',
				...collectDeviceData(),
			});
		} catch (error) {
			console.warn('[bnji] security enrichment beacon failed:', error);
		}
	}, 1500);
}

/**
 * Initialize reaction buttons. Each button sends a POST to /api/profile/react
 * and updates the count optimistically. On error, the button text reverts.
 */
export function initProfileReactions(slug: string): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>('[data-reaction]');

	for (const button of buttons) {
		button.addEventListener('click', async () => {
			const reaction = button.dataset.reaction;
			if (!reaction || button.disabled) return;

			// Optimistic: increment count and disable.
			const countEl = button.querySelector<HTMLElement>('[data-reaction-count]');
			const currentCount = countEl ? parseInt(countEl.textContent ?? '0', 10) || 0 : 0;
			if (countEl) countEl.textContent = String(currentCount + 1);
			button.disabled = true;
			button.classList.add('is-reacted');

			try {
				const response = await fetch('/api/profile/react', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ slug, reaction }),
					credentials: 'same-origin',
				});

				if (response.ok) {
					const data = (await response.json()) as { counts?: Record<string, number> };
					if (data.counts) {
						updateAllReactionCounts(data.counts);
					}
				} else if (response.status === 429) {
					// Cooldown: keep the optimistic increment but show feedback.
					button.classList.add('is-cooldown');
					setTimeout(() => button.classList.remove('is-cooldown'), 3000);
				} else {
					// Revert optimistic increment.
					if (countEl) countEl.textContent = String(currentCount);
				}
			} catch {
				// Network error: revert.
				if (countEl) countEl.textContent = String(currentCount);
			} finally {
				// Re-enable after a cooldown to prevent spam clicking.
				setTimeout(() => {
					button.disabled = false;
				}, 2000);
			}
		});
	}
}

function updateAllReactionCounts(counts: Record<string, number>): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>('[data-reaction]');
	for (const button of buttons) {
		const reaction = button.dataset.reaction;
		if (reaction && reaction in counts) {
			const countEl = button.querySelector<HTMLElement>('[data-reaction-count]');
			if (countEl) countEl.textContent = String(counts[reaction]);
		}
	}
}

/**
 * Track link clicks via beacon. Called for external profile links.
 * The actual navigation still happens via the <a> href — this only
 * records the click for analytics.
 */
export function initProfileLinkTracking(slug: string): void {
	const links = document.querySelectorAll<HTMLAnchorElement>('[data-link-id]');
	for (const link of links) {
		link.addEventListener('click', () => {
			const linkId = link.dataset.linkId;
			if (linkId) {
				sendBeacon('/api/profile/link/click', { slug, linkId });
			}
		});
	}
}

/**
 * Initialize copy-to-clipboard blocks.
 */
export function initProfileCopyBlocks(): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>('[data-copy-handle]');
	for (const button of buttons) {
		const container = button.closest<HTMLElement>('.profile-page__copy') ?? button.parentElement;
		const valueEl = container?.querySelector<HTMLElement>('[data-copy-value]');
		const labelEl = button.querySelector<HTMLElement>('[data-copy-text]');

		if (!valueEl || !labelEl) continue;

		button.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(valueEl.textContent?.trim() ?? '');
				labelEl.textContent = 'Copied ✓';
				setTimeout(() => (labelEl.textContent = 'Copy'), 1600);
			} catch {
				labelEl.textContent = 'Select + copy';
				setTimeout(() => (labelEl.textContent = 'Copy'), 2400);
			}
		});
	}
}

/**
 * Master init for the profile page. Called from the page's <script> block.
 */
export function initProfile(slug: string): void {
	try {
		initProfileViewTracking(slug);
	} catch (error) {
		console.warn('[bnji] profile view tracking failed:', error);
	}

	try {
		initSecurityEnrichment(slug);
	} catch (error) {
		console.warn('[bnji] security enrichment failed:', error);
	}

	try {
		initProfileReactions(slug);
	} catch (error) {
		console.warn('[bnji] profile reactions failed:', error);
	}

	try {
		initProfileLinkTracking(slug);
	} catch (error) {
		console.warn('[bnji] profile link tracking failed:', error);
	}

	try {
		initProfileCopyBlocks();
	} catch (error) {
		console.warn('[bnji] profile copy blocks failed:', error);
	}
}