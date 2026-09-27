/**
 * BNJI.NET — client-side device reporting (shared by every surface).
 *
 * Both the profile pages and the message board report the same device facts
 * to the same endpoint (/api/security/enrich) so that abuse detection sees
 * one consistent picture regardless of where a visitor is on the site. This
 * module is the single implementation of that report; the surfaces differ
 * only in the `surface` and `endpoint` they tag it with.
 *
 * WHAT IS REPORTED
 *   screen size + pixel ratio, CPU core count, device memory, OS platform,
 *   IANA timezone, UI language, GPU renderer string, touch support.
 *
 * WHAT IS NOT
 *   No canvas pixels, no audio fingerprint, no font enumeration, no cookies
 *   or storage, no third-party identifiers, nothing about other sites. The
 *   GPU string comes from a throwaway WebGL context that is destroyed
 *   immediately; it is a capability label, not a rendered image.
 *
 * WHY ANY OF IT
 *   Bot farms run homogeneous fleets. Hundreds of "unique" IP addresses
 *   posting from byte-identical screen sizes, GPUs and timezones is a signal
 *   that IP and user-agent alone cannot produce, and it is exactly what an
 *   abuse response needs to act on.
 *
 * The server hashes these into a device fingerprint. The raw values are sent
 * once, folded into a row the server already wrote, and never come back —
 * every response on this path is an empty 204.
 */

/** The payload shape understood by POST /api/security/enrich. */
export type EnrichTarget = {
	/** 'profile' | 'board' | 'dm' */
	surface: 'profile' | 'board' | 'dm';
	/** Endpoint whose most recent event should receive this data. */
	endpoint: string;
	/** Required for surface 'profile' only. */
	slug?: string;
};

/**
 * Collect the device details only a browser can see.
 *
 * Every read is defensive: an older browser that lacks a given API simply
 * omits that field rather than throwing, so a partial report still enriches
 * whatever it does know.
 */
export function collectDeviceData(): Record<string, unknown> {
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
	let gl: WebGLRenderingContext | null = null;
	try {
		const canvas = document.createElement('canvas');
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
 * Report device details to the server, once per action being described.
 *
 * `delayMs` exists for one specific race. The action that logs the event
 * (a view beacon, a board page load) may be the request that SETS the session
 * cookie — on a first visit there is no cookie yet, and firing this
 * immediately would arrive before the Set-Cookie had been committed, leaving
 * the server nothing to match against. A short delay is imperceptible and
 * makes the first-visit case work; later visits already carry the cookie.
 *
 * The endpoint always answers 204 and never reveals whether it matched, so
 * there is nothing useful to retry and nothing to leak.
 */
export function sendSecurityEnrichment(target: EnrichTarget, delayMs = 1500): void {
	setTimeout(() => {
		try {
			reportDeviceData(target);
		} catch (error) {
			console.warn('[bnji] security enrichment beacon failed:', error);
		}
	}, delayMs);
}

/** Fire the enrichment beacon immediately (used right after an action). */
export function reportDeviceData(target: EnrichTarget): void {
	const payload = {
		surface: target.surface,
		endpoint: target.endpoint,
		...(target.slug ? { slug: target.slug } : {}),
		...collectDeviceData(),
	};
	postBeacon('/api/security/enrich', payload);
}

/**
 * POST a JSON body as a beacon.
 *
 * sendBeacon is used where available because it survives the page going
 * away — a visitor who posts a message and immediately navigates off must
 * not lose the report. The fetch(keepalive) path is the fallback for the
 * handful of browsers without it, and is still non-blocking.
 */
export function postBeacon(url: string, data: unknown): void {
	try {
		if (navigator.sendBeacon) {
			const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
			navigator.sendBeacon(url, blob);
		} else {
			void fetch(url, {
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
