/**
 * BNJI.NET — global page telemetry & device enrichment runtime.
 *
 * Sends a non-blocking beacon to /api/track on boot to record global page
 * traffic, and enriches security/traffic events with local screen & hardware facts.
 */
let tracked = false;

export function initTelemetry(): void {
	if (tracked) return;
	tracked = true;

	const path = window.location.pathname;
	// Do not track admin panel accesses
	if (path.startsWith('/admin')) return;

	try {
		const payload = JSON.stringify({
			path,
			referrer: document.referrer || undefined,
		});

		if (navigator.sendBeacon) {
			navigator.sendBeacon('/api/track', payload);
		} else {
			fetch('/api/track', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: payload,
				keepalive: true,
			}).catch(() => {});
		}
	} catch {
		// Non-fatal telemetry beacon
	}
}
