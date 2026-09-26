/**
 * BNJI.NET — shared rate limiter (KV with TTL).
 *
 * Fixed-window counters stored in Cloudflare KV so limits are consistent
 * ACROSS Worker isolates: two requests landing on different isolates still
 * share the same counter, which per-instance memory could never guarantee.
 *
 * Design
 * ------
 *  - key:   `rl:<scope>:<clientKey>:<windowIndex>` where
 *           windowIndex = floor(now / windowMs) — a new key per window;
 *  - value: hit count for that window;
 *  - TTL:   the remainder of the current window (+1s slack, floor 60s — KV's
 *           minimum), so keys expire themselves and never accumulate;
 *  - deny:  count >= maxHits → allowed:false with retryAfter = seconds until
 *           the window rolls over.
 *
 * Chosen over Durable Objects on purpose: the board's abuse protection needs
 * shared state, not serialization. KV adds no new binding (BOARD_KV already
 * exists for the board's infra), no DO class to deploy, and costs nothing at
 * rest. The known trade-off is accepted and bounded: two simultaneous hits in
 * the same window can race the read-then-put and under-count by one, so the
 * limit is "at most maxHits + concurrency", which is fine for throttling
 * humans. If exact serialization ever matters, swap this module for a
 * Durable Object — the call sites are two lines in each API route.
 *
 * Failure mode: if the KV binding is missing entirely (misconfiguration), we
 * FAIL OPEN with a console warning — losing abuse throttling must not take
 * the board down. This is a throttle, not authentication.
 */
export type KvRateLimitStore = {
	get(key: string, type?: 'text'): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type RateLimitResult = {
	allowed: boolean;
	/** Seconds until the current window rolls over (0 when allowed). */
	retryAfter: number;
};

let warnedMissingKv = false;

export async function rateLimit(
	kv: KvRateLimitStore | undefined,
	key: string,
	windowMs: number,
	maxHits: number,
): Promise<RateLimitResult> {
	if (!kv || typeof kv.get !== 'function') {
		if (!warnedMissingKv) {
			warnedMissingKv = true;
			console.warn('[bnji] rate limiting disabled: BOARD_KV binding missing');
		}
		return { allowed: true, retryAfter: 0 };
	}

	const now = Date.now();
	const windowIndex = Math.floor(now / windowMs);
	const elapsedInWindow = now % windowMs;
	// KV rejects expirationTtl below 60s. Overshooting the window is harmless:
	// the key name embeds windowIndex, so a longer-lived key never leaks into
	// a future window's count — it just gets garbage-collected a bit later.
	const ttlSeconds = Math.max(60, Math.ceil((windowMs - elapsedInWindow) / 1000) + 1);
	const retryAfter = Math.max(1, Math.ceil((windowMs - elapsedInWindow) / 1000));
	const kvKey = `rl:${key}:${windowIndex}`;

	let count = 0;
	try {
		const raw = await kv.get(kvKey, 'text');
		count = raw ? Number.parseInt(raw, 10) || 0 : 0;
	} catch (error) {
		// KV read failure: fail open (throttle, not auth), but log it.
		console.warn('[bnji] rate limit read failed, allowing:', error);
		return { allowed: true, retryAfter: 0 };
	}

	if (count >= maxHits) return { allowed: false, retryAfter };

	try {
		await kv.put(kvKey, String(count + 1), { expirationTtl: ttlSeconds });
	} catch (error) {
		// A failed write must not block the request; the next hit re-reads.
		console.warn('[bnji] rate limit write failed, allowing:', error);
	}
	return { allowed: true, retryAfter: 0 };
}
